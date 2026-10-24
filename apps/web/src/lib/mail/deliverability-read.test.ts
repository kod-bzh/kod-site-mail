import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), resolve: vi.fn(), domains: vi.fn(), monitored: vi.fn(), incidents: vi.fn(), observations: vi.fn(), reports: vi.fn(), connector: vi.fn(), monitor: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { domain: { findMany: mocks.domains }, mailMonitoredDomain: { findMany: mocks.monitored }, mailIncident: { findMany: mocks.incidents }, mailObservation: { findMany: mocks.observations }, dmarcReport: { findMany: mocks.reports }, mailConnector: { findUnique: mocks.connector }, mailMonitorState: { findUnique: mocks.monitor } } }));
vi.mock("@/lib/api/v1-auth", () => ({ resolveV1ActorFromRequest: mocks.actor, resolveActorOrganizationId: mocks.resolve,
  actorHasScope: (actor: { scopes: string[] }, scope: string) => actor.scopes.includes(scope) }));
import { readScope, dmarcSummary } from "./deliverability-read";
import { GET as alerts } from "@/app/api/v1/mail/alerts/route";
beforeEach(() => { vi.clearAllMocks(); mocks.actor.mockResolvedValue({ organizationId: "org-a", apiKeyId: "key-a", scopes: ["deliverability:read"], allowedMailDomains: ["mail.example.org"] });
  mocks.resolve.mockResolvedValue({ ok: true, organizationId: "org-a" }); mocks.domains.mockResolvedValue([{ fqdn: "mail.example.org" }]); mocks.monitored.mockResolvedValue([]); mocks.incidents.mockResolvedValue([]); });
it("requires dedicated read authorization before consulting any tenant data", async () => {
  mocks.actor.mockResolvedValue(null); expect((await readScope(new Request("https://kod.bzh/api/v1/mail/deliverability"))).error?.status).toBe(401);
  mocks.actor.mockResolvedValue({ scopes: ["mail:send"] }); expect((await readScope(new Request("https://kod.bzh/api/v1/mail/deliverability"))).error?.status).toBe(403);
  expect(mocks.domains).not.toHaveBeenCalled();
});
it("enforces both organization and the key domain allowlist, including observation-only domains", async () => {
  const scope = await readScope(new Request("https://kod.bzh/api/v1/mail/domains/mail.example.org/health"), "other.example.org"); expect(scope.error?.status).toBe(404);
  expect(mocks.domains).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org-a", fqdn: { in: ["mail.example.org"] } } }));
  expect(mocks.monitored).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org-a", domain: { in: ["mail.example.org"] } } }));
  mocks.resolve.mockResolvedValue({ ok: false, error: "organization_forbidden" }); expect((await readScope(new Request("https://kod.bzh/api/v1/mail/alerts?organizationSlug=other"))).error?.status).toBe(403);
});
it("bounds incident pagination and excludes unauthorized domains even without an explicit filter", async () => {
  const response = await alerts(new Request("https://kod.bzh/api/v1/mail/alerts?limit=10&status=open")); expect(response.status).toBe(200);
  expect(mocks.incidents).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org-a", domain: { in: ["mail.example.org"] }, status: "open" }, take: 11 }));
  expect((await alerts(new Request("https://kod.bzh/api/v1/mail/alerts?limit=10000"))).status).toBe(400);
});

it("does not count a Graph or JMAP report as proof of the native pre-encryption intake", async () => {
  const now = new Date(), start = new Date(now.getTime() - 86400000);
  const report = { id: "graph-report", provenance: "microsoft_graph_unverified_aggregate", sourcesJson: [], totalCount: 3, createdAt: now, periodStart: start, periodEnd: now };
  mocks.connector.mockResolvedValue(null); mocks.monitor.mockResolvedValue({ checkedAt: now, lastError: null });
  mocks.reports.mockResolvedValueOnce([report]).mockResolvedValueOnce([]);
  const graphOnly = await dmarcSummary("org-a", "example.org", { start, end: now });
  expect(graphOnly.reportCount).toBe(1); expect(graphOnly.nativeIntake.receivedReportCount).toBeNull();
  mocks.reports.mockResolvedValueOnce([report, { ...report, id: "native-report", provenance: "native_inbound_unverified_aggregate" }]).mockResolvedValueOnce([]);
  expect((await dmarcSummary("org-a", "example.org", { start, end: now })).nativeIntake.receivedReportCount).toBe(1);
});
