import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ claim: vi.fn(), find: vi.fn(), update: vi.fn(), tx: vi.fn(), get: vi.fn(), lock: vi.fn(), latest: vi.fn(), persisted: vi.fn(), suppress: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { outboundMessage: { updateMany: mocks.claim, findUniqueOrThrow: mocks.find, update: mocks.update }, $transaction: mocks.tx } }));
vi.mock("@/lib/stalwart/client", () => ({ getSubmissionDelivery: mocks.get }));
import { refreshOutbound } from "./delivery";
const record = { id: "tracked", accountId: "account", submissionId: "submission", organizationId: "org", recipients: { to: ["one@example.com", "two@example.com"], cc: [], bcc: [] }, deliveryJson: null };
beforeEach(() => {
  vi.clearAllMocks(); mocks.claim.mockResolvedValue({ count: 1 }); mocks.find.mockResolvedValue(record);
  mocks.get.mockResolvedValue({ ok: true, deliveryStatus: { "one@example.com": { delivered: "unknown", smtpReply: "250 Queued" }, "two@example.com": { delivered: "queued" } } });
  mocks.latest.mockResolvedValue({ ...record, deliveryJson: { "one@example.com": { source: "smtp", state: "ACCEPTED", smtpReply: "250 remote final OK", observedAt: new Date().toISOString() } } });
  mocks.tx.mockImplementation(fn => fn({ $queryRaw: mocks.lock, outboundMessage: { findUniqueOrThrow: mocks.latest, update: mocks.persisted }, mailSuppression: { upsert: mocks.suppress } }));
});
it("merges against the latest locked record so a concurrent receipt is never overwritten", async () => {
  await refreshOutbound("tracked");
  expect(mocks.lock).toHaveBeenCalled();
  expect(mocks.persisted).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ deliveryJson: {
    "one@example.com": expect.objectContaining({ source: "smtp", state: "ACCEPTED", smtpReply: "250 remote final OK" }), "two@example.com": { delivered: "queued" },
  } }) }));
});
it("does not query ephemeral submission state when all recipients already have durable proofs", async () => {
  mocks.find.mockResolvedValue({ ...record, deliveryJson: { "one@example.com": { source: "smtp", state: "ACCEPTED" }, "two@example.com": { source: "dsn", state: "BOUNCED" } } });
  await refreshOutbound("tracked"); expect(mocks.get).not.toHaveBeenCalled();
});
it("respects a lease held by another worker", async () => {
  mocks.claim.mockResolvedValue({ count: 0 }); await refreshOutbound("tracked"); expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.find).not.toHaveBeenCalled();
});
