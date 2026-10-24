import { verifyReceiptSignature } from "@/lib/mail/receipt-signature";
import { reportTargets } from "@/lib/mail/incoming-reports";
import { prisma } from "@/lib/prisma";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  if (!verifyReceiptSignature(req.headers.get("X-Kod-Timestamp") ?? "", req.headers.get("X-Kod-Signature") ?? "", "")) return Response.json({ error: "unauthorized" }, { status: 401 });
  const targets = await reportTargets();
  const failed = ["intake_busy", "intake_unavailable", "forwarding_unavailable", "expired_reports", "legacy_unbound_reports", "legacy_target_authorization_refresh_required"].includes(req.headers.get("X-Kod-Report-Error") ?? "");
  const lastError = failed ? "Collecte entrante partiellement indisponible ou rapport rejeté ; couverture incomplète" : null;
  await prisma.mailMonitorState.upsert({ where: { id: "incoming-report-bridge" }, create: { id: "incoming-report-bridge", lastError }, update: { checkedAt: new Date(), lastError } });
  return Response.json({ targets: targets.map(row => ({ address: row.address, domain: row.domain, kinds: row.kinds, targetRef: row.targetRef })) });
}
