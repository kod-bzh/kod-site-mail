import { afterEach, expect, it, vi } from "vitest";
import { receiptKey, signWebhook, verifyReceiptSignature } from "./receipt-signature";
afterEach(() => vi.unstubAllEnvs());
it("authenticates exact bytes and rejects tampering and replay outside five minutes", () => {
  vi.stubEnv("STALWART_API_KEY", "test-only-master");
  const timestamp = String(Math.floor(Date.now() / 1000)), body = '{"events":[]}';
  const signature = signWebhook(receiptKey()!, timestamp, body);
  expect(verifyReceiptSignature(timestamp, signature, body)).toBe(true);
  expect(verifyReceiptSignature(timestamp, signature, body + " ")).toBe(false);
  expect(verifyReceiptSignature(timestamp, signature, body, Date.now() + 301_000)).toBe(false);
  expect(verifyReceiptSignature(timestamp, signature.slice(1), body)).toBe(false);
  vi.stubEnv("STALWART_API_KEY", "different-key");
  expect(verifyReceiptSignature(timestamp, signature, body)).toBe(false);
});
