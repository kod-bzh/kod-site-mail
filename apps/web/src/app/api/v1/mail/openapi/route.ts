import contract from "@/lib/mail/openapi.json";
import { resolveV1ActorFromRequest } from "@/lib/api/v1-auth";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const actor = await resolveV1ActorFromRequest(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(contract);
}
