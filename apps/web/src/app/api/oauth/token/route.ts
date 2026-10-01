import {
  exchangeAuthorizationCode,
  findOAuthClient,
  jsonOAuth,
  oauthPreflight,
  rotateRefreshToken,
} from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return oauthPreflight();
}

async function readTokenParams(req: Request): Promise<URLSearchParams> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await req.json()) as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "string") params.set(key, value);
    }
    return params;
  }
  return new URLSearchParams(await req.text());
}

export async function POST(req: Request) {
  let params: URLSearchParams;
  try {
    params = await readTokenParams(req);
  } catch {
    return jsonOAuth({ error: "invalid_request" }, 400);
  }

  const grantType = params.get("grant_type")?.trim() ?? "";
  const clientId = params.get("client_id")?.trim() ?? "";
  const resource = params.get("resource")?.trim() || null;

  if (!clientId) {
    return jsonOAuth({ error: "invalid_client" }, 400);
  }

  const client = await findOAuthClient(clientId);
  if (!client) {
    return jsonOAuth({ error: "invalid_client" }, 400);
  }

  if (grantType === "authorization_code") {
    const code = params.get("code")?.trim() ?? "";
    const redirectUri = params.get("redirect_uri")?.trim() ?? "";
    const codeVerifier = params.get("code_verifier")?.trim() ?? "";
    if (!code || !redirectUri || !codeVerifier) {
      return jsonOAuth({ error: "invalid_request" }, 400);
    }
    const result = await exchangeAuthorizationCode({
      clientId,
      code,
      redirectUri,
      codeVerifier,
      resource,
    });
    if (!result.ok) {
      return jsonOAuth({ error: result.error }, 400);
    }
    return jsonOAuth({
      access_token: result.access_token,
      token_type: result.token_type,
      expires_in: result.expires_in,
      refresh_token: result.refresh_token,
      scope: result.scope,
    });
  }

  if (grantType === "refresh_token") {
    const refreshToken = params.get("refresh_token")?.trim() ?? "";
    if (!refreshToken) {
      return jsonOAuth({ error: "invalid_request" }, 400);
    }
    const result = await rotateRefreshToken({ clientId, refreshToken, resource });
    if (!result.ok) {
      return jsonOAuth({ error: result.error }, 400);
    }
    return jsonOAuth({
      access_token: result.access_token,
      token_type: result.token_type,
      expires_in: result.expires_in,
      refresh_token: result.refresh_token,
      scope: result.scope,
    });
  }

  return jsonOAuth({ error: "unsupported_grant_type" }, 400);
}
