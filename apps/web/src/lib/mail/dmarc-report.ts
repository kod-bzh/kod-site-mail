import { gunzipSync } from "node:zlib";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { fromBuffer } from "yauzl";
import { isIP } from "node:net";
export const MAX_REPORT_BYTES = 2_000_000;
async function unzipXml(buffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    fromBuffer(buffer, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error("Archive invalide"));
      let files = 0; let xml: Buffer | undefined;
      const fail = (error: Error) => { zip.close(); reject(error); };
      zip.on("error", fail);
      zip.on("end", () => xml ? resolve(xml) : reject(new Error("XML absent de l’archive")));
      zip.on("entry", entry => {
        if (++files > 10) return fail(new Error("Trop de fichiers dans l’archive"));
        if (!entry.fileName.toLowerCase().endsWith(".xml")) { zip.readEntry(); return; }
        if (xml || entry.uncompressedSize > MAX_REPORT_BYTES) return fail(new Error("Archive trop volumineuse ou plusieurs XML"));
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return fail(error ?? new Error("Fichier illisible"));
          const chunks: Buffer[] = []; let total = 0;
          stream.on("error", fail);
          stream.on("data", (chunk: Buffer) => { total += chunk.length; if (total > MAX_REPORT_BYTES) { stream.destroy(); fail(new Error("XML trop volumineux")); } else chunks.push(chunk); });
          stream.on("end", () => { xml = Buffer.concat(chunks); zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}
export async function parseDmarcReport(buffer: Buffer, filename: string, expectedDomain: string) {
  if (buffer.length > MAX_REPORT_BYTES) throw Error("Rapport compressé trop volumineux");
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = gunzipSync(buffer, { maxOutputLength: MAX_REPORT_BYTES });
  else if (buffer[0] === 0x50 && buffer[1] === 0x4b) buffer = await unzipXml(buffer);
  const xml = buffer.toString("utf8");
  if (buffer.length > MAX_REPORT_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw Error("XML interdit ou trop volumineux");
  // Reject excessive nesting before parsing untrusted report attachments.
  let depth = 0;
  for (const tag of xml.matchAll(/<\/?[A-Za-z_][^>]*>/g)) {
    if (tag[0].startsWith("</")) depth--; else if (!tag[0].endsWith("/>")) depth++;
    if (depth > 32 || depth < 0) throw Error("Profondeur XML invalide");
  }
  if (XMLValidator.validate(xml) !== true) throw Error("XML illisible");
  const feedback = new XMLParser({ ignoreAttributes: true, processEntities: false, parseTagValue: false, isArray: name => name === "record" }).parse(xml)?.feedback;
  if (!feedback || String(feedback.policy_published?.domain ?? "").toLowerCase() !== expectedDomain.toLowerCase()) throw Error("Le rapport ne concerne pas ce domaine");
  const records = (feedback.record ?? []) as { row?: { source_ip?: string; count?: string; policy_evaluated?: { dkim?: string; spf?: string } } }[];
  if (records.length > 10_000) throw Error("Trop de lignes dans le rapport");
  const sources = records.map(record => {
    const count = Number(record.row?.count); const ip = String(record.row?.source_ip ?? "");
    if (!Number.isSafeInteger(count) || count < 0 || count > 100_000_000 || !isIP(ip)) throw Error("Compteur ou IP invalide");
    return { ip, count, dkim: record.row?.policy_evaluated?.dkim === "pass", spf: record.row?.policy_evaluated?.spf === "pass" };
  });
  const date = (value: unknown) => { const seconds = Number(value); if (!Number.isFinite(seconds) || seconds < 0 || seconds > 32_503_680_000) throw Error("Date de rapport invalide"); return new Date(seconds * 1000); };
  const totalCount = sources.reduce((sum, row) => sum + row.count, 0);
  if (totalCount > 2_000_000_000) throw Error("Compteur total trop élevé");
  return { filename, reporter: String(feedback.report_metadata?.org_name ?? "").slice(0, 200), reportedDomain: expectedDomain,
    reportIdentifier: String(feedback.report_metadata?.report_id ?? "").slice(0, 300),
    periodStart: date(feedback.report_metadata?.date_range?.begin), periodEnd: date(feedback.report_metadata?.date_range?.end),
    totalCount, dkimPassCount: sources.filter(row => row.dkim).reduce((n, r) => n + r.count, 0),
    spfPassCount: sources.filter(row => row.spf).reduce((n, r) => n + r.count, 0), sourcesJson: sources };
}
