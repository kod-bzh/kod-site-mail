import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { outboundMessage: { findMany: mocks.find } } }));
import { orangeDiagnostic, recipientProvider, smtpMetrics } from "./smtp-metrics";
beforeEach(() => vi.clearAllMocks());
it("recognizes French providers by exact recipient domains or bounded MX suffixes", () => {
  expect(recipientProvider("test@WANADOO.FR")).toBe("orange_wanadoo");
  expect(recipientProvider("test@example.org", "mwinf.example.orange.fr.")).toBe("orange_wanadoo");
  for (const [domain, provider] of [["sfr.fr", "sfr"], ["free.fr", "free"], ["laposte.net", "laposte"]]) expect(recipientProvider(`test@${domain}`)).toBe(provider);
  for (const host of ["orange.fr.evil.test", "fakeorange.fr", "evil-sfr.fr", "free.fr.evil.test"]) expect(recipientProvider("test@example.org", host)).toBe("other_or_unknown");
  expect(recipientProvider("test@orange.fr", "tenant.mail.protection.outlook.com")).toBe("microsoft365");
});
it("interprets explicit OFR suffixes only from an observed Orange SMTP reply", () => {
  expect(orangeDiagnostic("orange_wanadoo", { source: "smtp", smtpReply: "550 IP blocked OFR_099" })).toMatchObject({ code: "099", category: "ip_blocked" });
  expect(orangeDiagnostic("orange_wanadoo", { source: "smtp", smtpReply: "421 Too many connections OFR002_104" })).toMatchObject({ code: "104", category: "connection_limit" });
  expect(orangeDiagnostic("orange_wanadoo", { source: "smtp", smtpReply: "550 Message blocked OFR_506" })).toMatchObject({ code: "506", category: "suspected_spam" });
  expect(orangeDiagnostic("orange_wanadoo", { source: "smtp", smtpReply: "451 OFR123_989" })).toMatchObject({ category: "reputation_limited" });
  expect(orangeDiagnostic("orange_wanadoo", { source: "dsn", smtpReply: "550 OFR_506" })).toBeNull();
  expect(orangeDiagnostic("google_mx", { source: "smtp", smtpReply: "550 OFR_506" })).toBeNull();
  expect(orangeDiagnostic("orange_wanadoo", { source: "smtp", smtpReply: "550 Address contains 506" })).toBeNull();
  expect(orangeDiagnostic("orange_wanadoo", { source: "smtp", smtpReply: "250 Accepted with reference OFR_506" })).toBeNull();
});
it("keeps absent French metrics and inbox placement unknown, with organization/domain query isolation", async () => {
  mocks.find.mockResolvedValue([]);
  const result = await smtpMetrics("org-a", "example.org", new Date(0), new Date(1000));
  expect(mocks.find).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: "org-a", fromAddress: { endsWith: "@example.org" } }) }));
  for (const row of result.providers) expect(row).toMatchObject({ availability: "unknown", accepted: null, failed: null, inboxPlacement: null, rejectionRate: { value: null, denominator: null } });
});
it("separates Orange policy evidence from SMTP acceptance and never returns Bcc addresses or raw replies", async () => {
  const observedAt = "2026-10-24T10:00:00Z";
  mocks.find.mockResolvedValue([{ recipients: { to: ["invoice@wanadoo.fr"], cc: [], bcc: ["private@orange.fr"] },
    deliveryJson: { "invoice@wanadoo.fr": { source: "smtp", state: "FAILED", observedAt, smtpReply: "550 Message invoice@wanadoo.fr blocked OFR_506" },
      "private@orange.fr": { source: "smtp", state: "ACCEPTED", observedAt, smtpReply: "250 OK" } }, status: "PARTIAL" }]);
  const result = await smtpMetrics("org-a", "example.org", new Date(0), new Date());
  const row = result.providers.find(item => item.provider === "orange_wanadoo")!;
  expect(row).toMatchObject({ accepted: 1, failed: 1, lastSmtpObservationAt: observedAt, inboxPlacement: null, diagnostics: [{ code: "506", category: "suspected_spam", count: 1 }], rejectionRate: { value: null, denominator: 2 } });
  expect(JSON.stringify(result)).not.toContain("invoice@wanadoo.fr"); expect(JSON.stringify(result)).not.toContain("private@orange.fr");
});
