import { TELEMETRY_TYPES } from "@/lib/mail/telemetry";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { resolveV1ActorFromRequest, resolveActorOrganizationId, actorHasScope } from "@/lib/api/v1-auth";
import { MAIL_SEND_SCOPE, DELIVERABILITY_READ_SCOPE } from "@/lib/api-keys";
import { prisma } from "@/lib/prisma";
import { sealSecret } from "@/lib/crypto/seal";
import { resolveWebhook } from "@/lib/mail/webhook-http";
import { readLimitedBody } from "@/lib/mail/read-limited-body";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const select = { id: true, url: true, eventTypes: true, allowedDomains: true, createdAt: true } as const;
async function owner(req: Request) {
  const actor = await resolveV1ActorFromRequest(req);
  if (!actor) return { error: Response.json({ error: "unauthorized" }, { status: 401 }) };
  if (!actorHasScope(actor, MAIL_SEND_SCOPE) && !actorHasScope(actor, DELIVERABILITY_READ_SCOPE)) return { error: Response.json({ error: "forbidden" }, { status: 403 }) };
  const org = await resolveActorOrganizationId(actor, { organizationSlug: new URL(req.url).searchParams.get("organizationSlug") ?? undefined });
  if (!org.ok) return { error: Response.json({ error: org.error }, { status: 403 }) };
  return { actor, where: { organizationId: org.organizationId, initiatorId: actor.apiKeyId ?? actor.userId ?? (actor.isAdmin ? "admin" : "unavailable") } };
}
export async function GET(req: Request) {
  const scope = await owner(req); if (scope.error) return scope.error;
  return Response.json({ webhooks: await prisma.mailWebhook.findMany({ where: scope.where, select: { ...select,
    attempts: { orderBy: { createdAt: "desc" }, take: 20, select: { eventId: true, telemetryEventId: true, attempts: true, completedAt: true, nextAttempt: true, lastStatus: true, lastError: true } } }, orderBy: { createdAt: "desc" } }) });
}
export async function POST(req: Request) {
  const scope = await owner(req); if (scope.error) return scope.error;
  let url: string, eventTypes: string[];
  try { const body = z.object({ url: z.string().max(2048), eventTypes: z.array(z.enum(TELEMETRY_TYPES)).max(4).optional() }).strict().parse(JSON.parse(await readLimitedBody(req, 4096)));
    url = body.url; eventTypes = [...new Set(body.eventTypes ?? [])]; await resolveWebhook(url); }
  catch { return Response.json({ error: "invalid_webhook_url", detail: "URL HTTPS publique requise sur le port 443" }, { status: 400 }); }
  if (eventTypes.length && !actorHasScope(scope.actor, DELIVERABILITY_READ_SCOPE)) return Response.json({ error: "forbidden", requiredScope: DELIVERABILITY_READ_SCOPE }, { status: 403 });
  const allowedDomains = scope.actor.allowedMailDomains ?? [];
  const signingSecret = "whsec_" + randomBytes(32).toString("base64url");
  try {
    const secretCipher = sealSecret(signingSecret);
    const webhook = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${scope.where.organizationId} FOR UPDATE`;
      if (await tx.mailWebhook.count({ where: scope.where }) >= 5) return null;
      return tx.mailWebhook.create({ data: { ...scope.where, url, secretCipher, ...(eventTypes.length ? { eventTypes } : {}), ...(allowedDomains.length ? { allowedDomains } : {}) }, select });
    });
    if (!webhook) return Response.json({ error: "webhook_limit", detail: "Maximum 5 webhooks par clé" }, { status: 409 });
    return Response.json({ webhook, signingSecret, notice: "Conserver ce secret côté serveur ; il ne sera plus affiché." }, { status: 201 });
  } catch { return Response.json({ error: "webhook_unavailable" }, { status: 503 }); }
}
export async function DELETE(req: Request) {
  const scope = await owner(req); if (scope.error) return scope.error;
  const id = new URL(req.url).searchParams.get("id");
  if (!id || id.length > 100) return Response.json({ error: "invalid_id" }, { status: 400 });
  const result = await prisma.mailWebhook.deleteMany({ where: { ...scope.where, id } });
  return Response.json({ ok: true, deleted: result.count > 0 });
}
