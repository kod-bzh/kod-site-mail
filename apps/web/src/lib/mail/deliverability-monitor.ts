import { classifySource, type KnownSource } from "./source-inventory";
import { smtpMetrics } from "./smtp-metrics";
import { prisma } from "@/lib/prisma";
import { COVERAGE, PROVIDERS, fetchDns, fetchGoogle, fetchBlocklists, googleCredentials, sndsCredentials, approvedSndsUrl,
  readConfiguration, storeObservation, parseCsv, boundedResponse, ProviderError } from "./provider-connectors";
import { graphCredentials, collectGraphDmarc } from "./graph-dmarc";
import { setIncident } from "./telemetry";

const hours = (name: string, fallback: number) => { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? value : fallback; };
export async function pollDeliverability() {
  const registered = await prisma.domain.findMany({ where: { status: { in: ["VERIFIED", "ACTIVE"] } }, select: { organizationId: true, fqdn: true } });
  const monitored = await prisma.mailMonitoredDomain.findMany({ select: { organizationId: true, domain: true } });
  const domains = [...registered, ...monitored.filter(row => !registered.some(item => item.organizationId === row.organizationId && item.fqdn === row.domain)).map(row => ({ organizationId: row.organizationId, fqdn: row.domain }))];
  await prisma.mailConnector.createMany({ data: domains.flatMap(domain => PROVIDERS.map(provider => ({
    organizationId: domain.organizationId, domain: domain.fqdn, provider, state: provider === "dns" ? "insufficient_data" : "not_configured",
  }))), skipDuplicates: true });
  const due = await prisma.mailConnector.findMany({ where: { nextCheckAt: { lte: new Date() }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, orderBy: { nextCheckAt: "asc" }, take: 10 });
  for (const connector of due) {
    const claim = await prisma.mailConnector.updateMany({ where: { id: connector.id, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { leaseUntil: new Date(Date.now() + 300_000), lastAttemptAt: new Date() } });
    if (!claim.count) continue;
    let state = connector.state, lastError: string | null = null, success = false;
    try {
      const currentDomain = await prisma.domain.findUnique({ where: { organizationId_fqdn: { organizationId: connector.organizationId, fqdn: connector.domain } } });
      const monitorDomain = currentDomain ?? await prisma.mailMonitoredDomain.findFirst({ where: { organizationId: connector.organizationId, domain: connector.domain } });
      if (!monitorDomain) continue; // Domain transfer/removal never gives a former tenant a new observation.
      if (connector.expiresAt && connector.expiresAt.getTime() <= Date.now()) throw new ProviderError("authorization_required", "Autorisation fournisseur expirée");
      const now = new Date();
      if (connector.provider === "dns") {
        const data = await fetchDns(connector.domain, !currentDomain);
        const bucket = new Date(Math.floor(now.getTime() / 3600_000) * 3600_000);
        await storeObservation(connector, bucket, now, data);
        const result = data as unknown as { results: { required: boolean; ok: boolean; issue: string | null; found: string; record: { type: string } }[]; tls: { value: boolean | null } };
        const relevant = result.results.filter(row => row.required);
        const unknown = relevant.some(row => !row.ok && !row.issue && (row.found === "—" || row.found === "Non disponible" || row.found.includes("vérifiable")));
        await setIncident({ organizationId: connector.organizationId, domain: connector.domain, code: "authentication_dns", active: unknown ? null : relevant.some(row => !row.ok),
          summary: "Contrôle DNS/authentification en défaut", action: "Vérifier les enregistrements actifs et la signature, en préservant les MX et les autres expéditeurs.", evidence: { provider: "dns", observedAt: now.toISOString() } });
        state = unknown ? "error" : "active"; success = !unknown; if (unknown) lastError = "Certaines vérifications DNS sont impossibles ; état inconnu";
      } else if (connector.provider === "google_postmaster" && connector.secretCipher) {
        const rows = await fetchGoogle(connector.domain, googleCredentials.parse(readConfiguration(connector)));
        for (const row of rows) await storeObservation(connector, row.start, row.end, row.data);
        state = !rows.length ? "insufficient_data" : Math.max(...rows.map(row => row.end.getTime())) < Date.now() - 72 * 3600_000 ? "stale" : "active"; success = true;
      } else if (connector.provider === "microsoft_snds" && connector.secretCipher) {
        const config = sndsCredentials.parse(readConfiguration(connector));
        const response = await fetch(approvedSndsUrl(config.url), { redirect: "error", signal: AbortSignal.timeout(20_000) });
        const csv = parseCsv((await boundedResponse(response)).toString("utf8"));
        const settings = connector.settings as { ipColumn: string; dateColumn: string; reputationColumn: string } | null;
        if (!settings) throw new ProviderError("error", "Correspondance des colonnes de l’export SNDS requise");
        const header = csv.shift() ?? [], indices = [settings.ipColumn, settings.dateColumn, settings.reputationColumn].map(key => header.indexOf(key));
        if (indices.some(i => i < 0)) throw new ProviderError("error", "Schéma SNDS modifié ; vérifier l’export officiel");
        let count = 0;
        for (const row of csv) {
          if (row[indices[0]] !== (process.env.MAIL_EGRESS_IP ?? "51.15.220.2")) continue;
          // Explicit ISO format only: ambiguous locale dates must be mapped during approved import.
          const value = row[indices[1]]; if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ProviderError("error", "Date SNDS non ISO : normaliser l’export explicitement");
          const start = new Date(`${value}T00:00:00Z`);
          if (!Number.isFinite(start.getTime()) || start.getTime() < Date.now() - 90 * 86400_000 || start.getTime() > Date.now()) continue;
          const reputation = row[indices[2]].toLowerCase();
          if (!["green", "yellow", "red"].includes(reputation)) throw new ProviderError("error", "Réputation SNDS inconnue");
          await storeObservation(connector, start, new Date(start.getTime() + 86400_000), { ip: row[indices[0]], reputation, sharedIp: true,
            complaintRate: null, numerator: null, denominator: null, absenceReason: "shared_ip_traffic_not_disclosed", inboxPlacementProven: false }, "ip"); count++;
        }
        const latest = await prisma.mailObservation.findFirst({ where: { organizationId: connector.organizationId, domain: connector.domain, provider: connector.provider }, orderBy: { periodEnd: "desc" } });
        state = !count ? "insufficient_data" : latest && latest.periodEnd.getTime() < Date.now() - 72 * 3600_000 ? "stale" : "active"; success = true;
      } else if (connector.provider === "microsoft365_dmarc" && connector.secretCipher) {
        await collectGraphDmarc(connector, graphCredentials.parse(readConfiguration(connector))); state = "active"; success = true;
      } else if (connector.provider === "blocklists" && connector.secretCipher) {
        const data = await fetchBlocklists(readConfiguration(connector) as { zone: string; resolver: string });
        await storeObservation(connector, new Date(Math.floor(now.getTime() / 3600_000) * 3600_000), now, data, "ip");
        await setIncident({ organizationId: connector.organizationId, domain: connector.domain, code: "blocklist", active: data.listed,
          summary: "IP signalée par une liste autorisée", action: "Consulter la procédure officielle de diagnostic et retrait.", evidence: data });
        state = "active"; success = true;
      } else if (["microsoft_jmrp", "yahoo_cfl"].includes(connector.provider) && connector.state !== "not_configured") {
        const settings = connector.settings as { mailboxId?: string; enrollmentVerifiedAt?: string } | null;
        const box = settings?.mailboxId ? await prisma.mailbox.findFirst({ where: { id: settings.mailboxId, organizationId: connector.organizationId, domain: { fqdn: connector.domain } } }) : null;
        if (!box?.stalwartAccountId || !settings?.enrollmentVerifiedAt) throw new ProviderError("authorization_required", "Vérifier l’inscription et la boîte de retour fournisseur");
        const monitor = await prisma.mailMonitorState.findUnique({ where: { id: `feedback:${connector.organizationId}:${box.stalwartAccountId}` } });
        if (!monitor || monitor.lastError || monitor.checkedAt.getTime() < Date.now() - 180_000) throw new ProviderError("error", "Boîte de plaintes non surveillée ou collecte périmée");
        const native = await prisma.mailMonitorState.findUnique({ where: { id: "incoming-report-bridge" } });
        if (!native || native.lastError || native.checkedAt.getTime() < Date.now() - 180_000) throw new ProviderError("error", "Relais entrant avant chiffrement indisponible ; couverture incomplète");
        const count = await prisma.mailTelemetryEvent.count({ where: { organizationId: connector.organizationId, domain: connector.domain, source: connector.provider, reliability: "authenticated_provider_report" } });
        state = count ? "active" : "insufficient_data"; success = true;
      } else { state = "not_configured"; }
    } catch (error) {
      state = error instanceof ProviderError ? error.state : "error";
      // Provider responses/URLs may include tokens. Never persist raw error text.
      lastError = error instanceof ProviderError ? error.message : `Collecte ${connector.provider} indisponible ; vérifier l’accès et le format de données.`;
    } finally {
      await prisma.mailConnector.update({ where: { id: connector.id }, data: { state, lastError, leaseUntil: null,
        nextCheckAt: new Date(Date.now() + (state === "error" ? 900_000 : connector.provider === "dns" ? 3600_000 : 6 * 3600_000)), ...(success ? { lastSuccessAt: new Date() } : {}) } });
    }
    if (connector.secretCipher || ["microsoft_jmrp", "yahoo_cfl"].includes(connector.provider) && connector.state !== "not_configured") {
      await setIncident({ organizationId: connector.organizationId, domain: connector.domain, code: `collector:${connector.provider}`,
        active: ["error", "authorization_required"].includes(state), summary: `Collecte ${connector.provider} indisponible`, action: "Rétablir l’accès et la collecte ; consulter les dates avant toute conclusion.",
        evidence: { provider: connector.provider, state, lastSuccessAt: connector.lastSuccessAt?.toISOString() ?? null } });
    }
  }
  // Monitor outages must not be hidden by a scheduler that remains alive.
  for (const domain of domains) {
    const bridge = await prisma.mailMonitorState.findUnique({ where: { id: "incoming-report-bridge" } });
    await setIncident({ organizationId: domain.organizationId, domain: domain.fqdn, code: "incoming_report_bridge",
      active: !bridge || !!bridge.lastError || bridge.checkedAt.getTime() < Date.now() - 180000,
      summary: "Collecte entrante native non confirmée", action: "Vérifier le hook avant chiffrement, sa file durable et la liaison à KOD ; ne pas désactiver le chiffrement.",
      evidence: { lastHeartbeatAt: bridge?.checkedAt.toISOString() ?? null, reason: bridge?.lastError ?? "heartbeat_not_received" } });
    const unreadableReports = await prisma.dmarcReport.count({ where: { organizationId: domain.organizationId, reportedDomain: domain.fqdn, error: { not: null } } });
    await setIncident({ organizationId: domain.organizationId, domain: domain.fqdn, code: "unreadable_reports", active: unreadableReports > 0,
      summary: "Rapports DMARC reçus mais non exploitables", action: "Fournir une décryption autorisée pour l’historique chiffré ou corriger le format ; contrôler la collecte native avant chiffrement pour les prochains rapports.",
      evidence: { count: unreadableReports, source: "dmarc_report_diagnostics" } });
    const configured = await prisma.mailConnector.findMany({ where: { organizationId: domain.organizationId, domain: domain.fqdn, state: { not: "not_configured" } } });
    for (const collector of configured) {
      await setIncident({ organizationId: domain.organizationId, domain: domain.fqdn, code: `stale:${collector.provider}`,
        active: !collector.lastSuccessAt || collector.lastSuccessAt.getTime() < Date.now() - (collector.provider === "dns" ? 2 : 72) * 3600_000,
        summary: `Données ${collector.provider} non fraîches`, action: "Vérifier la dernière collecte réussie et les autorisations.", evidence: { provider: collector.provider, lastSuccessAt: collector.lastSuccessAt?.toISOString() ?? null } });
      if (collector.expiresAt) await setIncident({ organizationId: domain.organizationId, domain: domain.fqdn, code: `renewal:${collector.provider}`,
        active: collector.expiresAt.getTime() < Date.now() + 7 * 86400_000, summary: "Autorisation fournisseur à renouveler",
        action: "Renouveler le lien d’export, le secret ou la validation de propriété avant l’échéance déclarée.",
        evidence: { source: "configured_access_expiry", provider: collector.provider, expiresAt: collector.expiresAt.toISOString(), advanceDays: 7 } });
    }
    const stuck = await prisma.outboundMessage.count({ where: { organizationId: domain.organizationId, fromAddress: { endsWith: `@${domain.fqdn}` },
      status: { in: ["QUEUED", "SUBMITTED", "RESERVED"] }, createdAt: { lt: new Date(Date.now() - hours("MAIL_QUEUE_ALERT_HOURS", 2) * 3600_000), gte: new Date(Date.now() - 7 * 86400_000) } } });
    await setIncident({ organizationId: domain.organizationId, domain: domain.fqdn, code: "queue_delay", active: stuck > 0, summary: "Soumissions en attente prolongée",
      action: "Examiner la file et les réponses SMTP sans resoumettre les messages.", evidence: { count: stuck, thresholdHours: hours("MAIL_QUEUE_ALERT_HOURS", 2), scope: "domain" } });
    const failed = await prisma.mailWebhookAttempt.count({ where: { webhook: { organizationId: domain.organizationId }, completedAt: { not: null }, lastError: { not: null },
      OR: [{ event: { message: { fromAddress: { endsWith: `@${domain.fqdn}` } } } }, { telemetryEvent: { domain: domain.fqdn } }], createdAt: { gte: new Date(Date.now() - 86400_000) } } });
    await setIncident({ organizationId: domain.organizationId, domain: domain.fqdn, code: "webhook_failed", active: failed > 0, summary: "Notifications non confirmées après reprises",
      action: "Réparer la destination et rattraper les événements par API ; ne pas renvoyer les emails.", evidence: { count: failed, periodHours: 24 } });
    for (const provider of ["google_postmaster", "microsoft_snds"]) {
      const latest = await prisma.mailObservation.findFirst({ where: { organizationId: domain.organizationId, domain: domain.fqdn, provider }, orderBy: { periodEnd: "desc" } });
      const recent = latest && latest.periodEnd.getTime() >= Date.now() - 72 * 3600_000;
      const values = latest?.data as { domainReputation?: string | null; reputation?: string | null } | undefined;
      const value = provider === "google_postmaster" ? values?.domainReputation : values?.reputation;
      await setIncident({ organizationId: domain.organizationId, domain: domain.fqdn, code: `provider_reputation:${provider}`,
        active: !recent || !value ? null : ["LOW", "BAD", "red", "yellow"].includes(value),
        summary: provider === "google_postmaster" ? "Réputation Google défavorable" : "Réputation de l’IP Outlook.com à examiner",
        action: "Examiner la métrique fournisseur, sa période et les rejets ; une IP partagée ne permet aucune attribution à une autre organisation.",
        evidence: { provider, value: value ?? null, scope: provider === "google_postmaster" ? "domain" : "ip", evidenceRef: latest?.id ?? null, periodStart: latest?.periodStart.toISOString() ?? null, periodEnd: latest?.periodEnd.toISOString() ?? null } });
      await setIncident({ organizationId: domain.organizationId, domain: domain.fqdn, code: `provider_data_stale:${provider}`, active: latest ? !recent : null,
        summary: "Statistiques fournisseur périmées", action: "Contrôler les droits et le volume disponible ; ne pas considérer une collecte HTTP réussie comme une statistique récente.",
        evidence: { provider, evidenceRef: latest?.id ?? null, periodEnd: latest?.periodEnd.toISOString() ?? null } });
    }
    const metrics = await smtpMetrics(domain.organizationId, domain.fqdn, new Date(Date.now() - 86400_000), new Date());
    for (const provider of metrics.providers ?? []) await setIncident({ organizationId: domain.organizationId, domain: domain.fqdn,
      code: `smtp_rejection:${provider.provider}`, active: provider.rejectionRate.value === null ? null : provider.rejectionRate.value >= hours("MAIL_SMTP_FAILURE_RATE", 0.05),
      summary: `Rejets SMTP élevés : ${provider.provider}`, action: "Examiner les réponses, la réputation et les limitations du fournisseur sans rejouer les envois.",
      evidence: { numerator: provider.rejectionRate.numerator, denominator: provider.rejectionRate.denominator, periodHours: 24, minimumVolume: metrics.minimumRateVolume } });
    const reports = await prisma.dmarcReport.findMany({ where: { organizationId: domain.organizationId, reportedDomain: domain.fqdn, error: null,
      periodEnd: { gte: new Date(Date.now() - 7 * 86400_000) } }, select: { totalCount: true, sourcesJson: true, id: true, periodEnd: true } });
    const inventory = configured.find(row => row.provider === "dns")?.settings as { knownSources?: KnownSource[] } | null;
    const sourceIps = new Map<string, string[]>();
    for (const report of reports) for (const source of (report.sourcesJson ?? []) as { ip: string }[]) {
      if (classifySource(source.ip, inventory?.knownSources ?? []).kind === "unknown") sourceIps.set(source.ip, [...(sourceIps.get(source.ip) ?? []).slice(0, 9), report.id]);
    }
    for (const [ip, refs] of sourceIps) await setIncident({ organizationId: domain.organizationId, domain: domain.fqdn, code: `dmarc_source:${ip}`, active: true,
      summary: "Source DMARC à inventorier", action: "Identifier l’IP et son fournisseur ; vérifier s’il s’agit de Microsoft 365 ou d’un autre expéditeur légitime.",
      evidence: { ip, reportIds: refs, provenance: "unverified_reports", periodDays: 7 } });
    const previousSources = await prisma.mailIncident.findMany({ where: { organizationId: domain.organizationId, domain: domain.fqdn, status: "open", code: { startsWith: "dmarc_source:" } } });
    for (const incident of previousSources) {
      const ip = incident.code.slice("dmarc_source:".length);
      if (classifySource(ip, inventory?.knownSources ?? []).kind !== "unknown") await setIncident({ organizationId: domain.organizationId, domain: domain.fqdn, code: incident.code, active: false,
        summary: "Source DMARC inventoriée", action: "Conserver la référence des plages IP et suivre les prochains rapports.", evidence: { ip, reason: "source_inventory_updated" } });
    }
    const total = reports.reduce((n, r) => n + r.totalCount, 0), minimum = hours("MAIL_DMARC_MIN_VOLUME", 100);
    const noAlignedPass = reports.reduce((n, r) => n + ((r.sourcesJson ?? []) as { count: number; dkimAlignment?: string; spfAlignment?: string }[]).filter(row => row.dkimAlignment === "fail" && row.spfAlignment === "fail").reduce((sum, row) => sum + row.count, 0), 0);
    await setIncident({ organizationId: domain.organizationId, domain: domain.fqdn, code: "dmarc_alignment", active: total < minimum ? null : noAlignedPass / total >= hours("MAIL_DMARC_FAILURE_RATE", 0.05),
      summary: "Anomalie d’alignement dans les rapports DMARC déclaratifs", action: "Inventorier les sources et valider les rapports avant de durcir DMARC.",
      evidence: { numeratorLowerBound: noAlignedPass, denominator: total, minimumVolume: minimum, periodDays: 7, provenance: "unverified_reports" } });
  }
  const cutoff = new Date(Date.now() - 90 * 86400_000);
  await prisma.mailObservation.deleteMany({ where: { fetchedAt: { lt: cutoff } } });
  await prisma.mailTelemetryEvent.deleteMany({ where: { receivedAt: { lt: cutoff } } });
  await prisma.mailIncident.deleteMany({ where: { status: "resolved", resolvedAt: { lt: cutoff } } });
}
export { COVERAGE };
