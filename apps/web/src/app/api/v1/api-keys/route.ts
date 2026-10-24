import { z } from "zod";
import { API_KEY_WRITE_SCOPE, ALL_API_SCOPES, MCP_DEFAULT_SCOPES, createOrganizationApiKey } from "@/lib/api-keys";
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
    select: { id: true, name: true, keyPrefix: true, scopes: true, allowedMailDomains: true, lastUsedAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  return jsonOk({ keys });
}

export async function POST(req: Request) {
  const gate = await requireV1Actor(req, API_KEY_WRITE_SCOPE);
  if (!gate.actor) return gate.error;

  let body: { name?: string; organizationSlug?: string; scopes?: string[]; allowedMailDomains?: string[] } = {};
  try {
    body = z.object({ name: z.string().max(200).optional(), organizationSlug: z.string().max(200).optional(),
      scopes: z.array(z.enum(ALL_API_SCOPES)).max(20).optional(), allowedMailDomains: z.array(z.string().regex(/^[a-z0-9.-]{1,253}$/)).max(100).optional() }).parse(await req.json());
  } catch { return Response.json({ error: "invalid_body" }, { status: 400 }); }

  const org = await resolveActorOrganizationId(gate.actor, {
    organizationSlug: body.organizationSlug ?? readOrgSlug(req, body),
  });
  if (!org.ok) return v1Error(org.error);

  const defaults = gate.actor.isAdmin
    ? [...ALL_API_SCOPES]
    : MCP_DEFAULT_SCOPES.filter((scope) => actorHasScope(gate.actor, scope));

  const scopes = body.scopes ?? defaults;
  if (scopes.some(scope => !actorHasScope(gate.actor!, scope))) return Response.json({ error: "scope_forbidden" }, { status: 403 });
  const allowedMailDomains = body.allowedMailDomains ?? gate.actor.allowedMailDomains ?? [];
  if (gate.actor.allowedMailDomains?.length && (!allowedMailDomains.length || allowedMailDomains.some(domain => !gate.actor!.allowedMailDomains!.includes(domain)))) return Response.json({ error: "domain_forbidden" }, { status: 403 });
  for (const domain of allowedMailDomains) {
    const owned = await prisma.domain.findFirst({ where: { organizationId: org.organizationId, fqdn: domain } })
      ?? await prisma.mailMonitoredDomain.findFirst({ where: { organizationId: org.organizationId, domain } });
    if (!owned) return Response.json({ error: "domain_forbidden" }, { status: 403 });
  }
  const created = await createOrganizationApiKey({
    organizationId: org.organizationId,
    name: body.name?.trim() || "MCP",
    scopes,
    allowedMailDomains,
  });

  return jsonOk(
    {
      id: created.id,
      prefix: created.prefix,
      token: created.token,
      scopes,
      allowedMailDomains,
    },
    201
  );
}
