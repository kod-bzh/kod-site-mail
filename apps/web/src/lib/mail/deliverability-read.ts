import { smtpMetrics } from "./smtp-metrics";
import { classifySource, type KnownSource } from "./source-inventory";
import { prisma } from "@/lib/prisma";
import { resolveV1ActorFromRequest, resolveActorOrganizationId, actorHasScope } from "@/lib/api/v1-auth";
import { DELIVERABILITY_READ_SCOPE } from "@/lib/api-keys";
import { PROVIDERS, connectorPublic } from "./provider-connectors";

export async function readScope(req: Request, domain?: string) {
  const actor = await resolveV1ActorFromRequest(req);
  if (!actor) return { error: Response.json({ error: "unauthorized" }, { status: 401 }) };
  if (!actorHasScope(actor, DELIVERABILITY_READ_SCOPE)) return { error: Response.json({ error: "forbidden", requiredScope: DELIVERABILITY_READ_SCOPE }, { status: 403 }) };
  const org = await resolveActorOrganizationId(actor, { organizationSlug: new URL(req.url).searchParams.get("organizationSlug") ?? undefined });
  if (!org.ok) return { error: Response.json({ error: org.error }, { status: 403 }) };
  const registered = await prisma.domain.findMany({ where: { organizationId: org.organizationId,
    ...(actor.allowedMailDomains?.length ? { fqdn: { in: actor.allowedMailDomains } } : {}) }, select: { fqdn: true } });
  const monitored = await prisma.mailMonitoredDomain.findMany({ where: { organizationId: org.organizationId,
    ...(actor.allowedMailDomains?.length ? { domain: { in: actor.allowedMailDomains } } : {}) }, select: { domain: true } });
  const domains = [...registered, ...monitored.map(row => ({ fqdn: row.domain }))];
  if (domain && !domains.some(row => row.fqdn === domain)) return { error: Response.json({ error: "not_found" }, { status: 404 }) };
  return { organizationId: org.organizationId, domains: domains.map(row => row.fqdn), actor };
}
export function period(req: Request) {
  const url = new URL(req.url), end = url.searchParams.get("until") ? new Date(url.searchParams.get("until")!) : new Date();
  const start = url.searchParams.get("since") ? new Date(url.searchParams.get("since")!) : new Date(end.getTime() - 30 * 86400_000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end || end.getTime() - start.getTime() > 90 * 86400_000 || end.getTime() > Date.now() + 300_000) throw Error("Période ISO valide de 90 jours maximum requise");
  return { start, end };
}
export async function domainHealth(organizationId: string, domain: string) {
  const connector = await prisma.mailConnector.findUnique({ where: { organizationId_domain_provider: { organizationId, domain, provider: "dns" } } });
  const observation = await prisma.mailObservation.findFirst({ where: { organizationId, domain, provider: "dns" }, orderBy: { fetchedAt: "desc" } });
  const value = observation?.data as { results?: { ok: boolean; issue?: string | null; found?: string; required?: boolean; record: { name: string; type: string }; detail?: string }[]; rua?: { address: string }[] } | null;
  const destinations = value?.rua ?? [];
  const reception = await Promise.all(destinations.map(async destination => {
    const alias = await prisma.emailAlias.findFirst({ where: { organizationId, source: destination.address }, select: { destination: true } });
    const mailbox = await prisma.mailbox.findFirst({ where: { organizationId, address: alias?.destination ?? destination.address }, select: { id: true } });
    const monitor = mailbox ? await prisma.mailMonitorState.findUnique({ where: { id: `dmarc:${mailbox.id}` } }) : null;
    const report = await prisma.dmarcReport.findFirst({ where: { organizationId, reportedDomain: domain, }, orderBy: [{ sourceReceivedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }], select: { sourceReceivedAt: true, createdAt: true, id: true, error: true } });
    const external = await prisma.mailConnector.findUnique({ where: { organizationId_domain_provider: { organizationId, domain, provider: "microsoft365_dmarc" } } });
    return { address: destination.address, source: mailbox ? "kod_mailbox_configuration" : "external_mailbox_not_verified", scope: "domain", routeConfiguredInKod: mailbox ? true : null,
      collectorLastSuccessfulAt: monitor?.checkedAt ?? external?.lastSuccessAt ?? null, collectorError: monitor?.lastError ?? external?.lastError ?? null,
      actualReportReceivedAt: report?.sourceReceivedAt ?? null, fetchedAt: report?.createdAt ?? null, evidenceRef: report?.id ?? null, receptionProven: report ? true : null, parsedReportObserved: report && !report.error ? true : null, diagnostic: report?.error ?? null,
      action: mailbox ? "Contrôler l’arrivée des rapports ; une boîte configurée ne prouve pas leur réception." : "Autoriser la collecte du dossier Microsoft 365 dédié sans changer les MX." };
  }));
  const checks = value?.results?.map(row => {
    const unknown = !row.ok && !row.issue && (row.found === "—" || row.found === "Non disponible" || row.found?.includes("vérifiable"));
    return { source: "dns_and_signing_policy", scope: "domain", record: row.record, observedAt: observation?.observedAt ?? null,
      required: row.required ?? false, value: unknown ? null : row.ok, availability: unknown ? "unknown" : "available", evidenceRef: observation?.id ?? null,
      reason: unknown ? "verification_unavailable" : row.issue ?? null, detail: row.detail ?? null };
  }) ?? null;
  return { domain, checks, reportReception: reception, source: "kod_dns_and_signing_policy", scope: "domain", connector: connectorPublic(connector, "dns"),
    availability: observation ? "available" : "unknown", value: observation ? { ...(observation.data as object), results: checks,
      verified: checks?.some(row => row.required && row.value === null) ? null : (observation.data as { verified?: boolean }).verified ?? null } : null, observedAt: observation?.observedAt ?? null,
    fetchedAt: observation?.fetchedAt ?? null, period: observation ? { start: observation.periodStart, end: observation.periodEnd } : null,
    freshness: observation && Date.now() - observation.fetchedAt.getTime() < 2 * 3600_000 ? "fresh" : observation ? "stale" : "unknown",
    evidenceRef: observation?.id ?? null, absenceReason: observation ? null : "no_successful_observation", action: "Préserver les MX actuels, vérifier les expéditeurs légitimes et les rapports avant tout durcissement DMARC." };
}
export async function reputation(organizationId: string, domain: string, range: { start: Date; end: Date }) {
  const connectors = await prisma.mailConnector.findMany({ where: { organizationId, domain } });
  const observations = await prisma.mailObservation.findMany({ where: { organizationId, domain, provider: { not: "dns" },
    periodEnd: { gt: range.start }, periodStart: { lt: range.end } }, orderBy: [{ periodStart: "desc" }, { id: "desc" }], take: 1001 });
  const truncated = observations.length > 1000;
  return { domain, period: range, truncated, smtp: await smtpMetrics(organizationId, domain, range.start, range.end), providers: PROVIDERS.filter(provider => provider !== "dns").map(provider => {
    const connector = connectorPublic(connectors.find(row => row.provider === provider) ?? null, provider);
    const values = observations.slice(0, 1000).filter(row => row.provider === provider);
    return { ...connector, scope: provider === "microsoft_snds" || provider === "blocklists" ? "ip" : "domain",
      availability: values.length ? "available" : "unknown", coverageCompleteness: truncated ? "partial_query_limit" : "observed_provider_data_only", metrics: values.length ? values.map(row => ({ source: row.source, scope: row.scope,
        period: { start: row.periodStart, end: row.periodEnd }, observedAt: row.observedAt, fetchedAt: row.fetchedAt,
        freshness: Date.now() - row.periodEnd.getTime() < 72 * 3600_000 ? "fresh" : "stale", evidenceRef: row.id, values: row.data })) : null,
      absenceReason: values.length ? null : truncated ? "query_result_truncated_reduce_period" : connector.reason ?? "no_observations_for_period" };
  }), notice: "Aucune métrique, inscription ou acceptation SMTP ne garantit l’arrivée hors spam. Les statistiques ne sont pas des plaintes attribuables à une personne." };
}
export async function dmarcSummary(organizationId: string, domain: string, range: { start: Date; end: Date }) {
  const rows = await prisma.dmarcReport.findMany({ where: { organizationId, reportedDomain: domain, error: null, periodEnd: { gt: range.start }, periodStart: { lt: range.end } },
    orderBy: [{ periodStart: "desc" }, { id: "desc" }], take: 1001 });
  const connector = await prisma.mailConnector.findUnique({ where: { organizationId_domain_provider: { organizationId, domain, provider: "dns" } } });
  const known = (connector?.settings as { knownSources?: KnownSource[] } | null)?.knownSources ?? [];
  const sources = new Map<string, { ip: string; count: number; dkimAlignedCount: number; spfAlignedCount: number; dmarcFailCount: number; unknownAlignmentCount: number; classification: ReturnType<typeof classifySource>; evidenceRefs: string[] }>();
  for (const report of rows.slice(0, 1000)) for (const row of (report.sourcesJson ?? []) as { ip: string; count: number; dkimAlignment?: string; spfAlignment?: string; dkim: boolean; spf: boolean }[]) {
    const value = sources.get(row.ip) ?? { ip: row.ip, count: 0, dkimAlignedCount: 0, spfAlignedCount: 0, dmarcFailCount: 0, unknownAlignmentCount: 0, classification: classifySource(row.ip, known), evidenceRefs: [] };
    value.count += row.count; if (row.dkim) value.dkimAlignedCount += row.count; if (row.spf) value.spfAlignedCount += row.count;
    if (row.dkimAlignment === "fail" && row.spfAlignment === "fail") value.dmarcFailCount += row.count;
    if (!row.dkimAlignment || !row.spfAlignment || row.dkimAlignment === "unknown" || row.spfAlignment === "unknown") value.unknownAlignmentCount += row.count;
    if (value.evidenceRefs.length < 10) value.evidenceRefs.push(report.id); sources.set(row.ip, value);
  }
  const unreadable = await prisma.dmarcReport.findMany({ where: { organizationId, reportedDomain: domain, error: { not: null }, createdAt: { gte: range.start, lt: range.end } },
    select: { id: true, error: true, sourceReceivedAt: true, createdAt: true, provenance: true }, orderBy: { createdAt: "desc" }, take: 100 });
  const bridge = await prisma.mailMonitorState.findUnique({ where: { id: "incoming-report-bridge" } });
  const total = rows.slice(0, 1000).reduce((n, r) => n + r.totalCount, 0);
  return { domain, unreadableReports: unreadable, nativeIntake: { source: "native_inbound_before_encryption", lastHeartbeatAt: bridge?.checkedAt ?? null,
    state: bridge && !bridge.lastError && bridge.checkedAt.getTime() > Date.now() - 180000 ? "active" : "unknown", reason: bridge?.lastError ?? null, receivedReportCount: rows.length || null }, scope: "domain", source: "dmarc_aggregate_reports", period: range, availability: rows.length ? "available" : "unknown",
    freshness: rows.length ? Date.now() - Math.max(...rows.map(row => row.periodEnd?.getTime() ?? 0)) < 72 * 3600_000 ? "fresh" : "stale" : "unknown",
    observedAt: rows[0]?.periodEnd ?? null, fetchedAt: rows.length ? new Date(Math.max(...rows.map(row => row.createdAt.getTime()))) : null,
    absenceReason: rows.length ? null : "no_reports_received_for_period", totalCount: rows.length ? total : null, reportCount: rows.length ? Math.min(rows.length, 1000) : null,
    truncated: rows.length > 1000, sources: rows.length ? [...sources.values()] : null,
    anomalies: rows.length ? [...sources.values()].filter(row => row.classification.kind === "unknown" || row.dmarcFailCount > 0).map(row => ({ ip: row.ip,
      reason: row.classification.kind === "unknown" ? "unclassified_source" : "alignment_failure", evidenceRefs: row.evidenceRefs })) : null,
    reports: rows.slice(0, 1000).map(row => ({ id: row.id, reporter: row.reporter, periodStart: row.periodStart, periodEnd: row.periodEnd,
      totalCount: row.totalCount, sources: row.sourcesJson, provenance: row.provenance, intakeEvidence: row.intakeEvidence, receivedAt: row.sourceReceivedAt, fetchedAt: row.createdAt })),
    action: "Inventorier KOD, Microsoft 365 et les autres sources avec leurs plages IP documentées ; analyser plusieurs semaines avant de proposer quarantine puis reject. Aucun changement automatique de p=none.",
    trust: "Rapports déclaratifs non authentifiés cryptographiquement ; ne pas appliquer de suppression ni de changement DNS sur leur seule base." };
}
export function pagination(req: Request) {
  const url = new URL(req.url), raw = url.searchParams.get("limit") ?? "50", cursor = url.searchParams.get("cursor");
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 100 || cursor && !/^[a-zA-Z0-9_-]{1,100}$/.test(cursor)) throw Error("Pagination invalide");
  return { take: Number(raw), ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) };
}
