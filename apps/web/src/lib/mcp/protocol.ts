import type { V1Actor } from "@/lib/api/v1-auth";
import { getMailSendApiInstructions } from "@/lib/mcp/mail-api-guide";
import { FRAMM_MCP_TOOLS } from "@/lib/mcp/tools";

const PROTOCOL_VERSION = "2025-03-26";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolsList() {
  return {
    tools: FRAMM_MCP_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

async function callTool(params: Record<string, unknown> | undefined, actor: V1Actor) {
  const name = typeof params?.name === "string" ? params.name : "";
  const args =
    params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};
  const tool = FRAMM_MCP_TOOLS.find((item) => item.name === name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: "unknown_tool", name }) }],
    };
  }
  return tool.handler(args, actor);
}

async function dispatch(message: JsonRpcRequest, actor: V1Actor) {
  const id = message.id ?? null;
  const method = message.method ?? "";

  if (message.id === undefined && method.startsWith("notifications/")) {
    return null;
  }

  switch (method) {
    case "initialize":
      return jsonRpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "framm", version: "1.0.0" },
        instructions: getMailSendApiInstructions(),
      });
    case "ping":
      return jsonRpcResult(id, {});
    case "tools/list":
      return jsonRpcResult(id, toolsList());
    case "tools/call":
      return jsonRpcResult(id, await callTool(message.params, actor));
    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcpJsonRpc(body: unknown, actor: V1Actor): Promise<unknown | null> {
  if (Array.isArray(body)) {
    const responses = [];
    for (const item of body) {
      const response = await dispatch(item as JsonRpcRequest, actor);
      if (response) responses.push(response);
    }
    return responses.length > 0 ? responses : null;
  }
  return dispatch(body as JsonRpcRequest, actor);
}
