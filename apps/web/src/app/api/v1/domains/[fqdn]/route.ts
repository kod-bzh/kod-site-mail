import { DOMAIN_READ_SCOPE, DOMAIN_WRITE_SCOPE } from "@/lib/api-keys";
import { resolveActorOrganizationId } from "@/lib/api/v1-auth";
import { jsonOk, readOrgSlug, requireV1Actor, v1Error } from "@/lib/api/v1-http";
import { verifyDomainDns } from "@/lib/dns/verify";
import { getOrganizationDomain } from "@/lib/domains/manage";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  context: { params: Promise<{ fqdn: string }> }
) {
  const gate = await requireV1Actor(req, [DOMAIN_READ_SCOPE, DOMAIN_WRITE_SCOPE]);
  if (!gate.actor) return gate.error;
  const { fqdn } = await context.params;
  const org = await resolveActorOrganizationId(gate.actor, {
    organizationSlug: readOrgSlug(req),
    fqdn,
  });
  if (!org.ok) return v1Error(org.error);
  const domain = await getOrganizationDomain(org.organizationId, fqdn);
  if (!domain) return v1Error("domain_not_found");
  return jsonOk({ domain, deliverability: await verifyDomainDns(domain.fqdn) });
}
