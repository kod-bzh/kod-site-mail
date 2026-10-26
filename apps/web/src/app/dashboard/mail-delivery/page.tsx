/* eslint-disable react-hooks/purity -- Dynamic async server component: freshness is evaluated once per request. */
import Link from "next/link";
import { PROVIDERS, connectorPublic } from "@/lib/mail/provider-connectors";
import { safeMessage } from "@/lib/mail/telemetry";
import { requireOrgAdmin, getOrgId } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { getT } from "@/i18n/t";
import { DELIVERY_NOTICE } from "@/lib/mail/delivery-status";
export const dynamic = "force-dynamic";
export default async function MailDeliveryPage() {
  const session = await requireOrgAdmin();
  const organizationId = getOrgId(session)!;
  const t = await getT("mailDelivery");
  const [messages, suppressed, monitor, reports, mailboxes] = await Promise.all([
    prisma.outboundMessage.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.mailSuppression.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.mailMonitorState.findUnique({ where: { id: "delivery" } }),
    prisma.dmarcReport.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.mailbox.findMany({ where: { organizationId, address: { startsWith: "postmaster@" } }, select: { id: true, address: true } }),
  ]);
  const connectors = await prisma.mailConnector.findMany({ where: { organizationId }, orderBy: [{ domain: "asc" }, { provider: "asc" }] });
  const domains = await prisma.domain.findMany({ where: { organizationId }, select: { fqdn: true } });
  const monitoredDomains = await prisma.mailMonitoredDomain.findMany({ where: { organizationId }, select: { domain: true } });
  const visibleDomains = [...new Set([...domains.map(row => row.fqdn), ...monitoredDomains.map(row => row.domain)])];
  const dnsObservations = await Promise.all(visibleDomains.map(domain => prisma.mailObservation.findFirst({
    where: { organizationId, domain, provider: "dns" }, orderBy: { fetchedAt: "desc" },
  })));
  const alerts = await prisma.mailIncident.findMany({ where: { organizationId, status: "open" }, orderBy: { openedAt: "desc" }, take: 50 });
  const feedback = await prisma.mailTelemetryEvent.findMany({ where: { organizationId, type: { in: ["email.mdn", "email.complaint"] } }, orderBy: { receivedAt: "desc" }, take: 30 });
  const providerLabels: Record<string, string> = { dns: "DNS et authentification", google_postmaster: "Google Postmaster", microsoft_snds: "Microsoft SNDS", microsoft_jmrp: "Microsoft JMRP", yahoo_cfl: "Yahoo/AOL CFL", microsoft365_dmarc: "Rapports Microsoft 365", blocklists: "Listes de blocage autorisées" };
  const reliabilityLabels: Record<string, string> = { unverified_report: "Provenance non vérifiée", authenticated_domain_report: "Domaine signataire vérifié", authenticated_provider_report: "Fournisseur authentifié", observed: "Observation KOD" };
  const labels: Record<string, string> = { not_configured: "Non configuré", authorization_required: "Autorisation requise", active: "Actif", insufficient_data: "Données insuffisantes", stale: "Données périmées", error: "Erreur" };
  const fresh = monitor && !monitor.lastError && Date.now() - monitor.checkedAt.getTime() < 180_000;
  const reportMonitors = await prisma.mailMonitorState.findMany({ where: { id: { in: mailboxes.map(box => `dmarc:${box.id}`) } } });
  const statuses = { RESERVED: t("statuses.RESERVED"), SUBMITTED: t("statuses.SUBMITTED"), QUEUED: t("statuses.QUEUED"), ACCEPTED: t("statuses.ACCEPTED"), DELIVERED: t("statuses.DELIVERED"), FAILED: t("statuses.FAILED"), BOUNCED: t("statuses.BOUNCED"), PARTIAL: t("statuses.PARTIAL"), UNKNOWN: t("statuses.UNKNOWN") };
  const status = (value: string) => statuses[value as keyof typeof statuses] ?? statuses.UNKNOWN;
  return <div className="space-y-6">
    <div><h1 className="text-2xl font-semibold">{t("title")}</h1><p className="mt-2 text-sm text-zinc-600">{DELIVERY_NOTICE}</p></div>
    <div className="grid gap-4 md:grid-cols-3">
      <div className="rounded-lg border p-4"><p className="text-sm text-zinc-500">{t("monitor")}</p><strong className={fresh ? "text-green-800" : "text-amber-800"}>{fresh ? t("active") : t("notObserved")}</strong><p className="text-xs text-zinc-500">{monitor?.checkedAt.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}</p></div>
      <div className="rounded-lg border p-4"><p className="text-sm text-zinc-500">{t("limits")}</p><p>{t("limitsValue")}</p></div>
      <div className="rounded-lg border p-4"><p className="text-sm text-zinc-500">{t("reputation")}</p><p className="text-amber-800">{t("notMeasured")}</p><Link className="text-sm underline" href="https://postmaster.google.com/" target="_blank" rel="noreferrer">{t("postmaster")}</Link></div>
    </div>
    <section className="space-y-3"><h2 className="font-semibold">Surveillance et autorisations</h2>
      <p className="text-sm text-zinc-600">Une vérification impossible reste inconnue. Les inscriptions et scores ne garantissent pas l’arrivée hors spam. Les données Google concernent Gmail personnel ; SNDS/JMRP concernent Outlook.com.</p>
      {visibleDomains.map(domain => <details key={domain} className="rounded border p-3"><summary>{domain}</summary><div className="mt-3 grid gap-3 md:grid-cols-2">{PROVIDERS.map(provider => {
        const connector = connectorPublic(connectors.find(row => row.domain === domain && row.provider === provider) ?? null, provider);
        return <div key={provider} className="rounded bg-zinc-50 p-3 text-sm"><strong>{providerLabels[provider]} · {labels[connector.state] ?? connector.state}</strong><p>{connector.coverage}</p>
          <p>Dernière collecte réussie : {connector.lastSuccessfulCollectionAt?.toISOString() ?? "Inconnue"}</p><p>Échéance d’accès déclarée : {connector.expiresAt?.toISOString() ?? "Inconnue / non renseignée"}</p>{connector.reason && <p className="text-amber-800">{connector.reason}</p>}{connector.action && <p>{connector.action}</p>}</div>;
      })}</div><div className="mt-3 text-sm">{(() => {
        const observation = dnsObservations.find(row => row?.domain === domain);
        const value = observation?.data as { tls?: { value?: boolean | null; reason?: string }; results?: { ok: boolean; found?: string; required?: boolean; record: { name: string; type: string } }[] } | undefined;
        return <><p>Dernière observation DNS : {observation?.fetchedAt.toISOString() ?? "Inconnue"}</p><p>TLS du service SMTP : {value?.tls?.value === true ? "Certificat vérifié" : value?.tls?.value === false ? "En défaut" : "Inconnu / vérification indisponible"}</p>
          {value?.results?.filter(row => row.required).map((row, index) => <p key={index}>{row.record.type} · {row.record.name} : {row.ok ? "Vérifié lors du contrôle" : ["—", "Non disponible"].includes(row.found ?? "") || row.found?.includes("vérifiable") ? "Inconnu ou indisponible" : "À corriger"}</p>)}</>;
      })()}</div></details>)}
    </section>
    <section className="space-y-3"><h2 className="font-semibold">Incidents ouverts</h2>{!alerts.length && <p className="text-sm">Aucun incident ouvert enregistré. Consulter les couvertures inconnues ci-dessus.</p>}
      {alerts.map(alert => <div key={alert.id} className="rounded border p-3 text-sm"><strong>{alert.domain} · {alert.summary}</strong><p>{alert.action}</p><p className="text-zinc-500">Observé le {alert.observedAt.toISOString()} · Référence {alert.id}</p></div>)}
    </section>
    <section className="space-y-3"><h2 className="font-semibold">Plaintes et accusés MDN</h2><p className="text-sm">Un accusé rapporte une disposition du logiciel ; il ne prouve pas une lecture humaine. Son absence reste inconnue. Aucune suppression automatique des factures à partir d’une plainte déclarative.</p>
      {!feedback.length && <p className="text-sm text-amber-800">Aucun rapport collecté ; aucune conclusion sur la lecture ou le nombre réel de plaintes.</p>}
      {feedback.map(event => <p className="rounded border p-3 text-sm" key={event.id}>{event.domain} · {event.type === "email.mdn" ? "Accusé de lecture reçu" : "Plainte rapportée"} · {providerLabels[event.source] ?? event.source} · {reliabilityLabels[event.reliability] ?? event.reliability} · {event.type === "email.mdn" ? String((event.data as { disposition?: string }).disposition ?? "Disposition inconnue") : "Signalement à examiner"} · {event.occurredAt.toISOString()} · Référence {event.id}</p>)}
    </section>
    <section className="space-y-3"><h2 className="font-semibold">{t("recent")}</h2><div className="overflow-x-auto rounded-lg border"><table className="w-full text-left text-sm"><thead className="bg-zinc-50"><tr>{(["date", "from", "subject", "recipients", "status"] as const).map(key => <th className="p-3" key={key}>{t(key)}</th>)}</tr></thead><tbody>
      {messages.map(message => <tr key={message.id} className="border-t align-top"><td className="p-3 whitespace-nowrap">{message.createdAt.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}</td><td className="p-3">{message.fromAddress}</td><td className="p-3">{message.subject}<p className="break-all text-xs text-zinc-500">{message.submissionId ?? message.id}</p></td><td className="p-3">{message.recipientCount}</td><td className="p-3"><strong>{status(message.status)}</strong>{message.lastError && <p className="text-xs text-amber-800">{message.lastError}</p>}{message.deliveryJson && <details className="mt-2"><summary>{t("details")}</summary><pre className="max-w-lg whitespace-pre-wrap break-all text-xs">{JSON.stringify(safeMessage({ recipients: message.recipients, deliveryJson: message.deliveryJson }), null, 2)}</pre></details>}</td></tr>)}
      {!messages.length && <tr><td className="p-4 text-zinc-500" colSpan={5}>{t("empty")}</td></tr>}
    </tbody></table></div></section>
    <section className="space-y-3"><h2 className="font-semibold">{t("suppressed")}</h2><p className="text-sm text-zinc-600">{t("suppressedHint")}</p><ul className="space-y-2">{suppressed.map(item => <li className="rounded border p-3 text-sm" key={item.id}>{item.address} · {item.reason}</li>)}{!suppressed.length && <li className="text-sm text-zinc-500">{t("noneSuppressed")}</li>}</ul></section>
    <section className="space-y-3"><h2 className="font-semibold">{t("reports")}</h2><p className="text-sm text-zinc-600">{t("reportsHint")}</p>
      {mailboxes.map(box => { const state = reportMonitors.find(item => item.id === `dmarc:${box.id}`); const active = state && !state.lastError && Date.now() - state.checkedAt.getTime() < 180_000;
        return <p key={box.id} className={active ? "text-sm text-green-800" : "text-sm text-amber-800"}>{box.address} · {active ? t("active") : t("notObserved")}{state?.lastError && ` · ${state.lastError}`}</p>; })}
      <p className="text-sm text-zinc-600">{t("reportTrust")}</p>
      {!reports.length && <p className="text-sm text-amber-800">{t("noReports")}</p>}
      {reports.map(report => <div className="rounded border p-3 text-sm" key={report.id}><strong>{report.reportedDomain ?? report.filename}</strong> · {report.reporter}
        {report.error ? <p className="text-amber-800">{report.error}</p> : <><p>{t("reportCounts", { total: report.totalCount, dkim: report.dkimPassCount, spf: report.spfPassCount })}</p><details><summary>{t("reportIps")}</summary><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(report.sourcesJson, null, 2)}</pre></details></>}
      </div>)}
    </section>
  </div>;
}
