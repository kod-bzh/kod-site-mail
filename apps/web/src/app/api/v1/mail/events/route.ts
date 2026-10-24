import { prisma } from "@/lib/prisma";
import { readScope, pagination, period } from "@/lib/mail/deliverability-read";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const url = new URL(req.url), domain = url.searchParams.get("domain") ?? undefined;
  const scope = await readScope(req, domain); if (scope.error) return scope.error;
  let page, range; try { page = pagination(req); range = period(req); } catch { return Response.json({ error: "invalid_query" }, { status: 400 }); }
  const rows = await prisma.mailTelemetryEvent.findMany({ where: { organizationId: scope.organizationId, domain: { in: domain ? [domain] : scope.domains },
    receivedAt: { gte: range.start, lt: range.end }, ...(scope.actor.isAdmin ? {} : { OR: [{ messageId: null }, { message: { initiatorId: scope.actor.apiKeyId ?? scope.actor.userId ?? "unavailable" } }] }) },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }], ...page, take: page.take + 1 });
  return Response.json({ events: rows.slice(0, page.take), period: range, nextCursor: rows.length > page.take ? rows[page.take - 1].id : null,
    notice: "Rattrapage par receivedAt, distinct de occurredAt ; conserver la période jusqu’à la fin des pages, puis reprendre avec chevauchement et dédupliquer par id." });
}
