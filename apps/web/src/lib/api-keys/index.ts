import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";

export const API_KEY_PREFIX = "framm_";
export const MAIL_SEND_SCOPE = "mail:send";
export const DOMAIN_READ_SCOPE = "domains:read";
export const DOMAIN_WRITE_SCOPE = "domains:write";
export const API_KEY_WRITE_SCOPE = "api_keys:write";
export const MAILBOX_WRITE_SCOPE = "mailboxes:write";

export const MCP_DEFAULT_SCOPES = [
  MAIL_SEND_SCOPE,
  DOMAIN_READ_SCOPE,
  DOMAIN_WRITE_SCOPE,
  MAILBOX_WRITE_SCOPE,
] as const;

export const ALL_API_SCOPES = [
  MAIL_SEND_SCOPE,
  DOMAIN_READ_SCOPE,
  DOMAIN_WRITE_SCOPE,
  API_KEY_WRITE_SCOPE,
  MAILBOX_WRITE_SCOPE,
] as const;

export function hashApiKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateApiKeySecret(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function isApiKeyFormat(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX) && token.length > API_KEY_PREFIX.length + 16;
}

export type VerifiedApiKey = {
  id: string;
  organizationId: string;
  scopes: string[];
};

export async function verifyBearerApiKey(
  authorization: string | null
): Promise<VerifiedApiKey | null> {
  if (!authorization?.startsWith("Bearer ")) return null;

  const token = authorization.slice("Bearer ".length).trim();
  if (!isApiKeyFormat(token)) return null;

  const keyHash = hashApiKey(token);
  const record = await prisma.organizationApiKey.findUnique({
    where: { keyHash },
    select: {
      id: true,
      organizationId: true,
      scopes: true,
      revokedAt: true,
    },
  });

  if (!record || record.revokedAt) return null;

  await prisma.organizationApiKey.update({
    where: { id: record.id },
    data: { lastUsedAt: new Date() },
  });

  return {
    id: record.id,
    organizationId: record.organizationId,
    scopes: record.scopes,
  };
}

export function hasScope(scopes: string[], scope: string): boolean {
  return scopes.includes(scope);
}

export async function createOrganizationApiKey(input: {
  organizationId: string;
  name: string;
  createdById?: string;
  scopes?: string[];
}): Promise<{ id: string; token: string; prefix: string }> {
  const token = generateApiKeySecret();
  const prefix = token.slice(0, 12);
  const keyHash = hashApiKey(token);

  const record = await prisma.organizationApiKey.create({
    data: {
      organizationId: input.organizationId,
      name: input.name.trim(),
      keyPrefix: prefix,
      keyHash,
      scopes: input.scopes ?? [MAIL_SEND_SCOPE],
      createdById: input.createdById,
    },
    select: { id: true },
  });

  return { id: record.id, token, prefix };
}
