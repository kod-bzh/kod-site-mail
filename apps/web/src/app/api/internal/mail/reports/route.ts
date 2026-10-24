import { z } from "zod";
import { verifyReceiptSignature } from "@/lib/mail/receipt-signature";
import { readLimitedBody } from "@/lib/mail/read-limited-body";
import { incomingReportSchema, ingestIncomingReport } from "@/lib/mail/incoming-reports";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const timestamp = req.headers.get("X-Kod-Timestamp") ?? "", signature = req.headers.get("X-Kod-Signature") ?? "";
  if (!/^\d{10}$/.test(timestamp) || !/^v1=[a-f0-9]{64}$/.test(signature) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return Response.json({ error: "unauthorized" }, { status: 401 });
  let body; try { body = await readLimitedBody(req, 6_000_000); } catch { return Response.json({ error: "payload_too_large" }, { status: 413 }); }
  if (!verifyReceiptSignature(timestamp, signature, body)) return Response.json({ error: "unauthorized" }, { status: 401 });
  let events; try { events = z.object({ events: z.array(incomingReportSchema).max(10) }).strict().parse(JSON.parse(body)).events; }
  catch { return Response.json({ error: "invalid_report" }, { status: 400 }); }
  try { for (const event of events) await ingestIncomingReport(event); return Response.json({ ok: true }); }
  catch { return Response.json({ error: "report_intake_unavailable" }, { status: 503 }); }
}
