import { readScope, domainHealth } from "@/lib/mail/deliverability-read";
export const dynamic = "force-dynamic";
export async function GET(req: Request, context: { params: Promise<{ domain: string }> }) {
  const domain = (await context.params).domain.toLowerCase();
  const scope = await readScope(req, domain); if (scope.error) return scope.error;
  return Response.json(await domainHealth(scope.organizationId, domain));
}
