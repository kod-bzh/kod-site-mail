import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { downloadReportBlob, listDmarcMessages, markDmarcProcessed } from "@/lib/stalwart/client";
import { parseDmarcReport } from "./dmarc-report";
export async function pollDmarcReports(): Promise<void> {
  const mailboxes = await prisma.mailbox.findMany({ where: { address: { startsWith: "postmaster@" }, stalwartAccountId: { not: null } }, select: { id: true, address: true, organizationId: true, stalwartAccountId: true } });
  for (const mailbox of mailboxes) {
    const id = `dmarc:${mailbox.id}`;
    await prisma.mailMonitorState.upsert({ where: { id }, create: { id, checkedAt: new Date(0) }, update: {} });
    const claim = await prisma.mailMonitorState.updateMany({ where: { id, checkedAt: { lt: new Date(Date.now() - 55_000) }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { leaseUntil: new Date(Date.now() + 120_000) } });
    if (!claim.count) continue;
    try {
      const domain = mailbox.address.split("@")[1]; const accountId = mailbox.stalwartAccountId!;
      const messages = await listDmarcMessages(accountId, `dmarc@${domain}`);
      const deadline = Date.now() + 45_000;
      scan: for (const message of messages) {
        for (const attachment of message.attachments) {
          if (Date.now() > deadline) break scan;
          const reportId = createHash("sha256").update(`${accountId}:${message.id}:${attachment.blobId}`).digest("hex");
          if (await prisma.dmarcReport.findUnique({ where: { id: reportId } })) continue;
          const base = { id: reportId, organizationId: mailbox.organizationId, mailboxId: mailbox.id, sourceMessageId: message.id, filename: attachment.name! };
          const buffer = (attachment.size ?? 0) <= 2_000_000 ? await downloadReportBlob(accountId, attachment.blobId!) : null;
          try {
            if (!buffer) throw Error("Rapport trop volumineux");
            const data = await parseDmarcReport(buffer, attachment.name!, domain);
            await prisma.dmarcReport.create({ data: { ...base, ...data } });
          } catch (error) {
            await prisma.dmarcReport.create({ data: { ...base, error: (error instanceof Error ? error.message : "Rapport illisible").slice(0, 1000) } });
          }
        }
        await markDmarcProcessed(accountId, message.id);
      }
      await prisma.mailMonitorState.update({ where: { id }, data: { checkedAt: new Date(), lastError: null } });
    } catch (error) {
      await prisma.mailMonitorState.update({ where: { id }, data: { lastError: (error instanceof Error ? error.message : "Lecture indisponible").slice(0, 1000) } });
    } finally {
      await prisma.mailMonitorState.update({ where: { id }, data: { leaseUntil: null } });
    }
  }
}
