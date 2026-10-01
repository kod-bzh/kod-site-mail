import {
  authorizationServerMetadata,
  jsonOAuth,
  oauthPreflight,
} from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return oauthPreflight();
}

export function GET(req: Request) {
  return jsonOAuth(authorizationServerMetadata(req));
}
