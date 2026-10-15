import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { UserRole } from "@prisma/client";
import {
  ALL_API_SCOPES,
  DOMAIN_READ_SCOPE,
  MAIL_SEND_SCOPE,
  hashApiKey,
} from "@/lib/api-keys";
import type { V1Actor } from "@/lib/api/v1-auth";
import { prisma } from "@/lib/prisma";
import { getDefaultMembership } from "@/lib/tenant";

export const OAUTH_ACCESS_PREFIX = "frmo_";
export const OAUTH_REFRESH_PREFIX = "frmr_";
export const OAUTH_CLIENT_PREFIX = "frmc_";

export const ACCESS_TTL_SEC = 60 * 60 * 24 * 30;
export const REFRESH_TTL_SEC = 60 * 60 * 24 * 90;
export const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

const BLOCKED_REDIRECT_PROTOCOLS = new Set([
  "javascript:",
  "data:",
  "file:",
  "vbscript:",
  "blob:",
]);

export type AuthorizeRequest = {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string | null;
  responseType: string;
};

export function publicOrigin(req?: Request): string {
  const fromEnv = (process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? "").replace(
    /\/$/,
    ""
  );
  if (fromEnv) return fromEnv;
  if (req) return new URL(req.url).origin;
  return "https://kod.bzh";
}

export function mcpResourceUrl(req?: Request): string {
  return `${publicOrigin(req)}/api/mcp`;
}

export function oauthCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Accept, MCP-Protocol-Version",
    "Access-Control-Expose-Headers": "WWW-Authenticate",
    "Cache-Control": "no-store",
  };
}

export function wwwAuthenticateHeader(req?: Request): string {
  const metadata = `${publicOrigin(req)}/.well-known/oauth-protected-resource`;
  return `Bearer realm="framm-mcp", resource_metadata="${metadata}"`;
}

export function authorizationServerMetadata(req?: Request) {
  const issuer = publicOrigin(req);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    registration_endpoint: `${issuer}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...ALL_API_SCOPES],
    resource_indicators_supported: true,
  };
}

export function protectedResourceMetadata(req?: Request) {
  const issuer = publicOrigin(req);
  return {
    resource: mcpResourceUrl(req),
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [...ALL_API_SCOPES],
  };
}

export function jsonOAuth(data: unknown, status = 200, req?: Request): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...oauthCorsHeaders(),
      ...(status === 401
        ? { "WWW-Authenticate": wwwAuthenticateHeader(req) }
        : {}),
    },
  });
}

export function oauthPreflight(): Response {
  return new Response(null, { status: 204, headers: oauthCorsHeaders() });
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

export function isSafeRedirectUri(raw: string): boolean {
  let uri: URL;
  try {
    uri = new URL(raw);
  } catch {
    return false;
  }
  if (uri.username || uri.password) return false;
  const protocol = uri.protocol.toLowerCase();
  if (BLOCKED_REDIRECT_PROTOCOLS.has(protocol)) return false;
  if (protocol === "https:") return true;
  if (protocol === "http:") return isLoopbackHostname(uri.hostname);
  return /^[a-z][a-z0-9+.-]*:$/i.test(protocol);
}

export function redirectUriAllowed(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (req.protocol !== "http:" || !isLoopbackHostname(req.hostname)) return false;
  return registered.some((item) => {
    try {
      const allowed = new URL(item);
      return (
        allowed.protocol === "http:" &&
        isLoopbackHostname(allowed.hostname) &&
        allowed.hostname === req.hostname &&
        allowed.pathname === req.pathname
      );
    } catch {
      return false;
    }
  });
}

export function parseAuthorizeRequest(input: {
  get(name: string): string | null;
}): AuthorizeRequest | { error: string } {
  const clientId = input.get("client_id")?.trim() ?? "";
  const redirectUri = input.get("redirect_uri")?.trim() ?? "";
  const state = input.get("state") ?? "";
  const codeChallenge = input.get("code_challenge")?.trim() ?? "";
  const codeChallengeMethod = input.get("code_challenge_method")?.trim() || "S256";
  const resource = input.get("resource")?.trim() || null;
  const responseType = input.get("response_type")?.trim() ?? "";

  if (!clientId || !redirectUri || responseType !== "code") {
    return { error: "invalid_request" };
  }
  if (!isSafeRedirectUri(redirectUri)) {
    return { error: "invalid_redirect" };
  }
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return { error: "pkce_required" };
  }

  return {
    clientId,
    redirectUri,
    state,
    codeChallenge,
    codeChallengeMethod,
    resource,
    responseType,
  };
}

export function scopesForRoles(
  globalRole: UserRole,
  membershipRole: UserRole | null
): string[] {
  if (globalRole === "BUREAU" || membershipRole === "ASSOC_ADMIN" || globalRole === "ASSOC_ADMIN") {
    return [...ALL_API_SCOPES];
  }
  return [MAIL_SEND_SCOPE, DOMAIN_READ_SCOPE];
}

export async function actorFromUserId(userId: string): Promise<V1Actor | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  });
  if (!user) return null;

  if (user.role === "BUREAU") {
    return {
      isAdmin: true,
      organizationId: null,
      userId: user.id,
      scopes: [...ALL_API_SCOPES],
    };
  }

  const membership = await getDefaultMembership(user.id);
  return {
    isAdmin: false,
    organizationId: membership?.organizationId ?? null,
    userId: user.id,
    scopes: scopesForRoles(user.role, membership?.role ?? null),
  };
}

export function isOAuthAccessToken(token: string): boolean {
  return token.startsWith(OAUTH_ACCESS_PREFIX) && token.length > OAUTH_ACCESS_PREFIX.length + 16;
}

export async function verifyMcpOAuthAccessToken(token: string): Promise<V1Actor | null> {
  if (!isOAuthAccessToken(token)) return null;
  const record = await prisma.mcpOAuthAccessToken.findUnique({
    where: { tokenHash: hashApiKey(token) },
    select: { userId: true, expiresAt: true },
  });
  if (!record || record.expiresAt.getTime() <= Date.now()) return null;
  return actorFromUserId(record.userId);
}

export async function registerPublicClient(input: {
  clientName?: string;
  redirectUris: string[];
}) {
  const redirectUris = [...new Set(input.redirectUris.map((uri) => uri.trim()).filter(Boolean))];
  if (redirectUris.length === 0 || redirectUris.length > 10) {
    return { ok: false as const, error: "invalid_redirect_uri" };
  }
  if (redirectUris.some((uri) => !isSafeRedirectUri(uri))) {
    return { ok: false as const, error: "invalid_redirect_uri" };
  }

  const clientId = `${OAUTH_CLIENT_PREFIX}${randomBytes(16).toString("base64url")}`;
  const clientName = input.clientName?.trim() || "MCP";
  await prisma.mcpOAuthClient.create({
    data: { clientId, clientName, redirectUris },
  });

  return {
    ok: true as const,
    client: {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
  };
}

export async function findOAuthClient(clientId: string) {
  return prisma.mcpOAuthClient.findUnique({
    where: { clientId },
    select: { clientId: true, clientName: true, redirectUris: true },
  });
}

export async function issueAuthorizationCode(input: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  resource: string | null;
  userId: string;
}) {
  const code = randomBytes(24).toString("base64url");
  await prisma.mcpOAuthAuthCode.create({
    data: {
      code,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      state: input.state,
      resource: input.resource,
      userId: input.userId,
      expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
    },
  });
  return code;
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function persistTokens(input: {
  clientId: string;
  userId: string;
  resource: string | null;
}) {
  const accessToken = `${OAUTH_ACCESS_PREFIX}${randomBytes(32).toString("base64url")}`;
  const refreshToken = `${OAUTH_REFRESH_PREFIX}${randomBytes(32).toString("base64url")}`;
  const now = Date.now();
  await prisma.mcpOAuthAccessToken.create({
    data: {
      tokenHash: hashApiKey(accessToken),
      tokenPrefix: accessToken.slice(0, 12),
      refreshTokenHash: hashApiKey(refreshToken),
      clientId: input.clientId,
      userId: input.userId,
      resource: input.resource,
      expiresAt: new Date(now + ACCESS_TTL_SEC * 1000),
      refreshExpiresAt: new Date(now + REFRESH_TTL_SEC * 1000),
    },
  });
  return { accessToken, refreshToken };
}

export async function exchangeAuthorizationCode(input: {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  resource?: string | null;
}) {
  const record = await prisma.mcpOAuthAuthCode.findUnique({
    where: { code: input.code },
  });
  if (!record || record.expiresAt.getTime() <= Date.now()) {
    return { ok: false as const, error: "invalid_grant" };
  }
  if (record.clientId !== input.clientId || record.redirectUri !== input.redirectUri) {
    return { ok: false as const, error: "invalid_grant" };
  }
  if (!safeEqual(record.codeChallenge, sha256Base64Url(input.codeVerifier))) {
    return { ok: false as const, error: "invalid_grant" };
  }

  await prisma.mcpOAuthAuthCode.delete({ where: { id: record.id } });

  const actor = await actorFromUserId(record.userId);
  if (!actor) return { ok: false as const, error: "invalid_grant" };

  const tokens = await persistTokens({
    clientId: record.clientId,
    userId: record.userId,
    resource: input.resource ?? record.resource,
  });

  return {
    ok: true as const,
    access_token: tokens.accessToken,
    token_type: "Bearer" as const,
    expires_in: ACCESS_TTL_SEC,
    refresh_token: tokens.refreshToken,
    scope: actor.scopes.join(" "),
  };
}

export async function rotateRefreshToken(input: {
  clientId: string;
  refreshToken: string;
  resource?: string | null;
}) {
  if (!input.refreshToken.startsWith(OAUTH_REFRESH_PREFIX)) {
    return { ok: false as const, error: "invalid_grant" };
  }
  const record = await prisma.mcpOAuthAccessToken.findUnique({
    where: { refreshTokenHash: hashApiKey(input.refreshToken) },
  });
  if (!record || record.clientId !== input.clientId) {
    return { ok: false as const, error: "invalid_grant" };
  }
  if (!record.refreshExpiresAt || record.refreshExpiresAt.getTime() <= Date.now()) {
    return { ok: false as const, error: "invalid_grant" };
  }

  await prisma.mcpOAuthAccessToken.delete({ where: { id: record.id } });
  const actor = await actorFromUserId(record.userId);
  if (!actor) return { ok: false as const, error: "invalid_grant" };

  const tokens = await persistTokens({
    clientId: record.clientId,
    userId: record.userId,
    resource: input.resource ?? record.resource,
  });

  return {
    ok: true as const,
    access_token: tokens.accessToken,
    token_type: "Bearer" as const,
    expires_in: ACCESS_TTL_SEC,
    refresh_token: tokens.refreshToken,
    scope: actor.scopes.join(" "),
  };
}

export function clientRedirectWithParams(redirectUri: string, params: Record<string, string>) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
