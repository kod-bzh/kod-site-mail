import { prisma } from "@/lib/prisma";
import { recipientState, type RecipientDelivery } from "./delivery-status";
export function recipientProvider(address: string, remoteMta?: string, observedReply?: string) {
  const domain = address.split("@")[1]?.toLowerCase(), host = (remoteMta ?? "").toLowerCase().replace(/\.$/, "");
  const suffix = (value: string) => host === value || host.endsWith(`.${value}`);
  if (suffix("olc.protection.outlook.com")) return "outlook_consumer";
  if (suffix("pphosted.com") || /https:\/\/ipcheck\.proofpoint\.com\/\?ip=/.test(observedReply ?? "")) return "proofpoint";
  if (suffix("protection.outlook.com")) return "microsoft365";
  if (["outlook.com", "hotmail.com", "live.com", "msn.com"].includes(domain)) return "outlook_consumer";
  if (suffix("google.com") || suffix("googlemail.com") || ["gmail.com", "googlemail.com"].includes(domain)) return "google_mx";
  if (suffix("yahoodns.net") || ["yahoo.com", "yahoo.fr", "aol.com"].includes(domain)) return "yahoo_aol";
  if (suffix("orange.fr") || suffix("wanadoo.fr") || ["orange.fr", "wanadoo.fr"].includes(domain)) return "orange_wanadoo";
  if (suffix("sfr.fr") || domain === "sfr.fr") return "sfr";
  if (suffix("free.fr") || domain === "free.fr") return "free";
  if (suffix("laposte.net") || domain === "laposte.net") return "laposte";
  return "other_or_unknown";
}
export const ORANGE_POSTMASTER = "https://postmaster.orange.fr/index.html";
const orangeCodes: Record<string, { category: string; action: string }> = {
  "99": { category: "ip_blocked", action: "Examiner l’IP avec le support Orange." },
  "103": { category: "ip_blocked", action: "Examiner l’IP avec le support Orange." },
  "100": { category: "blocklist", action: "Consulter Abusix par un moyen autorisé." },
  "101": { category: "blocklist", action: "Consulter Spamhaus par un moyen autorisé." },
  "102": { category: "blocklist", action: "Consulter Cloudmark par un moyen autorisé." },
  "104": { category: "connection_limit", action: "Réduire les connexions vers Orange/Wanadoo." },
  "109": { category: "session_message_limit", action: "Limiter les messages par connexion." },
  "107": { category: "authentication", action: "Vérifier le PTR et sa résolution directe." },
  "416": { category: "invalid_recipient", action: "Faire corriger l’adresse ; informer MD2." },
  "506": { category: "suspected_spam", action: "Examiner le signalement et préparer les preuves pour Orange." },
  "515": { category: "authentication", action: "Vérifier l’alignement DMARC." },
  "519": { category: "authentication", action: "Vérifier l’autorisation SPF de l’IP." },
  "535": { category: "authentication", action: "Vérifier la signature DKIM active." },
  "988": { category: "reputation_limited", action: "Vérifier la réputation et espacer les tentatives natives." },
  "989": { category: "reputation_limited", action: "Examiner la réputation du domaine." },
  "990": { category: "reputation_limited", action: "Examiner la réputation du domaine." },
};
export function orangeDiagnostic(provider: string, value: RecipientDelivery) {
  if (provider !== "orange_wanadoo" || value.source !== "smtp" || !/^[45]\d{2}\b/.test(value.smtpReply ?? "")) return null;
  const match = value.smtpReply?.match(/\bOFR(?:\d{1,3})?[_-](\d{2,3})\b/i);
  if (!match) return null;
  return { code: match[1], ...(orangeCodes[String(Number(match[1]))] ?? { category: "provider_policy_unknown", action: "Consulter le diagnostic officiel Orange." }), source: ORANGE_POSTMASTER };
}
export function providerDiagnostic(provider: string, value: RecipientDelivery) {
  const orange = orangeDiagnostic(provider, value);
  if (orange) return orange;
  if (value.source !== "smtp" || !/(?:^|Code:\s*)[45]\d{2}\b/.test(value.smtpReply ?? "")) return null;
  const reply = value.smtpReply ?? "";
  if (provider === "proofpoint" && /https:\/\/ipcheck\.proofpoint\.com\/\?ip=/.test(reply)) return {
    code: "PDR_IP_BLOCK", category: "ip_blocked", action: "Examiner l’IP d’envoi et demander son réexamen par la procédure officielle Proofpoint ; ce rejet ne prouve pas une adresse invalide.",
    source: "https://www.proofpoint.com/us/support-services/ip-blocked-faq",
  };
  if (provider === "proofpoint" && /Local Policy Violation: Reputation Services/i.test(reply)) return {
    code: "PROOFPOINT_REPUTATION_POLICY", category: "provider_reputation_policy", action: "Examiner le refus de réputation avec l’administrateur destinataire ; la liste de blocage précise n’est pas fournie.",
    source: "https://www.proofpoint.com/us/support-services/ip-blocked-faq",
  };
  const outlook = provider === "outlook_consumer" ? reply.match(/\b(S31[45]0)\b/) : null;
  if (outlook) return { code: outlook[1], category: "ip_blocked", action: "Examiner l’IP et contacter le support de délivrabilité Outlook.com ; distinguer ce service de Microsoft 365.",
    source: "https://substrate.office.com/ip-domain-management-snds/Postmaster/Troubleshooting" };
  if (provider === "microsoft365" && /5\.4\.1\b/.test(reply) && /Recipient address rejected: Access denied/i.test(reply)) return {
    code: "M365_RECIPIENT_DIRECTORY", category: "recipient_directory", action: "Faire confirmer l’adresse et demander à l’administrateur destinataire de vérifier les alias, DBEB et la synchronisation de l’annuaire.",
    source: "https://learn.microsoft.com/en-us/troubleshoot/exchange/email-delivery/ndr/fix-error-code-550-5-4-1",
  };
  return null;
}
export async function smtpMetrics(organizationId: string, domain: string, start: Date, end: Date) {
  const messages = await prisma.outboundMessage.findMany({ where: { organizationId, fromAddress: { endsWith: `@${domain}` }, createdAt: { gte: start, lt: end } },
    select: { recipients: true, deliveryJson: true, status: true }, take: 10001 });
  const result: Record<string, { requestedRecipients: number; observedRecipients: number; accepted: number; failed: number; lateBounceReports: number; waiting: number; unknown: number;
    lastSmtpObservationAt: string | null; diagnostics: Record<string, NonNullable<ReturnType<typeof providerDiagnostic>> & { count: number }> }> = {};
  for (const message of messages.slice(0, 10000)) {
    const recipients = message.recipients as { to: string[]; cc: string[]; bcc: string[] };
    const delivery = (message.deliveryJson ?? {}) as Record<string, RecipientDelivery>;
    for (const address of [...recipients.to, ...recipients.cc, ...recipients.bcc]) {
      const value = delivery[address] ?? {}, provider = recipientProvider(address, value.remoteMta, value.source === "smtp" ? value.smtpReply : undefined);
      const row = result[provider] ??= { requestedRecipients: 0, observedRecipients: 0, accepted: 0, failed: 0, lateBounceReports: 0, waiting: 0, unknown: 0, lastSmtpObservationAt: null, diagnostics: {} };
      row.requestedRecipients++; const state = recipientState(value);
      if (value.source === "smtp") {
        row.observedRecipients++;
        if (value.observedAt && Number.isFinite(Date.parse(value.observedAt)) && (!row.lastSmtpObservationAt || Date.parse(value.observedAt) > Date.parse(row.lastSmtpObservationAt))) row.lastSmtpObservationAt = value.observedAt;
        const diagnostic = providerDiagnostic(provider, value);
        if (diagnostic) { row.diagnostics[diagnostic.code] ??= { ...diagnostic, count: 0 }; row.diagnostics[diagnostic.code].count++; }
      }
      if (value.source === "smtp" && ["ACCEPTED", "DELIVERED"].includes(state)) row.accepted++;
      else if (value.source === "smtp" && state === "FAILED") row.failed++;
      else if (state === "BOUNCED") row.lateBounceReports++;
      else if (state === "QUEUED") row.waiting++;
      else row.unknown++;
    }
  }
  const minimum = Number(process.env.MAIL_SMTP_MIN_VOLUME) || 100;
  return { source: "kod_recipient_observations", scope: "domain", period: { start, end }, truncated: messages.length > 10000,
    availability: messages.length ? "available" : "unknown", observedAt: new Date(), fetchedAt: new Date(),
    absenceReason: messages.length ? null : "no_messages_observed_for_period", minimumRateVolume: minimum,
    providers: [...new Set([...Object.keys(result), "orange_wanadoo", "sfr", "free", "laposte"])].map(provider => {
      const value = result[provider];
      if (!value) return { provider, availability: "unknown", absenceReason: "no_recipient_observations_for_provider", requestedRecipients: messages.length > 10000 ? null : 0,
        observedRecipients: null, accepted: null, failed: null, lateBounceReports: null, waiting: null, unknown: null, lastSmtpObservationAt: null, diagnostics: null,
        rejectionRate: { value: null, numerator: null, denominator: null, absenceReason: "no_recipient_observations_for_provider" },
        evidenceRef: `/api/v1/mail/domains/${encodeURIComponent(domain)}/reputation`, inboxPlacement: null, humanReading: null };
      return { provider, ...value, diagnostics: value.observedRecipients ? Object.values(value.diagnostics) : null,
      accepted: value.observedRecipients ? value.accepted : null, failed: value.observedRecipients ? value.failed : null,
      availability: value.observedRecipients ? "available" : "unknown", absenceReason: value.observedRecipients ? null : "no_smtp_observations_for_provider",
      rejectionRate: { value: messages.length <= 10000 && value.observedRecipients >= minimum ? value.failed / value.observedRecipients : null,
        numerator: value.observedRecipients ? value.failed : null, denominator: value.observedRecipients || null, absenceReason: messages.length > 10000 ? "message_observation_limit_reached" : !value.observedRecipients ? "no_smtp_observations_for_provider" : value.observedRecipients >= minimum ? null : "insufficient_observed_volume",
        description: "Rejets parmi les destinataires avec observation SMTP KOD ; les inconnus et DSN déclaratifs sont hors dénominateur." },
      evidenceRef: `/api/v1/mail/domains/${encodeURIComponent(domain)}/reputation`, inboxPlacement: null, humanReading: null };
    }) };
}
