import { resolveV1ActorFromRequest } from "@/lib/api/v1-auth";
import { getMailSendApiInstructions } from "@/lib/mcp/mail-api-guide";
import { publicOrigin, wwwAuthenticateHeader } from "@/lib/mcp/oauth";
import { handleMcpJsonRpc } from "@/lib/mcp/protocol";
import { FRAMM_MCP_TOOLS } from "@/lib/mcp/tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
};

function withCors(response: Response): Response {
  for (const [name, value] of Object.entries(corsHeaders)) {
    response.headers.set(name, value);
  }
  return response;
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

function unauthorized(req: Request) {
  return withCors(
    Response.json(
      { error: "unauthorized" },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": wwwAuthenticateHeader(req),
        },
      }
    )
  );
}

export async function GET(req: Request) {
  const actor = await resolveV1ActorFromRequest(req);
  if (!actor) {
    return unauthorized(req);
  }
  const origin = publicOrigin(req);
  return withCors(
    Response.json({
      name: "framm",
      version: "1.0.0",
      transport: "streamable-http",
      auth: "oauth2",
      oauth: {
        authorizationServer: `${origin}/.well-known/oauth-authorization-server`,
        resource: `${origin}/api/mcp`,
      },
      instructions: getMailSendApiInstructions(),
      tools: FRAMM_MCP_TOOLS.map((tool) => tool.name),
    })
  );
}

export function DELETE() {
  return withCors(new Response(null, { status: 405 }));
}

export async function POST(req: Request) {
  const actor = await resolveV1ActorFromRequest(req);
  if (!actor) {
    return unauthorized(req);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return withCors(Response.json({ error: "invalid_body" }, { status: 400 }));
  }

  const payload = await handleMcpJsonRpc(body, actor);
  if (payload === null) {
    return withCors(new Response(null, { status: 202 }));
  }
  return withCors(Response.json(payload));
}
