import { z } from "zod";
import { resolveActorOrganizationId, resolveV1ActorFromRequest } from "@/lib/api/v1-auth";
import { readLimitedBody } from "@/lib/mail/read-limited-body";
import { openPostmasterOAuth, startPostmasterOAuth } from "@/lib/mail/google-postmaster-oauth";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(req: Request) {
  const actor = await resolveV1ActorFromRequest(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!actor.isAdmin) return Response.json({ error: "platform_admin_required" }, { status: 403 });
  const org = await resolveActorOrganizationId(actor, { organizationSlug: new URL(req.url).searchParams.get("organizationSlug") ?? undefined });
  if (!org.ok) return Response.json({ error: org.error }, { status: 403 });
  try {
    const input = z.object({ domains: z.array(z.string().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/)).min(1).max(10) }).strict().parse(JSON.parse(await readLimitedBody(req, 4096)));
    return Response.json(await startPostmasterOAuth(org.organizationId, input.domains), { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch { return Response.json({ error: "postmaster_authorization_unavailable", action: "Vérifier les domaines autorisés et les identifiants OAuth serveur." }, { status: 400 }); }
}
export async function GET(req: Request) {
  try { return await openPostmasterOAuth(new URL(req.url).searchParams.get("state") ?? ""); }
  catch { return Response.json({ error: "invalid_or_expired_authorization" }, { status: 400, headers: { "Cache-Control": "no-store" } }); }
}
