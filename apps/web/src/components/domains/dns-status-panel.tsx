"use client";

import { useT } from "@/i18n/t";
import type { DnsVerifyResult } from "@/lib/dns/dns-records";

export function DnsStatusPanel({ check }: { check: DnsVerifyResult; mailHost: string }) {
  const t = useT("domains");
  return (
    <section className="space-y-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm" aria-label={t("dnsCurrentTitle")}>
      <h4 className="font-medium text-zinc-900">{t("dnsCurrentTitle")}</h4>
      {check.checkedAt && <p className="text-xs text-zinc-500">{t("dnsCheckedAt", { date: new Date(check.checkedAt).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }) })}</p>}
      <ul className="space-y-3">
        {check.results.map(row => (
          <li key={`${row.record.type}-${row.record.name}`} className="space-y-2 rounded-md border border-zinc-200 bg-white p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="break-all">{row.record.type} · {row.record.name}</strong>
              <span className={row.ok ? "text-green-800" : row.required ? "text-amber-800" : "text-zinc-600"}>
                {row.ok ? t("dnsPass") : t("dnsFail")}
              </span>
            </div>
            <p className="text-xs text-zinc-500">{row.record.type === "PTR" ? t("dnsServerManaged") : row.required ? t("dnsRequired") : t("dnsOptional")}</p>
            {row.detail && <p>{row.detail}</p>}
            <p className="text-xs text-zinc-500">{t("dnsExpected")}</p>
            <code className="block break-all rounded bg-zinc-50 p-2 text-xs">{row.record.value}</code>
            <p className="text-xs text-zinc-500">{t("dnsFound")}</p>
            <code className="block break-all rounded bg-zinc-50 p-2 text-xs">{row.found}</code>
          </li>
        ))}
      </ul>
      {Boolean(check.warnings?.length) && <div className="space-y-2 text-zinc-700"><h5 className="font-medium">{t("dnsGuidance")}</h5>{check.warnings?.map(warning => <p key={warning}>{warning}</p>)}</div>}
    </section>
  );
}
