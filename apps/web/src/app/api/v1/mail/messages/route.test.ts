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
  expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: "org-a", initiatorId: "key-a" }), omit: { accountId: true, initiatorId: true, leaseUntil: true } }));
});
it("searches beyond the latest 50 while preserving key and allowed-domain isolation on every page", async () => {
  mocks.actor.mockResolvedValue({ isAdmin: false, apiKeyId: "key-a", allowedMailDomains: ["example.org"] });
  mocks.findMany.mockResolvedValue([{ id: "b", createdAt: new Date("2026-10-26T10:00:00Z"), recipients: { to: [], cc: [], bcc: [] } }, { id: "a", createdAt: new Date("2026-10-26T10:00:00Z"), recipients: { to: [], cc: [], bcc: [] } }]);
  const first = await GET(new Request("https://example.org/api/v1/mail/messages?limit=1&from=sender@example.org&recipient=invoice@example.net&since=2026-10-26T00:00:00Z"));
  const body = await first.json();
  expect(body.messages).toHaveLength(1); expect(body.nextCursor).toBeTypeOf("string");
  const where = mocks.findMany.mock.calls[0][0].where;
  expect(where).toMatchObject({ organizationId: "org-a", initiatorId: "key-a", OR: [{ fromAddress: { endsWith: "@example.org" } }] });
  expect(where.AND).toContainEqual({ fromAddress: "sender@example.org" });
  expect(where.AND).toContainEqual({ OR: ["to", "cc", "bcc"].map(field => ({ recipients: { path: [field], array_contains: ["invoice@example.net"] } })) });
  mocks.findMany.mockResolvedValue([]);
  await GET(new Request(`https://example.org/api/v1/mail/messages?limit=1&cursor=${body.nextCursor}`));
  expect(mocks.findMany.mock.calls[1][0].where).toMatchObject({ organizationId: "org-a", initiatorId: "key-a", OR: [{ fromAddress: { endsWith: "@example.org" } }] });
  expect(mocks.findMany.mock.calls[1][0].where.AND).toContainEqual({ OR: [{ createdAt: { lt: new Date("2026-10-26T10:00:00Z") } }, { createdAt: new Date("2026-10-26T10:00:00Z"), id: { lt: "b" } }] });
  expect(mocks.refresh).not.toHaveBeenCalled();
});
it.each(["limit=0", "limit=101", "limit=oops", "cursor=bad!", "since=yesterday", "recipient=bad", "since=2026-10-27T00:00:00Z&until=2026-10-26T00:00:00Z"])("rejects invalid searches before reading the journal (%s)", async query => {
  expect((await GET(new Request(`https://example.org/api/v1/mail/messages?${query}`))).status).toBe(400);
  expect(mocks.findMany).not.toHaveBeenCalled();
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
