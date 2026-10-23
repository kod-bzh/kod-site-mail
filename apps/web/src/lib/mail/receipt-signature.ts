import { createHmac, timingSafeEqual } from "node:crypto";

export function receiptKey(): Buffer | null {
  const master = process.env.STALWART_API_KEY;
  return master ? createHmac("sha256", master).update("kod-mail-receipts-v1").digest() : null;
}
export function signWebhook(secret: string | Buffer, timestamp: string, body: string): string {
  return "v1=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}
export function verifyReceiptSignature(timestamp: string, signature: string, body: string, now = Date.now()): boolean {
  const key = receiptKey();
  if (!key || !/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300 || !/^v1=[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(signWebhook(key, timestamp, body)));
}
