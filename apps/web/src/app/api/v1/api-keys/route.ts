import { API_KEY_WRITE_SCOPE, ALL_API_SCOPES, MAIL_SEND_SCOPE, MCP_DEFAULT_SCOPES, createOrganizationApiKey } from "@/lib/api-keys";
import { actorHasScope, resolveActorOrganizationId } from "@/lib/api/v1-auth";
import { jsonOk, readOrgSlug, requireV1Actor, v1Error } from "@/lib/api/v1-http";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await requireV1Actor(req, API_KEY_WRITE_SCOPE);
  if (!gate.actor) return gate.error;
  const org = await resolveActorOrganizationId(gate.actor, {
    organizationSlug: readOrgSlug(req),
  });
  if (!org.ok) return v1Error(org.error);
  const keys = await prisma.organizationApiKey.findMany({
    where: { organizationId: org.organizationId, revokedAt: null },
    select: { id: true, name: true, keyPrefix: true, scopes: true, lastUsedAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  return jsonOk({ keys });
}

export async function POST(req: Request) {
  const gate = await requireV1Actor(req, API_KEY_WRITE_SCOPE);
  if (!gate.actor) return gate.error;

  let body: { name?: string; organizationSlug?: string } = {};
  try {
    body = (await req.json()) as { name?: string; organizationSlug?: string };
  } catch {
    body = {};
  }

  const org = await resolveActorOrganizationId(gate.actor, {
    organizationSlug: body.organizationSlug ?? readOrgSlug(req, body),
  });
  if (!org.ok) return v1Error(org.error);

  const scopes = gate.actor.isAdmin
    ? [...ALL_API_SCOPES]
    : MCP_DEFAULT_SCOPES.filter((scope) => actorHasScope(gate.actor, scope));

  const created = await createOrganizationApiKey({
    organizationId: org.organizationId,
    name: body.name?.trim() || "MCP",
    scopes: scopes.length > 0 ? scopes : [MAIL_SEND_SCOPE],
  });

  return jsonOk(
    {
      id: created.id,
      prefix: created.prefix,
      token: created.token,
      scopes,
    },
    201
  );
}
