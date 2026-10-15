import { Resolver } from "node:dns/promises";
import { getPlatformMailHost, type DnsLookupIssue } from "./dns-records";
import { checkDomainDeliverability } from "./deliverability";

export type { DnsCheckRow, DnsLookupIssue, DnsRecord, DnsVerifyResult, MxRecordFinding, TxtRecordFinding } from "./dns-records";
export { expectedRecords, formatDnsHostLabel, getExpectedSpfValue, getPlatformApexSpfIncludeTokens, getPlatformMailHost, isPlatformDomain, mailAutoconfigTarget, parseMxRecordValue, parseSrvRecordValue } from "./dns-records";
export { checkDomainDeliverability as verifyDomainDns } from "./deliverability";

export type PlatformARecordCheck = {
  host: string;
  label: string;
  ok: boolean;
  addresses: string[];
  issue: DnsLookupIssue;
};

export async function verifyPlatformARecords(domain?: string): Promise<PlatformARecordCheck[]> {
  const fqdn = domain ?? getPlatformMailHost();
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  return Promise.all([
    { host: fqdn, label: "@" },
    { host: `mail.${fqdn}`, label: "mail" },
    { host: `webmail.${fqdn}`, label: "webmail" },
  ].map(async entry => {
    try {
      const addresses = await resolver.resolve4(entry.host);
      return { ...entry, ok: addresses.length > 0, addresses, issue: null };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const issue: DnsLookupIssue = code === "ENOTFOUND" ? "NXDOMAIN" : code === "ENODATA" ? "ENODATA" : null;
      return { ...entry, ok: false, addresses: [], issue };
    }
  }));
}

export async function verifyPlatformDns(domain?: string) {
  return checkDomainDeliverability(domain ?? getPlatformMailHost());
}
