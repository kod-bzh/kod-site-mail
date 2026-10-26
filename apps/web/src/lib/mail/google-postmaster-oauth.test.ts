import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const db = vi.hoisted(() => ({ domain: { findFirst: vi.fn() }, mailMonitoredDomain: { findFirst: vi.fn() },
  mailConnector: { findUnique: vi.fn(), findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn() }, $queryRaw: vi.fn(), $transaction: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
import { unsealSecret } from "@/lib/crypto/seal";
import { finishPostmasterOAuth, openPostmasterOAuth, startPostmasterOAuth, POSTMASTER_COOKIE, POSTMASTER_SCOPE, isPostmasterState } from "./google-postmaster-oauth";

type Row = { id: string; organizationId: string; domain: string; provider: string; settings: Record<string, unknown>; secretCipher?: string; state?: string; expiresAt?: Date | null };
let rows: Map<string, Row>, fetchMock: ReturnType<typeof vi.fn>, transactionTail: Promise<unknown>;
const domains = ["mail.example.org", "example.org"];
beforeEach(() => {
  vi.clearAllMocks(); rows = new Map(); transactionTail = Promise.resolve();
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret"); vi.stubEnv("AUTH_URL", "https://kod.test");
  vi.stubEnv("GOOGLE_MIGRATION_CLIENT_ID", "fixture.apps.googleusercontent.com"); vi.stubEnv("GOOGLE_MIGRATION_CLIENT_SECRET", "fixture-secret");
  vi.stubEnv("GOOGLE_POSTMASTER_CLIENT_ID", ""); vi.stubEnv("GOOGLE_POSTMASTER_CLIENT_SECRET", "");
  // Domain ownership is organization-specific; the root uses observation-only registration.
  db.domain.findFirst.mockImplementation(async ({ where }) => where.organizationId === "org-a" && where.fqdn === domains[0] ? { id: "hosted" } : null);
  db.mailMonitoredDomain.findFirst.mockImplementation(async ({ where }) => where.organizationId === "org-a" && where.domain === domains[1] ? { id: "observed" } : null);
  db.$transaction.mockImplementation((fn: (tx: typeof db) => Promise<unknown>) => {
    const run = transactionTail.then(() => fn(db)); transactionTail = run.catch(() => undefined); return run;
  });
  db.mailConnector.findUnique.mockImplementation(async ({ where }) => rows.get(where.organizationId_domain_provider.domain) ?? null);
  db.mailConnector.findUniqueOrThrow.mockImplementation(async ({ where }) => [...rows.values()].find(row => row.id === where.id));
  db.mailConnector.findFirst.mockImplementation(async ({ where }) => [...rows.values()].find(row => (row.settings.pendingPostmaster as { nonceHash?: string } | undefined)?.nonceHash === where.settings.equals) ?? null);
  db.mailConnector.upsert.mockImplementation(async ({ where, create, update }) => {
    const key = where.organizationId_domain_provider.domain, prior = rows.get(key);
    const row = prior ? { ...prior, ...update } : { id: `connector-${rows.size}`, settings: {}, ...create }; rows.set(key, row); return row;
  });
  db.mailConnector.update.mockImplementation(async ({ where, data }) => {
    const prior = [...rows.values()].find(row => row.id === where.id)!; const row = { ...prior, ...data }; rows.set(row.domain, row); return row;
  });
  fetchMock = vi.fn(async (url: string) => Response.json(url.includes("oauth2.googleapis.com/token")
    ? { access_token: "fixture-access", refresh_token: "fixture-refresh", scope: POSTMASTER_SCOPE }
    : { name: `domains/${domains[0]}`, permission: "OWNER" })); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function authorize() {
  const start = await startPostmasterOAuth("org-a", domains);
  const state = new URL(start.authorizationUrl).searchParams.get("state")!;
  const redirect = await openPostmasterOAuth(state);
  const cookie = redirect.cookies.get(POSTMASTER_COOKIE)!.value;
  return { start, state, redirect, cookie };
}
function callback(state: string, cookie: string, query = "code=fixture-code") {
  return new NextRequest(`https://kod.test/api/migration/oauth/google/callback?state=${state}&${query}`, { headers: { Cookie: `${POSTMASTER_COOKIE}=${cookie}` } });
}
it("requests only readonly Postmaster with PKCE, an expiring HttpOnly cookie and no public secret", async () => {
  const { start, state, redirect } = await authorize(), url = new URL(redirect.headers.get("location")!);
  expect(url.origin).toBe("https://accounts.google.com"); expect(url.searchParams.get("scope")).toBe(POSTMASTER_SCOPE);
  expect(url.searchParams.get("include_granted_scopes")).toBe("false"); expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toHaveLength(43); expect(url.searchParams.get("state")).toBe(state);
  expect(redirect.headers.get("set-cookie")).toMatch(/HttpOnly/); expect(redirect.headers.get("set-cookie")).toMatch(/Secure/);
  const exposed = JSON.stringify(start) + url.toString(); expect(exposed).not.toContain("fixture-secret"); expect(exposed).not.toContain("verifier");
  expect(redirect.headers.get("cache-control")).toBe("no-store");
});
it("refuses another organization and does not mix a half-configured dedicated client with migration credentials", async () => {
  await expect(startPostmasterOAuth("org-b", domains)).rejects.toThrow("domain_not_authorized");
  vi.stubEnv("GOOGLE_POSTMASTER_CLIENT_ID", "dedicated-client");
  await expect(startPostmasterOAuth("org-a", domains)).rejects.toThrow("postmaster_client_not_configured"); expect(rows.size).toBe(0);
});
it("seals the offline grant only for the exact owned domains and leaves unknown expiry null", async () => {
  const { state, cookie } = await authorize(); const result = await finishPostmasterOAuth(callback(state, cookie));
  expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ status: "authorized", domains, metrics: "awaiting_collection" });
  for (const domain of domains) {
    const row = rows.get(domain)!; expect(JSON.parse(unsealSecret(row.secretCipher!)!)).toEqual({ clientId: "fixture.apps.googleusercontent.com", clientSecret: "fixture-secret", refreshToken: "fixture-refresh" });
    expect(row.state).toBe("insufficient_data"); expect(row.expiresAt).toBeNull();
  }
  expect(rows.get(domains[0])!.settings.pendingPostmaster).toBeUndefined();
  const body = fetchMock.mock.calls[0][1] as RequestInit;
  expect(new URLSearchParams(body.body as URLSearchParams).get("code_verifier")).toHaveLength(43);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
it("binds callback to the initiating browser before consuming state or exchanging codes", async () => {
  const { state } = await authorize(); const result = await finishPostmasterOAuth(callback(state, "0".repeat(64)));
  expect(result.status).toBe(400); expect(fetchMock).not.toHaveBeenCalled(); expect(rows.get(domains[0])!.settings.pendingPostmaster).toBeDefined();
});
it("rejects invalid/expired states and keeps migration states separate", async () => {
  expect(isPostmasterState("migration-state")).toBe(false); await expect(openPostmasterOAuth("postmaster.evil")).rejects.toThrow();
  const { state, cookie } = await authorize(); const pending = rows.get(domains[0])!.settings.pendingPostmaster as { expiresAt: string };
  pending.expiresAt = new Date(0).toISOString(); expect((await finishPostmasterOAuth(callback(state, cookie))).status).toBe(400); expect(fetchMock).not.toHaveBeenCalled();
});
it("consumes callbacks exactly once even when duplicated concurrently", async () => {
  const { state, cookie } = await authorize();
  const results = await Promise.all([finishPostmasterOAuth(callback(state, cookie)), finishPostmasterOAuth(callback(state, cookie))]);
  expect(results.map(row => row.status).sort()).toEqual([200, 400]); expect(fetchMock).toHaveBeenCalledTimes(3);
  expect((await finishPostmasterOAuth(callback(state, cookie))).status).toBe(400); expect(fetchMock).toHaveBeenCalledTimes(3);
});
it.each([
  { access_token: "x", refresh_token: "y", scope: `${POSTMASTER_SCOPE} https://mail.google.com/` },
  { access_token: "x", scope: POSTMASTER_SCOPE },
  { access_token: "x", refresh_token: "y" },
])("does not overwrite active credentials with an overbroad or incomplete grant %#", async tokens => {
  const { state, cookie } = await authorize(); rows.get(domains[0])!.secretCipher = "existing-sealed-credentials";
  fetchMock.mockResolvedValueOnce(Response.json(tokens)); const result = await finishPostmasterOAuth(callback(state, cookie));
  expect(result.status).toBe(400); expect(rows.get(domains[0])!.secretCipher).toBe("existing-sealed-credentials");
  expect(rows.has(domains[1])).toBe(false); expect(JSON.stringify(await result.json())).not.toContain("fixture-code");
});
it("requires provider domain permission and never stores a grant if a domain moved during exchange", async () => {
  const { state, cookie } = await authorize();
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("oauth2.googleapis.com/token")) { db.domain.findFirst.mockResolvedValue(null); return Response.json({ access_token: "x", refresh_token: "y", scope: POSTMASTER_SCOPE }); }
    return Response.json({ permission: "READER" });
  });
  expect((await finishPostmasterOAuth(callback(state, cookie))).status).toBe(400);
  expect([...rows.values()].every(row => !row.secretCipher)).toBe(true);
});
it("does not mark an unverified Google domain authorized", async () => {
  const { state, cookie } = await authorize();
  fetchMock.mockResolvedValueOnce(Response.json({ access_token: "x", refresh_token: "y", scope: POSTMASTER_SCOPE })).mockResolvedValueOnce(Response.json({ permission: "NONE" }));
  expect((await finishPostmasterOAuth(callback(state, cookie))).status).toBe(400); expect([...rows.values()].every(row => !row.secretCipher)).toBe(true);
});
it("exposes a bounded phase/status diagnostic without returning provider payloads or secrets", async () => {
  const { state, cookie } = await authorize();
  fetchMock.mockResolvedValueOnce(Response.json({ access_token: "secret-access", refresh_token: "secret-refresh", scope: POSTMASTER_SCOPE }))
    .mockResolvedValueOnce(Response.json({ error: { message: "private-provider-detail", credential: "secret-access" } }, { status: 403 }));
  const response = await finishPostmasterOAuth(callback(state, cookie));
  const body = await response.json();
  expect(body).toMatchObject({ status: "authorization_failed", diagnostic: { phase: "domain_access", code: "provider_http_403" } });
  for (const secret of ["secret-access", "secret-refresh", "private-provider-detail", "fixture-code"]) expect(JSON.stringify(body)).not.toContain(secret);
  expect([...rows.values()].every(row => !row.secretCipher)).toBe(true);
});
it("identifies a Google quota refusal separately from authorization and retains only safe retry evidence", async () => {
  const { state, cookie } = await authorize();
  fetchMock.mockResolvedValueOnce(Response.json({ access_token: "secret-access", refresh_token: "secret-refresh", scope: POSTMASTER_SCOPE }))
    .mockResolvedValueOnce(Response.json({ error: { status: "RESOURCE_EXHAUSTED", message: "private secret-access",
      details: [{ reason: "RATE_LIMIT_EXCEEDED", metadata: { credential: "secret-refresh" } }] } }, { status: 429, headers: { "Retry-After": "120" } }));
  const response = await finishPostmasterOAuth(callback(state, cookie)), body = await response.json();
  expect(response.status).toBe(503); expect(response.headers.get("retry-after")).toBe("120");
  expect(body).toMatchObject({ status: "verification_rate_limited", diagnostic: { phase: "domain_access", code: "provider_http_429", reason: "RATE_LIMIT_EXCEEDED", retryAfterSeconds: 120 } });
  expect(body.action).toContain("Ce refus ne prouve pas un problème de droits");
  for (const secret of ["secret-access", "secret-refresh", "fixture-code", "metadata"]) expect(JSON.stringify(body)).not.toContain(secret);
  expect([...rows.values()].every(row => !row.secretCipher)).toBe(true);
});
