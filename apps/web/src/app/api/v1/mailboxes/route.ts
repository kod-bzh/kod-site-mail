import { MAILBOX_WRITE_SCOPE } from "@/lib/api-keys";
import { resolveActorOrganizationId } from "@/lib/api/v1-auth";
import { jsonOk, readOrgSlug, requireV1Actor, v1Error } from "@/lib/api/v1-http";
import { createMailboxForOrg } from "@/lib/mail/create-mailbox";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await requireV1Actor(req, MAILBOX_WRITE_SCOPE);
  if (!gate.actor) return gate.error;

  let body: {
    fqdn?: string;
    localPart?: string;
    password?: string;
    displayName?: string;
    organizationSlug?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return v1Error("invalid_body");
  }

  const fqdn = body.fqdn ?? "";
  const org = await resolveActorOrganizationId(gate.actor, {
    organizationSlug: body.organizationSlug ?? readOrgSlug(req, body),
    fqdn,
  });
  if (!org.ok) return v1Error(org.error);

  const result = await createMailboxForOrg({
    organizationId: org.organizationId,
    fqdn,
    localPart: body.localPart ?? "noreply",
    password: body.password,
    displayName: body.displayName,
  });
  if (!result.ok) return v1Error(result.error);
  return jsonOk(result, result.created ? 201 : 200);
}
