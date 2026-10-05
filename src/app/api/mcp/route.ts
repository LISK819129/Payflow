import { handleMcpRequest } from "@/server/agents/http";

/** PayFlow's MCP server for external AI agents (Streamable HTTP, stateless). See src/server/agents/. */
export async function POST(request: Request) {
  return handleMcpRequest(request);
}

export async function GET(request: Request) {
  return handleMcpRequest(request);
}

export async function DELETE(request: Request) {
  return handleMcpRequest(request);
}
