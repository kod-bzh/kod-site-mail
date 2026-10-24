import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), org: vi.fn(), scope: vi.fn(), find: vi.fn(), create: vi.fn(), count: vi.fn(), del: vi.fn(), tx: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/api/v1-auth", () => ({ resolveV1ActorFromRequest: mocks.actor, resolveActorOrganizationId: mocks.org, actorHasScope: mocks.scope }));
vi.mock("@/lib/prisma", () => ({ prisma: { mailWebhook: { findMany: mocks.find, deleteMany: mocks.del }, $transaction: mocks.tx } }));
vi.mock("@/lib/crypto/seal", () => ({ sealSecret: () => "encrypted-secret" }));
vi.mock("@/lib/mail/webhook-http", () => ({ resolveWebhook: mocks.resolve }));
import { GET, POST, DELETE } from "./route";
beforeEach(() => {
  vi.clearAllMocks(); mocks.actor.mockResolvedValue({ isAdmin: false, apiKeyId: "key-a" }); mocks.scope.mockReturnValue(true);
  mocks.org.mockResolvedValue({ ok: true, organizationId: "org-a" }); mocks.find.mockResolvedValue([]); mocks.count.mockResolvedValue(0);
  mocks.tx.mockImplementation(fn => fn({ $queryRaw: vi.fn(), mailWebhook: { count: mocks.count, create: mocks.create } }));
  mocks.create.mockResolvedValue({ id: "hook", url: "https://example.com/hooks" }); mocks.resolve.mockResolvedValue({});
});
const request = () => new Request("https://kod.bzh/api/v1/mail/webhooks", { method: "POST", body: JSON.stringify({ url: "https://example.com/hooks" }) });
it("requires authorization before reading a URL or exposing webhook data", async () => {
  mocks.actor.mockResolvedValue(null); expect((await POST(request())).status).toBe(401); expect(mocks.resolve).not.toHaveBeenCalled();
});
it("restricts history and deletion to the organization and creating key", async () => {
  await GET(new Request("https://kod.bzh/api/v1/mail/webhooks"));
  expect(mocks.find).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org-a", initiatorId: "key-a" } }));
  mocks.del.mockResolvedValue({ count: 0 }); await DELETE(new Request("https://kod.bzh/api/v1/mail/webhooks?id=other-hook"));
  expect(mocks.del).toHaveBeenCalledWith({ where: { organizationId: "org-a", initiatorId: "key-a", id: "other-hook" } });
});
it("returns the secret once while storing only ciphertext", async () => {
  const response = await POST(request()); expect(response.status).toBe(201);
  expect((await response.json()).signingSecret).toMatch(/^whsec_/);
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ data: { organizationId: "org-a", initiatorId: "key-a", url: "https://example.com/hooks", secretCipher: "encrypted-secret" } }));
});
it("rejects unsafe callback destinations and bounds subscriptions", async () => {
  mocks.resolve.mockRejectedValueOnce(Error("private destination")); expect((await POST(request())).status).toBe(400);
  mocks.count.mockResolvedValue(5); expect((await POST(request())).status).toBe(409);
});

it("keeps legacy defaults and accepts exact filters, requiring the dedicated scope only for new types", async () => {
  const filtered = (eventTypes: string[]) => new Request("https://kod.bzh/api/v1/mail/webhooks", { method: "POST", body: JSON.stringify({ url: "https://example.com/hooks", eventTypes }) });
  mocks.scope.mockImplementation((_actor, scope) => scope === "mail:send");
  expect((await POST(filtered(["email.mdn"]))).status).toBe(403);
  expect((await POST(filtered(["email.accepted"]))).status).toBe(201);
  expect(mocks.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventTypes: ["email.accepted"] }) }));
  expect((await POST(filtered([]))).status).toBe(400);
  mocks.scope.mockReturnValue(true); expect((await POST(filtered(["email.mdn"]))).status).toBe(201);
  expect(mocks.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventTypes: ["email.mdn"] }) }));
});
