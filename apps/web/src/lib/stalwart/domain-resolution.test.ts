import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

describe("exact domain resolution", () => {
  it("does not confuse kod.bzh with kod-digor.bzh or trust a stale cached id", async () => {
    vi.stubEnv("STALWART_URL", "https://mail.example.org");
    vi.stubEnv("STALWART_API_KEY", "test-key");
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ methodResponses: [["x:Domain/query", { ids: ["legacy", "new"] }]] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ methodResponses: [["x:Domain/get", { list: [{ id: "legacy", name: "kod-digor.bzh" }, { id: "new", name: "kod.bzh" }] }]] }) });
    vi.stubGlobal("fetch", fetch);
    const { resolveStalwartDomainId } = await import("./client");
    expect(await resolveStalwartDomainId("kod.bzh", "legacy")).toEqual({ id: "new", unavailable: false });
  });
  it("returns no domain when a text query only matches a different name", async () => {
    vi.stubEnv("STALWART_URL", "https://mail.example.org");
    vi.stubEnv("STALWART_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ methodResponses: [["x:Domain/query", { ids: ["legacy"] }]] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ methodResponses: [["x:Domain/get", { list: [{ id: "legacy", name: "kod-digor.bzh" }] }]] }) }));
    const { resolveStalwartDomainId } = await import("./client");
    expect(await resolveStalwartDomainId("kod.bzh")).toEqual({ id: null, unavailable: false });
  });
});
