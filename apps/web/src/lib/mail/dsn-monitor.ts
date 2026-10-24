import { prisma } from "@/lib/prisma";
import { listDsnMessages, downloadReportBlob, markDsnProcessed } from "@/lib/stalwart/client";
import { dsnEventId, ingestReceipt } from "./receipts";

/** A DSN is a failure report, never positive proof of delivery or reading. */
export function parseDsn(text: string): { envelopeId: string; recipient: string; smtpReply: string; remoteMta: string }[] {
  if (Buffer.byteLength(text) > 256_000) return [];
  const blocks = text.replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ").trim().split(/\n\s*\n/);
  const fields = (block: string) => Object.fromEntries(block.split("\n").flatMap(line => {
    const match = line.match(/^([A-Za-z-]+):\s*(.*)$/); return match ? [[match[1].toLowerCase(), match[2].trim()]] : [];
  }));
  const header = fields(blocks[0] ?? "");
  const envelopeId = (header["original-envelope-id"] ?? "").replace(/\+([A-Fa-f0-9]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/^<|>$/g, "");
  if (!/^[0-9a-f-]{36}(?:@[A-Za-z0-9.-]+)?$/.test(envelopeId)) return [];
  return blocks.slice(1).flatMap(block => {
    const row = fields(block), recipient = row["final-recipient"]?.replace(/^(?:rfc822|utf-8);\s*/i, "").trim().toLowerCase();
    if (row.action?.toLowerCase() !== "failed" || !/^5\.\d{1,3}\.\d{1,3}$/.test(row.status ?? "") || !recipient || !/^[^\s@]+@[^\s@]+$/.test(recipient)) return [];
    const diagnostic = (row["diagnostic-code"] ?? "").replace(/^smtp;\s*/i, "");
    return [{ envelopeId, recipient, smtpReply: (diagnostic || row.status).slice(0, 2000),
      remoteMta: (row["remote-mta"] ?? header["reporting-mta"] ?? "").replace(/^dns;\s*/i, "").slice(0, 255) }];
  });
}

export async function pollDsnReports() {
  const active = await prisma.outboundMessage.findMany({ where: { createdAt: { gte: new Date(Date.now() - 7 * 86400_000) }, submissionId: { not: null } },
    distinct: ["accountId", "fromAddress"], select: { accountId: true, fromAddress: true } });
  const accounts = new Map<string, string[]>();
  for (const item of active) accounts.set(item.accountId, [...(accounts.get(item.accountId) ?? []), item.fromAddress]);
  for (const [accountId, addresses] of accounts) {
    const id = `dsn:${accountId}`;
    await prisma.mailMonitorState.upsert({ where: { id }, create: { id, checkedAt: new Date(0) }, update: {} });
    const claim = await prisma.mailMonitorState.updateMany({ where: { id, checkedAt: { lt: new Date(Date.now() - 55_000) },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { leaseUntil: new Date(Date.now() + 120_000) } });
    if (!claim.count) continue;
    try {
      for (const message of await listDsnMessages(accountId, addresses)) {
        for (const part of message.parts) {
          const blob = await downloadReportBlob(accountId, part.blobId!);
          for (const failure of parseDsn(blob.toString("utf8"))) {
            const matching = await prisma.outboundMessage.findMany({ where: { accountId, rfcMessageId: failure.envelopeId.includes("@")
              ? failure.envelopeId : { startsWith: `${failure.envelopeId}@` } }, take: 2, select: { rfcMessageId: true, fromAddress: true } });
            if (matching.length !== 1) continue;
            const original = matching[0];
            await ingestReceipt({ recipient: failure.recipient, smtpReply: failure.smtpReply, remoteMta: failure.remoteMta, rfcMessageId: original.rfcMessageId,
              id: dsnEventId(original.rfcMessageId, failure.recipient, failure.smtpReply), type: "mail.bounced",
              from: original.fromAddress, reliability: "unverified_report", occurredAt: message.receivedAt });
          }
        }
        await markDsnProcessed(accountId, message.id);
      }
      await prisma.mailMonitorState.update({ where: { id }, data: { checkedAt: new Date(), lastError: null } });
    } catch { await prisma.mailMonitorState.update({ where: { id }, data: { lastError: "Lecture des retours de livraison indisponible" } }); }
    finally { await prisma.mailMonitorState.update({ where: { id }, data: { leaseUntil: null } }); }
  }
}
