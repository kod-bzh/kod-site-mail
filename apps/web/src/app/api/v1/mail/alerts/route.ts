import { prisma } from "@/lib/prisma";
import { readScope, pagination } from "@/lib/mail/deliverability-read";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const url = new URL(req.url), domain = url.searchParams.get("domain") ?? undefined;
  const scope = await readScope(req, domain); if (scope.error) return scope.error;
  const status = url.searchParams.get("status"); if (status && !["open", "resolved"].includes(status)) return Response.json({ error: "invalid_status" }, { status: 400 });
  let page; try { page = pagination(req); } catch { return Response.json({ error: "invalid_pagination" }, { status: 400 }); }
  const rows = await prisma.mailIncident.findMany({ where: { organizationId: scope.organizationId, domain: { in: domain ? [domain] : scope.domains }, ...(status ? { status } : {}) },
    orderBy: [{ openedAt: "desc" }, { id: "desc" }], ...page, take: page.take + 1 });
  return Response.json({ alerts: rows.slice(0, page.take).map(row => ({ ...row, source: "kod_monitor", scope: "domain", fetchedAt: row.observedAt,
    period: { start: row.openedAt, end: row.resolvedAt }, availability: "available", evidenceRef: row.id, recommendedAction: row.action })),
    nextCursor: rows.length > page.take ? rows[page.take - 1].id : null });
}
