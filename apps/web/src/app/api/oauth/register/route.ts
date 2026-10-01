import { jsonOAuth, oauthPreflight, registerPublicClient } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return oauthPreflight();
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonOAuth({ error: "invalid_client_metadata" }, 400);
  }

  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const redirectUris = Array.isArray(record.redirect_uris)
    ? record.redirect_uris.filter((item): item is string => typeof item === "string")
    : [];
  const clientName = typeof record.client_name === "string" ? record.client_name : undefined;

  const result = await registerPublicClient({ clientName, redirectUris });
  if (!result.ok) {
    return jsonOAuth({ error: result.error }, 400);
  }
  return jsonOAuth(result.client, 201);
}
