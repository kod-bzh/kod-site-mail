import { createHash } from "node:crypto";
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
  const allowedNamespaces = new Set(["urn:ietf:params:xml:ns:dmarc-2.0", "urn:ietf:params:xml:ns:dmarc", "http://dmarc.org/dmarc-xml/0.1"]);
  const namespaces = new Map<string, string>();
  for (const declaration of xml.matchAll(/\bxmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*["']([^"']+)["']/g)) {
    const prefix = declaration[1] ?? "", uri = declaration[2];
    if (namespaces.has(prefix) && namespaces.get(prefix) !== uri) throw Error("Redéfinition d’espace XML non prise en charge");
    namespaces.set(prefix, uri);
  }
  if (namespaces.has("") && !allowedNamespaces.has(namespaces.get("")!)) throw Error("Espace XML DMARC non pris en charge");
  const feedback = new XMLParser({ ignoreAttributes: true, processEntities: false, parseTagValue: false,
    transformTagName: name => { const colon = name.indexOf(":"); return colon > 0 && allowedNamespaces.has(namespaces.get(name.slice(0, colon)) ?? "") ? name.slice(colon + 1) : name; },
    isArray: (name, path) => name === "record" || String(path).endsWith("auth_results.dkim") || String(path).endsWith("auth_results.spf") }).parse(xml)?.feedback;
  if (!feedback || String(feedback.policy_published?.domain ?? "").toLowerCase() !== expectedDomain.toLowerCase()) throw Error("Le rapport ne concerne pas ce domaine");
  const records = (feedback.record ?? []) as { row?: { source_ip?: string; count?: string; policy_evaluated?: { dkim?: string; spf?: string; disposition?: string } }; auth_results?: { dkim?: { domain?: string; result?: string; selector?: string }[]; spf?: { domain?: string; result?: string; scope?: string }[] }; identifiers?: { header_from?: string } }[];
  // RFC 9990 section 3.1.1.2 requires at least one record.
  if (!records.length || records.length > 10_000) throw Error("Nombre de lignes DMARC invalide");
  const sources = records.map(record => {
    const count = Number(record.row?.count); const ip = String(record.row?.source_ip ?? "");
    if (!Number.isSafeInteger(count) || count < 0 || count > 100_000_000 || !isIP(ip)) throw Error("Compteur ou IP invalide");
    const auth = (rows: { domain?: string; result?: string; selector?: string; scope?: string }[] = []) => rows.slice(0, 20).map(row => ({ domain: String(row.domain ?? "").slice(0, 253), result: String(row.result ?? "unknown").slice(0, 32), selector: String(row.selector ?? "").slice(0, 100), scope: String(row.scope ?? "").slice(0, 32) }));
    return { ip, count, dkim: record.row?.policy_evaluated?.dkim === "pass", spf: record.row?.policy_evaluated?.spf === "pass",
      dkimAlignment: record.row?.policy_evaluated?.dkim ?? "unknown", spfAlignment: record.row?.policy_evaluated?.spf ?? "unknown",
      disposition: record.row?.policy_evaluated?.disposition ?? "unknown", headerFrom: String(record.identifiers?.header_from ?? "").slice(0, 253),
      dkimAuth: auth(record.auth_results?.dkim), spfAuth: auth(record.auth_results?.spf) };
  });
  const date = (value: unknown) => { const seconds = Number(value); if (!Number.isFinite(seconds) || seconds < 0 || seconds > 32_503_680_000) throw Error("Date de rapport invalide"); return new Date(seconds * 1000); };
  const totalCount = sources.reduce((sum, row) => sum + row.count, 0);
  if (totalCount > 2_000_000_000) throw Error("Compteur total trop élevé");
  const periodStart = date(feedback.report_metadata?.date_range?.begin), periodEnd = date(feedback.report_metadata?.date_range?.end);
  if (periodEnd <= periodStart || periodEnd.getTime() - periodStart.getTime() > 32 * 86400_000 || periodEnd.getTime() > Date.now() + 86400_000) throw Error("Période de rapport invalide");
  const reporter = String(feedback.report_metadata?.org_name ?? "").trim().toLowerCase().slice(0, 200);
  const identifier = String(feedback.report_metadata?.report_id ?? "").trim().slice(0, 300);
  if (!reporter || !identifier) throw Error("Identité de rapport absente");
  const semanticKey = createHash("sha256").update(JSON.stringify([expectedDomain.toLowerCase(), reporter, identifier, periodStart, periodEnd])).digest("hex");
  return { semanticKey, filename, reporter: String(feedback.report_metadata?.org_name ?? "").slice(0, 200), reportedDomain: expectedDomain,
    reportIdentifier: String(feedback.report_metadata?.report_id ?? "").slice(0, 300),
    periodStart, periodEnd,
    totalCount, dkimPassCount: sources.filter(row => row.dkim).reduce((n, r) => n + r.count, 0),
    spfPassCount: sources.filter(row => row.spf).reduce((n, r) => n + r.count, 0), sourcesJson: sources };
}
