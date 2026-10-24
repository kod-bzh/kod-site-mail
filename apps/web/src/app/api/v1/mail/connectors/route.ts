import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { resolveV1ActorFromRequest, resolveActorOrganizationId } from "@/lib/api/v1-auth";
import { readScope } from "@/lib/mail/deliverability-read";
import { PROVIDERS, connectorPublic, googleCredentials, sndsCredentials, approvedSndsUrl, secretConfiguration } from "@/lib/mail/provider-connectors";
import { graphCredentials } from "@/lib/mail/graph-dmarc";
import { readLimitedBody } from "@/lib/mail/read-limited-body";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const scope = await readScope(req); if (scope.error) return scope.error;
  const rows = await prisma.mailConnector.findMany({ where: { organizationId: scope.organizationId, domain: { in: scope.domains } } });
  return Response.json({ connectors: scope.domains.flatMap(domain => PROVIDERS.map(provider => ({ domain, ...connectorPublic(rows.find(row => row.domain === domain && row.provider === provider) ?? null, provider) }))) });
}
const settingsSchema = z.object({ mailboxId: z.string().max(100).optional(), enrollmentVerifiedAt: z.string().datetime().optional(),
  signingDomains: z.array(z.string().regex(/^[a-z0-9.-]{1,253}$/)).max(10).optional(),
  ipColumn: z.string().max(100).optional(), dateColumn: z.string().max(100).optional(), reputationColumn: z.string().max(100).optional(),
  knownSources: z.array(z.object({ cidr: z.string().max(64), kind: z.enum(["microsoft365", "known_other"]), label: z.string().max(100) }).strict()).max(100).optional(),
}).strict();
export async function POST(req: Request) {
  const actor = await resolveV1ActorFromRequest(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!actor.isAdmin) return Response.json({ error: "platform_admin_required" }, { status: 403 });
  const org = await resolveActorOrganizationId(actor, { organizationSlug: new URL(req.url).searchParams.get("organizationSlug") ?? undefined });
  if (!org.ok) return Response.json({ error: org.error }, { status: 403 });
  try {
    const body = z.object({ domain: z.string().regex(/^[a-z0-9.-]{1,253}$/), provider: z.enum(PROVIDERS), credentials: z.unknown().optional(),
      expiresAt: z.string().datetime().optional(), settings: settingsSchema.optional() }).strict().parse(JSON.parse(await readLimitedBody(req, 32000)));
    const registered = await prisma.domain.findFirst({ where: { organizationId: org.organizationId, fqdn: body.domain } })
      ?? await prisma.mailMonitoredDomain.findFirst({ where: { organizationId: org.organizationId, domain: body.domain } });
    if (!registered) return Response.json({ error: "domain_not_authorized" }, { status: 403 });
    let credentials: unknown;
    if (body.provider === "google_postmaster") credentials = googleCredentials.parse(body.credentials);
    else if (body.provider === "microsoft365_dmarc") credentials = graphCredentials.parse(body.credentials);
    else if (body.provider === "microsoft_snds") { credentials = sndsCredentials.parse(body.credentials); approvedSndsUrl((credentials as { url: string }).url);
      if (!body.expiresAt || !body.settings?.ipColumn || !body.settings.dateColumn || !body.settings.reputationColumn) throw Error("SNDS schema/expiry required"); }
    else if (body.provider === "blocklists") credentials = z.object({ zone: z.string().regex(/^[a-zA-Z0-9.-]+\.dq\.spamhaus\.net$/), resolver: z.string().ip() }).strict().parse(body.credentials);
    else if (body.credentials !== undefined) throw Error("Credentials not supported");
    if (["microsoft_jmrp", "yahoo_cfl"].includes(body.provider)) {
      if (!body.settings?.mailboxId || !body.settings.enrollmentVerifiedAt || !body.expiresAt) throw Error("Enrollment proof/expiry required");
      const mailbox = await prisma.mailbox.findFirst({ where: { id: body.settings.mailboxId, organizationId: org.organizationId, domain: { fqdn: body.domain } } });
      if (!mailbox?.stalwartAccountId) throw Error("Mailbox not authorized");
    }
    const data = { settings: body.settings, ...(credentials ? { secretCipher: secretConfiguration(credentials) } : {}),
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, state: "insufficient_data", lastError: null, nextCheckAt: new Date() };
    const connector = await prisma.mailConnector.upsert({ where: { organizationId_domain_provider: { organizationId: org.organizationId, domain: body.domain, provider: body.provider } },
      create: { organizationId: org.organizationId, domain: body.domain, provider: body.provider, ...data }, update: data });
    await prisma.auditLog.create({ data: { organizationId: org.organizationId, action: "mail.connector.configure", target: `${body.domain}:${body.provider}`, metadata: { credentialsProvided: !!credentials } } });
    return Response.json({ connector: connectorPublic(connector, body.provider) });
  } catch { return Response.json({ error: "invalid_connector_configuration", detail: "Vérifier le domaine autorisé, le format, l’inscription, les colonnes et les dates de renouvellement. Aucun secret retourné." }, { status: 400 }); }
}
