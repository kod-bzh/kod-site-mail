import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ boxes: vi.fn(), aliases: vi.fn(), save: vi.fn(), feedback: vi.fn(), matching: vi.fn(), receipt: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { mailbox: { findMany: mocks.boxes }, emailAlias: { findMany: mocks.aliases }, dmarcReport: { upsert: mocks.save }, outboundMessage: { findMany: mocks.matching } } }));
vi.mock("./feedback", () => ({ ingestFeedback: mocks.feedback, resolveFeedbackDomain: mocks.resolve })); vi.mock("./receipts", () => ({ ingestReceipt: mocks.receipt, dsnEventId: () => "dsn-fixture" }));
import { digest } from "./telemetry";
import { ingestIncomingReport } from "./incoming-reports";
beforeEach(() => { vi.clearAllMocks(); mocks.boxes.mockResolvedValue([{ id: "box-a", organizationId: "org-a", address: "postmaster@example.org", stalwartAccountId: "account-a" }]);
  mocks.matching.mockResolvedValue([]); mocks.resolve.mockResolvedValue("example.org"); mocks.feedback.mockResolvedValue(true); mocks.aliases.mockResolvedValue([{ organizationId: "org-a", source: "dmarc@example.org", destination: "postmaster@example.org" }]); });
const report = { reportedDomain: "example.org", reporter: "Fixture", reportIdentifier: "simulated", periodStart: new Date(Date.now() - 86400000).toISOString(), periodEnd: new Date().toISOString(), filename: "report.xml",
  sourcesJson: [{ ip: "192.0.2.1", count: 2, dkim: false, spf: false, dkimAlignment: "fail" as const, spfAlignment: "fail" as const, disposition: "none", headerFrom: "example.org", dkimAuth: [], spfAuth: [] }] };
const input = { id: "a".repeat(64), address: "dmarc@example.org", targetRef: digest(["org-a", "box-a", "account-a", "dmarc@example.org", "example.org"]), occurredAt: new Date().toISOString(), peerIp: "192.0.2.5", verifiedDomains: [], kind: "dmarc" as const, report };
it("derives organization/account from the authenticated native receiver, not report claims", async () => {
  await ingestIncomingReport(input); expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ organizationId: "org-a", mailboxId: "box-a", totalCount: 2, dkimPassCount: 0, provenance: "native_inbound_unverified_aggregate" }) }));
  mocks.save.mockClear(); await ingestIncomingReport({ ...input, address: "dmarc@other.example" }); await ingestIncomingReport({ ...input, report: { ...report, reportedDomain: "other.example" } });
  expect(mocks.save).not.toHaveBeenCalled();
});
it("uses semantic deduplication across native event redelivery ids and refuses invalid time", async () => {
  await ingestIncomingReport(input); await ingestIncomingReport({ ...input, id: "b".repeat(64) });
  expect(mocks.save.mock.calls[0][0].where).toEqual(mocks.save.mock.calls[1][0].where);
  await expect(ingestIncomingReport({ ...input, occurredAt: new Date(Date.now() + 86400000).toISOString() })).rejects.toThrow();
});

it("rejects a queued report after mailbox ownership or account binding changes", async () => {
  mocks.boxes.mockResolvedValue([{ id: "box-b", organizationId: "org-b", address: "postmaster@example.org", stalwartAccountId: "account-b" }]);
  mocks.aliases.mockResolvedValue([{ organizationId: "org-b", source: "dmarc@example.org", destination: "postmaster@example.org" }]);
  expect(await ingestIncomingReport(input)).toBe(false); expect(mocks.save).not.toHaveBeenCalled();
});

it("scopes malformed report diagnostics to the receiving organization/domain without a global relay failure", async () => {
  const { report: omitted, ...base } = input; void omitted;
  await ingestIncomingReport({ ...base, kind: "invalid_report", reason: "invalid_dmarc_report", diagnosticRef: "c".repeat(64) });
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ organizationId: "org-a", reportedDomain: "example.org", error: "invalid_dmarc_report" }) }));
});

it("quarantines an invalid structured report instead of retrying it as a global collector outage", async () => {
  mocks.feedback.mockRejectedValue(Object.assign(new Error("Duplicate structured field"), { code: "invalid_structured_report" }));
  const { report: omitted, ...base } = input; void omitted;
  expect(await ingestIncomingReport({ ...base, kind: "mdn", address: "postmaster@example.org", targetRef: digest(["org-a", "box-a", "account-a", "postmaster@example.org", "example.org"]), content: "invalid fixture" })).toBe(true);
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ organizationId: "org-a", error: "invalid_structured_report" }) }));
});

it("allows native MDN correlation only for sender identities that requested a receipt at this controlled account/address", async () => {
  mocks.matching.mockResolvedValue([{ fromAddress: "billing@shop.example.org" }]);
  const { report: omitted, ...base } = input; void omitted;
  await ingestIncomingReport({ ...base, kind: "mdn", address: "postmaster@example.org", targetRef: digest(["org-a", "box-a", "account-a", "postmaster@example.org", "example.org"]), content: "fixture" });
  expect(mocks.matching).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org-a", accountId: "account-a", requestReadReceipt: true, readReceiptAddress: "postmaster@example.org" } }));
  expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ domains: ["example.org", "shop.example.org"] }));
});
