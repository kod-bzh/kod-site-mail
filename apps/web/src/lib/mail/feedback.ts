import { Resolver } from "node:dns/promises";
import { dkimVerify } from "mailauth/lib/dkim/verify";
import { prisma } from "@/lib/prisma";
import { appendTelemetry, digest, setIncident } from "./telemetry";
import { downloadReportBlob, listFeedbackMessages, markFeedbackProcessed } from "@/lib/stalwart/client";

export class InvalidStructuredReport extends Error { readonly code = "invalid_structured_report"; }
export function reportFields(text: string): Record<string, string> {
  if (Buffer.byteLength(text) > 256_000 || text.includes("\0")) throw new InvalidStructuredReport("Rapport structuré trop volumineux");
  const values: Record<string, string> = Object.create(null);
  for (const line of text.replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ").split("\n")) {
    const match = line.match(/^([a-zA-Z][a-zA-Z0-9-]*):[ \t]*(.*)$/); if (!match) continue;
    const name = match[1].toLowerCase(); if (name in values) throw new InvalidStructuredReport("Champ structuré ambigu");
    values[name] = match[2].trim();
  }
  return values;
}
const address = (value: string | undefined) => {
  const normalized = (value ?? "").replace(/^(?:rfc822|utf-8);\s*/i, "").replace(/^<|>$/g, "").trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(normalized) ? normalized : null;
};
const messageId = (value: string | undefined) => {
  const normalized = (value ?? "").replace(/^<|>$/g, "").trim();
  return /^[^\s<>@]{1,100}@[^\s<>@]{1,253}$/.test(normalized) ? normalized : null;
};
export function parseMdn(text: string) {
  const fields = reportFields(text), rfcMessageId = messageId(fields["original-message-id"]);
  const recipient = address(fields["original-recipient"] ?? fields["final-recipient"]);
  const disposition = fields.disposition?.match(/^(manual-action|automatic-action)\/(MDN-sent-manually|MDN-sent-automatically);\s*(displayed|deleted|dispatched|processed|denied|failed)(?:\/([a-zA-Z0-9, -]+))?$/i);
  if (!rfcMessageId || !recipient || !disposition) return null;
  return { rfcMessageId, recipient, disposition: disposition[3].toLowerCase(), actionMode: disposition[1].toLowerCase(),
    sendingMode: disposition[2].toLowerCase(), modifiers: disposition[4]?.slice(0, 100) ?? null };
}
export function parseArf(text: string, originalHeaders: string) {
  const fields = reportFields(text), headers = reportFields(originalHeaders);
  if (fields["feedback-type"]?.toLowerCase() !== "abuse" || fields.version !== "1") return null;
  return { rfcMessageId: messageId(headers["message-id"] ?? fields["original-message-id"]),
    recipient: address(fields["original-rcpt-to"]), originalFrom: address(fields["original-mail-from"]), feedbackType: "abuse" };
}
export async function verifiedDkimDomains(raw: Buffer): Promise<string[]> {
  if (raw.length > 2_000_000) return [];
  const header = raw.subarray(0, Math.min(raw.length, 128_000)).toString("latin1").split(/\r?\n\r?\n/)[0];
  if ((header.match(/^DKIM-Signature:/gim) ?? []).length > 5) return [];
  const resolver = new Resolver({ timeout: 2000, tries: 1 }); let queries = 0;
  const result = await dkimVerify(raw, { strict: true, resolver: async (name: string, type: string) => {
    if (type !== "TXT" || ++queries > 10 || !/^[a-zA-Z0-9_.-]{1,253}$/.test(name)) throw Error("DNS de signature interdit");
    return resolver.resolveTxt(name);
  } });
  return result.results.filter(row => row.status.result === "pass" && !row.canonBodyLengthLimited && row.signingDomain)
    .map(row => row.signingDomain!.toLowerCase());
}
export async function ingestFeedback(input: { organizationId: string; domain: string; accountId: string; sourceId: string;
  receivedAt: Date; kind: "mdn" | "arf"; content: string; originalHeaders?: string; verifiedDomains: string[] }) {
  const report = input.kind === "mdn" ? parseMdn(input.content) : parseArf(input.content, input.originalHeaders ?? "");
  if (!report || input.receivedAt.getTime() > Date.now() + 300_000 || input.receivedAt.getTime() < Date.now() - 90 * 86400_000) return false;
  const original = report.rfcMessageId ? await prisma.outboundMessage.findFirst({ where: { organizationId: input.organizationId,
    ...(input.kind === "mdn" ? { accountId: input.accountId } : {}), rfcMessageId: report.rfcMessageId, fromAddress: { endsWith: `@${input.domain}` } } }) : null;
  const expected = original?.recipients as { to: string[]; cc: string[]; bcc: string[] } | undefined;
  const knownRecipient = report.recipient && expected && [...expected.to, ...expected.cc, ...expected.bcc].includes(report.recipient) ? report.recipient : null;
  if (input.kind === "mdn" && (!original?.requestReadReceipt || !knownRecipient)) return false;
  let provider = "unverified_report";
  if (input.kind === "arf") {
    if (input.verifiedDomains.includes("arf.mail.yahoo.com")) provider = "yahoo_cfl";
    else {
      const connector = await prisma.mailConnector.findUnique({ where: { organizationId_domain_provider: { organizationId: input.organizationId, domain: input.domain, provider: "microsoft_jmrp" } } });
      const settings = connector?.settings as { signingDomains?: string[] } | null;
      if (settings?.signingDomains?.some(domain => input.verifiedDomains.includes(domain))) provider = "microsoft_jmrp";
    }
    // Unmatched feedback cannot be assigned by a shared IP or a guess at the recipient.
    if (!original) {
      if (provider !== "unverified_report") await setIncident({ organizationId: input.organizationId, domain: input.domain,
        code: `unmatched_feedback:${provider}`, active: true, summary: "Plainte fournisseur reçue mais non corrélable",
        action: "Examiner le retour dans la boîte surveillée. Aucun destinataire ni domaine d’envoi ne sont attribués, aucune suppression automatique.",
        evidence: { scope: "monitored_inbox", provider, reliability: "authenticated_provider_report", receivedAt: input.receivedAt.toISOString(), evidenceRef: digest(input.sourceId) } });
      return false;
    }
  }
  const reliability = input.kind === "mdn" ? (input.verifiedDomains.includes(knownRecipient!.split("@")[1]) ? "authenticated_domain_report" : "unverified_report")
    : provider === "unverified_report" ? "unverified_report" : "authenticated_provider_report";
  const visibleRecipient = knownRecipient && !expected?.bcc.includes(knownRecipient) ? knownRecipient : null;
  const data = input.kind === "mdn" ? { requestMade: true, receiptReceived: true, disposition: (report as ReturnType<typeof parseMdn>)!.disposition,
    actionMode: (report as ReturnType<typeof parseMdn>)!.actionMode, label: "Accusé de lecture reçu", humanReadingProven: false }
    : { feedbackType: "abuse", recipientIdentified: !!visibleRecipient, action: "Examiner la plainte ; aucun blocage automatique du flux de factures." };
  const id = digest([input.organizationId, input.domain, input.kind, report.rfcMessageId, knownRecipient, data]);
  return prisma.$transaction(tx => appendTelemetry(tx, { id, organizationId: input.organizationId, domain: input.domain,
    messageId: original?.id, initiatorId: original?.initiatorId, recipient: visibleRecipient, type: input.kind === "mdn" ? "email.mdn" : "email.complaint",
    source: input.kind === "mdn" ? "rfc8098" : provider, reliability, occurredAt: input.receivedAt,
    data: { ...data, evidenceRef: `feedback:${id}`, rfcMessageId: report.rfcMessageId } }));
}
export async function resolveFeedbackDomain(input: { organizationId: string; accountId: string; domains: string[]; fallbackDomain: string; kind: "mdn" | "arf"; content: string; originalHeaders?: string }) {
  const report = input.kind === "mdn" ? parseMdn(input.content) : parseArf(input.content, input.originalHeaders ?? "");
  if (!report?.rfcMessageId) return input.fallbackDomain;
  const original = await prisma.outboundMessage.findFirst({ where: { organizationId: input.organizationId, rfcMessageId: report.rfcMessageId,
    ...(input.kind === "mdn" ? { accountId: input.accountId } : {}) }, select: { fromAddress: true } });
  const domain = original?.fromAddress?.split("@")[1];
  return domain && input.domains.includes(domain) ? domain : input.fallbackDomain;
}

export async function pollFeedbackReports() {
  // Monitor requested MDNs plus explicitly configured feedback inboxes, never general copies of all mail.
  const messages = await prisma.outboundMessage.findMany({ where: { createdAt: { gte: new Date(Date.now() - 30 * 86400_000) } },
    distinct: ["organizationId", "accountId", "fromAddress"], select: { organizationId: true, accountId: true, fromAddress: true } });
  const accounts = new Map<string, { organizationId: string; accountId: string; domains: Set<string>; fallbackDomain: string }>();
  for (const row of messages) {
    const key = `${row.organizationId}:${row.accountId}`, domain = row.fromAddress.split("@")[1];
    const account = accounts.get(key) ?? { organizationId: row.organizationId, accountId: row.accountId, domains: new Set<string>(), fallbackDomain: domain };
    account.domains.add(domain); accounts.set(key, account);
  }
  const connectors = await prisma.mailConnector.findMany({ where: { provider: { in: ["yahoo_cfl", "microsoft_jmrp"] }, state: { not: "not_configured" } } });
  for (const connector of connectors) {
    const settings = connector.settings as { mailboxId?: string } | null;
    if (!settings?.mailboxId) continue;
    const box = await prisma.mailbox.findFirst({ where: { id: settings.mailboxId, organizationId: connector.organizationId } });
    if (box?.stalwartAccountId) {
      const key = `${box.organizationId}:${box.stalwartAccountId}`;
      const account = accounts.get(key) ?? { organizationId: box.organizationId, accountId: box.stalwartAccountId, domains: new Set<string>(), fallbackDomain: box.address.split("@")[1] };
      account.domains.add(connector.domain); account.fallbackDomain = box.address.split("@")[1]; accounts.set(key, account);
    }
  }
  for (const account of accounts.values()) {
    const id = `feedback:${account.organizationId}:${account.accountId}`;
    await prisma.mailMonitorState.upsert({ where: { id }, create: { id, checkedAt: new Date(0) }, update: {} });
    const claim = await prisma.mailMonitorState.updateMany({ where: { id, checkedAt: { lt: new Date(Date.now() - 55_000) }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { leaseUntil: new Date(Date.now() + 120_000) } });
    if (!claim.count) continue;
    try {
      for (const report of await listFeedbackMessages(account.accountId)) {
        for (const part of report.parts) {
          if (!["message/disposition-notification", "message/feedback-report"].includes(part.type ?? "") || (part.size ?? 0) > 256_000) continue;
          const content = (await downloadReportBlob(account.accountId, part.blobId!)).toString("utf8");
          const original = report.parts.find(row => ["text/rfc822-headers", "message/rfc822"].includes(row.type ?? ""));
          const originalHeaders = original && (original.size ?? 0) <= 128_000 ? (await downloadReportBlob(account.accountId, original.blobId!)).toString("utf8").split(/\r?\n\r?\n/)[0] : "";
          const verifiedDomains = report.size <= 2_000_000 ? await verifiedDkimDomains(await downloadReportBlob(account.accountId, report.blobId)) : [];
          try {
            const kind = part.type === "message/disposition-notification" ? "mdn" : "arf";
            const domain = await resolveFeedbackDomain({ ...account, domains: [...account.domains], kind, content, originalHeaders });
            await ingestFeedback({ organizationId: account.organizationId, accountId: account.accountId, domain,
              sourceId: `${account.accountId}:${report.id}:${part.blobId}`, receivedAt: new Date(report.receivedAt), kind, content, originalHeaders, verifiedDomains });
          }
          catch (error) { if (!(error instanceof Error) || !/structuré|ambigu/.test(error.message)) throw error; }
        }
        await markFeedbackProcessed(account.accountId, report.id);
      }
      await prisma.mailMonitorState.update({ where: { id }, data: { checkedAt: new Date(), lastError: null } });
    } catch { await prisma.mailMonitorState.update({ where: { id }, data: { lastError: "Collecte des plaintes/MDN indisponible ; les données restent inconnues." } }); }
    finally { await prisma.mailMonitorState.update({ where: { id }, data: { leaseUntil: null } }); }
  }
}
