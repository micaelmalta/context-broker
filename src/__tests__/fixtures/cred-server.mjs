// Minimal stdio MCP server for gateway tests.
// Tools: <PREFIX>_probe → "len:<n>:<reversed TEST_TOKEN>" (proves which credential reached the process
// without printing it verbatim); <PREFIX>_echo → TEST_TOKEN verbatim (to exercise redaction).
import { createInterface } from "readline";

const prefix = process.env.TOOL_PREFIX ?? "t";
const token = process.env.TEST_TOKEN ?? "";
const tools = [
  { name: `${prefix}_probe`, description: "Probe the credential. Second sentence.", inputSchema: { type: "object", properties: {} } },
  { name: `${prefix}_echo`, description: "Echo the credential.", inputSchema: { type: "object", properties: {} } },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notification
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "cred-server", version: "1" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  } else if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const text = name.endsWith("_probe") ? `len:${token.length}:${[...token].reverse().join("")}` : token;
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
  } else {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
  }
});
