import { jsonOk, v1Error } from "@/lib/api/v1-http";
import { resolveV1ActorFromRequest } from "@/lib/api/v1-auth";
import { previewDomainDns } from "@/lib/domains/manage";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  context: { params: Promise<{ fqdn: string }> }
) {
  const actor = await resolveV1ActorFromRequest(req);
  if (!actor) return v1Error("unauthorized");
  const { fqdn } = await context.params;
  const result = await previewDomainDns(fqdn);
  if (!result.ok) return v1Error(result.error);
  return jsonOk(result);
}
