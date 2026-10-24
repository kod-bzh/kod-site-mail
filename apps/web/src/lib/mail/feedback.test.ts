import { describe, expect, it, vi, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({ original: vi.fn(), connector: vi.fn(), append: vi.fn(), incident: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { outboundMessage: { findFirst: mocks.original }, mailConnector: { findUnique: mocks.connector }, $transaction: (fn: (tx: object) => unknown) => fn({}) } }));
vi.mock("./telemetry", async original => ({ ...await original<object>(), appendTelemetry: mocks.append, setIncident: mocks.incident }));
import { ingestFeedback, parseMdn, parseArf, verifiedDkimDomains, resolveFeedbackDomain } from "./feedback";
const mdn = 'Original-Message-ID: <opaque@example.org>\r\nFinal-Recipient: rfc822; recipient@example.net\r\nDisposition: manual-action/MDN-sent-manually; displayed\r\n';
beforeEach(() => { vi.clearAllMocks(); mocks.original.mockResolvedValue({ id: "message-a", organizationId: "org-a", initiatorId: "key-a", requestReadReceipt: true,
  recipients: { to: ["recipient@example.net"], cc: [], bcc: ["hidden@example.net"] } }); mocks.connector.mockResolvedValue(null); mocks.append.mockResolvedValue(true); });
describe("structured MDN and anonymous feedback", () => {
  it("parses reported disposition without claiming a human read", () => {
    expect(parseMdn(mdn)).toMatchObject({ recipient: "recipient@example.net", disposition: "displayed", rfcMessageId: "opaque@example.org" });
    expect(parseMdn(mdn.replace("displayed", "deleted"))?.disposition).toBe("deleted");
    expect(() => parseMdn(mdn + "Original-Message-ID: <different@example.org>\r\n")).toThrow();
    expect(parseMdn(mdn.replace("displayed", "human-understood"))).toBeNull();
  });
  it("does not infer an ARF recipient from To or a domain statistic", () => {
    expect(parseArf('Feedback-Type: abuse\r\nVersion: 1', 'Message-ID: <opaque@example.org>\r\nTo: recipient@example.net')).toMatchObject({ recipient: null });
  });
  it("ignores forged Authentication-Results when no real DKIM signature exists", async () => {
    expect(await verifiedDkimDomains(Buffer.from('From: attacker@example.net\r\nAuthentication-Results: mail.kod.bzh; dkim=pass header.d=arf.mail.yahoo.com\r\n\r\nBody'))).toEqual([]);
  });
  it("binds correlation to the authorized organization/domain/account and never suppresses", async () => {
    await ingestFeedback({ organizationId: "org-a", domain: "example.org", accountId: "account-a", sourceId: "input", receivedAt: new Date(), kind: "mdn", content: mdn, verifiedDomains: [] });
    expect(mocks.original).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org-a", accountId: "account-a", rfcMessageId: "opaque@example.org", fromAddress: { endsWith: "@example.org" } } }));
    expect(mocks.append).toHaveBeenCalledWith({}, expect.objectContaining({ organizationId: "org-a", messageId: "message-a", reliability: "unverified_report", data: expect.objectContaining({ humanReadingProven: false }) }));
    mocks.original.mockResolvedValue(null); mocks.append.mockClear();
    expect(await ingestFeedback({ organizationId: "org-b", domain: "example.org", accountId: "account-b", sourceId: "input", receivedAt: new Date(), kind: "mdn", content: mdn, verifiedDomains: [] })).toBe(false);
    expect(mocks.append).not.toHaveBeenCalled();
  });
  it("never claims a receipt that was not requested or an unknown recipient", async () => {
    for (const content of [mdn.replace("recipient@example.net", "other@example.net"), mdn]) {
      if (content === mdn) mocks.original.mockResolvedValue({ requestReadReceipt: false });
      expect(await ingestFeedback({ organizationId: "org-a", domain: "example.org", accountId: "account-a", sourceId: "input", receivedAt: new Date(), kind: "mdn", content, verifiedDomains: [] })).toBe(false);
    }
    expect(mocks.append).not.toHaveBeenCalled();
  });
  it("deduplicates equivalent feedback independent of mailbox delivery ids", async () => {
    const input = { organizationId: "org-a", domain: "example.org", accountId: "account-a", sourceId: "first", receivedAt: new Date(), kind: "mdn" as const, content: mdn, verifiedDomains: ["example.net"] };
    await ingestFeedback(input); await ingestFeedback({ ...input, sourceId: "resent-envelope", receivedAt: new Date(Date.now() - 1000) });
    expect(mocks.append.mock.calls[0][1].id).toBe(mocks.append.mock.calls[1][1].id);
  });
  it("preserves anonymous complaints at message scope and hides Bcc", async () => {
    await ingestFeedback({ organizationId: "org-a", domain: "example.org", accountId: "report-inbox", sourceId: "arf", receivedAt: new Date(), kind: "arf",
      content: 'Feedback-Type: abuse\r\nVersion: 1', originalHeaders: 'Message-ID: <opaque@example.org>\r\nTo: recipient@example.net', verifiedDomains: ["arf.mail.yahoo.com"] });
    expect(mocks.append).toHaveBeenCalledWith({}, expect.objectContaining({ type: "email.complaint", recipient: null, source: "yahoo_cfl", reliability: "authenticated_provider_report", data: expect.objectContaining({ recipientIdentified: false }) }));
  });
});

it("surfaces an authenticated uncorrelatable complaint as an inbox incident without assigning a person or sending domain", async () => {
  mocks.original.mockResolvedValue(null);
  await ingestFeedback({ organizationId: "org-a", domain: "example.org", accountId: "reports", sourceId: "anonymous", receivedAt: new Date(), kind: "arf",
    content: 'Feedback-Type: abuse\r\nVersion: 1', originalHeaders: '', verifiedDomains: ["arf.mail.yahoo.com"] });
  expect(mocks.append).not.toHaveBeenCalled(); expect(mocks.incident).toHaveBeenCalledWith(expect.objectContaining({ code: "unmatched_feedback:yahoo_cfl", evidence: expect.objectContaining({ scope: "monitored_inbox" }) }));
});

it("resolves each MDN against its actual sender when multiple domains share an account", async () => {
  const domains = ["first.example", "second.example"];
  for (const domain of domains) {
    mocks.original.mockResolvedValue({ fromAddress: `sender@${domain}` });
    expect(await resolveFeedbackDomain({ organizationId: "org-a", accountId: "shared", domains, fallbackDomain: "second.example", kind: "mdn", content: mdn })).toBe(domain);
  }
  mocks.original.mockResolvedValue({ fromAddress: "sender@unrelated.example" });
  expect(await resolveFeedbackDomain({ organizationId: "org-a", accountId: "shared", domains, fallbackDomain: "second.example", kind: "mdn", content: mdn })).toBe("second.example");
});
