import { NextRequest, NextResponse } from "next/server";
import { MailRequestError, parseMailSendRequest } from "@/lib/mail/send-request";
import { hasScope, MAIL_SEND_SCOPE, verifyBearerApiKey } from "@/lib/api-keys";
import { resolveV1ActorFromRequest } from "@/lib/api/v1-auth";
import { sendAdminMail, verifyAdminMailToken } from "@/lib/mail/admin-send";
import { findOrganizationIdByFromAddress, sendOrgMail } from "@/lib/mail/org-mail-send";
import { getMailSendApiGuide } from "@/lib/mcp/mail-api-guide";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const actor = await resolveV1ActorFromRequest(req);
  if (!actor) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(getMailSendApiGuide());
}

function extractBearerToken(authorization: string | null): string | null {
  if (!authorization?.toLowerCase().startsWith("bearer ")) return null;
  return authorization.slice(7).trim();
}

const ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_body: 400,
  invalid_from: 400,
  invalid_to: 400,
  recipient_suppressed: 422,
  missing_content: 400,
  domain_not_in_org: 403,
  domain_not_verified: 403,
  smtp_not_configured: 503,
  send_failed: 502,
};

export async function POST(req: NextRequest) {
  const authorization = req.headers.get("authorization");
  const isAdminToken = verifyAdminMailToken(extractBearerToken(authorization));
  const apiKey = isAdminToken ? null : await verifyBearerApiKey(authorization);

  if (!isAdminToken && !apiKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (apiKey && !hasScope(apiKey.scopes, MAIL_SEND_SCOPE)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let payload;
  try {
    payload = await parseMailSendRequest(req);
  } catch (error) {
    if (error instanceof MailRequestError) return NextResponse.json({ error: error.code, detail: error.message }, { status: error.status });
    console.error("[mail] Upload preparation unavailable");
    return NextResponse.json({ error: "upload_unavailable", detail: "Réception des fichiers indisponible ; aucun envoi effectué" }, { status: 503 });
  }
  const input = payload.input;
  try {
    const fromDomain = (input.from.match(/<([^>]+)>/)?.[1] ?? input.from).trim().toLowerCase().split("@")[1];
    if (apiKey?.allowedMailDomains?.length && !apiKey.allowedMailDomains.includes(fromDomain)) return NextResponse.json({ error: "domain_forbidden" }, { status: 403 });
    const organizationId =
      apiKey?.organizationId ?? (await findOrganizationIdByFromAddress(input.from));

    if (organizationId) {
      const result = await sendOrgMail({
        organizationId,
        ...input,
        initiatorId: apiKey?.id ?? "admin",
      });

      if (!result.ok) {
        const status = ERROR_STATUS[result.error] ?? 400;
        return NextResponse.json(
          { error: result.error, ...(result.detail ? { detail: result.detail } : {}) },
          { status }
        );
      }

      await prisma.auditLog.create({
        data: {
          organizationId,
          action: "api.mail.send",
          target: input.from,
          metadata: {
            apiKeyId: apiKey?.id ?? "admin-mail-token",
            to: input.to,
            subject: input.subject,
            messageId: result.messageId,
          },
        },
      });

      return NextResponse.json({ ok: true, messageId: result.messageId, trackingId: result.trackingId, rfcMessageId: result.rfcMessageId });
    }

    if (!isAdminToken) {
      return NextResponse.json({ error: "domain_not_in_org" }, { status: 403 });
    }

    if (input.requestReadReceipt) return NextResponse.json({ error: "read_receipt_requires_registered_sender", detail: "Utiliser un domaine d’organisation et sa boîte contrôlée pour le suivi MDN." }, { status: 422 });
    const adminResult = await sendAdminMail(input);
    if (!adminResult.ok) {
      const status = adminResult.code === "invalid_from" ? 422 : 502;
      return NextResponse.json(
        { error: adminResult.code, detail: adminResult.detail },
        { status }
      );
    }

    return NextResponse.json({
      ok: true,
      via: adminResult.via,
      messageId: adminResult.messageId,
    });
  } finally {
    await payload.cleanup();
  }
}
