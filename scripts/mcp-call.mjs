/**
 * Drive the remote MCP endpoint from the shell — the same streamable-HTTP handshake
 * a model client does, so what passes here is what a client sees.
 *
 *   node scripts/mcp-call.mjs list
 *   node scripts/mcp-call.mjs call read_plan '{"plan_id":"plan_x"}'
 *
 * Env: RAIDPLAN_URL (default http://localhost:5173/mcp), RAIDPLAN_TOKEN (rp_…).
 */
const url = process.env.RAIDPLAN_URL ?? "http://localhost:5173/mcp";
const token = process.env.RAIDPLAN_TOKEN;
if (!token) throw new Error("set RAIDPLAN_TOKEN=rp_…");

let session;

async function rpc(method, params, notify = false) {
  const body = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
  if (!notify) body.id = Math.floor(Math.random() * 1e6);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify(body),
  });
  session ??= res.headers.get("mcp-session-id") ?? undefined;
  if (notify) return;
  const text = await res.text();
  // Streamable HTTP answers as SSE; the JSON-RPC response is the last data: line.
  const line = text.split("\n").filter((l) => l.startsWith("data: ")).pop();
  if (!line) throw new Error(`${res.status} ${text.slice(0, 400)}`);
  const msg = JSON.parse(line.slice(6));
  if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
  return msg.result;
}

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "mcp-call", version: "1" },
});
await rpc("notifications/initialized", undefined, true);

const [cmd, name, json] = process.argv.slice(2);
if (cmd === "list") {
  const { tools } = await rpc("tools/list");
  const picked = name ? tools.filter((t) => t.name === name) : tools;
  for (const t of picked) {
    if (!name) console.log(`${t.name.padEnd(18)} ${t.description.split("\n")[0]}`);
    else console.log(`${t.name}\n${t.description}\n${JSON.stringify(t.inputSchema, null, 2)}`);
  }
} else if (cmd === "call") {
  const result = await rpc("tools/call", { name, arguments: json ? JSON.parse(json) : {} });
  for (const part of result.content ?? []) console.log(part.text ?? JSON.stringify(part));
  if (result.isError) process.exit(1);
} else {
  console.log("usage: mcp-call.mjs list | call <tool> '<json>'");
  process.exit(2);
}
