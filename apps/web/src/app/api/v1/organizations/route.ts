import { jsonOk, requireV1Actor, v1Error } from "@/lib/api/v1-http";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await requireV1Actor(req);
  if (!gate.actor) return gate.error;
  if (!gate.actor.isAdmin) return v1Error("forbidden");
  const organizations = await prisma.organization.findMany({
    select: { id: true, name: true, slug: true, status: true },
    orderBy: { slug: "asc" },
  });
  return jsonOk({ organizations });
}
