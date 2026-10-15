import { z } from "zod";
import { resolveV1ActorFromRequest, resolveActorOrganizationId, actorHasScope } from "@/lib/api/v1-auth";
import { API_KEY_WRITE_SCOPE } from "@/lib/api-keys";
import { prisma } from "@/lib/prisma";
export const dynamic = "force-dynamic";
const schema = z.object({ address: z.string().trim().email().transform(v => v.toLowerCase()), reason: z.enum(["complaint", "unsubscribe", "hard_bounce", "manual"]).default("manual"), organizationSlug: z.string().max(80).optional() });
async function handle(req: Request) {
  const actor = await resolveV1ActorFromRequest(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!actorHasScope(actor, API_KEY_WRITE_SCOPE)) return Response.json({ error: "forbidden" }, { status: 403 });
  let body: unknown;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid_body" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { address, reason, organizationSlug } = parsed.data;
  const org = await resolveActorOrganizationId(actor, { organizationSlug });
  if (!org.ok) return Response.json({ error: org.error }, { status: 403 });
  await prisma.$transaction(async tx => {
    if (req.method === "DELETE") await tx.mailSuppression.deleteMany({ where: { organizationId: org.organizationId, address } });
    else await tx.mailSuppression.upsert({ where: { organizationId_address: { organizationId: org.organizationId, address } },
      create: { organizationId: org.organizationId, address, reason, source: "authorized_operator" }, update: { reason, source: "authorized_operator" } });
    await tx.auditLog.create({ data: { organizationId: org.organizationId, action: req.method === "DELETE" ? "mail.suppression.remove" : "mail.suppression.add", target: address, metadata: { reason, actor: actor.apiKeyId ?? actor.userId ?? "admin" } } });
  });
  return Response.json({ ok: true, address, suppressed: req.method !== "DELETE" });
}
export const POST = handle;
export const DELETE = handle;
