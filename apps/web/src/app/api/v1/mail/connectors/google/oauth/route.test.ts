import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), org: vi.fn(), start: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/api/v1-auth", () => ({ resolveV1ActorFromRequest: mocks.actor, resolveActorOrganizationId: mocks.org }));
vi.mock("@/lib/mail/google-postmaster-oauth", () => ({ startPostmasterOAuth: mocks.start, openPostmasterOAuth: mocks.open }));
import { POST, GET } from "./route";
const request = (body: unknown = { domains: ["mail.example.org"] }) => new Request("https://kod.test/api/v1/mail/connectors/google/oauth?organizationSlug=example", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); mocks.actor.mockResolvedValue({ isAdmin: true }); mocks.org.mockResolvedValue({ ok: true, organizationId: "org-a" }); mocks.start.mockResolvedValue({ authorizationUrl: "https://kod.test/authorization", scope: "readonly" }); });
it("requires platform administration, not an organization send/read key", async () => {
  mocks.actor.mockResolvedValueOnce(null); expect((await POST(request())).status).toBe(401);
  mocks.actor.mockResolvedValueOnce({ isAdmin: false, scopes: ["mail:send", "deliverability:read"] }); expect((await POST(request())).status).toBe(403);
  expect(mocks.start).not.toHaveBeenCalled();
});
it("rejects cross-organization resolution, unknown options and invalid domain inputs", async () => {
  mocks.org.mockResolvedValueOnce({ ok: false, error: "organization_forbidden" }); expect((await POST(request())).status).toBe(403);
  for (const body of [{ domains: [] }, { domains: ["https://evil.test"] }, { domains: ["mail.example.org"], scope: "https://mail.google.com/" }]) expect((await POST(request(body))).status).toBe(400);
  expect(mocks.start).not.toHaveBeenCalled();
});
it("starts the grant for the resolved organization with no cached response", async () => {
  const result = await POST(request()); expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("no-store");
  expect(mocks.start).toHaveBeenCalledWith("org-a", ["mail.example.org"]);
});
it("does not expose internal diagnostics for an invalid bootstrap link", async () => {
  mocks.open.mockRejectedValue(Error("private provider diagnostic")); const result = await GET(new Request("https://kod.test/api/v1/mail/connectors/google/oauth?state=invalid"));
  expect(result.status).toBe(400); expect(JSON.stringify(await result.json())).not.toContain("private");
});
