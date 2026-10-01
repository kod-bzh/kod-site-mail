import {
  jsonOAuth,
  oauthPreflight,
  protectedResourceMetadata,
} from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return oauthPreflight();
}

export function GET(req: Request) {
  return jsonOAuth(protectedResourceMetadata(req));
}
