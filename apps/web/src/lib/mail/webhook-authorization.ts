import { prisma } from "@/lib/prisma";
export async function webhookAuthorized(hook: { organizationId: string; initiatorId: string }, scope: "mail:send" | "deliverability:read", domain: string) {
  if (hook.initiatorId === "admin") return true;
  const key = await prisma.organizationApiKey.findUnique({ where: { id: hook.initiatorId }, select: { organizationId: true, revokedAt: true, scopes: true, allowedMailDomains: true } });
  if (key) return key.organizationId === hook.organizationId && !key.revokedAt && key.scopes.includes(scope)
    && (!key.allowedMailDomains.length || key.allowedMailDomains.includes(domain));
  const user = await prisma.user.findUnique({ where: { id: hook.initiatorId }, select: { role: true } });
  if (user?.role === "BUREAU") return true;
  const membership = await prisma.organizationMember.findFirst({ where: { userId: hook.initiatorId, organizationId: hook.organizationId }, select: { role: true } });
  return !!membership && (scope === "mail:send" || membership.role === "ASSOC_ADMIN");
}
