import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ ingest: vi.fn() }));
vi.mock("@/lib/mail/receipts", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/mail/receipts")>(), ingestReceipt: mocks.ingest }));
import { POST } from "./route";
import { receiptKey, signWebhook } from "@/lib/mail/receipt-signature";
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("STALWART_API_KEY", "test-only-key"); });
const body = JSON.stringify({ events: [{ id: "a".repeat(64), type: "smtp.accepted", rfcMessageId: "rfc@example.org", from: "sender@example.org", recipient: "recipient@example.com", occurredAt: new Date().toISOString(), remoteMta: "mx.example.com", smtpReply: "250 OK", queueId: "123456789012345678" }] });
function req(text = body) { const timestamp = String(Math.floor(Date.now() / 1000)); return new Request("https://kod.bzh/api/internal/mail/receipts", { method: "POST", body: text, headers: { "X-Kod-Timestamp": timestamp, "X-Kod-Signature": signWebhook(receiptKey()!, timestamp, text) } }); }
it("rejects unauthenticated and altered receipts before database access", async () => {
  expect((await POST(new Request("https://kod.bzh/api/internal/mail/receipts", { method: "POST", body }))).status).toBe(401);
  const altered = req(); altered.headers.set("X-Kod-Signature", "v1=" + "0".repeat(64));
  expect((await POST(altered)).status).toBe(401); expect(mocks.ingest).not.toHaveBeenCalled();
});
it("acknowledges only persisted receipts and lets the bridge retry database failures", async () => {
  expect((await POST(req())).status).toBe(200);
  mocks.ingest.mockRejectedValue(Error("offline")); expect((await POST(req())).status).toBe(503);
});
it("rejects signed malformed requests", async () => {
  expect((await POST(req('{"events":[{}]}'))).status).toBe(400);
  expect((await POST(req("x".repeat(1_000_001)))).status).toBe(413);
});
