"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgAdmin, resolveOrgId } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import type { ActionResult } from "@/lib/action-result";
import { deleteDomain as deleteStalwartDomain } from "@/lib/stalwart/client";
import { expectedRecords, getPlatformMailHost, isPlatformDomain } from "@/lib/dns/dns-records";
import { DomainStatus } from "@prisma/client";
import { addDomainForOrg, verifyDomainForOrg } from "@/lib/domains/manage";
import {
  createDomain,
  extractStalwartCreatedId,
  isStalwartFailure,
  resolveStalwartDomainId,
} from "@/lib/stalwart/client";

export async function addDomainAction(
  _prev: ActionResult,
  formData: FormData
): Promise<ActionResult> {
  const session = await requireOrgAdmin();
  const orgId = await resolveOrgId(session);
  if (!orgId) redirect("/login?error=session");

  const fqdn = (formData.get("fqdn") as string).toLowerCase().trim();
  if (!fqdn) return null;

  const result = await addDomainForOrg(orgId, fqdn);
  if (!result.ok) {
    if (result.error === "domain_taken") {
      return { ok: false, message: "domainTaken", detail: fqdn };
    }
    return null;
  }

  revalidatePath("/dashboard/domains");
  if (!result.stalwartSynced) {
    return { ok: false, message: "stalwartSyncFailed", detail: fqdn, warning: true };
  }
  return { ok: true, message: "addSuccess", detail: fqdn };
}

export async function verifyDomainAction(
  _prev: ActionResult,
  formData: FormData
): Promise<ActionResult> {
  const session = await requireOrgAdmin();
  const orgId = await resolveOrgId(session);
  if (!orgId) redirect("/login?error=session");

  const domainId = formData.get("domainId") as string;
  if (!domainId) return null;

  const domain = await prisma.domain.findFirst({
    where: { id: domainId, organizationId: orgId },
  });
  if (!domain) return null;

  const result = await verifyDomainForOrg(orgId, domain.fqdn);
  if (!result.ok) return null;

  revalidatePath("/dashboard/domains", "page");
  if (result.check.verified) {
    return { ok: true, message: "verifySuccess", detail: domain.fqdn };
  }
  return { ok: false, message: "verifyStillPending", detail: domain.fqdn, warning: true };
}

async function ensureStalwartDomain(
  fqdn: string,
  cachedId: string | null
): Promise<{ id: string | null; unavailable: boolean }> {
  const resolved = await resolveStalwartDomainId(fqdn, cachedId);
  if (resolved.unavailable) return { id: null, unavailable: true };
  if (resolved.id) return { id: resolved.id, unavailable: false };

  const createRes = await createDomain(fqdn);
  if (isStalwartFailure(createRes)) return { id: null, unavailable: true };
  return { id: extractStalwartCreatedId(createRes), unavailable: false };
}

export async function forceApproveDomainAction(
  _prev: ActionResult,
  formData: FormData
): Promise<ActionResult> {
  const session = await requireOrgAdmin();
  const orgId = await resolveOrgId(session);
  if (!orgId) redirect("/login?error=session");

  const domainId = formData.get("domainId") as string;
  if (!domainId) return null;

  const domain = await prisma.domain.findFirst({
    where: { id: domainId, organizationId: orgId },
  });
  if (!domain) return null;

  if (isPlatformDomain(domain.fqdn)) return null;

  if (domain.status === "VERIFIED" || domain.status === "ACTIVE") {
    return { ok: true, message: "forceApproveAlreadyVerified", detail: domain.fqdn };
  }

  const platformHost = getPlatformMailHost();
  const stalwart = await ensureStalwartDomain(domain.fqdn, domain.stalwartDomainId);

  await prisma.domain.update({
    where: { id: domainId },
    data: {
      status: DomainStatus.VERIFIED,
      dnsRecordsJson: expectedRecords(domain.fqdn, platformHost),
      ...(stalwart.id && !domain.stalwartDomainId
        ? { stalwartDomainId: stalwart.id }
        : {}),
    },
  });

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      organizationId: orgId,
      action: "domain.force_approve",
      target: domain.fqdn,
      metadata: {
        domainId: domain.id,
        previousStatus: domain.status,
        stalwartDomainId: stalwart.id ?? domain.stalwartDomainId,
        stalwartUnavailable: stalwart.unavailable,
      },
    },
  });

  revalidatePath("/dashboard/domains", "page");
  revalidatePath("/dashboard");

  if (stalwart.unavailable) {
    return {
      ok: false,
      message: "forceApproveStalwartFailed",
      detail: domain.fqdn,
      warning: true,
    };
  }

  return { ok: true, message: "forceApproveSuccess", detail: domain.fqdn };
}

export async function deleteDomainAction(
  _prev: ActionResult,
  formData: FormData
): Promise<ActionResult> {
  const session = await requireOrgAdmin();
  const orgId = await resolveOrgId(session);
  if (!orgId) redirect("/login?error=session");

  const domainId = formData.get("domainId") as string;
  if (!domainId) return null;

  const domain = await prisma.domain.findFirst({
    where: { id: domainId, organizationId: orgId },
  });
  if (!domain) return null;

  if (isPlatformDomain(domain.fqdn)) {
    return { ok: false, message: "deletePlatform" };
  }

  const mailboxCount = await prisma.mailbox.count({ where: { domainId } });
  if (mailboxCount > 0) {
    return { ok: false, message: "deleteMailboxes", detail: domain.fqdn };
  }

  if (domain.stalwartDomainId) {
    await deleteStalwartDomain(domain.stalwartDomainId);
  }

  await prisma.domain.delete({ where: { id: domainId } });

  revalidatePath("/dashboard/domains", "page");
  return { ok: true, message: "deleteSuccess", detail: domain.fqdn };
}
