import { checkRuaAuthorization } from "./dmarc-destinations";
import { z } from "zod";
import { Resolver } from "node:dns/promises";
import { connect } from "node:tls";
import { isIP } from "node:net";
import { Prisma, type MailConnector } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sealSecret, unsealSecret } from "@/lib/crypto/seal";
import { validDmarc } from "@/lib/dns/authentication";
import { checkDomainDeliverability } from "@/lib/dns/deliverability";
import { digest } from "./telemetry";

export const PROVIDERS = ["dns", "google_postmaster", "microsoft_snds", "microsoft_jmrp", "yahoo_cfl", "microsoft365_dmarc", "blocklists"] as const;
export type Provider = typeof PROVIDERS[number];
export const COVERAGE: Record<Provider, string> = {
  dns: "DNS public, politique de signature KOD et certificat du serveur ; aucune preuve de classement hors spam",
  google_postmaster: "Comptes Gmail personnels uniquement ; seuils de confidentialité/volume Google ; aucun destinataire individuel",
  microsoft_snds: "IP auprès d’Outlook.com ; ne décrit pas les tenants Microsoft 365 ; volumes partagés masqués",
  microsoft_jmrp: "Plaintes Outlook.com reçues en ARF ; anonymisation possible ; aucune attribution par déduction",
  yahoo_cfl: "Plaintes ARF des domaines DKIM inscrits, Yahoo/AOL ; Insights n’a pas d’API disponible",
  microsoft365_dmarc: "Rapports d’un dossier dédié autorisé via Microsoft Graph ; aucune modification des MX",
  blocklists: "Uniquement listes et résolveurs explicitement autorisés ; une impossibilité reste inconnue",
};
export class ProviderError extends Error { constructor(readonly state: "authorization_required" | "error", message: string) { super(message); } }
export async function boundedResponse(response: Response, maximum = 2_000_000): Promise<Buffer> {
  if (!response.ok) throw new ProviderError([401, 403, 404].includes(response.status) ? "authorization_required" : "error", `Fournisseur HTTP ${response.status}`);
  if (!response.body) throw new ProviderError("error", "Réponse fournisseur absente");
  const chunks: Buffer[] = []; let total = 0; const reader = response.body.getReader();
  try { while (true) { const { done, value } = await reader.read(); if (done) break; total += value.length;
    if (total > maximum) { await reader.cancel(); throw new ProviderError("error", "Réponse fournisseur trop volumineuse"); } chunks.push(Buffer.from(value)); }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
async function jsonFetch(url: string, options: RequestInit = {}) {
  return JSON.parse((await boundedResponse(await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(20_000) }))).toString("utf8"));
}
export const googleCredentials = z.object({ clientId: z.string().min(5).max(1000), clientSecret: z.string().min(5).max(2000), refreshToken: z.string().min(5).max(10000) }).strict();
export async function googleAccessToken(credentials: z.infer<typeof googleCredentials>) {
  const token = await jsonFetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret, refresh_token: credentials.refreshToken, grant_type: "refresh_token" }) });
  if (typeof token.access_token !== "string") throw new ProviderError("authorization_required", "Renouveler l’autorisation Google Postmaster");
  return token.access_token as string;
}
const ratio = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
export function normalizeGoogle(row: Record<string, unknown>): Record<string, unknown> {
  const rates = ["userReportedSpamRatio", "spfSuccessRatio", "dkimSuccessRatio", "dmarcSuccessRatio", "outboundEncryptionRatio", "inboundEncryptionRatio"];
  const values: Record<string, unknown> = Object.fromEntries(rates.map(name => [name, { value: ratio(row[name]), numerator: null, denominator: null,
    absenceReason: row[name] == null ? "not_returned_by_provider" : null, denominatorDescription: name === "userReportedSpamRatio" ? "Messages authentifiés DKIM arrivés en boîte de réception Gmail ; volume non fourni" : "Population propre à la métrique Google ; volume non fourni" }]));
  return { ...values, domainReputation: ["HIGH", "MEDIUM", "LOW", "BAD"].includes(String(row.domainReputation)) ? row.domainReputation : null,
    complaintRatioBounds: { lower: ratio(row.userReportedSpamRatioLowerBound), upper: ratio(row.userReportedSpamRatioUpperBound) },
    deliveryErrors: Array.isArray(row.deliveryErrors) ? row.deliveryErrors.slice(0, 50).map(item => ({ errorClass: String(item.errorClass ?? "").slice(0, 100), errorType: String(item.errorType ?? "").slice(0, 100), value: ratio(item.errorRatio), numerator: null, denominator: null })) : null,
    // Google IP samples can contain other senders. Only retain our configured egress IP.
    ipReputation: Array.isArray(row.ipReputations) ? row.ipReputations.filter(item => Array.isArray(item.sampleIps) && item.sampleIps.includes(process.env.MAIL_EGRESS_IP ?? "51.15.220.2"))
      .map(item => ({ ip: process.env.MAIL_EGRESS_IP ?? "51.15.220.2", reputation: String(item.reputation ?? "").slice(0, 32) })) : null };
}
export async function fetchGoogle(domain: string, credentials: z.infer<typeof googleCredentials>) {
  const token = await googleAccessToken(credentials), headers = { Authorization: `Bearer ${token}` };
  // GET existing registration first; never create/re-enrol an existing domain.
  const registration = await jsonFetch(`https://gmailpostmastertools.googleapis.com/v1/domains/${encodeURIComponent(domain)}`, { headers });
  if (registration.permission === "PERMISSION_UNSPECIFIED") throw new ProviderError("authorization_required", "Accès au domaine Google Postmaster à confirmer");
  const rows: { start: Date; end: Date; data: Prisma.InputJsonValue }[] = [];
  let page = "";
  for (let count = 0; count < 10; count++) {
    const query = new URLSearchParams({ pageSize: "100", ...(page ? { pageToken: page } : {}) });
    const payload = await jsonFetch(`https://gmailpostmastertools.googleapis.com/v1/domains/${encodeURIComponent(domain)}/trafficStats?${query}`, { headers });
    for (const row of payload.trafficStats ?? []) {
      const date = String(row.name ?? "").match(/\/([0-9]{4})([0-9]{2})([0-9]{2})$/); if (!date) continue;
      const start = new Date(`${date[1]}-${date[2]}-${date[3]}T00:00:00Z`);
      if (!Number.isFinite(start.getTime()) || start.getTime() < Date.now() - 90 * 86400_000) continue;
      rows.push({ start, end: new Date(start.getTime() + 86400_000), data: normalizeGoogle(row) as Prisma.InputJsonValue });
    }
    page = typeof payload.nextPageToken === "string" ? payload.nextPageToken : ""; if (!page) return rows;
  }
  throw new ProviderError("error", "Collecte Google incomplète : limite de pagination atteinte");
}
export function parseCsv(text: string): string[][] {
  if (Buffer.byteLength(text) > 2_000_000) throw Error("Export trop volumineux");
  const rows: string[][] = []; let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === "," || c === "\n")) { row.push(field.replace(/\r$/, "")); field = ""; if (c === "\n") { rows.push(row); row = []; } }
    else field += c;
    if (field.length > 10_000 || row.length > 100 || rows.length > 20_000) throw Error("Export hors limites");
  }
  if (quoted) throw Error("Export CSV incomplet"); if (field || row.length) rows.push([...row, field.replace(/\r$/, "")]); return rows;
}
export const sndsCredentials = z.object({ url: z.string().url().max(4096) }).strict();
export function approvedSndsUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || url.hostname !== "substrate.office.com" || !url.pathname.toLowerCase().startsWith("/ip-domain-management-snds/")) throw Error("Utiliser un export HTTPS du portail SNDS officiel actuel");
  return url.toString();
}
const smtpTls = () => new Promise<Record<string, unknown>>(resolve => {
  const socket = connect({ host: "mail.kod.bzh", port: 465, servername: "mail.kod.bzh", rejectUnauthorized: true });
  const finish = (value: Record<string, unknown>) => { socket.destroy(); resolve(value); };
  socket.setTimeout(5000, () => finish({ value: null, reason: "smtp_tls_probe_timeout", action: "Vérifier l’accès réseau à 465 ; observer aussi TLS dans les en-têtes reçus." }));
  socket.once("secureConnect", () => { const cert = socket.getPeerCertificate(); finish({ value: true, protocol: socket.getProtocol(), validTo: cert.valid_to, source: "smtp_implicit_tls_465", outboundRecipientTls: null }); });
  socket.once("error", () => finish({ value: null, reason: "smtp_tls_probe_unavailable" }));
});
export async function fetchDns(domain: string, observationOnly = false) {
  if (observationOnly) {
    const resolver = new Resolver({ timeout: 3000, tries: 2 });
    const results = await Promise.all([domain, `_dmarc.${domain}`].map(async name => {
      const record = { type: "TXT", name, value: name === domain ? "SPF unique" : "DMARC" };
      try { const found = (await resolver.resolveTxt(name)).map(chunks => chunks.join(""));
        const spf = found.filter(value => /^v=spf1(?: |$)/i.test(value));
        return { record, required: true, issue: null, found: found.join(" | "), ...(name === domain ? { ok: spf.length === 1,
          detail: "Présence d’un SPF unique ; validation des IP de tous les expéditeurs non effectuée." } : validDmarc(found)) };
      } catch (error) { return { record, required: true, ok: false, found: "—", issue: ["ENOTFOUND", "ENODATA"].includes((error as NodeJS.ErrnoException).code ?? "") ? "absent" : null, detail: "DNS absent ou inaccessible" }; }
    }));
    const mx = await resolver.resolveMx(domain).then(value => ({ value, availability: "available" })).catch(() => ({ value: null, availability: "unknown" }));
    const rua = await checkRuaAuthorization(domain, results.find(row => row.record.name === `_dmarc.${domain}`)?.found ?? "");
    return { results, mx, rua, checkedAt: new Date().toISOString(), role: "external_reception_observation_only", dkim: { value: null, reason: "external_provider_selectors_and_received_message_required" },
      tls: { value: null, reason: "external_provider_not_probed" }, sendingAllowed: null } as unknown as Prisma.InputJsonValue;
  }
  const [dns, tls] = await Promise.all([checkDomainDeliverability(domain), smtpTls()]);
  const rua = await checkRuaAuthorization(domain, dns.results.find(row => row.record.name === `_dmarc.${domain}`)?.found ?? "");
  return { ...dns, tls, rua } as unknown as Prisma.InputJsonValue;
}
export async function fetchBlocklists(credentials: { zone: string; resolver: string }) {
  if (!/^[a-zA-Z0-9.-]+\.dq\.spamhaus\.net$/.test(credentials.zone) || !isIP(credentials.resolver)) throw Error("Résolveur et zone DQS autorisés requis");
  const ip = process.env.MAIL_EGRESS_IP ?? "51.15.220.2"; if (isIP(ip) !== 4) throw Error("IPv4 d’envoi requise");
  const resolver = new Resolver({ timeout: 3000, tries: 1 }); resolver.setServers([credentials.resolver]);
  try { const codes = await resolver.resolve4(`${ip.split(".").reverse().join(".")}.${credentials.zone}`);
    if (codes.some(code => !code.startsWith("127.0.0."))) throw Error("Réponse de blocage non exploitable");
    return { list: "Spamhaus DQS", ip, listed: codes.length > 0, codes };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOTFOUND" || (error as NodeJS.ErrnoException).code === "ENODATA") return { list: "Spamhaus DQS", ip, listed: false, codes: [] }; throw error; }
}
export async function storeObservation(connector: Pick<MailConnector, "organizationId" | "domain" | "provider">, start: Date, end: Date, data: Prisma.InputJsonValue, scope = "domain") {
  const id = digest([connector.organizationId, connector.domain, connector.provider, start.toISOString(), end.toISOString()]);
  await prisma.mailObservation.upsert({ where: { id }, create: { id, organizationId: connector.organizationId, domain: connector.domain, provider: connector.provider,
    source: connector.provider, scope, periodStart: start, periodEnd: end, observedAt: end, data }, update: { data, fetchedAt: new Date() } });
}
export function connectorPublic(connector: MailConnector | null, provider: Provider, now = Date.now()) {
  const stale = !!connector?.lastSuccessAt && now - connector.lastSuccessAt.getTime() > (provider === "dns" ? 2 * 3600_000 : 72 * 3600_000);
  const expired = !!connector?.expiresAt && connector.expiresAt.getTime() <= now;
  const state = expired ? "authorization_required" : stale && !["error", "authorization_required"].includes(connector?.state ?? "") ? "stale" : connector?.state ?? "not_configured";
  return { provider, state, coverage: COVERAGE[provider], lastAttemptAt: connector?.lastAttemptAt ?? null,
    lastSuccessfulCollectionAt: connector?.lastSuccessAt ?? null, expiresAt: connector?.expiresAt ?? null,
    freshness: stale || state === "stale" ? "stale" : state === "insufficient_data" ? "unknown" : connector?.lastSuccessAt ? "fresh" : "unknown",
    reason: expired ? "authorization_expired" : connector?.lastError ?? (state === "not_configured" ? "configuration_or_authorization_missing" : state === "insufficient_data" ? "provider_returned_no_observations" : null),
    action: state === "authorization_required" ? "Renouveler l’accès ou confirmer la propriété dans le portail fournisseur." : state === "not_configured" ? "Configurer un accès autorisé ; vérifier les inscriptions existantes avant d’en créer." : state === "insufficient_data" ? "Attendre des rapports ou un volume suffisant ; aucune bonne réputation ne peut être déduite." : stale ? "Rétablir la collecte et vérifier sa dernière réussite." : null };
}
export function secretConfiguration(value: unknown) { return sealSecret(JSON.stringify(value)); }
export function readConfiguration(connector: MailConnector): unknown { const raw = connector.secretCipher && unsealSecret(connector.secretCipher); if (!raw) throw new ProviderError("authorization_required", "Identifiants serveur requis"); return JSON.parse(raw); }
