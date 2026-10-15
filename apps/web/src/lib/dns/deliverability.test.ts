import { beforeEach, describe, expect, it, vi } from "vitest";
const { records, resolveTxt, reverse } = vi.hoisted(() => ({ records: vi.fn(), resolveTxt: vi.fn(), reverse: vi.fn() }));
vi.mock("./domain-records", () => ({ domainDnsRecords: records }));
vi.mock("node:dns/promises", () => ({ Resolver: class {
  setServers() {}
  resolveTxt = resolveTxt;
  reverse = reverse;
  async resolve4() { return ["192.0.2.10"]; }
  async resolve6() { return []; }
  async resolveMx() { return [{ exchange: "google.example", priority: 10 }]; }
  async resolveCname() { throw Object.assign(Error(), { code: "ENODATA" }); }
  async resolveSrv() { throw Object.assign(Error(), { code: "ENODATA" }); }
} }));
import { checkDomainDeliverability } from "./deliverability";
const dnsRecords = [
  { type: "TXT", name: "example.org", value: "v=spf1 ip4:192.0.2.10 -all" },
  { type: "TXT", name: "_dmarc.example.org", value: "v=DMARC1; p=none" },
  { type: "TXT", name: "kod._domainkey.example.org", value: "v=DKIM1; k=rsa; p=abc" },
  { type: "MX", name: "example.org", value: "10 mail.platform.org." },
  { type: "CNAME", name: "autoconfig.example.org", value: "mail.platform.org." },
];
beforeEach(() => {
  records.mockResolvedValue({ records: dnsRecords, signingConfigured: true, signingEnabled: true });
  resolveTxt.mockImplementation(async name => [dnsRecords.filter(record => record.name === name && record.type === "TXT").map(record => record.value)]);
  reverse.mockResolvedValue(["mail.platform.org"]);
});
describe("deliverability diagnostics", () => {
  it("does not require moving existing MX or installing autoconfig", async () => {
    const result = await checkDomainDeliverability("example.org", "platform.org");
    expect(result.verified).toBe(true);
    expect(result.results.find(row => row.record.type === "MX")).toMatchObject({ ok: false, required: false });
    expect(result.sendingAllowed).toBe(true);
  });
  it("cannot report verified when DKIM material is unavailable", async () => {
    records.mockResolvedValue({ records: dnsRecords.slice(0, 2), signingConfigured: false });
    expect((await checkDomainDeliverability("example.org", "platform.org")).verified).toBe(false);
  });
  it("keeps sending authorized but reports mismatched public DKIM and reverse DNS", async () => {
    reverse.mockResolvedValue(["generic.provider.org"]);
    resolveTxt.mockImplementation(async name => name.includes("_domainkey") ? [["v=DKIM1; k=rsa; p=wrong"]] : [dnsRecords.filter(record => record.name === name && record.type === "TXT").map(record => record.value)]);
    const result = await checkDomainDeliverability("example.org", "platform.org");
    expect(result.verified).toBe(false);
    expect(result.sendingAllowed).toBe(true);
    expect(result.results.find(row => row.record.type === "PTR")?.ok).toBe(false);
    expect(result.results.find(row => row.record.name.includes("_domainkey"))?.ok).toBe(false);
  });
});

it("does not mark DNS ready when server signing is disabled", async () => {
  records.mockResolvedValue({ records: dnsRecords, signingConfigured: true, signingEnabled: false });
  const result = await checkDomainDeliverability("example.org", "platform.org");
  expect(result.verified).toBe(false);
  expect(result.results.find(row => row.record.type === "DKIM")?.found).toBe("Désactivée");
});
