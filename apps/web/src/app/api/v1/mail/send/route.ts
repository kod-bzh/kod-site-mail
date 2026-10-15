import { NextRequest, NextResponse } from "next/server";
import { sendBodySchema, validateAttachments } from "@/lib/mail/send-payload";
import { hasScope, MAIL_SEND_SCOPE, verifyBearerApiKey } from "@/lib/api-keys";
import { resolveV1ActorFromRequest } from "@/lib/api/v1-auth";
import { sendAdminMail, verifyAdminMailToken } from "@/lib/mail/admin-send";
import { findOrganizationIdByFromAddress, sendOrgMail } from "@/lib/mail/org-mail-send";
import { getMailSendApiGuide } from "@/lib/mcp/mail-api-guide";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

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
  rate_limited: 429,
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const parsed = sendBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  }
  try { validateAttachments(parsed.data.attachments); } catch (error) {
    return NextResponse.json({ error: "invalid_attachments", detail: (error as Error).message }, { status: 400 });
  }

  const organizationId =
    apiKey?.organizationId ?? (await findOrganizationIdByFromAddress(parsed.data.from));

  if (organizationId) {
    const result = await sendOrgMail({
      organizationId,
      ...parsed.data,
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
        target: parsed.data.from,
        metadata: {
          apiKeyId: apiKey?.id ?? "admin-mail-token",
          to: parsed.data.to,
          subject: parsed.data.subject,
          messageId: result.messageId,
        },
      },
    });

    return NextResponse.json({ ok: true, messageId: result.messageId });
  }

  if (!isAdminToken) {
    return NextResponse.json({ error: "domain_not_in_org" }, { status: 403 });
  }

  const adminResult = await sendAdminMail(parsed.data);
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
}
