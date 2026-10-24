import { safeMessage } from "./telemetry";
import { webhookAuthorized } from "./webhook-authorization";
import { prisma } from "@/lib/prisma";
import { unsealSecret } from "@/lib/crypto/seal";
import { postWebhook } from "./webhook-http";
import { signWebhook } from "./receipt-signature";
import { type DeliveryReceipt } from "./receipts";

export const WEBHOOK_RETRIES = [10, 60, 300, 900, 3600, 7200, 14400, 21600, 21600, 21600, 21600, 21600];
export async function pollMailWebhooks(): Promise<void> {
  const now = new Date();
  const due = await prisma.mailWebhookAttempt.findMany({ where: { completedAt: null, nextAttempt: { lte: now },
    OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, orderBy: { nextAttempt: "asc" }, take: 25, select: { id: true } });
  for (const job of due) {
    const claim = await prisma.mailWebhookAttempt.updateMany({ where: { id: job.id, completedAt: null,
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { leaseUntil: new Date(Date.now() + 60_000) } });
    if (!claim.count) continue;
    const item = await prisma.mailWebhookAttempt.findUnique({ where: { id: job.id }, include: { webhook: true, event: { include: { message: true } }, telemetryEvent: true } });
    if (!item) continue;
    if (item.attempts >= WEBHOOK_RETRIES.length || Date.now() - item.createdAt.getTime() >= 86400_000) {
      await prisma.mailWebhookAttempt.update({ where: { id: item.id }, data: { completedAt: new Date(), leaseUntil: null, lastError: "Notification expirée ; le suivi reste disponible par GET" } });
      continue;
    }
    let lastStatus: number | null = null;
    try {
      const secret = unsealSecret(item.webhook.secretCipher); if (!secret) throw Error("Signing unavailable");
      const telemetry = item.telemetryEvent;
      const domain = telemetry?.domain ?? item.event?.message.fromAddress.split("@")[1] ?? "";
      if (!await webhookAuthorized(item.webhook, telemetry ? "deliverability:read" : "mail:send", domain)) {
        await prisma.mailWebhookAttempt.update({ where: { id: item.id }, data: { completedAt: new Date(), leaseUntil: null, lastError: "Autorisation du webhook révoquée ou périmètre retiré" } });
        continue;
      }
      const delivery = item.event;
      if (!telemetry && !delivery) throw Error("Missing event");
      let eventId: string, payload: unknown;
      if (telemetry) {
        eventId = telemetry.id;
        payload = { id: telemetry.id, type: telemetry.type, occurredAt: telemetry.occurredAt, receivedAt: telemetry.receivedAt,
          source: telemetry.source, scope: telemetry.messageId ? "message" : "domain", reliability: telemetry.reliability,
          data: { domain: telemetry.domain, trackingId: telemetry.messageId, recipient: telemetry.recipient, details: telemetry.data } };
      } else {
        const event = delivery!.data as DeliveryReceipt;
        const recipients = delivery!.message.recipients as { bcc?: string[] } | undefined;
        const hidden = recipients?.bcc?.includes(event.recipient);
        eventId = delivery!.id;
        payload = { id: eventId, type: event.type.replace(/^smtp\./, "email.").replace(/^mail\./, "email."),
          occurredAt: delivery!.occurredAt.toISOString(), data: { trackingId: delivery!.messageId,
            submissionId: delivery!.message.submissionId, rfcMessageId: event.rfcMessageId,
            from: event.from, recipient: hidden ? null : event.recipient, smtpReply: hidden ? null : event.smtpReply, remoteMta: event.remoteMta } };
      }
      if (delivery) {
        const sanitized = safeMessage({ ...(payload as Record<string, unknown>), recipients: delivery.message.recipients }) as Record<string, unknown>;
        delete sanitized.recipients; payload = sanitized;
      }
      const body = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      lastStatus = await postWebhook(item.webhook.url, body, { "X-Kod-Event-Id": eventId,
        "X-Kod-Timestamp": timestamp, "X-Kod-Signature": signWebhook(secret, timestamp, body) });
      if (lastStatus < 200 || lastStatus >= 300) throw Error("Destination unavailable");
      await prisma.mailWebhookAttempt.update({ where: { id: item.id }, data: { completedAt: new Date(), leaseUntil: null, attempts: { increment: 1 }, lastStatus, lastError: null } });
    } catch {
      // No response body or URL credentials in logs/database. Delivery can be duplicated on an uncertain acknowledgement.
      await prisma.mailWebhookAttempt.updateMany({ where: { id: item.id }, data: { leaseUntil: null, attempts: { increment: 1 }, lastStatus,
        lastError: "Notification non confirmée ; nouvel essai prévu", nextAttempt: new Date(Date.now() + WEBHOOK_RETRIES[Math.min(item.attempts, WEBHOOK_RETRIES.length - 1)] * 1000) } });
    }
  }
}
