import { NextRequest } from "next/server";
import {
  ALL_API_SCOPES,
  hasScope,
  verifyBearerApiKey,
  type VerifiedApiKey,
} from "@/lib/api-keys";
import { verifyAdminMailToken } from "@/lib/mail/admin-send";
import { isOAuthAccessToken, verifyMcpOAuthAccessToken } from "@/lib/mcp/oauth";
import { prisma } from "@/lib/prisma";

export type V1Actor = {
  isAdmin: boolean;
  organizationId: string | null;
  apiKeyId?: string;
  userId?: string;
  scopes: string[];
  allowedMailDomains?: string[];
};

export function extractBearerToken(authorization: string | null): string | null {
  if (!authorization?.toLowerCase().startsWith("bearer ")) return null;
  return authorization.slice(7).trim();
}

export async function resolveV1Actor(
  authorization: string | null
): Promise<V1Actor | null> {
  const token = extractBearerToken(authorization);
  if (!token) return null;

  if (verifyAdminMailToken(token)) {
    return {
      isAdmin: true,
      organizationId: null,
      scopes: [...ALL_API_SCOPES],
    };
  }

  if (isOAuthAccessToken(token)) {
    return verifyMcpOAuthAccessToken(token);
  }

  const apiKey: VerifiedApiKey | null = await verifyBearerApiKey(authorization);
  if (!apiKey) return null;

  return {
    isAdmin: false,
    organizationId: apiKey.organizationId,
    apiKeyId: apiKey.id,
    scopes: apiKey.scopes,
    allowedMailDomains: apiKey.allowedMailDomains,
  };
}

export async function resolveV1ActorFromRequest(
  req: Request | NextRequest
): Promise<V1Actor | null> {
  return resolveV1Actor(req.headers.get("authorization"));
}

export function actorHasScope(actor: V1Actor, scope: string): boolean {
  return actor.isAdmin || hasScope(actor.scopes, scope);
}

export async function resolveActorOrganizationId(
  actor: V1Actor,
  options?: { organizationSlug?: string; fqdn?: string }
): Promise<
  | { ok: true; organizationId: string }
  | { ok: false; error: "organization_required" | "organization_not_found" | "organization_forbidden" }
> {
  const slug = options?.organizationSlug?.trim().toLowerCase();
  if (slug) {
    const org = await prisma.organization.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!org) return { ok: false, error: "organization_not_found" };
    if (actor.organizationId && actor.organizationId !== org.id) {
      return { ok: false, error: "organization_forbidden" };
    }
    return { ok: true, organizationId: org.id };
  }

  if (actor.organizationId) {
    return { ok: true, organizationId: actor.organizationId };
  }

  const fqdn = options?.fqdn?.trim().toLowerCase();
  if (fqdn) {
    const domain = await prisma.domain.findFirst({
      where: { fqdn },
      select: { organizationId: true },
      orderBy: { createdAt: "asc" },
    });
    if (domain) return { ok: true, organizationId: domain.organizationId };
  }

  return { ok: false, error: "organization_required" };
}
