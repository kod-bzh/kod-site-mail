import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ google: vi.fn(), incident: vi.fn(),
  db: { domain: { findMany: vi.fn(), findUnique: vi.fn() }, mailMonitoredDomain: { findMany: vi.fn() },
    mailConnector: { createMany: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    mailObservation: { deleteMany: vi.fn() }, mailTelemetryEvent: { deleteMany: vi.fn() }, mailIncident: { deleteMany: vi.fn() } } }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.db }));
vi.mock("./telemetry", () => ({ setIncident: mocks.incident }));
vi.mock("./provider-connectors", async importOriginal => ({ ...await importOriginal<typeof import("./provider-connectors")>(),
  fetchGoogle: mocks.google, readConfiguration: () => ({ clientId: "fixture-client", clientSecret: "fixture-secret", refreshToken: "fixture-refresh" }) }));
import { pollDeliverability } from "./deliverability-monitor";
let stored: { leaseUntil: Date | null; secretCipher: string; state: string; nextCheckAt: Date };
beforeEach(() => {
  vi.clearAllMocks(); stored = { leaseUntil: null, secretCipher: "old-secret", state: "active", nextCheckAt: new Date(0) };
  mocks.db.domain.findMany.mockResolvedValue([]); mocks.db.mailMonitoredDomain.findMany.mockResolvedValue([]);
  mocks.db.domain.findUnique.mockResolvedValue({ id: "domain", organizationId: "org-a", fqdn: "example.org" });
  mocks.db.mailConnector.findMany.mockResolvedValue([{ id: "connector", organizationId: "org-a", domain: "example.org", provider: "google_postmaster", secretCipher: "old-secret", state: "active", expiresAt: null }]);
  mocks.db.mailConnector.updateMany.mockImplementation(async ({ where, data }) => {
    if (where.OR || where.leaseUntil?.getTime() === stored.leaseUntil?.getTime() && where.secretCipher === stored.secretCipher) {
      Object.assign(stored, data); return { count: 1 };
    }
    return { count: 0 };
  });
  mocks.google.mockResolvedValue([]);
});
it("finishes a current collection and preserves the absence of Google statistics", async () => {
  await pollDeliverability(); expect(stored.state).toBe("insufficient_data"); expect(stored.leaseUntil).toBeNull();
  expect(mocks.db.mailConnector.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastSuccessAt: expect.any(Date) }) }));
});
it("does not overwrite a new OAuth grant or postpone its immediate collection after an old poll fails", async () => {
  const scheduled = new Date();
  mocks.google.mockImplementation(async () => { Object.assign(stored, { leaseUntil: null, secretCipher: "new-secret", state: "insufficient_data", nextCheckAt: scheduled }); throw Error("Old grant was revoked"); });
  await pollDeliverability(); expect(stored).toMatchObject({ secretCipher: "new-secret", state: "insufficient_data", nextCheckAt: scheduled });
  expect(mocks.incident).not.toHaveBeenCalled();
});
it("does not release or overwrite the lease of a replacement worker", async () => {
  const replacementLease = new Date(Date.now() + 600_000);
  mocks.google.mockImplementation(async () => { stored.leaseUntil = replacementLease; return []; });
  await pollDeliverability(); expect(stored.leaseUntil).toBe(replacementLease); expect(stored.state).toBe("active"); expect(mocks.incident).not.toHaveBeenCalled();
});
