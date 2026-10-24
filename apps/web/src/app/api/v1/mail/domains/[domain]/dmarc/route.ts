import { readScope, dmarcSummary, period } from "@/lib/mail/deliverability-read";
export const dynamic = "force-dynamic";
export async function GET(req: Request, context: { params: Promise<{ domain: string }> }) {
  const domain = (await context.params).domain.toLowerCase();
  const scope = await readScope(req, domain); if (scope.error) return scope.error;
  let range; try { range = period(req); } catch { return Response.json({ error: "invalid_period" }, { status: 400 }); }
  return Response.json(await dmarcSummary(scope.organizationId, domain, range));
}
