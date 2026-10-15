"use client";

import { useActionState } from "react";
import { deleteDomainAction } from "@/app/actions/domains";
import { DeleteDomainForm } from "@/components/domains/delete-domain-form";
import { DnsRecordsTable } from "@/components/domains/dns-records-table";
import { DnsStatusPanel } from "@/components/domains/dns-status-panel";
import { VerifyDomainForm } from "@/components/domains/verify-domain-form";
import { FormFeedback } from "@/components/ui/form-feedback";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { INITIAL_ACTION_RESULT } from "@/lib/action-result";
import type { DnsRecord, DnsVerifyResult } from "@/lib/dns/dns-records";

export type DomainCardData = {
  id: string;
  fqdn: string;
  isVerified: boolean;
  isPlatform: boolean;
  records: DnsRecord[];
  dnsCheck: DnsVerifyResult | null;
};

type DomainsListLabels = {
  statusVerified: string;
  statusPending: string;
  verified: string;
  pending: string;
  usableWhilePending: string;
  records: string;
  recordsIntro: string;
  recordsAutoconfigHint: string;
};

type TableLabels = {
  colType: string;
  colHost: string;
  colPriority: string;
  colValue: string;
  copy: string;
  copied: string;
  hostRootHint: string;
  srvValueHint: string;
};

export function DomainsList({
  domains,
  labels,
  tableLabels,
  mailHost,
}: {
  domains: DomainCardData[];
  labels: DomainsListLabels;
  tableLabels: TableLabels;
  mailHost: string;
}) {
  const [deleteState, deleteAction] = useActionState(deleteDomainAction, INITIAL_ACTION_RESULT);

  return (
    <div className="space-y-4">
      <FormFeedback state={deleteState} namespace="domains" paramKey="domain" />

      {domains.map((domain) => (
        <Card key={domain.id}>
          <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-2">
            <CardTitle className="text-lg">{domain.fqdn}</CardTitle>
            <span
              className={
                domain.isVerified
                  ? "rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800"
                  : "rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800"
              }
            >
              {domain.isVerified ? labels.statusVerified : labels.statusPending}
            </span>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-zinc-600">
              {domain.isVerified ? labels.verified : labels.pending}
            </p>
            {!domain.isVerified && (
              <p className="text-sm text-amber-800">{labels.usableWhilePending}</p>
            )}

            {domain.records.length > 0 && (
              <div className="space-y-3">
                <div>
                  <h3 className="text-sm font-medium text-zinc-900">{labels.records}</h3>
                  <p className="mt-1 text-sm text-zinc-500">{labels.recordsIntro}</p>
                  <p className="mt-2 text-sm text-zinc-600">{labels.recordsAutoconfigHint}</p>
                </div>
                <DnsRecordsTable
                  records={domain.records}
                  fqdn={domain.fqdn}
                  labels={tableLabels}
                />
                {domain.dnsCheck && (
                  <DnsStatusPanel check={domain.dnsCheck} mailHost={mailHost} />
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              {domain.records.length > 0 && (
                <VerifyDomainForm domainId={domain.id} />
              )}
              {!domain.isPlatform && (
                <DeleteDomainForm
                  action={deleteAction}
                  domainId={domain.id}
                  fqdn={domain.fqdn}
                />
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
