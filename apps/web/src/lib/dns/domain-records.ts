import { expectedRecords, getPlatformMailHost, type DnsRecord } from "./dns-records";
import { getDomainDkimRecords } from "@/lib/stalwart/client";

export async function domainDnsRecords(fqdn: string, platformHost = getPlatformMailHost()) {
  const dkim = await getDomainDkimRecords(fqdn);
  const records: DnsRecord[] = [...expectedRecords(fqdn, platformHost), ...dkim.records];
  return { records, signingConfigured: dkim.available, signingEnabled: dkim.signingEnabled };
}
