import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSubmissionDelivery } from "@/lib/stalwart/client";
import { aggregateDelivery, permanentAddressFailure, type RecipientDelivery } from "./delivery-status";

function limit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
export const MAIL_LIMIT_DEFAULTS = { minute: 20, dailyRecipients: 200 };
export class MailPolicyError extends Error {
  constructor(public code: "recipient_suppressed" | "rate_limited", message: string) { super(message); }
}
export async function reserveOutbound(input: {
  organizationId: string; accountId: string; fromAddress: string; subject: string;
  recipients: { to: string[]; cc: string[]; bcc: string[] }; initiatorId?: string;
}) {
  const addresses = [...input.recipients.to, ...input.recipients.cc, ...input.recipients.bcc];
  return prisma.$transaction(async tx => {
    // A row lock serializes all senders/pods for this organization, not only this process.
    await tx.$executeRaw`INSERT INTO "MailSendBudget" ("organizationId") VALUES (${input.organizationId}) ON CONFLICT DO NOTHING`;
    await tx.$queryRaw`SELECT "organizationId" FROM "MailSendBudget" WHERE "organizationId" = ${input.organizationId} FOR UPDATE`;
    const suppressed = await tx.mailSuppression.findFirst({ where: { organizationId: input.organizationId, address: { in: addresses } } });
    if (suppressed) throw new MailPolicyError("recipient_suppressed", `Destinataire bloqué : ${suppressed.address} (${suppressed.reason}). Aucun envoi effectué.`);
    const now = Date.now();
    const minuteCount = await tx.outboundMessage.count({ where: { organizationId: input.organizationId, createdAt: { gte: new Date(now - 60_000) } } });
    const day = await tx.outboundMessage.aggregate({ where: { organizationId: input.organizationId, createdAt: { gte: new Date(now - 86_400_000) } }, _sum: { recipientCount: true } });
    if (minuteCount >= limit("MAIL_SEND_MINUTE_LIMIT", MAIL_LIMIT_DEFAULTS.minute) || (day._sum.recipientCount ?? 0) + addresses.length > limit("MAIL_SEND_DAILY_RECIPIENT_LIMIT", MAIL_LIMIT_DEFAULTS.dailyRecipients)) {
      throw new MailPolicyError("rate_limited", "Limite progressive atteinte. Réessayer plus tard ; aucun envoi effectué.");
    }
    return tx.outboundMessage.create({ data: {
      ...input, initiatorId: input.initiatorId ?? "admin", recipients: input.recipients,
      recipientCount: addresses.length, rfcMessageId: `${randomUUID()}@${input.fromAddress.split("@")[1]}`,
    } });
  }, { maxWait: 10_000, timeout: 15_000 });
}
export async function refreshOutbound(id: string): Promise<void> {
  const now = new Date();
  const claim = await prisma.outboundMessage.updateMany({ where: { id, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseUntil: new Date(Date.now() + 60_000) } });
  if (!claim.count) return;
  try {
    const message = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
    if (!message.submissionId) return;
    const recipients = message.recipients as { to: string[]; cc: string[]; bcc: string[] };
    const expected = [...recipients.to, ...recipients.cc, ...recipients.bcc];
    const evidence = (message.deliveryJson ?? {}) as Record<string, RecipientDelivery>;
    if (expected.length && expected.every(address => evidence[address]?.source && evidence[address].state !== "QUEUED")) {
      await prisma.outboundMessage.update({ where: { id }, data: { nextCheckAt: new Date(Date.now() + 10 * 60_000), lastError: null } });
      return;
    }
    const result = await getSubmissionDelivery(message.accountId, message.submissionId);
    if (!result.ok) throw new Error(result.detail);
    const stored = message.recipients as { to: string[]; cc: string[]; bcc: string[] };
    const addresses = [...stored.to, ...stored.cc, ...stored.bcc];
    const known = Object.fromEntries(Object.entries(result.deliveryStatus ?? {}).map(([email, status]) => [email.toLowerCase(), status]));
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "OutboundMessage" WHERE id=${message.id} FOR UPDATE`;
      const latest = await tx.outboundMessage.findUniqueOrThrow({ where: { id: message.id } });
      const stored = (latest.deliveryJson ?? {}) as Record<string, RecipientDelivery>;
      // A synthetic JMAP "Queued" reply must never overwrite a durable SMTP/DSN receipt.
      const delivery = Object.fromEntries(addresses.map(email => [email, stored[email]?.source ? stored[email] : known[email] ?? {}])) as Record<string, RecipientDelivery>;
      for (const address of addresses) if (permanentAddressFailure(delivery[address])) {
        await tx.mailSuppression.upsert({ where: { organizationId_address: { organizationId: message.organizationId, address } }, create: { organizationId: message.organizationId, address, reason: "hard_bounce", source: "stalwart_delivery_status" }, update: {} });
      }
      await tx.outboundMessage.update({ where: { id }, data: {
        status: aggregateDelivery(delivery, addresses), deliveryJson: delivery as Prisma.InputJsonValue,
        lastError: null, nextCheckAt: new Date(Date.now() + 10 * 60_000),
      } });
    });
  } catch (error) {
    await prisma.outboundMessage.update({ where: { id }, data: { lastError: (error instanceof Error ? error.message : "Vérification indisponible").slice(0, 1000), nextCheckAt: new Date(Date.now() + 120_000) } });
  } finally {
    await prisma.outboundMessage.update({ where: { id }, data: { leaseUntil: null } });
  }
}
export async function pollOutbound(): Promise<void> {
  // "unknown" can become a late DSN failure. Keep observing accepted submissions for seven days.
  const messages = await prisma.outboundMessage.findMany({ where: {
    submissionId: { not: null }, status: { in: ["SUBMITTED", "QUEUED", "ACCEPTED", "UNKNOWN", "PARTIAL"] },
    nextCheckAt: { lte: new Date() }, createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) },
    OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
  }, select: { id: true }, orderBy: { nextCheckAt: "asc" }, take: 25 });
  for (const message of messages) await refreshOutbound(message.id);
  await prisma.mailMonitorState.upsert({ where: { id: "delivery" }, create: { id: "delivery" }, update: { checkedAt: new Date(), lastError: null } });
  await prisma.outboundMessage.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 90 * 86_400_000) } } });
  await prisma.dmarcReport.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 90 * 86_400_000) } } });
  // No replay: a process crash during submission must not trigger a duplicate email.
  await prisma.outboundMessage.updateMany({ where: { status: "RESERVED", createdAt: { lt: new Date(Date.now() - 5 * 60_000) } }, data: { status: "UNKNOWN", lastError: "Soumission interrompue : statut inconnu. Aucun renvoi automatique." } });
}
