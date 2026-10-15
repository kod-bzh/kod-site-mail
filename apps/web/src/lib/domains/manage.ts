import { domainToASCII } from "node:url";
import { DomainStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  formatDnsHostLabel,
  getPlatformMailHost,
  type DnsRecord,
} from "@/lib/dns/dns-records";
import { domainDnsRecords } from "@/lib/dns/domain-records";
import { DELIVERABILITY_NOTICE } from "@/lib/dns/deliverability";
import { verifyDomainDns, type DnsVerifyResult } from "@/lib/dns/verify";
import {
  createDomain as createStalwartDomain,
  extractStalwartCreatedId,
  isStalwartFailure,
  resolveStalwartDomainId,
} from "@/lib/stalwart/client";

const FQDN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export type RegistrarDnsRecord = DnsRecord & { host: string };

export function normalizeFqdn(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed) return null;
  let ascii = trimmed;
  if (/[^\x00-\x7F]/.test(trimmed)) {
    ascii = domainToASCII(trimmed);
  }
  if (!ascii || ascii === "null") return null;
  const fqdn = ascii.toLowerCase();
  if (!FQDN_RE.test(fqdn)) return null;
  return fqdn;
}

export async function registrarDnsRecords(fqdn: string, platformHost?: string): Promise<RegistrarDnsRecord[]> {
  const { records } = await domainDnsRecords(fqdn, platformHost);
  return records.map((record) => ({
    ...record,
    host: formatDnsHostLabel(record.name, fqdn),
  }));
}

export type DomainSummary = {
  id: string;
  fqdn: string;
  status: DomainStatus;
  organizationId: string;
  stalwartSynced: boolean;
};

function toSummary(domain: {
  id: string;
  fqdn: string;
  status: DomainStatus;
  organizationId: string;
  stalwartDomainId: string | null;
}): DomainSummary {
  return {
    id: domain.id,
    fqdn: domain.fqdn,
    status: domain.status,
    organizationId: domain.organizationId,
    stalwartSynced: Boolean(domain.stalwartDomainId),
  };
}

async function syncStalwartDomain(
  fqdn: string,
  cachedId: string | null
): Promise<{ id: string | null; unavailable: boolean }> {
  const resolved = await resolveStalwartDomainId(fqdn, cachedId);
  if (resolved.unavailable) return { id: null, unavailable: true };
  if (resolved.id) return { id: resolved.id, unavailable: false };

  const created = await createStalwartDomain(fqdn);
  if (isStalwartFailure(created)) {
    const again = await resolveStalwartDomainId(fqdn, null);
    return { id: again.id, unavailable: again.unavailable };
  }
  return { id: extractStalwartCreatedId(created), unavailable: false };
}

export async function previewDomainDns(fqdnRaw: string): Promise<
  | { ok: true; fqdn: string; records: RegistrarDnsRecord[]; mailHost: string; signingConfigured: boolean }
  | { ok: false; error: "invalid_fqdn" }
> {
  const fqdn = normalizeFqdn(fqdnRaw);
  if (!fqdn) return { ok: false, error: "invalid_fqdn" };
  const mailHost = getPlatformMailHost();
  const configuration = await domainDnsRecords(fqdn, mailHost);
  return { ok: true, fqdn, records: configuration.records.map(record => ({ ...record, host: formatDnsHostLabel(record.name, fqdn) })), mailHost, signingConfigured: configuration.signingConfigured };
}

export async function listOrganizationDomains(organizationId: string): Promise<DomainSummary[]> {
  const domains = await prisma.domain.findMany({
    where: { organizationId },
    orderBy: { fqdn: "asc" },
    select: {
      id: true,
      fqdn: true,
      status: true,
      organizationId: true,
      stalwartDomainId: true,
    },
  });
  return domains.map(toSummary);
}

export async function getOrganizationDomain(
  organizationId: string,
  fqdnRaw: string
): Promise<DomainSummary | null> {
  const fqdn = normalizeFqdn(fqdnRaw);
  if (!fqdn) return null;
  const domain = await prisma.domain.findFirst({
    where: { organizationId, fqdn },
    select: {
      id: true,
      fqdn: true,
      status: true,
      organizationId: true,
      stalwartDomainId: true,
    },
  });
  return domain ? toSummary(domain) : null;
}

export async function addDomainForOrg(
  organizationId: string,
  fqdnRaw: string
): Promise<
  | {
      ok: true;
      created: boolean;
      domain: DomainSummary;
      records: RegistrarDnsRecord[];
      verified: boolean;
      stalwartSynced: boolean;
      sendingAllowed: boolean;
      sender: string;
      notice: string;
    }
  | { ok: false; error: "invalid_fqdn" | "domain_taken" }
> {
  const fqdn = normalizeFqdn(fqdnRaw);
  if (!fqdn) return { ok: false, error: "invalid_fqdn" };

  const existing = await prisma.domain.findFirst({
    where: { fqdn },
    select: {
      id: true,
      fqdn: true,
      status: true,
      organizationId: true,
      stalwartDomainId: true,
    },
  });
  if (existing && existing.organizationId !== organizationId) {
    return { ok: false, error: "domain_taken" };
  }

  const platformHost = getPlatformMailHost();
  if (existing) {
    const stalwart = await syncStalwartDomain(fqdn, existing.stalwartDomainId);
    const check = await verifyDomainDns(fqdn, platformHost);
    const records = await registrarDnsRecords(fqdn, platformHost);
    const updated = await prisma.domain.update({
      where: { id: existing.id },
      data: { status: check.verified ? DomainStatus.VERIFIED : DomainStatus.PENDING_DNS,
        ...(stalwart.id ? { stalwartDomainId: stalwart.id } : {}), dnsRecordsJson: records },
    });
    return {
      ok: true, created: false, domain: toSummary(updated), records,
      ...(await prepareSender(organizationId, fqdn)),
      verified: check.verified, stalwartSynced: Boolean(stalwart.id),
    };
  }

  const stalwart = await syncStalwartDomain(fqdn, null);
  const dnsCheck = await verifyDomainDns(fqdn, platformHost);
  const status =
    dnsCheck.verified
      ? DomainStatus.VERIFIED
      : DomainStatus.PENDING_DNS;

  const domain = await prisma.domain.create({
    data: {
      organizationId,
      fqdn,
      stalwartDomainId: stalwart.id,
      status,
      dnsRecordsJson: await registrarDnsRecords(fqdn, platformHost),
    },
    select: {
      id: true,
      fqdn: true,
      status: true,
      organizationId: true,
      stalwartDomainId: true,
    },
  });

  return {
    ok: true,
    created: true,
    domain: toSummary(domain),
    records: await registrarDnsRecords(fqdn, platformHost),
    ...(await prepareSender(organizationId, fqdn)),
    verified: domain.status === "VERIFIED" || domain.status === "ACTIVE",
    stalwartSynced: Boolean(domain.stalwartDomainId),
  };
}

export async function verifyDomainForOrg(
  organizationId: string,
  fqdnRaw: string
): Promise<
  | {
      ok: true;
      domain: DomainSummary;
      records: RegistrarDnsRecord[];
      check: DnsVerifyResult;
    }
  | { ok: false; error: "invalid_fqdn" | "domain_not_found" }
> {
  const fqdn = normalizeFqdn(fqdnRaw);
  if (!fqdn) return { ok: false, error: "invalid_fqdn" };

  const domain = await prisma.domain.findFirst({
    where: { organizationId, fqdn },
  });
  if (!domain) return { ok: false, error: "domain_not_found" };

  const platformHost = getPlatformMailHost();
  const check = await verifyDomainDns(fqdn, platformHost);
  const status = check.verified ? DomainStatus.VERIFIED : DomainStatus.PENDING_DNS;

  const updated = await prisma.domain.update({
    where: { id: domain.id },
    data: {
      status,
      dnsRecordsJson: await registrarDnsRecords(fqdn, platformHost),
    },
    select: {
      id: true,
      fqdn: true,
      status: true,
      organizationId: true,
      stalwartDomainId: true,
    },
  });

  return {
    ok: true,
    domain: toSummary(updated),
    records: await registrarDnsRecords(fqdn, platformHost),
    check,
  };
}

async function prepareSender(organizationId: string, fqdn: string) {
  const { createMailboxForOrg } = await import("@/lib/mail/create-mailbox");
  const mailbox = await createMailboxForOrg({ organizationId, fqdn, localPart: "noreply" });
  return {
    sendingAllowed: mailbox.ok,
    sender: `noreply@${fqdn}`,
    notice: mailbox.ok
      ? `Domaine ajouté. Vous pouvez envoyer dès maintenant depuis noreply@${fqdn} avec une clé API autorisée. ${DELIVERABILITY_NOTICE}`
      : `Domaine ajouté ; la préparation de noreply@${fqdn} reste à terminer (${mailbox.error}). ${DELIVERABILITY_NOTICE}`,
  };
}
