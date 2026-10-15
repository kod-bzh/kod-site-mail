import { validateAttachments, normalizeMailRecipients, type MailAttachment } from "./send-payload";
import { prisma } from "@/lib/prisma";
import { MAIL_USABLE_DOMAIN_STATUSES } from "@/lib/domain-status";
import { sendViaStalwartMailbox } from "@/lib/mail/outbound-smtp";
import { resolveStalwartAccountId } from "@/lib/stalwart/client";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type OrgMailSendInput = {
  organizationId: string;
  from: string;
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  cc?: string | string[];
  bcc?: string | string[];
  attachments?: MailAttachment[];
};

export type OrgMailSendError =
  | "invalid_from"
  | "invalid_to"
  | "invalid_attachments"
  | "missing_content"
  | "domain_not_in_org"
  | "domain_not_verified"
  | "smtp_not_configured"
  | "send_failed";

export function parseEmailAddress(raw: string): string | null {
  const trimmed = raw.trim();
  const angle = trimmed.match(/<([^>]+)>/);
  const addr = (angle?.[1] ?? trimmed).trim().toLowerCase();
  if (!EMAIL_RE.test(addr)) return null;
  return addr;
}

function extractDomain(email: string): string {
  return email.split("@")[1] ?? "";
}

/** Résout l'organisation propriétaire d'un From (domaine vérifié ou non). */
export async function findOrganizationIdByFromAddress(
  from: string
): Promise<string | null> {
  const fromEmail = parseEmailAddress(from);
  if (!fromEmail) return null;
  const domain = await prisma.domain.findFirst({
    where: { fqdn: extractDomain(fromEmail) },
    select: { organizationId: true },
    orderBy: { createdAt: "asc" },
  });
  return domain?.organizationId ?? null;
}

/** Compte Stalwart pour envoyer depuis cette adresse (JMAP admin). */
export async function findStalwartSmtpAuth(
  fromEmail: string,
  organizationId?: string
): Promise<{ address: string; accountId: string } | null> {
  const exact = await prisma.mailbox.findFirst({
    where: {
      address: fromEmail,
      ...(organizationId ? { organizationId } : {}),
    },
    select: { address: true, stalwartAccountId: true },
  });
  if (exact) {
    const resolved = await resolveStalwartAccountId(exact.stalwartAccountId, exact.address);
    if (resolved.id) return { address: exact.address, accountId: resolved.id };
  }

  const domainFqdn = extractDomain(fromEmail);
  const fallback = await prisma.mailbox.findFirst({
    where: {
      stalwartAccountId: { not: null },
      domain: { fqdn: domainFqdn },
      ...(organizationId ? { organizationId } : {}),
    },
    select: { address: true, stalwartAccountId: true },
    orderBy: { createdAt: "asc" },
  });
  if (fallback) {
    const resolved = await resolveStalwartAccountId(fallback.stalwartAccountId, fallback.address);
    if (resolved.id) return { address: fallback.address, accountId: resolved.id };
  }

  return null;
}

export async function validateFromDomainForOrg(
  organizationId: string,
  fromEmail: string
): Promise<OrgMailSendError | null> {
  const domainFqdn = extractDomain(fromEmail);
  const domain = await prisma.domain.findUnique({
    where: {
      organizationId_fqdn: { organizationId, fqdn: domainFqdn },
    },
    select: { status: true },
  });

  if (!domain) return "domain_not_in_org";
  if (!MAIL_USABLE_DOMAIN_STATUSES.includes(domain.status)) return "domain_not_verified";
  return null;
}

export async function sendOrgMail(
  input: OrgMailSendInput
): Promise<
  | { ok: true; messageId: string }
  | { ok: false; error: OrgMailSendError; detail?: string }
> {
  const fromEmail = parseEmailAddress(input.from);
  if (!fromEmail) return { ok: false, error: "invalid_from" };

  let recipients;
  try { recipients = normalizeMailRecipients(input); } catch (error) {
    return { ok: false, error: "invalid_to", detail: (error as Error).message };
  }
  if (!recipients.to.length) return { ok: false, error: "invalid_to" };
  try { validateAttachments(input.attachments); } catch (error) {
    return { ok: false, error: "invalid_attachments", detail: (error as Error).message };
  }

  if (!input.text?.trim() && !input.html?.trim()) {
    return { ok: false, error: "missing_content" };
  }

  const domainError = await validateFromDomainForOrg(input.organizationId, fromEmail);
  if (domainError) return { ok: false, error: domainError };

  const mailPayload = {
    from: input.from.trim(),
    ...recipients,
    attachments: input.attachments,
    subject: input.subject.trim(),
    text: input.text,
    html: input.html,
    replyTo: input.replyTo,
  };

  const smtpAuth = await findStalwartSmtpAuth(fromEmail, input.organizationId);
  if (!smtpAuth) {
    return {
      ok: false,
      error: "smtp_not_configured",
      detail: "Aucune boîte Stalwart pour cet expéditeur.",
    };
  }

  const result = await sendViaStalwartMailbox(smtpAuth.accountId, mailPayload);

  if (!result.ok) {
    return {
      ok: false,
      error: result.code,
      detail: result.detail,
    };
  }

  return { ok: true, messageId: result.messageId };
}
