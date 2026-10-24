import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ boxes: vi.fn(), state: vi.fn(), claim: vi.fn(), updateState: vi.fn(), find: vi.fn(), save: vi.fn(), invalid: vi.fn(), list: vi.fn(), download: vi.fn(), mark: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { mailbox: { findMany: mocks.boxes }, mailMonitorState: { upsert: mocks.state, updateMany: mocks.claim, update: mocks.updateState }, dmarcReport: { findUnique: mocks.find, upsert: mocks.save, create: mocks.invalid } } }));
vi.mock("@/lib/stalwart/client", () => ({ listDmarcMessages: mocks.list, downloadReportBlob: mocks.download, markDmarcProcessed: mocks.mark }));
import { pollDmarcReports } from "./dmarc-monitor";
it("retries a storage failure without marking a valid report processed or classifying it as invalid XML", async () => {
  mocks.boxes.mockResolvedValue([{ id: "box", organizationId: "org-a", address: "dmarc@example.org", stalwartAccountId: "account-a" }]);
  mocks.claim.mockResolvedValue({ count: 1 }); mocks.find.mockResolvedValue(null);
  mocks.list.mockResolvedValue([{ id: "report", receivedAt: new Date().toISOString(), encrypted: false, attachments: [{ name: "report.xml", blobId: "blob", size: 1000 }] }]);
  const end = Math.floor(Date.now() / 1000);
  mocks.download.mockResolvedValue(Buffer.from(`<feedback><report_metadata><org_name>Fixture</org_name><report_id>fixture</report_id><date_range><begin>${end - 86400}</begin><end>${end}</end></date_range></report_metadata><policy_published><domain>example.org</domain></policy_published><record><row><source_ip>192.0.2.1</source_ip><count>1</count><policy_evaluated><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row></record></feedback>`));
  mocks.save.mockRejectedValue(Error("Simulated storage outage with private diagnostic"));
  await pollDmarcReports(); expect(mocks.mark).not.toHaveBeenCalled(); expect(mocks.invalid).not.toHaveBeenCalled();
  expect(mocks.updateState).toHaveBeenCalledWith(expect.objectContaining({ data: { lastError: expect.stringContaining("Collecte DMARC indisponible") } }));
  expect(JSON.stringify(mocks.updateState.mock.calls)).not.toContain("private diagnostic");
});
