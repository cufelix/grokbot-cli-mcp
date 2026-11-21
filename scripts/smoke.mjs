// Smoke test for an installed `grokbot` command: starts `grokbot mcp` over stdio, lists tools, lists models.
// Usage: node scripts/smoke.mjs [command] [command args...] (default: grokbot)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const command = process.argv[2] ?? "grokbot";
const transport = new StdioClientTransport({
  command,
  args: [...process.argv.slice(3), "mcp"],
  env: { ...process.env, PI_OFFLINE: "1" },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name);
const models = await client.callTool({ name: "grok_models", arguments: {} });
await client.close();

const expected = ["bot_list", "bot_info", "bot_status", "grokbot_doctor", "bot_read", "bot_send", "grok_agent", "grok_ask", "grok_generate_image", "grok_generate_video", "grok_models", "grok_search_web", "grok_search_x"];
const missing = expected.filter((name) => !tools.includes(name));
if (missing.length || models.isError || !JSON.stringify(models.content).includes("grok-")) {
  console.error("smoke failed", { tools, models });
  process.exit(1);
}
console.log(`ok: ${tools.length} tools via \`${[command, ...process.argv.slice(3), "mcp"].join(" ")}\``);
