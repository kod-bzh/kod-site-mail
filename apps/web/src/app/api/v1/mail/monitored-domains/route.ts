import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { resolveV1ActorFromRequest, resolveActorOrganizationId } from "@/lib/api/v1-auth";
import { readLimitedBody } from "@/lib/mail/read-limited-body";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const actor = await resolveV1ActorFromRequest(req); if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!actor.isAdmin) return Response.json({ error: "platform_admin_required" }, { status: 403 });
  const org = await resolveActorOrganizationId(actor, { organizationSlug: new URL(req.url).searchParams.get("organizationSlug") ?? undefined });
  if (!org.ok) return Response.json({ error: org.error }, { status: 403 });
  let body; try { body = z.object({ domain: z.string().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/), authorizationSource: z.string().min(10).max(300) }).strict().parse(JSON.parse(await readLimitedBody(req, 4096))); }
  catch { return Response.json({ error: "invalid_body" }, { status: 400 }); }
  const existing = await prisma.mailMonitoredDomain.findUnique({ where: { domain: body.domain } });
  const hosted = await prisma.domain.findFirst({ where: { fqdn: body.domain } });
  if (existing && existing.organizationId !== org.organizationId || hosted && hosted.organizationId !== org.organizationId) return Response.json({ error: "domain_not_available" }, { status: 409 });
  await prisma.mailMonitoredDomain.upsert({ where: { domain: body.domain }, create: { ...body, organizationId: org.organizationId }, update: {} });
  await prisma.auditLog.create({ data: { organizationId: org.organizationId, action: "mail.domain.monitor_authorize", target: body.domain, metadata: { source: body.authorizationSource } } });
  return Response.json({ domain: body.domain, mode: "observation_only", smtpProvisioning: false, dnsChanged: false });
}
