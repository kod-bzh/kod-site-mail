import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), org: vi.fn(), scope: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/api/v1-auth", () => ({ resolveV1ActorFromRequest: mocks.actor, resolveActorOrganizationId: mocks.org, actorHasScope: mocks.scope }));
vi.mock("@/lib/prisma", () => ({ prisma: { outboundMessage: { findMany: mocks.findMany, findUnique: mocks.findUnique } } }));
vi.mock("@/lib/mail/delivery", () => ({ refreshOutbound: mocks.refresh }));
import { GET } from "./route";
beforeEach(() => { vi.clearAllMocks(); mocks.actor.mockResolvedValue({ isAdmin: false, apiKeyId: "key-a", organizationId: "org-a" }); mocks.org.mockResolvedValue({ ok: true, organizationId: "org-a" }); mocks.scope.mockReturnValue(true); });
it("cannot read another key or organization’s Bcc history", async () => {
  mocks.findMany.mockResolvedValue([]);
  expect((await GET(new Request("https://example.org/api/v1/mail/messages"))).status).toBe(200);
  expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org-a", initiatorId: "key-a" }, omit: { accountId: true, initiatorId: true, leaseUntil: true } }));
});
it("refuses ambiguous account-scoped submission IDs", async () => {
  mocks.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
  expect((await GET(new Request("https://example.org/api/v1/mail/messages?messageId=k"))).status).toBe(409);
  expect(mocks.refresh).not.toHaveBeenCalled();
});
it("authenticates and checks scope before exposing metadata", async () => {
  mocks.actor.mockResolvedValue(null);
  expect((await GET(new Request("https://example.org/api/v1/mail/messages"))).status).toBe(401);
  expect(mocks.findMany).not.toHaveBeenCalled();
});
