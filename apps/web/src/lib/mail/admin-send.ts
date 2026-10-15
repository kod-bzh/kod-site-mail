import { attachmentSchema } from "./send-payload";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getPlatformEmailDomains } from "@/lib/platform-domains";
import { findStalwartSmtpAuth } from "@/lib/mail/org-mail-send";
import { sendViaStalwartMailbox } from "@/lib/mail/outbound-smtp";

/** Tokens admin acceptés (plusieurs valeurs possibles, séparées par des virgules). */
function configuredTokens(): string[] {
  return (process.env.ADMIN_MAIL_TOKEN ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function isAdminMailTokenConfigured(): boolean {
  return configuredTokens().length > 0;
}

/**
 * Compare `provided` aux tokens configurés en temps constant.
 * Le hachage SHA-256 uniformise la longueur avant `timingSafeEqual` (évite la fuite
 * de longueur et gère des tokens de tailles différentes).
 */
export function verifyAdminMailToken(provided: string | null | undefined): boolean {
  if (!provided) return false;
  const tokens = configuredTokens();
  if (tokens.length === 0) return false;

  const providedHash = createHash("sha256").update(provided).digest();
  let matched = false;
  for (const token of tokens) {
    const tokenHash = createHash("sha256").update(token).digest();
    if (timingSafeEqual(providedHash, tokenHash)) matched = true;
  }
  return matched;
}

/** Extrait l'adresse d'un champ From de la forme `Nom <a@b>` ou `a@b`. */
export function extractEmailAddress(input: string): string | null {
  const angle = input.match(/<([^>]+)>/);
  const candidate = (angle ? angle[1] : input).trim().toLowerCase();
  const valid = z.string().email().safeParse(candidate);
  return valid.success ? candidate : null;
}

export function allowAnyFromDomain(): boolean {
  return process.env.ADMIN_MAIL_ALLOW_ANY_DOMAIN === "true";
}

/**
 * Autorise l'expéditeur si son domaine appartient à la plateforme
 * (`PLATFORM_DOMAINS`). `ADMIN_MAIL_ALLOW_ANY_DOMAIN=true` lève la restriction.
 * Les domaines d'association passent par /api/v1/mail/send + SMTP Stalwart.
 */
export function isFromAddressAllowed(from: string): boolean {
  const address = extractEmailAddress(from);
  if (!address) return false;
  if (allowAnyFromDomain()) return true;

  const domain = address.split("@")[1];
  if (!domain) return false;

  const platformDomains = getPlatformEmailDomains();
  return platformDomains.some(
    (allowed) => domain === allowed || domain.endsWith(`.${allowed}`)
  );
}

const recipients = z.union([
  z.string().email(),
  z.array(z.string().email()).min(1),
]);

export const adminSendMailSchema = z
  .object({
    from: z.string().min(3),
    to: recipients,
    subject: z.string().min(1).max(998),
    text: z.string().optional(),
    html: z.string().optional(),
    attachments: z.array(attachmentSchema).optional(),
    cc: recipients.optional(),
    bcc: recipients.optional(),
    replyTo: z.string().email().optional(),
  })
  .refine((value) => Boolean(value.text ?? value.html), {
    message: "Le corps du message (text ou html) est requis.",
    path: ["text"],
  });

export type AdminSendMailInput = z.infer<typeof adminSendMailSchema>;

export type AdminSendMailResult =
  | { ok: true; via: string; messageId?: string }
  | { ok: false; code: "invalid_from" | "relay_error"; detail: string };

/** Valide l'expéditeur puis envoie via le SMTP Stalwart (pas TEM Scaleway). */
export async function sendAdminMail(
  input: AdminSendMailInput
): Promise<AdminSendMailResult> {
  const fromEmail = extractEmailAddress(input.from);
  if (!fromEmail) {
    return { ok: false, code: "invalid_from", detail: "Adresse expéditrice invalide." };
  }

  const smtpAuth = await findStalwartSmtpAuth(fromEmail);
  if (!smtpAuth) {
    if (!isFromAddressAllowed(input.from)) {
      return {
        ok: false,
        code: "invalid_from",
        detail: allowAnyFromDomain()
          ? "Adresse expéditrice invalide."
          : "Le domaine de l'expéditeur n'appartient pas à la plateforme.",
      };
    }
    return {
      ok: false,
      code: "relay_error",
      detail: "Aucune boîte Stalwart pour cet expéditeur.",
    };
  }

  const result = await sendViaStalwartMailbox(smtpAuth.accountId, {
    from: input.from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
    attachments: input.attachments,
    cc: input.cc,
    bcc: input.bcc,
    replyTo: input.replyTo,
  });

  if (!result.ok) {
    return { ok: false, code: "relay_error", detail: result.detail ?? result.code };
  }
  return { ok: true, via: result.via, messageId: result.messageId };
}
