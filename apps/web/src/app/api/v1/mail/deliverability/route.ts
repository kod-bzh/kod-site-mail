import { prisma } from "@/lib/prisma";
import { readScope, domainHealth } from "@/lib/mail/deliverability-read";
import { PROVIDERS, connectorPublic } from "@/lib/mail/provider-connectors";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const scope = await readScope(req); if (scope.error) return scope.error;
  const domains = await Promise.all(scope.domains.map(async domain => ({ domain,
    health: await domainHealth(scope.organizationId, domain), connectors: await prisma.mailConnector.findMany({ where: { organizationId: scope.organizationId, domain } }).then(rows => PROVIDERS.map(provider => connectorPublic(rows.find(row => row.provider === provider) ?? null, provider))) })));
  const openIncidents = await prisma.mailIncident.count({ where: { organizationId: scope.organizationId, domain: { in: scope.domains }, status: "open" } });
  return Response.json({ organizationId: scope.organizationId, observedAt: new Date(), domains, openIncidents,
    complaintCount: null, reputation: null, absenceReason: "provider_metrics_have_distinct_coverage_see_domain_reputation", notice: "Une absence de données ne signifie ni zéro plainte ni bonne réputation. Une acceptation SMTP ne prouve ni la lecture ni le classement hors spam." });
}
