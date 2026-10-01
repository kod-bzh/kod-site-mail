import {
  DOMAIN_READ_SCOPE,
  DOMAIN_WRITE_SCOPE,
} from "@/lib/api-keys";
import { resolveActorOrganizationId } from "@/lib/api/v1-auth";
import { jsonOk, readOrgSlug, requireV1Actor, v1Error } from "@/lib/api/v1-http";
import { addDomainForOrg, listOrganizationDomains } from "@/lib/domains/manage";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await requireV1Actor(req, [DOMAIN_READ_SCOPE, DOMAIN_WRITE_SCOPE]);
  if (!gate.actor) return gate.error;
  const org = await resolveActorOrganizationId(gate.actor, {
    organizationSlug: readOrgSlug(req),
  });
  if (!org.ok) return v1Error(org.error);
  return jsonOk({ domains: await listOrganizationDomains(org.organizationId) });
}

export async function POST(req: Request) {
  const gate = await requireV1Actor(req, DOMAIN_WRITE_SCOPE);
  if (!gate.actor) return gate.error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return v1Error("invalid_body");
  }
  const fqdn = typeof body === "object" && body && "fqdn" in body ? String(body.fqdn) : "";
  const organizationSlug =
    typeof body === "object" && body && "organizationSlug" in body
      ? String((body as { organizationSlug?: string }).organizationSlug ?? "")
      : readOrgSlug(req);
  const org = await resolveActorOrganizationId(gate.actor, { organizationSlug, fqdn });
  if (!org.ok) return v1Error(org.error);
  const result = await addDomainForOrg(org.organizationId, fqdn);
  if (!result.ok) return v1Error(result.error);
  return jsonOk(result, result.created ? 201 : 200);
}
