import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { MAX_REPORT_BYTES, parseDmarcReport } from "./dmarc-report";
const xml = `<feedback><report_metadata><org_name>Example reporter</org_name><report_id>test-1</report_id><date_range><begin>1792022400</begin><end>1792108800</end></date_range></report_metadata><policy_published><domain>mail.d2-group.fr</domain><p>none</p></policy_published><record><row><source_ip>51.15.220.2</source_ip><count>3</count><policy_evaluated><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row></record><record><row><source_ip>192.0.2.1</source_ip><count>2</count><policy_evaluated><dkim>fail</dkim><spf>fail</spf></policy_evaluated></row></record></feedback>`;
describe("DMARC reports are bounded untrusted input", () => {
  it("reads XML and gzip reports, counting aligned passes", async () => {
    for (const data of [Buffer.from(xml), gzipSync(xml)]) {
      const parsed = await parseDmarcReport(data, "report.xml.gz", "mail.d2-group.fr");
      expect(parsed.totalCount).toBe(5); expect(parsed.dkimPassCount).toBe(3); expect(parsed.spfPassCount).toBe(3);
      expect(parsed.sourcesJson[0].ip).toBe("51.15.220.2");
    }
  });
  it("rejects reports for a different organization domain", async () => {
    await expect(parseDmarcReport(Buffer.from(xml), "report.xml", "other.example")).rejects.toThrow(/domaine/);
  });
  it("rejects DTDs, entities, malformed XML, and decompression bombs", async () => {
    await expect(parseDmarcReport(Buffer.from(`<!DOCTYPE feedback [<!ENTITY x SYSTEM "file:///etc/passwd">]>${xml}`), "report.xml", "mail.d2-group.fr")).rejects.toThrow(/interdit/);
    await expect(parseDmarcReport(Buffer.from("<feedback>"), "report.xml", "mail.d2-group.fr")).rejects.toThrow();
    await expect(parseDmarcReport(gzipSync(Buffer.alloc(MAX_REPORT_BYTES + 1)), "report.xml.gz", "mail.d2-group.fr")).rejects.toThrow();
  });
});
