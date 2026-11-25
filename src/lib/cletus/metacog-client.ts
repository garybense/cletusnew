/**
 * Metacog MCP Client for Cletus MAS
 * Connects to https://metacognition.geraldelmerkern.workers.dev/mcp
 * providing 18 metacognitive primitives (feel, drugs, become, name, ritual, etc.).
 */

const METACOG_MCP_URL = "https://metacognition.geraldelmerkern.workers.dev/mcp";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export async function callMetacogMcpTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  try {
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept": "application/json, text/event-stream, */*",
      "Content-Type": "application/json",
    };

    // 1. Initialize session
    const initPayload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "cletus", version: "1.0.0" },
      },
    };

    const initRes = await fetch(METACOG_MCP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(initPayload),
      signal: AbortSignal.timeout(15_000),
    });

    const sessionId = initRes.headers.get("Mcp-Session-Id") || initRes.headers.get("mcp-session-id");
    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
    }

    // 2. Call tool via JSON-RPC tools/call
    const callPayload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    };

    const callRes = await fetch(METACOG_MCP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(callPayload),
      signal: AbortSignal.timeout(20_000),
    });

    if (!callRes.ok) {
      const errText = await callRes.text().catch(() => "");
      return { ok: false, error: `Metacog MCP HTTP ${callRes.status}: ${errText.slice(0, 300)}` };
    }

    const jsonText = await callRes.text();
    let parsed: any = null;
    for (const line of jsonText.split("\n")) {
      if (line.startsWith("data:")) {
        try {
          parsed = JSON.parse(line.slice(5).trim());
        } catch {}
      }
    }
    if (!parsed) {
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        parsed = { result: jsonText };
      }
    }

    return { ok: true, result: parsed.result ?? parsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Metacog MCP call failed: ${msg}` };
  }
}
