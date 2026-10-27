// `grokbot bot ...`: talk to your bots in the official Grok Bot app from a terminal.
import {
  type Bot,
  createBot,
  downloadBotFile,
  listBotFiles,
  listBots,
  listComputers,
  pickBot,
  pickComputer,
  readBot,
  sendToBot,
  stopBot,
  waitForBot,
} from "./bots.js";

const USAGE = `Usage:
  grokbot bot list                         your bots in the Grok Bot app
  grokbot bot create NAME [DESCRIPTION]    create a new bot
  grokbot bot send [--bot NAME] [--file PATH]... [--computer[=NAME]] [--download DIR] [--no-wait] [--] MESSAGE
                                           message a bot (default: your main bot) and print its replies;
                                           --file attaches local files, --computer runs the task on one of your
                                           computers (needs the Grok Bot app open there), --download saves the
                                           files the bot sends back
  grokbot bot read [--bot NAME] [--download DIR] [N]
                                           last N messages of a bot's chat (default 10, max 100)
  grokbot bot wait [--bot NAME] [--download DIR]
                                           wait for a bot that is still working and print its new replies
  grokbot bot stop [--bot NAME]            stop whatever the bot is doing
  grokbot bot computers                    your computers a bot can use (Grok Bot app open)
  grokbot bot files [--bot NAME]           the bot's saved files
  grokbot bot download [--bot NAME] PATH [DIR]
                                           download a file the bot sent or saved (default DIR: .)`;

function take(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
  return args.splice(i, 2)[1];
}

function takeAll(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let v = take(args, flag); v !== undefined; v = take(args, flag)) out.push(v);
  return out;
}

/** `--computer` (the only connected one) or `--computer=NAME` (label, prefix or machine id). */
async function takeComputer(args: string[]): Promise<string | undefined> {
  const i = args.findIndex((a) => a === "--computer" || a.startsWith("--computer="));
  if (i < 0) return undefined;
  const [arg] = args.splice(i, 1);
  return pickComputer(await listComputers(), arg.slice("--computer=".length) || undefined).machineId;
}

async function saveFiles(bot: Bot, files: { path: string; name: string }[], dir: string, signal?: AbortSignal): Promise<void> {
  for (const f of files) process.stderr.write(`saved ${await downloadBotFile(bot, f.path, dir, f.name, signal)}\n`);
}

/** Positional arguments only, at most max of them. */
function positional(args: string[], max: number): string[] {
  const flag = args.find((a) => a.startsWith("--"));
  if (flag) throw new Error(`Unknown option ${flag}`);
  if (args.length > max) throw new Error(`Too many arguments: ${args.slice(max).join(" ")}`);
  return args;
}

export async function botCommand(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  try {
    if (cmd === "list") {
      for (const b of await listBots()) console.log(`${b.name}${b.description ? `  (${b.description})` : ""}`);
      return 0;
    }
    if (cmd === "create") {
      const [name, ...desc] = args;
      if (!name) throw new Error("Give the new bot a name.");
      const bot = await createBot(name, desc.join(" "));
      console.log(`Created ${bot.name}. It shows up in the Grok Bot app.`);
      return 0;
    }
    if (cmd === "computers") {
      const computers = await listComputers();
      if (!computers.length) console.log("No computer connected. Open the Grok Bot app on the computer a bot should use.");
      for (const c of computers) console.log(`${c.label}${c.kind ? `  (${c.kind})` : ""}`);
      return 0;
    }
    // Everything after `--` is message text, even if it looks like a flag.
    const dashes = args.indexOf("--");
    const tail = dashes < 0 ? [] : args.splice(dashes).slice(1);
    const bot = pickBot(await listBots(), take(args, "--bot"));
    if (cmd === "files") {
      positional(args, 0);
      for (const f of await listBotFiles(bot)) console.log(`${f.path}  ${f.sizeBytes} B`);
      return 0;
    }
    if (cmd === "download") {
      const [path, dir = "."] = positional([...args, ...tail], 2);
      if (!path) throw new Error("Which file? Give its path from `grokbot bot read` or `grokbot bot files`.");
      console.log(await downloadBotFile(bot, path, dir));
      return 0;
    }
    if (cmd === "stop") {
      positional(args, 0);
      console.log((await stopBot(bot)) ? `Stopped ${bot.name}.` : `${bot.name} wasn't working.`);
      return 0;
    }
    if (cmd === "wait") {
      const dir = take(args, "--download");
      positional(args, 0);
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      const { replies, done } = await waitForBot(bot, {
        timeoutMs: 30 * 60_000,
        signal: controller.signal,
        onReply: (e) => console.log(`${e.text}${e.file ? `  ${e.file.path}` : ""}\n`),
        onActivity: (a) => process.stderr.write(`  … ${a}\n`),
      });
      if (dir) await saveFiles(bot, replies.filter((e) => e.file).map((e) => e.file!), dir, controller.signal);
      if (!done) process.stderr.write(`${bot.name} is still working.\n`);
      return 0;
    }
    if (cmd === "send" || cmd === "read") {
      const dir = take(args, "--download");
      if (cmd === "read") {
        const [count] = positional(args, 1);
        const n = count === undefined ? 10 : Number(count);
        if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error("N must be a whole number from 1 to 100.");
        const entries = await readBot(bot, n);
        for (const e of entries) console.log(`${e.from === "you" ? "you" : bot.name}: ${e.text}${e.file ? `  ${e.file.path}` : ""}\n`);
        if (dir) await saveFiles(bot, entries.filter((e) => e.from === "bot" && e.file).map((e) => e.file!), dir);
        return 0;
      }
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      const files = takeAll(args, "--file");
      const machineId = await takeComputer(args);
      const noWait = args.includes("--no-wait");
      if (noWait && dir) throw new Error("--download needs the reply: drop --no-wait, or use `grokbot bot read --download` later.");
      const rest = args.filter((a) => a !== "--no-wait");
      const unknown = rest.find((a) => a.startsWith("--"));
      if (unknown) throw new Error(`Unknown option ${unknown} (put \`--\` before a message that starts with --).`);
      const text = [...rest, ...tail].join(" ").trim();
      if (!text) throw new Error("Nothing to send.");
      if (!noWait) process.stderr.write(`→ ${bot.name} (the reply also shows in the Grok Bot app)\n`);
      const { replies, done } = await sendToBot(bot, text, {
        wait: !noWait,
        signal: controller.signal,
        files,
        machineId,
        onReply: (e) => console.log(`${e.text}${e.file ? `  ${e.file.path}` : ""}\n`),
        onActivity: (a) => process.stderr.write(`  … ${a}\n`),
      });
      if (dir) await saveFiles(bot, replies.filter((e) => e.file).map((e) => e.file!), dir, controller.signal);
      if (!noWait && !done) process.stderr.write(`${bot.name} is still working; check the app or \`grokbot bot read\`.\n`);
      return 0;
    }
    console.log(USAGE);
    return cmd ? 1 : 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
