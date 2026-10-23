import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));
import { isPublicAddress, resolveWebhook, postWebhook, webhookUrl } from "./webhook-http";
beforeEach(() => vi.clearAllMocks());
it("blocks loopback, private, link-local, mapped, transition and documentation addresses", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::"]) expect(isPublicAddress(ip), ip).toBe(false);
  expect(isPublicAddress("1.1.1.1")).toBe(true); expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
});
it("rejects unsafe URL forms and mixed DNS results", async () => {
  for (const url of ["http://example.com/", "https://user:pass@example.com/", "https://example.com:8443/", "https://example.com/#secret"]) expect(() => webhookUrl(url)).toThrow();
  mocks.lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }, { address: "127.0.0.1", family: 4 }]);
  await expect(resolveWebhook("https://example.com/")).rejects.toThrow();
});
it("pins the validated IP and returns redirects for retry without following them", async () => {
  mocks.lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
  const destroy = vi.fn();
  mocks.request.mockImplementation((_url, options, response) => {
    options.lookup("example.com", {}, (error: unknown, address: string) => { expect(error).toBeNull(); expect(address).toBe("1.1.1.1"); });
    return { on: vi.fn(), end: () => response({ statusCode: 302, destroy }) };
  });
  expect(await postWebhook("https://example.com/callback", "{}", {})).toBe(302);
  expect(mocks.request).toHaveBeenCalledTimes(1); expect(destroy).toHaveBeenCalled();
});
