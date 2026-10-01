import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { sealSecret } from "@/lib/crypto/seal";
import { MAIL_USABLE_DOMAIN_STATUSES } from "@/lib/domain-status";
import { normalizeFqdn } from "@/lib/domains/manage";
import {
  createAccount,
  extractStalwartCreatedId,
  extractStalwartOrphanAccountId,
  extractStalwartSetIssue,
  isStalwartAliasConflict,
  isStalwartDomainIssue,
  isStalwartFailure,
  isStalwartPasswordIssue,
  isStalwartTransportIssue,
  resolveStalwartDomainId,
  updateAccount,
  updateAccountPassword,
} from "@/lib/stalwart/client";

const LOCAL_PART_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type CreateMailboxResult =
  | {
      ok: true;
      created: boolean;
      address: string;
      password?: string;
    }
  | {
      ok: false;
      error:
        | "invalid_local_part"
        | "invalid_fqdn"
        | "domain_not_found"
        | "exists"
        | "exists_as_alias"
        | "password_weak"
        | "stalwart_unavailable"
        | "domain_not_synced"
        | "stalwart_error";
    };

function generateMailboxPassword(): string {
  return randomBytes(24).toString("base64url");
}

export async function createMailboxForOrg(input: {
  organizationId: string;
  fqdn: string;
  localPart: string;
  password?: string;
  displayName?: string;
}): Promise<CreateMailboxResult> {
  const fqdn = normalizeFqdn(input.fqdn);
  if (!fqdn) return { ok: false, error: "invalid_fqdn" };

  const localPart = input.localPart.trim().toLowerCase();
  if (!LOCAL_PART_RE.test(localPart)) return { ok: false, error: "invalid_local_part" };

  const generated = !input.password;
  const password = input.password?.trim() || generateMailboxPassword();
  if (password.length < 8) return { ok: false, error: "password_weak" };

  const displayName = input.displayName?.trim() || null;
  const domain = await prisma.domain.findFirst({
    where: {
      organizationId: input.organizationId,
      fqdn,
      status: { in: MAIL_USABLE_DOMAIN_STATUSES },
    },
  });
  if (!domain) return { ok: false, error: "domain_not_found" };

  const address = `${localPart}@${domain.fqdn}`;
  const existing = await prisma.mailbox.findUnique({ where: { address } });
  if (existing) {
    return { ok: true, created: false, address };
  }

  const alias = await prisma.emailAlias.findFirst({
    where: { organizationId: input.organizationId, source: address },
    select: { id: true },
  });
  if (alias) return { ok: false, error: "exists_as_alias" };

  const domainResolved = await resolveStalwartDomainId(domain.fqdn, domain.stalwartDomainId);
  if (domainResolved.unavailable) return { ok: false, error: "stalwart_unavailable" };
  if (!domainResolved.id) return { ok: false, error: "domain_not_synced" };

  const persistDomainId = !domain.stalwartDomainId
    ? prisma.domain.update({
        where: { id: domain.id },
        data: { stalwartDomainId: domainResolved.id },
      })
    : null;

  const stalwartRes = await createAccount(localPart, domainResolved.id, password, displayName);
  if (isStalwartFailure(stalwartRes)) {
    const issue = extractStalwartSetIssue(stalwartRes);
    if (issue?.type === "unavailable" || isStalwartTransportIssue(issue)) {
      return { ok: false, error: "stalwart_unavailable" };
    }
    if (isStalwartAliasConflict(issue)) return { ok: false, error: "exists_as_alias" };
    if (isStalwartPasswordIssue(issue)) return { ok: false, error: "password_weak" };
    if (isStalwartDomainIssue(issue)) return { ok: false, error: "domain_not_synced" };

    const orphanId = extractStalwartOrphanAccountId(issue);
    if (orphanId) {
      const pwdRes = await updateAccountPassword(orphanId, password);
      if (isStalwartFailure(pwdRes)) {
        if (isStalwartPasswordIssue(extractStalwartSetIssue(pwdRes))) {
          return { ok: false, error: "password_weak" };
        }
        return { ok: false, error: "stalwart_error" };
      }
      if (displayName) {
        const descRes = await updateAccount(orphanId, { description: displayName });
        if (isStalwartFailure(descRes)) return { ok: false, error: "stalwart_error" };
      }
      if (persistDomainId) await persistDomainId;
      await prisma.mailbox.create({
        data: {
          organizationId: input.organizationId,
          domainId: domain.id,
          address,
          displayName,
          stalwartAccountId: orphanId,
          credentialsEnc: sealSecret(password),
        },
      });
      return { ok: true, created: true, address, ...(generated ? { password } : {}) };
    }

    if (issue?.type === "primaryKeyViolation") return { ok: false, error: "exists" };
    return { ok: false, error: "stalwart_error" };
  }

  const stalwartAccountId = extractStalwartCreatedId(stalwartRes);
  if (persistDomainId) await persistDomainId;
  await prisma.mailbox.create({
    data: {
      organizationId: input.organizationId,
      domainId: domain.id,
      address,
      displayName,
      stalwartAccountId,
      credentialsEnc: sealSecret(password),
    },
  });

  return { ok: true, created: true, address, ...(generated ? { password } : {}) };
}
