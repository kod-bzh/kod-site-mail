import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { digest, setIncident } from "./telemetry";
import { ingestFeedback, resolveFeedbackDomain } from "./feedback";
import { parseDsn } from "./dsn-monitor";
import { dsnEventId, ingestReceipt } from "./receipts";

const auth = z.object({ domain: z.string().max(253), result: z.string().max(32), selector: z.string().max(100), scope: z.string().max(32) }).strict();
const row = z.object({ ip: z.string().ip(), count: z.number().int().min(0).max(100_000_000), dkim: z.boolean(), spf: z.boolean(),
  dkimAlignment: z.enum(["pass", "fail", "unknown"]), spfAlignment: z.enum(["pass", "fail", "unknown"]), disposition: z.string().max(32), headerFrom: z.string().max(253),
  dkimAuth: z.array(auth).max(20), spfAuth: z.array(auth).max(20) }).strict();
const aggregate = z.object({ reportedDomain: z.string().regex(/^[a-z0-9.-]{1,253}$/), reporter: z.string().min(1).max(200), reportIdentifier: z.string().min(1).max(300),
  periodStart: z.string().datetime(), periodEnd: z.string().datetime(), filename: z.string().max(255), sourcesJson: z.array(row).min(1).max(10000) }).strict();
export const incomingReportSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), address: z.string().email().max(320), targetRef: z.string().regex(/^[a-f0-9]{64}$/), peerIp: z.string().ip().nullable(),
  occurredAt: z.string().datetime(), verifiedDomains: z.array(z.string().regex(/^[a-z0-9.-]{1,253}$/)).max(5), kind: z.enum(["dmarc", "mdn", "arf", "dsn", "invalid_report"]),
  reason: z.enum(["invalid_dmarc_report", "invalid_structured_report"]).optional(), diagnosticRef: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  content: z.string().max(256000).optional(), originalHeaders: z.string().max(128000).optional(), report: aggregate.optional() }).strict();
export async function reportTargets() {
  const targets: { address: string; domain: string; organizationId: string; mailboxId: string; accountId: string; kinds: string[] }[] = [];
  const boxes = await prisma.mailbox.findMany({ where: { stalwartAccountId: { not: null } }, select: { id: true, organizationId: true, address: true, stalwartAccountId: true } });
  for (const box of boxes) {
    const domain = box.address.split("@")[1];
    // Only controlled mailbox addresses. No aliases inferred from a shared IP or customer identity.
    targets.push({ address: box.address.toLowerCase(), domain, organizationId: box.organizationId, mailboxId: box.id, accountId: box.stalwartAccountId!,
      kinds: /^(?:dmarc|postmaster)@/.test(box.address) ? ["dmarc", "feedback"] : ["feedback"] });
  }
  const aliases = await prisma.emailAlias.findMany({ where: { source: { startsWith: "dmarc@" } }, select: { organizationId: true, source: true, destination: true } });
  for (const alias of aliases) {
    const target = targets.find(item => item.organizationId === alias.organizationId && item.address === alias.destination.toLowerCase());
    if (target) targets.push({ ...target, address: alias.source.toLowerCase(), domain: alias.source.split("@")[1].toLowerCase(), kinds: ["dmarc"] });
  }
  return targets.map(target => ({ ...target, targetRef: digest([target.organizationId, target.mailboxId, target.accountId, target.address, target.domain]) }));
}
export async function ingestIncomingReport(input: z.infer<typeof incomingReportSchema>) {
  if (new Date(input.occurredAt).getTime() > Date.now() + 300000 || new Date(input.occurredAt).getTime() < Date.now() - 8 * 86400_000) throw Error("Outside intake window");
  const target = (await reportTargets()).find(row => row.address === input.address.toLowerCase());
  if (!target || target.targetRef !== input.targetRef) return false;
  if (input.kind === "invalid_report") {
    if (target.kinds.includes("dmarc")) await prisma.dmarcReport.upsert({ where: { id: input.id }, create: { id: input.id, organizationId: target.organizationId,
      mailboxId: target.mailboxId, sourceMessageId: `native:${input.diagnosticRef ?? input.id}`, sourceReceivedAt: new Date(input.occurredAt),
      filename: "invalid-report", reportedDomain: target.domain, error: input.reason ?? "invalid_structured_report", provenance: "native_inbound_unverified_report" }, update: {} });
    else await setIncident({ organizationId: target.organizationId, domain: target.domain, code: "invalid_feedback_report", active: true,
      summary: "Rapport structuré invalide dans la boîte surveillée", action: "Examiner le format du retour sans attribuer de destinataire ni interrompre le flux de factures.",
      evidence: { source: "native_inbound", scope: "monitored_inbox", evidenceRef: input.id, reason: input.reason ?? "invalid_structured_report" } });
    return true;
  }
  if (input.kind === "dmarc") {
    if (!target.kinds.includes("dmarc") || !input.report || input.report.reportedDomain !== target.domain) return false;
    const report = input.report, periodStart = new Date(report.periodStart), periodEnd = new Date(report.periodEnd);
    if (periodEnd <= periodStart || periodEnd.getTime() > Date.now() + 86400_000 || periodEnd.getTime() - periodStart.getTime() > 32 * 86400_000) throw Error("Invalid report period");
    const totalCount = report.sourcesJson.reduce((sum, row) => sum + row.count, 0); if (totalCount > 2_000_000_000) throw Error("Report volume limit");
    // Same canonical identity as the JMAP/Graph path, scoped to the receiving organization.
    const semantic = digest([report.reportedDomain.toLowerCase(), report.reporter.trim().toLowerCase(), report.reportIdentifier.trim(), periodStart, periodEnd]);
    const semanticKey = digest([target.organizationId, semantic]);
    await prisma.dmarcReport.upsert({ where: { semanticKey }, create: { ...report, semanticKey, id: input.id,
      organizationId: target.organizationId, mailboxId: target.mailboxId, sourceMessageId: `native:${input.id}`, sourceReceivedAt: new Date(input.occurredAt), periodStart, periodEnd, totalCount,
      dkimPassCount: report.sourcesJson.filter(row => row.dkim).reduce((sum, row) => sum + row.count, 0),
      spfPassCount: report.sourcesJson.filter(row => row.spf).reduce((sum, row) => sum + row.count, 0), provenance: "native_inbound_unverified_aggregate", intakeEvidence: { source: "native_before_encryption", receiverAddress: input.address, peerIp: input.peerIp, authenticatedSigningDomains: input.verifiedDomains, reporterClaimValidated: false } }, update: {} });
    return true;
  }
  if (!target.kinds.includes("feedback") || !input.content) return false;
  if (input.kind === "dsn") {
    for (const failure of parseDsn(input.content)) {
      const matching = await prisma.outboundMessage.findMany({ where: { organizationId: target.organizationId, accountId: target.accountId,
        rfcMessageId: failure.envelopeId.includes("@") ? failure.envelopeId : { startsWith: `${failure.envelopeId}@` } }, take: 2 });
      if (matching.length !== 1) continue;
      const original = matching[0];
      await ingestReceipt({ id: dsnEventId(original.rfcMessageId, failure.recipient, failure.smtpReply), type: "mail.bounced", rfcMessageId: original.rfcMessageId,
        from: original.fromAddress, recipient: failure.recipient, occurredAt: input.occurredAt, smtpReply: failure.smtpReply, remoteMta: failure.remoteMta, reliability: "unverified_report" });
    }
    return true;
  }
  try {
    const requestedIdentities = input.kind === "mdn" ? await prisma.outboundMessage.findMany({
      where: { organizationId: target.organizationId, accountId: target.accountId, requestReadReceipt: true, readReceiptAddress: target.address },
      distinct: ["fromAddress"], select: { fromAddress: true },
    }) : [];
    const connectors = input.kind === "arf" ? await prisma.mailConnector.findMany({ where: { organizationId: target.organizationId,
    provider: { in: ["yahoo_cfl", "microsoft_jmrp"] }, settings: { path: ["mailboxId"], equals: target.mailboxId } }, select: { domain: true } }) : [];
  const domain = await resolveFeedbackDomain({ organizationId: target.organizationId, accountId: target.accountId, fallbackDomain: target.domain,
    domains: [target.domain, ...requestedIdentities.map(row => row.fromAddress.split("@")[1]), ...connectors.map(row => row.domain)], kind: input.kind, content: input.content, originalHeaders: input.originalHeaders });
  return await ingestFeedback({ organizationId: target.organizationId, domain, accountId: target.accountId, sourceId: `native:${input.id}`,
    receivedAt: new Date(input.occurredAt), kind: input.kind, content: input.content, originalHeaders: input.originalHeaders, verifiedDomains: input.verifiedDomains });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "invalid_structured_report") {
      return ingestIncomingReport({ ...input, id: digest([input.id, "invalid"]), kind: "invalid_report", reason: "invalid_structured_report",
        diagnosticRef: input.id, content: undefined, originalHeaders: undefined, report: undefined });
    }
    throw error; // Storage/network failures remain retryable; untrusted parse errors do not poison the queue.
  }
}
