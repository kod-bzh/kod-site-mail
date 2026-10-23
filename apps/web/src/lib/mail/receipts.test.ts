import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), find: vi.fn(), latest: vi.fn(), lock: vi.fn(), event: vi.fn(), create: vi.fn(), update: vi.fn(), hooks: vi.fn(), attempts: vi.fn(), suppression: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));
import { applyReceipt, ingestReceipt, type DeliveryReceipt } from "./receipts";
import { aggregateDelivery, recipientState } from "./delivery-status";
const event: DeliveryReceipt = { id: "a".repeat(64), type: "smtp.accepted", from: "sender@example.org", recipient: "one@example.com",
  rfcMessageId: "unique@example.org", occurredAt: new Date().toISOString(), remoteMta: "mx.example.com", smtpReply: "250 2.0.0 OK", queueId: "336535801972610561" };
describe("durable delivery receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const record = { id: "tracked", fromAddress: event.from, recipients: { to: [event.recipient], cc: [], bcc: [] }, organizationId: "org", initiatorId: "key", deliveryJson: null };
    mocks.find.mockResolvedValue(record); mocks.latest.mockResolvedValue(record); mocks.event.mockResolvedValue(null);
    mocks.hooks.mockResolvedValue([{ id: "hook" }]);
    mocks.transaction.mockImplementation(fn => fn({ outboundMessage: { findUnique: mocks.find, findUniqueOrThrow: mocks.latest, update: mocks.update },
      $queryRaw: mocks.lock, mailDeliveryEvent: { findUnique: mocks.event, create: mocks.create }, mailWebhook: { findMany: mocks.hooks }, mailWebhookAttempt: { createMany: mocks.attempts }, mailSuppression: { upsert: mocks.suppression } }));
  });
  it("persists the remote reply and schedules notification for the sending key only", async () => {
    expect(await ingestReceipt(event)).toBe(true);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ACCEPTED" }) }));
    expect(mocks.hooks).toHaveBeenCalledWith({ where: { organizationId: "org", initiatorId: "key" }, select: { id: true } });
    expect(mocks.attempts).toHaveBeenCalledWith({ data: [{ webhookId: "hook", eventId: event.id }], skipDuplicates: true });
  });
  it("ignores retries without issuing another notification", async () => {
    mocks.event.mockResolvedValue({ id: event.id });
    expect(await ingestReceipt(event)).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.attempts).not.toHaveBeenCalled();
  });
  it("refuses cross-message sender and recipient injection", async () => {
    expect(await ingestReceipt({ ...event, from: "other@example.org" })).toBe(false);
    expect(await ingestReceipt({ ...event, recipient: "other@example.com" })).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("does not accept a queued/synthetic or error response as remote acceptance", async () => {
    await expect(ingestReceipt({ ...event, remoteMta: "" })).rejects.toThrow();
    await expect(ingestReceipt({ ...event, smtpReply: "450 later" })).rejects.toThrow();
  });
  it("preserves acceptance evidence through a late bounce and replay", () => {
    const accepted = applyReceipt({}, event);
    expect(recipientState(accepted)).toBe("ACCEPTED");
    const bounced = applyReceipt(accepted, { ...event, type: "mail.bounced", occurredAt: new Date(Date.now() + 1000).toISOString(), smtpReply: "550 5.1.1 unavailable" });
    expect(recipientState(bounced)).toBe("BOUNCED"); expect(bounced.acceptedAt).toBe(event.occurredAt);
    expect(recipientState(applyReceipt(bounced, event))).toBe("BOUNCED");
  });
  it("keeps independently accepted recipients when another recipient fails", () => {
    expect(aggregateDelivery({ a: applyReceipt({}, event), b: applyReceipt({}, { ...event, type: "smtp.failed" }) }, ["a", "b"])).toBe("PARTIAL");
  });
  it("rejects stale and future events", async () => {
    for (const date of [Date.now() - 9 * 86400_000, Date.now() + 600_000]) await expect(ingestReceipt({ ...event, occurredAt: new Date(date).toISOString() })).rejects.toThrow();
  });
});
