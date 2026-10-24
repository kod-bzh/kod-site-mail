vi.mock("./webhook-authorization", () => ({ webhookAuthorized: () => true }));
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ due: vi.fn(), claim: vi.fn(), find: vi.fn(), update: vi.fn(), retry: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { mailWebhookAttempt: { findMany: mocks.due, updateMany: mocks.claim, findUnique: mocks.find, update: mocks.update } } }));
vi.mock("@/lib/crypto/seal", () => ({ unsealSecret: () => "test-signing-secret" }));
vi.mock("./webhook-http", () => ({ postWebhook: mocks.post }));
import { pollMailWebhooks } from "./webhooks";
import { signWebhook } from "./receipt-signature";
beforeEach(() => {
  vi.clearAllMocks(); mocks.due.mockResolvedValue([{ id: "attempt" }]); mocks.claim.mockResolvedValue({ count: 1 });
  mocks.find.mockResolvedValue({ id: "attempt", attempts: 0, createdAt: new Date(), webhook: { url: "https://example.com/hooks", secretCipher: "cipher" },
    event: { id: "stable-event-id", messageId: "tracked", occurredAt: new Date(), data: { type: "smtp.accepted", rfcMessageId: "rfc@example.org", from: "from@example.org", recipient: "recipient@example.com", smtpReply: "250 OK", remoteMta: "mx.example.com" }, message: { submissionId: "submission", fromAddress: "from@example.org", recipients: { to: ["recipient@example.com"], cc: [], bcc: [] } } } });
  mocks.post.mockResolvedValue(204);
});
it("signs stable event identifiers and only acknowledges successful delivery", async () => {
  await pollMailWebhooks();
  const [, body, headers] = mocks.post.mock.calls[0];
  expect(headers["X-Kod-Event-Id"]).toBe("stable-event-id");
  expect(headers["X-Kod-Signature"]).toBe(signWebhook("test-signing-secret", headers["X-Kod-Timestamp"], body));
  expect(JSON.parse(body)).toMatchObject({ type: "email.accepted", data: { trackingId: "tracked", recipient: "recipient@example.com" } });
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ completedAt: expect.any(Date), lastStatus: 204 }) }));
});
it("retains a failed notification for retry without resending the email", async () => {
  mocks.post.mockResolvedValue(503); await pollMailWebhooks();
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.claim).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastStatus: 503, nextAttempt: expect.any(Date), attempts: { increment: 1 } }) }));
});
it("does not send when another worker holds the lease", async () => {
  mocks.claim.mockResolvedValue({ count: 0 }); await pollMailWebhooks(); expect(mocks.post).not.toHaveBeenCalled();
});

it("signs telemetry notifications with the same durable delivery contract", async () => {
  mocks.find.mockResolvedValue({ id: "attempt", attempts: 0, createdAt: new Date(), webhook: { url: "https://example.com/hooks", secretCipher: "cipher" }, event: null,
    telemetryEvent: { id: "mdn-stable", type: "email.mdn", domain: "example.org", messageId: "tracked", recipient: "recipient@example.com", occurredAt: new Date(), receivedAt: new Date(), source: "rfc8098", reliability: "unverified_report", data: { disposition: "displayed" } } });
  await pollMailWebhooks(); const [, body, headers] = mocks.post.mock.calls[0];
  expect(JSON.parse(body)).toMatchObject({ id: "mdn-stable", type: "email.mdn", reliability: "unverified_report", data: { details: { disposition: "displayed" } } });
  expect(headers["X-Kod-Signature"]).toBe(signWebhook("test-signing-secret", headers["X-Kod-Timestamp"], body));
});
