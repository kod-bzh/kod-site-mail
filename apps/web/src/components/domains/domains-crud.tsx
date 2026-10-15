"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useActionState } from "react";
import { ScrollText } from "lucide-react";
import { useTranslations } from "next-intl";
import { deleteDomainAction, verifyDomainAction } from "@/app/actions/domains";
import { CrudListCard } from "@/components/layout/crud-list-card";
import { CrudPageHeader } from "@/components/layout/crud-page-header";
import { AddDomainForm } from "@/components/domains/add-domain-form";
import { DeleteDomainForm } from "@/components/domains/delete-domain-form";
import { DnsRecordsTable } from "@/components/domains/dns-records-table";
import { DnsStatusPanel } from "@/components/domains/dns-status-panel";
import { VerifyDomainForm } from "@/components/domains/verify-domain-form";
import { CrudAddButton } from "@/components/ui/crud-add-button";
import {
  CrudRowActions,
  CRUD_ACTIONS_CELL_CLASS,
  CRUD_ACTIONS_HEADER_CLASS,
  crudIconButtonClass,
} from "@/components/ui/crud-row-actions";
import { DataTable } from "@/components/ui/data-table";
import { FormDrawer } from "@/components/ui/form-drawer";
import { FormFeedback } from "@/components/ui/form-feedback";
import { Button } from "@/components/ui/button";
import { INITIAL_ACTION_RESULT } from "@/lib/action-result";
import type { DomainCardData } from "@/components/domains/domains-list";

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

export function DomainsCrud({
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
  const t = useTranslations("domains");
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [dnsTargetId, setDnsTargetId] = useState<string | null>(null);
  const [pendingDnsFqdn, setPendingDnsFqdn] = useState<string | null>(null);
  const [deleteState, deleteAction] = useActionState(deleteDomainAction, INITIAL_ACTION_RESULT);
  const [verifyState, verifyAction] = useActionState(verifyDomainAction, INITIAL_ACTION_RESULT);

  const dnsDrawerDomain =
    (dnsTargetId ? domains.find((d) => d.id === dnsTargetId) : null) ??
    (pendingDnsFqdn ? domains.find((d) => d.fqdn === pendingDnsFqdn) : null) ??
    null;

  function handleDomainAdded(fqdn: string) {
    setCreateOpen(false);
    setDnsTargetId(null);
    setPendingDnsFqdn(fqdn);
    router.refresh();
  }

  function closeDnsDrawer() {
    setDnsTargetId(null);
    setPendingDnsFqdn(null);
  }

  const columns = [
    {
      key: "fqdn",
      header: t("colDomain"),
      cell: (row: DomainCardData) => (
        <span className="font-medium text-ardoise">{row.fqdn}</span>
      ),
    },
    {
      key: "status",
      header: t("colStatus"),
      cell: (row: DomainCardData) => (
        <span
          className={
            row.isVerified
              ? "inline-flex rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800"
              : "inline-flex rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800"
          }
        >
          {row.isVerified ? labels.statusVerified : labels.statusPending}
        </span>
      ),
    },
    {
      key: "actions",
      header: t("colActions"),
      headerClassName: CRUD_ACTIONS_HEADER_CLASS,
      cellClassName: CRUD_ACTIONS_CELL_CLASS,
      cell: (row: DomainCardData) => (
        <CrudRowActions>
          {row.records.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={crudIconButtonClass}
              aria-label={t("viewDnsAria", { fqdn: row.fqdn })}
              onClick={() => {
                setPendingDnsFqdn(null);
                setDnsTargetId(row.id);
              }}
            >
              <ScrollText className="size-4" aria-hidden />
            </Button>
          ) : null}
          {row.records.length > 0 ? (
            <VerifyDomainForm
              domainId={row.id}
              fqdn={row.fqdn}
              compact
              action={verifyAction}
              state={verifyState}
            />
          ) : null}
          {!row.isPlatform ? (
            <DeleteDomainForm
              action={deleteAction}
              domainId={row.id}
              fqdn={row.fqdn}
              compact
            />
          ) : null}
        </CrudRowActions>
      ),
    },
  ];

  return (
    <>
      <CrudPageHeader
        title={t("title")}
        description={labels.recordsIntro}
        action={<CrudAddButton label={t("add")} onClick={() => setCreateOpen(true)} />}
      />

      <FormDrawer open={createOpen} onOpenChange={setCreateOpen} title={t("add")}>
        <AddDomainForm
          onSuccess={handleDomainAdded}
          onCancel={() => setCreateOpen(false)}
        />
      </FormDrawer>

      <FormDrawer
        open={dnsDrawerDomain != null}
        onOpenChange={(open) => {
          if (!open) closeDnsDrawer();
        }}
        title={t("dnsDialogTitle")}
        description={
          dnsDrawerDomain ? t("dnsDialogHint", { fqdn: dnsDrawerDomain.fqdn }) : undefined
        }
        bodyClassName="py-6"
      >
        {dnsDrawerDomain ? (
          <div className="space-y-6">
            <p className="text-sm text-zinc-600">
              {dnsDrawerDomain.isVerified ? labels.verified : labels.pending}
            </p>
            {!dnsDrawerDomain.isVerified ? (
              <p className="text-sm text-amber-800">{labels.usableWhilePending}</p>
            ) : null}
            {dnsDrawerDomain.records.length > 0 ? (
              <>
                <div>
                  <h3 className="text-sm font-medium text-zinc-900">{labels.records}</h3>
                  <p className="mt-1 text-sm text-zinc-500">{labels.recordsIntro}</p>
                  <p className="mt-2 text-sm text-zinc-600">{labels.recordsAutoconfigHint}</p>
                </div>
                <DnsRecordsTable
                  records={dnsDrawerDomain.records}
                  fqdn={dnsDrawerDomain.fqdn}
                  labels={tableLabels}
                />
                {dnsDrawerDomain.dnsCheck ? (
                  <DnsStatusPanel check={dnsDrawerDomain.dnsCheck} mailHost={mailHost} />
                ) : null}
                <VerifyDomainForm domainId={dnsDrawerDomain.id} />
              </>
            ) : null}
          </div>
        ) : null}
      </FormDrawer>

      <FormFeedback state={deleteState} namespace="domains" paramKey="domain" />
      <FormFeedback state={verifyState} namespace="domains" paramKey="domain" />

      <CrudListCard>
        <DataTable
          columns={columns}
          rows={domains}
          rowKey={(row) => row.id}
          emptyMessage={t("empty")}
        />
      </CrudListCard>
    </>
  );
}
