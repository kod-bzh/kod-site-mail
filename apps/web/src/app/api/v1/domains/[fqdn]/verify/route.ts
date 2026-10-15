import { DOMAIN_WRITE_SCOPE } from "@/lib/api-keys";
import { resolveActorOrganizationId } from "@/lib/api/v1-auth";
import { jsonOk, readOrgSlug, requireV1Actor, v1Error } from "@/lib/api/v1-http";
import { verifyDomainForOrg } from "@/lib/domains/manage";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  context: { params: Promise<{ fqdn: string }> }
) {
  const gate = await requireV1Actor(req, DOMAIN_WRITE_SCOPE);
  if (!gate.actor) return gate.error;
  const { fqdn } = await context.params;
  const org = await resolveActorOrganizationId(gate.actor, {
    organizationSlug: readOrgSlug(req),
    fqdn,
  });
  if (!org.ok) return v1Error(org.error);
  const result = await verifyDomainForOrg(org.organizationId, fqdn);
  if (!result.ok) return v1Error(result.error);
  return jsonOk({
    domain: result.domain,
    verified: result.check.verified,
    deliverability: result.check,
    domainExists: result.check.domainExists,
    records: result.records,
    checks: result.check.results,
  });
}
