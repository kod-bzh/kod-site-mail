import type { OutboundAttachment } from "./send-payload";
import { sendMailViaStalwartJmap } from "@/lib/stalwart/client";

export type OutboundMailPayload = {
  from: string;
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  attachments?: OutboundAttachment[];
  rfcMessageId?: string;
};

/** Envoi via JMAP Stalwart (HTTPS). Jamais TEM Scaleway, jamais SMTP 465 (fermé depuis K8s). */
export async function sendViaStalwartMailbox(
  accountId: string,
  payload: OutboundMailPayload
): Promise<{ ok: true; messageId: string; via: string } | { ok: false; code: "smtp_not_configured" | "send_failed"; detail?: string }> {
  return sendMailViaStalwartJmap({
    accountId,
    from: payload.from,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
    cc: payload.cc,
    bcc: payload.bcc,
    replyTo: payload.replyTo,
    attachments: payload.attachments,
    rfcMessageId: payload.rfcMessageId,
  });
}
