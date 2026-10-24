import { prisma } from "@/lib/prisma";
import { recipientState, type RecipientDelivery } from "./delivery-status";
export function recipientProvider(address: string, remoteMta?: string) {
  const domain = address.split("@")[1], host = (remoteMta ?? "").toLowerCase().replace(/\.$/, "");
  const suffix = (value: string) => host === value || host.endsWith(`.${value}`);
  if (suffix("protection.outlook.com")) return "microsoft365";
  if (["outlook.com", "hotmail.com", "live.com", "msn.com"].includes(domain)) return "outlook_consumer";
  if (suffix("google.com") || suffix("googlemail.com") || ["gmail.com", "googlemail.com"].includes(domain)) return "google_mx";
  if (suffix("yahoodns.net") || ["yahoo.com", "yahoo.fr", "aol.com"].includes(domain)) return "yahoo_aol";
  return "other_or_unknown";
}
export async function smtpMetrics(organizationId: string, domain: string, start: Date, end: Date) {
  const messages = await prisma.outboundMessage.findMany({ where: { organizationId, fromAddress: { endsWith: `@${domain}` }, createdAt: { gte: start, lt: end } },
    select: { recipients: true, deliveryJson: true, status: true }, take: 10001 });
  const result: Record<string, { requestedRecipients: number; observedRecipients: number; accepted: number; failed: number; lateBounceReports: number; waiting: number; unknown: number }> = {};
  for (const message of messages.slice(0, 10000)) {
    const recipients = message.recipients as { to: string[]; cc: string[]; bcc: string[] };
    const delivery = (message.deliveryJson ?? {}) as Record<string, RecipientDelivery>;
    for (const address of [...recipients.to, ...recipients.cc, ...recipients.bcc]) {
      const value = delivery[address] ?? {}, provider = recipientProvider(address, value.remoteMta);
      const row = result[provider] ??= { requestedRecipients: 0, observedRecipients: 0, accepted: 0, failed: 0, lateBounceReports: 0, waiting: 0, unknown: 0 };
      row.requestedRecipients++; const state = recipientState(value);
      if (value.source === "smtp") row.observedRecipients++;
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
    providers: messages.length ? Object.entries(result).map(([provider, value]) => ({ provider, ...value,
      rejectionRate: { value: messages.length <= 10000 && value.observedRecipients >= minimum ? value.failed / value.observedRecipients : null,
        numerator: value.failed, denominator: value.observedRecipients, absenceReason: messages.length > 10000 ? "message_observation_limit_reached" : value.observedRecipients >= minimum ? null : "insufficient_observed_volume",
        description: "Rejets parmi les destinataires avec observation SMTP KOD ; les inconnus et DSN déclaratifs sont hors dénominateur." },
      evidenceRef: `/api/v1/mail/domains/${encodeURIComponent(domain)}/reputation`, inboxPlacement: null, humanReading: null })) : null };
}
