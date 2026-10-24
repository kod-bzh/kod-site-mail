import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { MailConnector } from "@prisma/client";
import { boundedResponse, ProviderError } from "./provider-connectors";
import { parseDmarcReport } from "./dmarc-report";
import { digest } from "./telemetry";

export const graphCredentials = z.object({ tenantId: z.string().uuid(), clientId: z.string().uuid(), clientSecret: z.string().min(5).max(10000),
  mailbox: z.string().email().max(320), folderId: z.string().min(1).max(1024) }).strict();
/** Only the explicitly authorized report folder is listed; no broad mailbox synchronization. */
export async function collectGraphDmarc(connector: MailConnector, credentials: z.infer<typeof graphCredentials>) {
  const tokenResponse = await fetch(`https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/token`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: credentials.clientId,
      client_secret: credentials.clientSecret, scope: "https://graph.microsoft.com/.default" }) });
  const token = JSON.parse((await boundedResponse(tokenResponse)).toString());
  if (typeof token.access_token !== "string") throw new ProviderError("authorization_required", "Autorisation Microsoft Graph Mail.Read limitée à cette boîte requise");
  const root = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(credentials.mailbox)}/mailFolders/${encodeURIComponent(credentials.folderId)}/messages`;
  const get = async (url: string) => { const parsed = new URL(url);
    if (parsed.origin !== "https://graph.microsoft.com" || !parsed.pathname.startsWith("/v1.0/")) throw Error("Pagination Graph interdite");
    return JSON.parse((await boundedResponse(await fetch(parsed, { redirect: "error", signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${token.access_token}` } }), 3_000_000)).toString()); };
  let next: string | undefined = `${root}?$top=20&$select=id,receivedDateTime&$filter=${encodeURIComponent(`hasAttachments eq true and receivedDateTime ge ${new Date(Date.now() - 30 * 86400_000).toISOString()}`)}`;
  let count = 0;
  for (let page = 0; next && page < 10; page++) {
    const messages = await get(next);
    for (const message of messages.value ?? []) {
      const attachments = await get(`${root}/${encodeURIComponent(message.id)}/attachments?$select=id,name,size,contentType`);
      if (attachments["@odata.nextLink"]) throw Error("Trop de pièces jointes DMARC ; collecte incomplète");
      for (const attachment of attachments.value ?? []) {
        if (!/\.(xml|gz|zip)$/i.test(attachment.name ?? "") || attachment.size > 2_000_000) continue;
        const sourceId = digest([connector.id, message.id, attachment.id]);
        if (await prisma.dmarcReport.findUnique({ where: { id: sourceId } })) continue;
        const file = await get(`${root}/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(attachment.id)}`);
        if (file["@odata.type"] !== "#microsoft.graph.fileAttachment" || typeof file.contentBytes !== "string" || file.contentBytes.length > 2_666_668) continue;
        try {
          const report = await parseDmarcReport(Buffer.from(file.contentBytes, "base64"), attachment.name, connector.domain);
          const semanticKey = digest([connector.organizationId, report.semanticKey]);
          await prisma.dmarcReport.upsert({ where: { semanticKey }, create: { ...report, semanticKey, id: sourceId,
            organizationId: connector.organizationId, mailboxId: connector.id, sourceMessageId: digest(message.id), sourceReceivedAt: new Date(message.receivedDateTime), provenance: "authorized_graph_mailbox_unverified_report" }, update: {} });
          count++;
        } catch {
          // Keep a bounded diagnostic, never attachment content or vendor-controlled exception text.
          await prisma.dmarcReport.upsert({ where: { id: sourceId }, create: { id: sourceId, organizationId: connector.organizationId,
            mailboxId: connector.id, sourceMessageId: digest(message.id), filename: "invalid-dmarc-report", reportedDomain: connector.domain,
            provenance: "authorized_graph_mailbox_unverified_report", error: "Rapport invalide, mauvais domaine ou limites dépassées" }, update: {} });
        }
      }
    }
    next = messages["@odata.nextLink"];
  }
  if (next) throw Error("Collecte Graph incomplète ; réduire le dossier de rapports");
  return count;
}
