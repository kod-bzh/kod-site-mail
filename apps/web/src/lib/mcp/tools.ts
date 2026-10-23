import { sendBodySchema } from "@/lib/mail/send-payload";
import { z } from "zod";
import {
  ALL_API_SCOPES,
  API_KEY_WRITE_SCOPE,
  DOMAIN_READ_SCOPE,
  DOMAIN_WRITE_SCOPE,
  MAIL_SEND_SCOPE,
  MAILBOX_WRITE_SCOPE,
  MCP_DEFAULT_SCOPES,
  createOrganizationApiKey,
} from "@/lib/api-keys";
import {
  actorHasScope,
  resolveActorOrganizationId,
  type V1Actor,
} from "@/lib/api/v1-auth";
import {
  addDomainForOrg,
  getOrganizationDomain,
  listOrganizationDomains,
  previewDomainDns,
  verifyDomainForOrg,
} from "@/lib/domains/manage";
import { createMailboxForOrg } from "@/lib/mail/create-mailbox";
import { refreshOutbound } from "@/lib/mail/delivery";
import { DELIVERY_NOTICE } from "@/lib/mail/delivery-status";
import { sendOrgMail } from "@/lib/mail/org-mail-send";
import { getMailSendApiGuide } from "@/lib/mcp/mail-api-guide";
import { verifyDomainDns } from "@/lib/dns/verify";
import { prisma } from "@/lib/prisma";

export type McpToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(error: string, extra?: Record<string, unknown>): McpToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error, ...extra }) }],
  };
}

const fqdnField = z.string().min(3).max(253);
const orgSlugField = z.string().min(1).max(80).optional();

export type McpToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, actor: V1Actor) => Promise<McpToolResult>;
};

async function requireOrg(
  actor: V1Actor,
  options?: { organizationSlug?: string; fqdn?: string }
) {
  return resolveActorOrganizationId(actor, options);
}

export const FRAMM_MCP_TOOLS: McpToolDef[] = [
  {
    name: "list_organizations",
    description: "Liste les organisations Framm (jeton admin uniquement).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, actor) => {
      if (!actor.isAdmin) return fail("forbidden");
      const orgs = await prisma.organization.findMany({
        select: { id: true, name: true, slug: true, status: true },
        orderBy: { slug: "asc" },
      });
      return ok({ organizations: orgs });
    },
  },
  {
    name: "get_dns_records",
    description:
      "Retourne SPF, DKIM et DMARC à publier pour améliorer la délivrabilité. MX et autoconfiguration sont optionnels pour la réception. Ajouter le domaine au préalable pour obtenir les clés DKIM exactes.",
    inputSchema: {
      type: "object",
      properties: {
        fqdn: { type: "string", description: "Nom de domaine (ex. asso.fr)" },
      },
      required: ["fqdn"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const parsed = z.object({ fqdn: fqdnField }).safeParse(args);
      if (!parsed.success) return fail("invalid_arguments");
      const result = await previewDomainDns(parsed.data.fqdn);
      if (!result.ok) return fail(result.error);
      return ok({
        fqdn: result.fqdn,
        mailHost: result.mailHost,
        records: result.records,
        signingConfigured: result.signingConfigured,
        warning: result.signingConfigured ? null : "Clés DKIM indisponibles : appeler add_domain puis relancer ce contrôle. Ne pas considérer cette liste comme complète.",
        instruction:
          "Publier SPF, DKIM et DMARC ; fusionner le SPF existant, conserver une politique DMARC plus stricte. Garder les MX existants si la réception reste ailleurs. Relancer verify_domain après propagation. L’envoi peut fonctionner avant validation DNS, sans garantie de réception.",
      });
    },
  },
  {
    name: "add_domain",
    description:
      "Enregistre un nom de domaine sur une organisation Framm, synchronise Stalwart et renvoie les DNS à publier.",
    inputSchema: {
      type: "object",
      properties: {
        fqdn: { type: "string", description: "Nom de domaine à ajouter" },
        organizationSlug: {
          type: "string",
          description: "Slug de l'organisation (requis avec le jeton admin)",
        },
      },
      required: ["fqdn"],
      additionalProperties: false,
    },
    handler: async (args, actor) => {
      if (!actorHasScope(actor, DOMAIN_WRITE_SCOPE)) return fail("forbidden");
      const parsed = z.object({ fqdn: fqdnField, organizationSlug: orgSlugField }).safeParse(args);
      if (!parsed.success) return fail("invalid_arguments");
      const org = await requireOrg(actor, {
        organizationSlug: parsed.data.organizationSlug,
        fqdn: parsed.data.fqdn,
      });
      if (!org.ok) return fail(org.error);
      const result = await addDomainForOrg(org.organizationId, parsed.data.fqdn);
      if (!result.ok) return fail(result.error);
      return ok({
        ...result,
        instruction:
          "Lire notice et sendingAllowed. Si true, get_api_key puis send_mail depuis sender sont disponibles immédiatement. Publier les DNS d’authentification fournis puis verify_domain. Ne pas remplacer les MX pour un usage envoi uniquement.",
      });
    },
  },
  {
    name: "list_domains",
    description: "Liste les domaines d'une organisation et leur statut DNS.",
    inputSchema: {
      type: "object",
      properties: {
        organizationSlug: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: async (args, actor) => {
      if (!actorHasScope(actor, DOMAIN_READ_SCOPE) && !actorHasScope(actor, DOMAIN_WRITE_SCOPE)) {
        return fail("forbidden");
      }
      const parsed = z.object({ organizationSlug: orgSlugField }).safeParse(args);
      if (!parsed.success) return fail("invalid_arguments");
      const org = await requireOrg(actor, { organizationSlug: parsed.data.organizationSlug });
      if (!org.ok) return fail(org.error);
      return ok({ domains: await listOrganizationDomains(org.organizationId) });
    },
  },
  {
    name: "get_domain_status",
    description: "Statut et diagnostic en direct SPF, DKIM, DMARC et reverse DNS. L’envoi reste autorisé pendant la configuration DNS.",
    inputSchema: {
      type: "object",
      properties: {
        fqdn: { type: "string" },
        organizationSlug: { type: "string" },
      },
      required: ["fqdn"],
      additionalProperties: false,
    },
    handler: async (args, actor) => {
      if (!actorHasScope(actor, DOMAIN_READ_SCOPE) && !actorHasScope(actor, DOMAIN_WRITE_SCOPE)) {
        return fail("forbidden");
      }
      const parsed = z.object({ fqdn: fqdnField, organizationSlug: orgSlugField }).safeParse(args);
      if (!parsed.success) return fail("invalid_arguments");
      const org = await requireOrg(actor, {
        organizationSlug: parsed.data.organizationSlug,
        fqdn: parsed.data.fqdn,
      });
      if (!org.ok) return fail(org.error);
      const domain = await getOrganizationDomain(org.organizationId, parsed.data.fqdn);
      if (!domain) return fail("domain_not_found");
      return ok({ domain, deliverability: await verifyDomainDns(domain.fqdn) });
    },
  },
  {
    name: "verify_domain",
    description:
      "Vérifie SPF (IP, includes, limite DNS), les clés DKIM actives, DMARC et reverse DNS. MX/autoconfiguration sont informatifs. Ne bloque pas l’envoi.",
    inputSchema: {
      type: "object",
      properties: {
        fqdn: { type: "string" },
        organizationSlug: { type: "string" },
      },
      required: ["fqdn"],
      additionalProperties: false,
    },
    handler: async (args, actor) => {
      if (!actorHasScope(actor, DOMAIN_WRITE_SCOPE)) return fail("forbidden");
      const parsed = z.object({ fqdn: fqdnField, organizationSlug: orgSlugField }).safeParse(args);
      if (!parsed.success) return fail("invalid_arguments");
      const org = await requireOrg(actor, {
        organizationSlug: parsed.data.organizationSlug,
        fqdn: parsed.data.fqdn,
      });
      if (!org.ok) return fail(org.error);
      const result = await verifyDomainForOrg(org.organizationId, parsed.data.fqdn);
      if (!result.ok) return fail(result.error);
      return ok({
        domain: result.domain,
        verified: result.check.verified,
        deliverability: result.check,
        domainExists: result.check.domainExists,
        records: result.records,
        checks: result.check.results.map((row) => ({
          type: row.record.type,
          host: row.record.name,
          expected: row.record.value,
          found: row.found,
          ok: row.ok,
          issue: row.issue,
        })),
      });
    },
  },
  {
    name: "list_api_keys",
    description: "Liste les préfixes de clés API (le secret n'est jamais relisible).",
    inputSchema: {
      type: "object",
      properties: { organizationSlug: { type: "string" } },
      additionalProperties: false,
    },
    handler: async (args, actor) => {
      if (!actorHasScope(actor, API_KEY_WRITE_SCOPE) && !actor.isAdmin) {
        return fail("forbidden");
      }
      const parsed = z.object({ organizationSlug: orgSlugField }).safeParse(args);
      if (!parsed.success) return fail("invalid_arguments");
      const org = await requireOrg(actor, { organizationSlug: parsed.data.organizationSlug });
      if (!org.ok) return fail(org.error);
      const keys = await prisma.organizationApiKey.findMany({
        where: { organizationId: org.organizationId, revokedAt: null },
        select: { id: true, name: true, keyPrefix: true, scopes: true, lastUsedAt: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      });
      return ok({ keys });
    },
  },
  {
    name: "get_api_key",
    description:
      "Crée une clé API organisation (framm_…) pour envoyer des mails. Le secret n'est renvoyé qu'une fois.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Libellé de la clé (défaut MCP)" },
        organizationSlug: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: async (args, actor) => {
      if (!actorHasScope(actor, API_KEY_WRITE_SCOPE) && !actor.isAdmin) {
        return fail("forbidden");
      }
      const parsed = z
        .object({
          name: z.string().min(1).max(80).optional(),
          organizationSlug: orgSlugField,
        })
        .safeParse(args);
      if (!parsed.success) return fail("invalid_arguments");
      const org = await requireOrg(actor, { organizationSlug: parsed.data.organizationSlug });
      if (!org.ok) return fail(org.error);
      const allowed = actor.isAdmin
        ? [...ALL_API_SCOPES]
        : MCP_DEFAULT_SCOPES.filter((scope) => actorHasScope(actor, scope));
      const created = await createOrganizationApiKey({
        organizationId: org.organizationId,
        name: parsed.data.name?.trim() || "MCP",
        scopes: allowed.length > 0 ? allowed : [MAIL_SEND_SCOPE],
        createdById: actor.userId,
      });
      return ok({
        id: created.id,
        prefix: created.prefix,
        token: created.token,
        scopes: allowed,
        warning: "Stocker le token maintenant : il ne sera plus relisible.",
      });
    },
  },
  {
    name: "ensure_mailbox",
    description:
      "Crée une boîte Stalwart (ex. noreply@domaine) si elle n'existe pas. Nécessaire avant send_mail sur un nouveau domaine.",
    inputSchema: {
      type: "object",
      properties: {
        fqdn: { type: "string" },
        localPart: { type: "string", description: "Partie locale (défaut noreply)" },
        password: { type: "string", description: "Mot de passe ; généré si omis" },
        displayName: { type: "string" },
        organizationSlug: { type: "string" },
      },
      required: ["fqdn"],
      additionalProperties: false,
    },
    handler: async (args, actor) => {
      if (!actorHasScope(actor, MAILBOX_WRITE_SCOPE) && !actor.isAdmin) {
        return fail("forbidden");
      }
      const parsed = z
        .object({
          fqdn: fqdnField,
          localPart: z.string().min(1).max(64).optional(),
          password: z.string().min(8).max(128).optional(),
          displayName: z.string().max(120).optional(),
          organizationSlug: orgSlugField,
        })
        .safeParse(args);
      if (!parsed.success) return fail("invalid_arguments");
      const org = await requireOrg(actor, {
        organizationSlug: parsed.data.organizationSlug,
        fqdn: parsed.data.fqdn,
      });
      if (!org.ok) return fail(org.error);
      const result = await createMailboxForOrg({
        organizationId: org.organizationId,
        fqdn: parsed.data.fqdn,
        localPart: parsed.data.localPart ?? "noreply",
        password: parsed.data.password,
        displayName: parsed.data.displayName,
      });
      if (!result.ok) return fail(result.error);
      return ok(result);
    },
  },
  {
    name: "explain_mail_send_api",
    description:
      "Explique comment envoyer des emails via l'API Framm à la place de Resend, SendGrid, Mailgun ou Nodemailer : URL, auth, payload, mapping Resend, exemples curl/fetch, erreurs. À lire avant d'intégrer l'envoi dans une app.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => ok(getMailSendApiGuide()),
  },
  {
    name: "get_mail_delivery_status",
    description: "Liste les 50 derniers envois ou vérifie une soumission. Un serveur distant qui accepte ne garantit pas l’absence de spam. Accès limité à l’organisation et aux envois de la clé ou de l’utilisateur connecté.",
    inputSchema: { type: "object", properties: { messageId: { type: "string" }, from: { type: "string" }, organizationSlug: { type: "string" } }, additionalProperties: false },
    handler: async (args, actor) => {
      if (!actorHasScope(actor, MAIL_SEND_SCOPE)) return fail("forbidden");
      const parsed = z.object({ messageId: z.string().max(300).optional(), from: z.string().email().optional(), organizationSlug: orgSlugField }).safeParse(args);
      if (!parsed.success) return fail("invalid_arguments");
      const org = await requireOrg(actor, parsed.data);
      if (!org.ok) return fail(org.error);
      const messageId = parsed.data.messageId;
      const where = { organizationId: org.organizationId, ...(actor.isAdmin ? {} : { initiatorId: actor.apiKeyId ?? actor.userId ?? "unavailable" }),
        ...(parsed.data.from ? { fromAddress: parsed.data.from.toLowerCase() } : {}),
        ...(messageId ? { OR: [{ id: messageId }, { submissionId: messageId }, { rfcMessageId: messageId }] } : {}) };
      const records = await prisma.outboundMessage.findMany({ where, orderBy: { createdAt: "desc" }, take: messageId ? 2 : 50,
        omit: { accountId: true, initiatorId: true, leaseUntil: true } });
      if (messageId && records.length > 1) return fail("ambiguous_message_id", { detail: "Préciser from ou utiliser id/rfcMessageId unique." });
      if (messageId && !records.length) return fail("not_found");
      if (messageId) {
        if (records[0].submissionId && records[0].nextCheckAt <= new Date()) await refreshOutbound(records[0].id);
        const message = await prisma.outboundMessage.findUnique({ where: { id: records[0].id }, omit: { accountId: true, initiatorId: true, leaseUntil: true },
          include: { events: { orderBy: { occurredAt: "asc" }, take: 100, select: { id: true, type: true, recipient: true, occurredAt: true, data: true } } } });
        return ok({ message, notice: DELIVERY_NOTICE });
      }
      return ok({ messages: records, notice: DELIVERY_NOTICE });
    },
  },
  {
    name: "send_mail",
    description:
      "Envoie un email via l'API Framm/Stalwart (remplace Resend). From d'un domaine ajouté + boîte existante. DNS non bloquant ; vérifier la délivrabilité avec verify_domain. Pour le contrat HTTP à copier dans une app, appeler explain_mail_send_api.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        cc: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 }] },
        bcc: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 }] },
        attachments: { type: "array", items: { type: "object", properties: {
          filename: { type: "string", minLength: 1 }, content: { type: "string", description: "Base64 canonique ; total maximal 50 Mo décodés" }, contentType: { type: "string", default: "application/octet-stream" },
        }, required: ["filename", "content"], additionalProperties: false } },
        subject: { type: "string" },
        text: { type: "string" },
        html: { type: "string" },
        replyTo: { type: "string" },
        organizationSlug: { type: "string" },
      },
      required: ["from", "to", "subject"],
      additionalProperties: false,
    },
    handler: async (args, actor) => {
      if (!actorHasScope(actor, MAIL_SEND_SCOPE)) return fail("forbidden");
      const parsed = sendBodySchema.extend({ organizationSlug: orgSlugField }).safeParse(args);
      if (!parsed.success) return fail("invalid_arguments", { detail: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") });
      const org = await requireOrg(actor, {
        organizationSlug: parsed.data.organizationSlug,
        fqdn: parsed.data.from.split("@")[1],
      });
      if (!org.ok) return fail(org.error);
      const result = await sendOrgMail({
        organizationId: org.organizationId,
        initiatorId: actor.apiKeyId ?? actor.userId ?? "admin",
        from: parsed.data.from,
        to: parsed.data.to,
        subject: parsed.data.subject,
        text: parsed.data.text,
        html: parsed.data.html,
        replyTo: parsed.data.replyTo,
        cc: parsed.data.cc,
        bcc: parsed.data.bcc,
        attachments: parsed.data.attachments,
      });
      if (!result.ok) return fail(result.error, { detail: result.detail });
      return ok({ ok: true, messageId: result.messageId, trackingId: result.trackingId, rfcMessageId: result.rfcMessageId });
    },
  },
];
