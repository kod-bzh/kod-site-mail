import { safeMessage } from "@/lib/mail/telemetry";
import { resolveV1ActorFromRequest, resolveActorOrganizationId, actorHasScope } from "@/lib/api/v1-auth";
import { MAIL_SEND_SCOPE } from "@/lib/api-keys";
import { prisma } from "@/lib/prisma";
import { refreshOutbound } from "@/lib/mail/delivery";
import { DELIVERY_NOTICE } from "@/lib/mail/delivery-status";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const actor = await resolveV1ActorFromRequest(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!actorHasScope(actor, MAIL_SEND_SCOPE)) return Response.json({ error: "forbidden" }, { status: 403 });
  const url = new URL(req.url);
  const org = await resolveActorOrganizationId(actor, { organizationSlug: url.searchParams.get("organizationSlug") ?? undefined });
  if (!org.ok) return Response.json({ error: org.error }, { status: 403 });
  const where = { organizationId: org.organizationId,
    ...(actor.allowedMailDomains?.length ? { OR: actor.allowedMailDomains.map(domain => ({ fromAddress: { endsWith: `@${domain}` } })) } : {}), ...(actor.isAdmin ? {} : { initiatorId: actor.apiKeyId ?? actor.userId ?? "unavailable" }) };
  const messageId = url.searchParams.get("messageId");
  if (messageId) {
    const fromAddress = url.searchParams.get("from")?.trim().toLowerCase();
    const records = await prisma.outboundMessage.findMany({ where: { ...where, ...(fromAddress ? { fromAddress } : {}), AND: [{ OR: [{ id: messageId }, { submissionId: messageId }, { rfcMessageId: messageId }] }] }, take: 2 });
    if (records.length > 1) return Response.json({ error: "ambiguous_message_id", detail: "Utiliser l’id de suivi unique, le rfcMessageId, ou préciser from." }, { status: 409 });
    const record = records[0];
    if (!record) return Response.json({ error: "not_found" }, { status: 404 });
    if (record.nextCheckAt <= new Date() && record.submissionId) await refreshOutbound(record.id);
    const message = await prisma.outboundMessage.findUnique({ where: { id: record.id }, omit: { leaseUntil: true, initiatorId: true, accountId: true },
      include: { telemetryEvents: { orderBy: { receivedAt: "asc" }, take: 100, select: { id: true, type: true, recipient: true, source: true, reliability: true, occurredAt: true, receivedAt: true, data: true } }, events: { orderBy: { occurredAt: "asc" }, take: 100, select: { id: true, type: true, recipient: true, occurredAt: true, data: true } } } });
    return Response.json({ message: message ? safeMessage(message) : null, notice: DELIVERY_NOTICE });
  }
  const messages = await prisma.outboundMessage.findMany({ where, orderBy: { createdAt: "desc" }, take: 50,
    omit: { leaseUntil: true, initiatorId: true, accountId: true } });
  return Response.json({ messages: messages.map(safeMessage), limit: 50, notice: DELIVERY_NOTICE });
}
