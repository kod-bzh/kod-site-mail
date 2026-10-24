import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ find: vi.fn(), upsert: vi.fn(), create: vi.fn(), hooks: vi.fn(), attempts: vi.fn(), lock: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: (fn: (tx: object) => unknown) => fn({ $queryRaw: mocks.lock,
  mailIncident: { findUnique: mocks.find, upsert: mocks.upsert }, mailTelemetryEvent: { createMany: mocks.create },
  mailWebhook: { findMany: mocks.hooks }, mailWebhookAttempt: { createMany: mocks.attempts } }) } }));
import { appendTelemetry, setIncident, safeMessage } from "./telemetry";
import type { Tx } from "./telemetry";
beforeEach(() => { vi.clearAllMocks(); mocks.find.mockResolvedValue(null); mocks.upsert.mockImplementation(({ create, update }) => ({ id: "incident", ...create, ...update }));
  mocks.create.mockResolvedValue({ count: 1 }); mocks.hooks.mockResolvedValue([{ id: "hook" }]); });
const incident = { organizationId: "org-a", domain: "example.org", code: "collector:google", active: true, summary: "Unavailable", action: "Renew", evidence: { state: "authorization_required" } };
it("only creates incident notifications for transitions, never for a repeated or unknown observation", async () => {
  await setIncident(incident); expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.create.mock.calls[0][0].data[0]).toMatchObject({ organizationId: "org-a", type: "deliverability.incident.opened", domain: "example.org" });
  mocks.find.mockResolvedValue({ id: "incident", status: "open", generation: 1 });
  await setIncident(incident); await setIncident({ ...incident, active: null }); expect(mocks.create).toHaveBeenCalledTimes(1);
  await setIncident({ ...incident, active: false }); expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(mocks.create.mock.calls[1][0].data[0].type).toBe("deliverability.incident.resolved");
  mocks.find.mockResolvedValue({ id: "incident", status: "resolved", generation: 1 }); await setIncident(incident);
  expect(mocks.create.mock.calls[2][0].data[0].id).not.toBe(mocks.create.mock.calls[0][0].data[0].id);
});
it("deduplicates a durable event before queueing any callback and restricts subscription scope", async () => {
  const tx = { mailTelemetryEvent: { createMany: mocks.create }, mailWebhook: { findMany: mocks.hooks }, mailWebhookAttempt: { createMany: mocks.attempts } } as unknown as Tx;
  const input = { id: "stable", organizationId: "org-a", domain: "example.org", messageId: "message-a", recipient: "user@example.net", initiatorId: "key-a", type: "email.mdn", source: "rfc8098", reliability: "unverified_report", occurredAt: new Date(), data: {} };
  await appendTelemetry(tx, input); expect(mocks.hooks).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: "org-a", initiatorId: "key-a", eventTypes: { has: "email.mdn" }, OR: [{ allowedDomains: { isEmpty: true } }, { allowedDomains: { has: "example.org" } }] }) }));
  mocks.create.mockResolvedValue({ count: 0 }); await appendTelemetry(tx, input); expect(mocks.attempts).toHaveBeenCalledTimes(1);
});
it("redacts Bcc addresses from recipient maps, nested evidence and hidden recipient events", () => {
  const safe = safeMessage({ recipients: { to: ["visible@example.net"], cc: [], bcc: ["hidden@example.net"] },
    deliveryJson: { "hidden@example.net": { smtpReply: "550 hidden@example.net" }, "visible@example.net": { smtpReply: "250 OK" } },
    events: [{ recipient: "hidden@example.net", data: {} }, { recipient: "visible@example.net", data: {} }], lastError: "HIDDEN@EXAMPLE.NET failed", diagnostics: { "Hidden@Example.Net": "550 error" } });
  expect(JSON.stringify(safe).toLowerCase()).not.toContain("hidden@example.net"); expect(JSON.stringify(safe)).not.toContain('"bcc"'); expect(JSON.stringify(safe)).toContain("visible@example.net");
  const literal = safeMessage({ recipients: { bcc: ["hidden+tag@example.net"] }, lastError: "HIDDEN+TAG@EXAMPLE.NET failed; hiddenntag@example.net is another address" });
  expect(literal).toMatchObject({ lastError: "[hidden] failed; hiddenntag@example.net is another address" });
  const date = new Date("2026-10-24T11:29:56.800Z");
  const dated = safeMessage({ recipients: { to: ["visible@example.net"] }, requestReadReceipt: true, createdAt: date,
    telemetryEvents: [{ id: "mdn", type: "email.mdn", recipient: "visible@example.net", occurredAt: date, receivedAt: date }], invalidDate: new Date(NaN) }) as { createdAt: string; readReceipt: { requestedAt: string; receipts: { receivedAt: string }[] }; invalidDate: null };
  expect(dated.createdAt).toBe(date.toISOString()); expect(dated.readReceipt.requestedAt).toBe(date.toISOString());
  expect(dated.readReceipt.receipts[0].receivedAt).toBe(date.toISOString()); expect(dated.invalidDate).toBeNull();
});

it("keeps the real resolution date stable across unchanged checks so retention can expire", async () => {
  const resolvedAt = new Date(Date.now() - 86400000);
  mocks.find.mockResolvedValue({ id: "incident", status: "resolved", generation: 1, resolvedAt });
  await setIncident({ ...incident, active: false });
  expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ resolvedAt }) }));
  expect(mocks.create).not.toHaveBeenCalled();
});
