import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { sealSecret, unsealSecret } from "@/lib/crypto/seal";
import { boundedResponse, ProviderError } from "./provider-connectors";

export const POSTMASTER_SCOPE = "https://www.googleapis.com/auth/postmaster.readonly";
export const POSTMASTER_COOKIE = "__Host-kod-postmaster-oauth";
const PREFIX = "postmaster.";
const TTL = 15 * 60_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const pendingSchema = z.object({ nonceHash: z.string().regex(/^[a-f0-9]{64}$/), verifierCipher: z.string().min(20), expiresAt: z.string().datetime(),
  domains: z.array(z.string().regex(/^[a-z0-9.-]{1,253}$/)).min(1).max(10), redirectUri: z.string().url(), clientId: z.string().min(5) });
function config() {
  const dedicated = !!(process.env.GOOGLE_POSTMASTER_CLIENT_ID || process.env.GOOGLE_POSTMASTER_CLIENT_SECRET);
  const clientId = dedicated ? process.env.GOOGLE_POSTMASTER_CLIENT_ID : process.env.GOOGLE_MIGRATION_CLIENT_ID;
  const clientSecret = dedicated ? process.env.GOOGLE_POSTMASTER_CLIENT_SECRET : process.env.GOOGLE_MIGRATION_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw Error("postmaster_client_not_configured");
  const origin = new URL(process.env.AUTH_URL ?? "https://kod.bzh").origin;
  if (!origin.startsWith("https://")) throw Error("https_callback_required");
  return { clientId, clientSecret, origin, redirectUri: `${origin}/api/migration/oauth/google/callback` };
}
async function owned(organizationId: string, domains: string[]) {
  for (const domain of domains) {
    const row = await prisma.domain.findFirst({ where: { organizationId, fqdn: domain }, select: { id: true } })
      ?? await prisma.mailMonitoredDomain.findFirst({ where: { organizationId, domain }, select: { id: true } });
    if (!row) throw Error("domain_not_authorized");
  }
}
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
export async function startPostmasterOAuth(organizationId: string, requested: string[]) {
  const domains = [...new Set(requested)]; await owned(organizationId, domains);
  const cfg = config(), nonce = randomBytes(32).toString("hex"), verifier = randomBytes(32).toString("base64url");
  const pending = { nonceHash: hash(nonce), verifierCipher: sealSecret(verifier), expiresAt: new Date(Date.now() + TTL).toISOString(), domains, redirectUri: cfg.redirectUri, clientId: cfg.clientId };
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${organizationId} FOR UPDATE`;
    const prior = await tx.mailConnector.findUnique({ where: { organizationId_domain_provider: { organizationId, domain: domains[0], provider: "google_postmaster" } } });
    const settings = { ...object(prior?.settings), pendingPostmaster: pending } as Prisma.InputJsonValue;
    await tx.mailConnector.upsert({ where: { organizationId_domain_provider: { organizationId, domain: domains[0], provider: "google_postmaster" } },
      create: { organizationId, domain: domains[0], provider: "google_postmaster", settings }, update: { settings } });
    await tx.auditLog.create({ data: { organizationId, action: "mail.postmaster.oauth_start", target: domains.join(","), metadata: { scope: POSTMASTER_SCOPE, credentialsExposed: false } } });
  });
  return { authorizationUrl: `${cfg.origin}/api/v1/mail/connectors/google/oauth?state=${PREFIX}${nonce}`, scope: POSTMASTER_SCOPE, domains, expiresAt: pending.expiresAt };
}
export function isPostmasterState(state: string | null) { return !!state?.startsWith(PREFIX); }
async function pendingFor(state: string) {
  const nonce = state.slice(PREFIX.length);
  if (!isPostmasterState(state) || !/^[a-f0-9]{64}$/.test(nonce)) throw Error("invalid_state");
  const connector = await prisma.mailConnector.findFirst({ where: { provider: "google_postmaster", settings: { path: ["pendingPostmaster", "nonceHash"], equals: hash(nonce) } } });
  const pending = pendingSchema.parse(object(connector?.settings).pendingPostmaster);
  if (!connector || Date.parse(pending.expiresAt) <= Date.now()) throw Error("expired_state");
  const cfg = config(); if (pending.clientId !== cfg.clientId || pending.redirectUri !== cfg.redirectUri) throw Error("oauth_configuration_changed");
  return { connector, pending, nonce, cfg };
}
export async function openPostmasterOAuth(state: string) {
  const { pending, nonce, cfg } = await pendingFor(state), verifier = unsealSecret(pending.verifierCipher);
  if (!verifier) throw Error("invalid_state");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: "code", scope: POSTMASTER_SCOPE,
    access_type: "offline", prompt: "consent", include_granted_scopes: "false", state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
  const response = NextResponse.redirect(url, { headers });
  response.cookies.set(POSTMASTER_COOKIE, nonce, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: TTL / 1000 });
  return response;
}
export async function finishPostmasterOAuth(req: NextRequest) {
  let response: NextResponse;
  let phase = "browser_state";
  try {
    const state = req.nextUrl.searchParams.get("state") ?? "", { connector, pending, nonce, cfg } = await pendingFor(state);
    const cookie = req.cookies.get(POSTMASTER_COOKIE)?.value ?? "";
    if (!/^[a-f0-9]{64}$/.test(cookie) || !timingSafeEqual(Buffer.from(cookie), Buffer.from(nonce))) throw Error("browser_state_mismatch");
    await owned(connector.organizationId, pending.domains);
    // Consume once before exchanging the authorization code. Other settings/active credentials survive a failed connection.
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "MailConnector" WHERE id=${connector.id} FOR UPDATE`;
      const current = await tx.mailConnector.findUniqueOrThrow({ where: { id: connector.id } });
      const saved = pendingSchema.parse(object(current.settings).pendingPostmaster);
      if (saved.nonceHash !== pending.nonceHash || Date.parse(saved.expiresAt) <= Date.now()) throw Error("state_already_consumed");
      const { pendingPostmaster: removed, ...settings } = object(current.settings); void removed;
      await tx.mailConnector.update({ where: { id: connector.id }, data: { settings: settings as Prisma.InputJsonValue } });
    });
    const code = req.nextUrl.searchParams.get("code"), verifier = unsealSecret(pending.verifierCipher);
    if (req.nextUrl.searchParams.has("error") || !code || !verifier || code.length > 4096) throw Error("consent_not_completed");
    phase = "token_exchange";
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret,
        redirect_uri: cfg.redirectUri, grant_type: "authorization_code", code_verifier: verifier }) });
    const tokens = JSON.parse((await boundedResponse(tokenResponse, 64000)).toString("utf8"));
    if (typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string" || tokens.scope !== POSTMASTER_SCOPE) throw Error("readonly_offline_grant_not_confirmed");
    phase = "domain_access";
    for (const domain of pending.domains) {
      const response = await fetch(`https://gmailpostmastertools.googleapis.com/v1/domains/${encodeURIComponent(domain)}`, { redirect: "error", signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${tokens.access_token}` } });
      const registered = JSON.parse((await boundedResponse(response, 64000)).toString("utf8"));
      if (!["OWNER", "READER"].includes(registered.permission)) throw Error("postmaster_domain_access_not_confirmed");
    }
    const credentials = sealSecret(JSON.stringify({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken: tokens.refresh_token }));
    const refreshSeconds = tokens.refresh_token_expires_in;
    const expiresAt = typeof refreshSeconds === "number" && refreshSeconds > 0 && refreshSeconds < 10 * 365 * 86400 ? new Date(Date.now() + refreshSeconds * 1000) : null;
    phase = "credential_storage";
    await prisma.$transaction(async tx => {
      // Recheck ownership at commit time; no credentials for transferred domains.
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${connector.organizationId} FOR UPDATE`;
      for (const domain of pending.domains) {
        await tx.$queryRaw`SELECT id FROM "Domain" WHERE "organizationId"=${connector.organizationId} AND fqdn=${domain} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "MailMonitoredDomain" WHERE "organizationId"=${connector.organizationId} AND domain=${domain} FOR UPDATE`;
        const registered = await tx.domain.findFirst({ where: { organizationId: connector.organizationId, fqdn: domain }, select: { id: true } })
          ?? await tx.mailMonitoredDomain.findFirst({ where: { organizationId: connector.organizationId, domain }, select: { id: true } });
        if (!registered) throw Error("domain_not_authorized");
        const data = { secretCipher: credentials, state: "insufficient_data", lastError: null, nextCheckAt: new Date(), leaseUntil: null, expiresAt };
        await tx.mailConnector.upsert({ where: { organizationId_domain_provider: { organizationId: connector.organizationId, domain, provider: "google_postmaster" } },
          create: { organizationId: connector.organizationId, domain, provider: "google_postmaster", ...data }, update: data });
      }
      await tx.auditLog.create({ data: { organizationId: connector.organizationId, action: "mail.postmaster.oauth_connected", target: pending.domains.join(","), metadata: { scope: POSTMASTER_SCOPE, domainAccessVerified: true, expiryProvidedByGoogle: !!expiresAt } } });
    });
    response = NextResponse.json({ status: "authorized", domains: pending.domains, scope: POSTMASTER_SCOPE, metrics: "awaiting_collection", credentialsExposed: false }, { headers });
  } catch (error) {
    // Provider error payloads and callback codes may contain credentials. Never log or return them.
    const message = error instanceof Error ? error.message : "";
    const known = new Set(["invalid_state", "expired_state", "oauth_configuration_changed", "browser_state_mismatch", "state_already_consumed", "domain_not_authorized", "consent_not_completed", "readonly_offline_grant_not_confirmed", "postmaster_domain_access_not_confirmed"]);
    const http = message.match(/^Fournisseur HTTP (\d{3})$/);
    const limited = error instanceof ProviderError && error.httpStatus === 429;
    const diagnostic = { phase, code: known.has(message) ? message : http ? `provider_http_${http[1]}` : "authorization_unavailable",
      ...(error instanceof ProviderError && error.reason ? { reason: error.reason } : {}),
      ...(limited && error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}) };
    response = NextResponse.json({ status: limited ? "verification_rate_limited" : "authorization_failed", diagnostic,
      action: limited ? "Google limite la vérification Postmaster (HTTP 429). Vérifier les quotas et l’état du service dans le projet Google Cloud, puis réessayer après le délai indiqué. Ce refus ne prouve pas un problème de droits sur le domaine et ne concerne pas l’envoi des emails KOD."
        : phase === "domain_access" ? "Vérifier que l’API Gmail Postmaster Tools est activée dans le projet OAuth et que le compte dispose des droits sur chaque domaine, puis recommencer la connexion." : "Recommencer la connexion et vérifier le client OAuth, le consentement lecture seule et les droits sur les domaines." },
      { status: limited ? 503 : 400, headers: { ...headers, ...(limited && error.retryAfterSeconds !== undefined ? { "Retry-After": String(error.retryAfterSeconds) } : {}) } });
  }
  response.cookies.set(POSTMASTER_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  return response;
}
