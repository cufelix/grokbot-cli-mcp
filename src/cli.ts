#!/usr/bin/env node
import { configureEnv, seedDefaultModel, VERSION } from "./setup.js";

const args = process.argv.slice(2);
configureEnv();

if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
  // Read from package.json: importing pi just for its VERSION takes about a second.
  const { readFileSync } = await import("node:fs");
  const piPkg = new URL("../package.json", import.meta.resolve("@earendil-works/pi-coding-agent"));
  console.log(`grokbot ${VERSION} (pi ${JSON.parse(readFileSync(piPkg, "utf8")).version})`);
  process.exit(0);
}

const commandHelp = `Grok Bot commands:
  grokbot doctor [--bot BOT] [--require-skill NAME] [--json]
  grokbot bot list [--ids] [--json]
  grokbot bot info BOT [--json]
  grokbot bot status [--bot BOT] [--json]
  grokbot bot help                 messages, files and computers
  grokbot skills                  bot skill commands
  grokbot secrets                 team-shared bot secrets
  grokbot submit BOT              pending one-time values
  grokbot automations help         scheduled routines
  grokbot vault                   logins and saved form answers
  grokbot mcp                     MCP server
  grokbot                         interactive terminal agent`;
if (args.length === 1 && args[0] === "help") {
  console.log(commandHelp);
  process.exit();
}
if (args.length === 1 && args[0] === "--help") console.log(commandHelp + "\nTerminal agent options:");

if (args[0] === "login" || args[0] === "logout") {
  const auth = await import("./login.js");
  await (args[0] === "login" ? auth.login(args.slice(1)) : auth.logout());
  process.exit();
}

const drain = () => Promise.all([process.stdout, process.stderr].map((s) => new Promise((r) => s.write("", r))));

if (args[0] === "doctor" || (args[0] === "bot" && ["info", "status"].includes(args[1]))) {
  const { inspectionCommand } = await import("./inspection.js");
  const kind = args[0] === "doctor" ? "doctor" : args[1] as "info" | "status";
  process.exitCode = await inspectionCommand(kind, args.slice(args[0] === "doctor" ? 1 : 2));
  await drain();
  process.exit();
}

if (args[0] === "bot" && ["update", "rm", "fresh"].includes(args[1])) {
  const { manageCommand } = await import("./manage.js");
  process.exitCode = await manageCommand(args.slice(1));
  await drain();
  process.exit();
}

for (const [name, module, command, rest] of [
  ["skills", "./bot-skills.js", "skillsCommand", 1],
  ["secrets", "./secrets.js", "secretsCommand", 1],
  ["submit", "./secrets.js", "secretsCommand", 0],
  ["automations", "./automations.js", "automationsCommand", 1],
] as const) {
  if (args[0] !== name) continue;
  const run = (await import(module))[command] as (argv: string[]) => Promise<number>;
  process.exitCode = await run(args.slice(rest));
  await drain();
  process.exit();
}

if (args[0] === "bot") {
  const { botCommand } = await import("./bot-cli.js");
  process.exitCode = await botCommand(args.slice(1));
  await drain();
  process.exit();
}

if (args[0] === "vault") {
  const { vaultCommand } = await import("./vault-cli.js");
  process.exitCode = await vaultCommand(args.slice(1));
  // Let piped stdout/stderr drain before exiting, or the listing can be cut off.
  await Promise.all([process.stdout, process.stderr].map((s) => new Promise((r) => s.write("", r))));
  process.exit();
}

// `grokbot mcp` (or `mcp serve`) runs our server; `grokbot mcp list|login|logout` stays pi's MCP client command.
if (args[0] === "mcp" && (args.length === 1 || args[1] === "serve")) {
  // stdout carries the MCP protocol; keep stray logs off it.
  console.log = console.error;
  const { startMcpServer } = await import("./mcp.js");
  await startMcpServer();
} else {
  seedDefaultModel(process.env.PI_CODING_AGENT_DIR as string);
  // pi's own bin calls setupCli() (HTTP dispatcher, warnings) before main(); it isn't in the package exports.
  const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const { setupCli } = await import(new URL("./cli/setup.js", piEntry).href);
  setupCli();
  process.title = "grokbot";
  const { main } = await import("@earendil-works/pi-coding-agent");
  const { default: grokExtension } = await import("./extension.js");
  await main(args, { extensionFactories: [{ name: "grokbot", factory: grokExtension, hidden: true }] });
}
