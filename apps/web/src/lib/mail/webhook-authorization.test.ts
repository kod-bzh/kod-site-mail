import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ key: vi.fn(), user: vi.fn(), member: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { organizationApiKey: { findUnique: mocks.key }, user: { findUnique: mocks.user }, organizationMember: { findFirst: mocks.member } } }));
import { webhookAuthorized } from "./webhook-authorization";
it("stops revoked keys, missing scopes, foreign organizations and withdrawn domains before callbacks", async () => {
  const hook = { organizationId: "org-a", initiatorId: "key-a" };
  const key = { organizationId: "org-a", revokedAt: null, scopes: ["deliverability:read"], allowedMailDomains: ["example.org"] };
  mocks.key.mockResolvedValue(key); expect(await webhookAuthorized(hook, "deliverability:read", "example.org")).toBe(true);
  for (const change of [{ revokedAt: new Date() }, { organizationId: "org-b" }, { scopes: ["mail:send"] }, { allowedMailDomains: ["other.example"] }]) {
    mocks.key.mockResolvedValue({ ...key, ...change }); expect(await webhookAuthorized(hook, "deliverability:read", "example.org")).toBe(false);
  }
});
