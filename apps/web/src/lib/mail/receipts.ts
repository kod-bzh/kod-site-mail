import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { aggregateDelivery, permanentAddressFailure, type RecipientDelivery } from "./delivery-status";

export const receiptSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  type: z.enum(["smtp.accepted", "smtp.failed", "smtp.deferred", "mail.bounced"]),
  rfcMessageId: z.string().min(3).max(320), from: z.string().email(), recipient: z.string().email(),
  reliability: z.enum(["observed_smtp", "unverified_report", "authenticated_domain_report"]).optional(),
  occurredAt: z.string().datetime({ offset: true }), queueId: z.string().regex(/^\d{1,20}$/).optional(),
  remoteMta: z.string().max(255).default(""), smtpReply: z.string().max(2100),
});
export type DeliveryReceipt = z.infer<typeof receiptSchema>;

export function applyReceipt(current: RecipientDelivery, event: DeliveryReceipt): RecipientDelivery {
  // SMTP acceptance remains evidence even if a later failure is reported.
  const result = { ...current };
  if (event.type === "smtp.accepted") result.acceptedAt ??= event.occurredAt;
  if (current.observedAt && new Date(current.observedAt) > new Date(event.occurredAt)) return result;
  // An old/replayed acceptance cannot erase a later bounce.
  if (current.source === "dsn" && event.type !== "mail.bounced") return result;
  return { ...result, source: event.type === "mail.bounced" ? "dsn" : "smtp",
    state: event.type === "smtp.accepted" ? "ACCEPTED" : event.type === "mail.bounced" ? "BOUNCED" : event.type === "smtp.failed" ? "FAILED" : "QUEUED",
    reliability: event.type === "mail.bounced" ? event.reliability ?? "unverified_report" : "observed_smtp",
    observedAt: event.occurredAt, evidenceId: event.id, remoteMta: event.remoteMta,
    smtpReply: event.smtpReply, ...(event.queueId ? { queueId: event.queueId } : {}),
    delivered: event.type === "smtp.failed" || event.type === "mail.bounced" ? "no" : event.type === "smtp.deferred" ? "queued" : "unknown" };
}

export async function ingestReceipt(event: DeliveryReceipt): Promise<boolean> {
  if (event.type === "smtp.accepted" && (!/^2\d\d\b/.test(event.smtpReply) || !event.remoteMta)) throw Error("Invalid acceptance evidence");
  const occurredAt = new Date(event.occurredAt);
  if (occurredAt.getTime() > Date.now() + 300_000 || occurredAt.getTime() < Date.now() - 8 * 86400_000) throw Error("Receipt outside retention window");
  return prisma.$transaction(async tx => {
    const record = await tx.outboundMessage.findUnique({ where: { rfcMessageId: event.rfcMessageId } });
    if (!record || record.fromAddress !== event.from.toLowerCase()) return false;
    const recipients = record.recipients as { to: string[]; cc: string[]; bcc: string[] };
    const addresses = [...recipients.to, ...recipients.cc, ...recipients.bcc];
    const recipient = event.recipient.toLowerCase();
    if (!addresses.includes(recipient)) return false;
    await tx.$queryRaw`SELECT id FROM "OutboundMessage" WHERE id=${record.id} FOR UPDATE`;
    if (await tx.mailDeliveryEvent.findUnique({ where: { id: event.id } })) return false;
    const latest = await tx.outboundMessage.findUniqueOrThrow({ where: { id: record.id } });
    const stored = (latest.deliveryJson ?? {}) as Record<string, RecipientDelivery>;
    const delivery = { ...stored, [recipient]: applyReceipt(stored[recipient] ?? {}, event) };
    await tx.mailDeliveryEvent.create({ data: { id: event.id, messageId: record.id, recipient, type: event.type, occurredAt,
      data: event as Prisma.InputJsonValue } });
    await tx.outboundMessage.update({ where: { id: record.id }, data: { deliveryJson: delivery as Prisma.InputJsonValue,
      status: aggregateDelivery(delivery, addresses), lastError: null } });
    if (permanentAddressFailure(delivery[recipient])) await tx.mailSuppression.upsert({
      where: { organizationId_address: { organizationId: record.organizationId, address: recipient } },
      create: { organizationId: record.organizationId, address: recipient, reason: "hard_bounce", source: event.type === "mail.bounced" ? "dsn_report" : "smtp_receipt" }, update: {},
    });
    const eventType = event.type.replace(/^smtp\./, "email.").replace(/^mail\./, "email.");
    const hooks = await tx.mailWebhook.findMany({ where: { organizationId: record.organizationId, initiatorId: record.initiatorId,
      AND: [{ OR: [{ eventTypes: { isEmpty: true } }, { eventTypes: { has: eventType } }] },
        { OR: [{ allowedDomains: { isEmpty: true } }, { allowedDomains: { has: record.fromAddress.split("@")[1] } }] }] }, select: { id: true } });
    if (hooks.length) await tx.mailWebhookAttempt.createMany({ data: hooks.map(hook => ({ webhookId: hook.id, eventId: event.id })), skipDuplicates: true });
    return true;
  }, { timeout: 15_000 });
}

export function dsnEventId(messageId: string, recipient: string, reply: string) {
  return createHash("sha256").update(`dsn:${messageId}:${recipient}:${reply}`).digest("hex");
}
