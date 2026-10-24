import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const DELIVERY_EVENT_TYPES = ["email.accepted", "email.failed", "email.deferred", "email.bounced"] as const;
export const TELEMETRY_TYPES = ["email.complaint", "email.mdn", "deliverability.incident.opened", "deliverability.incident.resolved"] as const;
export const MAIL_WEBHOOK_TYPES = [...DELIVERY_EVENT_TYPES, ...TELEMETRY_TYPES] as const;
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type Tx = Prisma.TransactionClient;
export async function appendTelemetry(tx: Tx, input: {
  id: string; organizationId: string; domain: string; messageId?: string | null; recipient?: string | null;
  initiatorId?: string; type: string; source: string; reliability: string; occurredAt: Date; data: Prisma.InputJsonValue;
}) {
  const { initiatorId, ...data } = input;
  const inserted = await tx.mailTelemetryEvent.createMany({ data: [data], skipDuplicates: true });
  if (!inserted.count) return false;
  // Org incidents require a dedicated read scope at subscription time. Feedback stays with its sending key.
  const hooks = await tx.mailWebhook.findMany({ where: { organizationId: input.organizationId,
    eventTypes: { has: input.type }, OR: [{ allowedDomains: { isEmpty: true } }, { allowedDomains: { has: input.domain } }], ...(input.messageId ? { initiatorId: initiatorId ?? "unavailable" } : {}) }, select: { id: true } });
  if (hooks.length) await tx.mailWebhookAttempt.createMany({ data: hooks.map(hook => ({ webhookId: hook.id, telemetryEventId: input.id })), skipDuplicates: true });
  return true;
}
export async function setIncident(input: {
  organizationId: string; domain: string; code: string; active: boolean | null; severity?: string;
  summary: string; action: string; evidence: Prisma.InputJsonValue;
}) {
  if (input.active === null) return; // Failed observation cannot resolve an existing incident.
  const fingerprint = digest([input.domain, input.code]);
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${input.organizationId} FOR UPDATE`;
    const previous = await tx.mailIncident.findUnique({ where: { organizationId_fingerprint: { organizationId: input.organizationId, fingerprint } } });
    if (!previous && !input.active) return;
    const changed = !previous || (previous.status === "open") !== input.active;
    const now = new Date(), generation = (previous?.generation ?? 0) + (input.active && changed ? 1 : 0);
    const fields = { domain: input.domain, code: input.code, severity: input.severity ?? "warning", summary: input.summary,
      action: input.action, evidence: input.evidence, observedAt: now, status: input.active ? "open" : "resolved",
      resolvedAt: input.active ? null : previous?.status === "resolved" ? previous.resolvedAt ?? now : now, generation };
    const incident = await tx.mailIncident.upsert({ where: { organizationId_fingerprint: { organizationId: input.organizationId, fingerprint } },
      create: { organizationId: input.organizationId, fingerprint, ...fields }, update: { ...fields, ...(input.active && changed ? { openedAt: now } : {}) } });
    if (changed) await appendTelemetry(tx, { id: digest([incident.id, generation, incident.status]), organizationId: input.organizationId,
      domain: input.domain, type: `deliverability.incident.${input.active ? "opened" : "resolved"}`, source: "kod_monitor", reliability: "observed",
      occurredAt: now, data: { incidentId: incident.id, code: input.code, status: incident.status, summary: input.summary, action: input.action, evidence: input.evidence } });
  });
}
export function safeMessage(message: { recipients: unknown; deliveryJson?: unknown; [key: string]: unknown }) {
  const recipients = message.recipients as { to?: string[]; cc?: string[]; bcc?: string[] };
  const hidden = new Set((recipients.bcc ?? []).map(address => address.toLowerCase()));
  const visible = new Set([...(recipients.to ?? []), ...(recipients.cc ?? [])]);
  const redact = (value: unknown): unknown => {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    if (typeof value === "string") { for (const address of hidden) value = (value as string).replace(new RegExp(address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[hidden]"); return value; }
    if (Array.isArray(value)) return value.filter(row => !row?.recipient || visible.has(row.recipient)).map(redact);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !hidden.has(key.toLowerCase()) && key !== "bcc").map(([key, item]) => [key, redact(item)]));
    return value;
  };
  const events = Array.isArray(message.telemetryEvents) ? message.telemetryEvents as { id: string; type: string; recipient: string | null; occurredAt: unknown; receivedAt: unknown; reliability: string; source: string; data: unknown }[] : [];
  const receipts = events.filter(event => event.type === "email.mdn");
  const readReceipt = "requestReadReceipt" in message ? { requestMade: message.requestReadReceipt === true,
    requestedAt: message.requestReadReceipt ? message.createdAt ?? null : null,
    submissionConfirmed: !!message.submissionId, receiptReceived: receipts.length ? true : null,
    absenceReason: receipts.length ? null : "no_receipt_observed_or_history_not_loaded", humanReading: null,
    receipts: receipts.map(event => ({ evidenceRef: event.id, recipient: event.recipient, receivedAt: event.receivedAt,
      dispositionReportedAt: null, source: event.source, reliability: event.reliability, report: event.data })) } : undefined;
  return redact({ ...message, ...(readReceipt ? { readReceipt } : {}), recipients: { to: recipients.to ?? [], cc: recipients.cc ?? [] } });
}
