export type DnsRecord = { type: string; name: string; value: string; stage?: string };

export type MxRecordFinding = {
  priority: number;
  host: string;
  matchesExpected: boolean;
};

export type TxtRecordFinding = {
  value: string;
  kind: "spf" | "other";
  matchesExpected: boolean;
};

export type DnsLookupIssue = "NXDOMAIN" | "ENODATA" | null;

export type DnsCheckRow = {
  record: DnsRecord;
  ok: boolean;
  found: string;
  issue: DnsLookupIssue;
  required?: boolean;
  detail?: string;
  mxRecords?: MxRecordFinding[];
  txtRecords?: TxtRecordFinding[];
};

export type DnsVerifyResult = {
  verified: boolean;
  domainExists: boolean;
  results: DnsCheckRow[];
  checkedAt?: string;
  warnings?: string[];
  sendingAllowed?: boolean;
};

export function getPlatformMailHost() {
  return (
    process.env.PRIMARY_PLATFORM_DOMAIN ??
    process.env.PRIMARY_MAIL_HOST ??
    "kod.bzh"
  );
}

/** SPF recommandé pour les domaines d'associations (include vers le sous-domaine plateforme). */
export function getExpectedSpfValue(platformHost?: string) {
  const host = platformHost ?? getPlatformMailHost();
  return `v=spf1 include:spf.${host} -all`;
}

/** Tokens SPF acceptés sur le domaine plateforme apex (prod : mail + TEM Scaleway). */
export function getPlatformApexSpfIncludeTokens(platformHost?: string) {
  const host = (platformHost ?? getPlatformMailHost()).toLowerCase();
  return [`include:spf.${host}`, "include:_spf.tem.scaleway.com"];
}

export function mailAutoconfigTarget(platformHost: string) {
  return `mail.${platformHost}.`;
}

/** Nom d'hôte relatif pour les registrars (@, autoconfig, _imaps._tcp, …). */
export function formatDnsHostLabel(name: string, fqdn: string) {
  if (name === fqdn) return "@";
  const suffix = `.${fqdn}`;
  if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  return name;
}

export function parseMxRecordValue(value: string) {
  const match = value.match(/^(\d+)\s+(.+)$/);
  if (!match) return { priority: "—", target: value };
  return { priority: match[1], target: match[2] };
}

export function parseSrvRecordValue(value: string) {
  const match = value.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) {
    return { priority: "—", weight: "—", port: "—", target: value };
  }
  return {
    priority: match[1],
    weight: match[2],
    port: match[3],
    target: match[4],
  };
}

export function expectedRecords(fqdn: string, mailHost?: string): DnsRecord[] {
  const platformHost = mailHost ?? getPlatformMailHost();
  const mailTarget = mailAutoconfigTarget(platformHost);
  return [
    { type: "MX", name: fqdn, value: `10 ${mailTarget}` },
    { type: "TXT", name: fqdn, value: getExpectedSpfValue(platformHost) },
    { type: "TXT", name: `_dmarc.${fqdn}`, value: "v=DMARC1; p=none" },
    { type: "CNAME", name: `autoconfig.${fqdn}`, value: mailTarget },
    { type: "CNAME", name: `autodiscover.${fqdn}`, value: mailTarget },
    {
      type: "SRV",
      name: `_imaps._tcp.${fqdn}`,
      value: `0 1 993 mail.${platformHost}.`,
    },
    {
      type: "SRV",
      name: `_submission._tcp.${fqdn}`,
      value: `0 1 587 mail.${platformHost}.`,
    },
  ];
}

export function isPlatformDomain(fqdn: string) {
  return fqdn.toLowerCase() === getPlatformMailHost().toLowerCase();
}
