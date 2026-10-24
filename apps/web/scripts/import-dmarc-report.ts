/** Operator-only import after authorized decryption; never submits email. */
import { parseArgs } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { prisma } from "../src/lib/prisma";
import { parseDmarcReport, MAX_REPORT_BYTES } from "../src/lib/mail/dmarc-report";
import { digest } from "../src/lib/mail/telemetry";
async function run() {
  const { values } = parseArgs({ options: { organization: { type: "string" }, domain: { type: "string" }, file: { type: "string" } } });
  if (!values.organization || !values.domain || !values.file) throw Error("Required: --organization slug --domain example.org --file authorized-report.xml[.gz|.zip]");
  const organization = await prisma.organization.findUnique({ where: { slug: values.organization }, select: { id: true } });
  if (!organization) throw Error("Organization unavailable");
  const owned = await prisma.domain.findFirst({ where: { organizationId: organization.id, fqdn: values.domain } })
    ?? await prisma.mailMonitoredDomain.findFirst({ where: { organizationId: organization.id, domain: values.domain } });
  if (!owned) throw Error("Domain not authorized");
  const metadata = await stat(values.file); if (!metadata.isFile() || metadata.size > MAX_REPORT_BYTES) throw Error("Report limit");
  const buffer = await readFile(values.file), report = await parseDmarcReport(buffer, "authorized-import.xml", values.domain);
  const semanticKey = digest([organization.id, report.semanticKey]), id = digest([organization.id, buffer.toString("base64")]);
  await prisma.dmarcReport.upsert({ where: { semanticKey }, create: { ...report, semanticKey, id, organizationId: organization.id,
    mailboxId: "authorized-operator-import", sourceMessageId: id, provenance: "authorized_manual_export_unverified_report" }, update: {} });
  console.log(JSON.stringify({ imported: true, evidenceRef: id, domain: values.domain, totalCount: report.totalCount, periodStart: report.periodStart, periodEnd: report.periodEnd, emailSubmitted: false }));
}
run().catch(() => { console.error("Report import failed: verify authorization, domain and bounded XML input. No content retained in logs."); process.exitCode = 1; }).finally(() => prisma.$disconnect());
