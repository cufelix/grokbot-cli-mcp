// Character measurements, not a tokenizer or a subscription-cost estimate. --live performs read-only MCP calls.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { previewText, summarizeToolTrail } from "../dist/responses.js";
const args = process.argv.slice(2);
if (args.some(x => x !== "--live") || args.length > 1) throw new Error("Usage: npm run measure:context -- [--live]");
const change = (before, after) => ({ before_chars: before, after_chars: after, reduction_pct: Number(((1 - after / before) * 100).toFixed(1)) });
const full = "synthetic ".repeat(10_000);
const old = full.slice(0, 60_000) + "\n\n[… cut at 60000 characters]";
const trail = [...Array.from({ length: 500 }, () => ({ name: "read", ok: true })), ...Array.from({ length: 100 }, () => ({ name: "bash", ok: true })), ...Array.from({ length: 10 }, () => ({ name: "bash", ok: false }))];
const result = { unit: "UTF-16 characters; not billed tokens", long_reply: change(old.length, previewText(full, () => "/private/tmp/example-reply.txt").length),
  repeated_tool_trail: change(trail.map(t => t.ok ? t.name : t.name + "(failed)").join(", ").length, summarizeToolTrail(trail).length) };
const client = new Client({ name: "context-measurement", version: "1" });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "mcp"], env: { ...process.env, PI_OFFLINE: "1" }, stderr: "inherit" }));
  const tools = await client.listTools();
  result.tool_definitions = { count: tools.tools.length, chars: JSON.stringify(tools).length };
  if (args.includes("--live")) {
    result.live = {};
    for (const name of ["grokbot_doctor", "bot_status"]) {
      const full = await client.callTool({ name, arguments: { details: true } }), compact = await client.callTool({ name, arguments: {} });
      if (full.isError || compact.isError) throw new Error(name + " measurement failed");
      const chars = r => r.content.filter(c => c.type === "text").reduce((n, c) => n + c.text.length, 0);
      result.live[name] = change(chars(full), chars(compact));
    }
  }
  console.log(JSON.stringify(result, null, 2));
} finally { await client.close(); }
