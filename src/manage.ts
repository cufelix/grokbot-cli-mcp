// Managing the user's own Grok Bot bots: rename or re-describe one, delete one, start a fresh conversation.
// Unofficial, like bots.ts: the same private Connect API (aiserver.v1.GrokBotService) with the user's own Cursor login.
// Methods and fields come from the app's schemas: UpdateGrokBotAgent {id, name?, description?, title?, public_description?,
// partial_update}, DeleteGrokBotAgent {id}, StartFreshGrokBotConversation {agent_id, session_id?}. Listing and reading
// stay in bots.ts (listBots, readBot); this module adds only the writes plus a detailed list the writes check against.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "./bots.js";
import { clean } from "./vault.js";

/** Limits on what we send, checked here so the CLI and the MCP tools both get them. */
export const MANAGE_LIMITS = { name: 100, title: 200, description: 2000, publicDescription: 2000 } as const;

/** Output cap for anything shown to a caller. */
const MAX_OUTPUT = 20_000;
const HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const capOutput = (text: string) => (text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[… cut at ${MAX_OUTPUT} characters]` : text);

/** An id as a string: a safe non-negative integer (the app's numeric id) becomes its digits; anything else odd is "". */
const cleanId = (value: unknown): string => {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : "";
};
/** The numeric id the update and delete calls need: digits only (a number or a digit string), nothing else passes for it. */
const cleanNumericId = (value: unknown): string => {
  const id = cleanId(value);
  return /^\d{1,20}$/.test(id) ? id : "";
};
/** Text from an error that reaches a caller: no control or bidi characters, bounded, whatever its source. */
const errText = (text: string): string => clean(text.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " "), 500);
const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n >= 0 && n <= 8.64e15 ? n : 0;
};

/** One of the user's bots with what the management calls need: the id they take, and whether the user may manage it. */
export interface ManagedBot {
  /** The id UpdateGrokBotAgent / DeleteGrokBotAgent take (the agent's own `id`); "" when the API gave none. Never the agentId. */
  id: string;
  /** The UUID StartFreshGrokBotConversation takes; "" when the API gave none. */
  agentId: string;
  name: string;
  description: string;
  title: string;
  publicDescription: string;
  updatedAtMs: number;
  /** True only when the API says the viewer owns or can manage it; missing or malformed information means no. */
  canManage: boolean;
  harness: string;
  kind: string;
  visibility: string;
  /** A known server restriction, not an instruction to share a personal bot. */
  namedSecrets: boolean;
  canResetConversation: boolean | null;
}

/** The bots with their management details. Everything is data from the server: cleaned and bounded. */
export async function listManagedBots(signal?: AbortSignal, forWrite = false): Promise<ManagedBot[]> {
  const { agents } = await rpc<{ agents?: unknown }>("ListGrokBotAgents", {}, signal);
  if (agents !== undefined && !Array.isArray(agents)) throw new Error("The app returned a bot list in an unexpected shape.");
  // A write must see every bot to know its target is unique: a list cut at 500 is not enough.
  if (forWrite && Array.isArray(agents) && agents.length > 500) throw new Error("You have too many bots to check them all, so the target cannot be confirmed as unique. Nothing was changed.");
  return (Array.isArray(agents) ? agents.slice(0, 500) : []).map((raw): ManagedBot => {
    const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
    return {
      id: cleanNumericId(a.id),
      agentId: cleanId(a.agentId),
      name: clean(a.name, MANAGE_LIMITS.name),
      description: clean(a.description, 500),
      title: clean(a.title, MANAGE_LIMITS.title),
      publicDescription: clean(a.publicDescription, 500),
      updatedAtMs: num(a.updatedAtMs),
      canManage: a.viewerIsOwner === true || a.viewerCanManage === true,
      harness: clean(a.harness, 80),
      kind: clean(a.kind, 80),
      visibility: clean(a.visibility, 80),
      namedSecrets: a.visibility === "GROK_BOT_AGENT_VISIBILITY_TEAM" && (a.viewerIsOwner === true || a.viewerCanManage === true) && a.kind !== "GROK_BOT_AGENT_KIND_ROOM",
      canResetConversation: typeof a.harness === "string" && /temporal/i.test(a.harness) ? false : null,
    };
  });
}

export interface BotChanges {
  name?: string;
  description?: string;
  title?: string;
  publicDescription?: string;
}

function checkText(label: string, value: string, max: number, allowEmpty: boolean): string {
  if (HAS_CONTROL.test(value)) throw new Error(`Control characters are not allowed in the ${label}.`);
  const text = value.trim();
  if (!text && !allowEmpty) throw new Error(`The ${label} cannot be empty.`);
  if (text.length > max) throw new Error(`The ${label} is longer than ${max} characters.`);
  return text;
}

/** Validates the changes and builds the UpdateGrokBotAgent body. Only the fields given are sent (partialUpdate). */
export function updateBody(id: string, changes: BotChanges): Record<string, unknown> {
  const body: Record<string, unknown> = { id, partialUpdate: true };
  if (changes.name !== undefined) body.name = checkText("name", changes.name, MANAGE_LIMITS.name, false);
  if (changes.title !== undefined) body.title = checkText("title", changes.title, MANAGE_LIMITS.title, true);
  // Descriptions may hold newlines (instructions are prose), so only the other control characters are refused.
  for (const [key, label, max] of [
    ["description", "description", MANAGE_LIMITS.description],
    ["publicDescription", "public description", MANAGE_LIMITS.publicDescription],
  ] as const) {
    const v = changes[key];
    if (v === undefined) continue;
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(v)) throw new Error(`Control characters are not allowed in the ${label}.`);
    if (v.length > max) throw new Error(`The ${label} is longer than ${max} characters.`);
    body[key] = v;
  }
  if (Object.keys(body).length === 2) throw new Error("Nothing to change: give a name, description, title or public description.");
  return body;
}

/**
 * Resolves one bot by exact id (its `id` or `agentId`) or exact name: never a prefix, never "the first". The id is
 * tried first; the name path goes through pickBotExact with the ids blanked so a name cannot be taken for an id.
 */
export function pickManaged(bots: ManagedBot[], ref: string): ManagedBot {
  if (!ref) throw new Error("Name the bot (its exact name or id): this action will not guess which one.");
  const lower = ref.toLowerCase();
  // One pool for ids and names: a bot whose name equals another bot's id makes the reference ambiguous, and ambiguity refuses.
  const hits = bots.filter((b) => (b.id && b.id === ref) || (b.agentId && b.agentId === ref) || b.name.toLowerCase() === lower);
  if (hits.length !== 1) throw new Error(hits.length ? "More than one bot matches that name or id: use the id. Nothing was changed." : "No bot has exactly that name or id.");
  return hits[0];
}

/** Renames a bot and/or changes its description, title or public description. Returns the bot as the server now has it. */
export async function updateBot(ref: string, changes: BotChanges, signal?: AbortSignal): Promise<{ id: string; name: string; description: string; title: string }> {
  const bot = pickManaged(await listManagedBots(signal, true), ref);
  if (!bot.canManage) throw new Error(`You cannot change "${bot.name}": it is not yours to manage.`);
  if (!bot.id) throw new Error(`The Grok Bot app gave no id for "${bot.name}", which updating needs. Nothing was changed.`);
  const body = updateBody(bot.id, changes);
  // retried = true: no automatic replay of the write after a 401.
  const res = await rpc<{ agent?: Record<string, any> }>("UpdateGrokBotAgent", body, signal, true);
  const a = res.agent ?? {};
  // Shown from the reply when it carries the agent, else from what we sent: either way cleaned.
  return {
    id: bot.id,
    name: clean(a.name ?? body.name ?? bot.name, MANAGE_LIMITS.name),
    description: clean(a.description ?? body.description ?? bot.description, 500),
    title: clean(a.title ?? body.title ?? bot.title, MANAGE_LIMITS.title),
  };
}

/**
 * Deletes a bot, for good. Takes the exact id (not a name or prefix, which could hit the wrong bot) and checks it
 * against the account's own bots first, so a mistyped id or someone else's bot fails here, not on the server.
 */
export async function deleteBot(id: string, signal?: AbortSignal): Promise<{ id: string; name: string }> {
  if (!id || !cleanId(id)) throw new Error("Deleting needs the bot's exact id, not a name.");
  const hits = (await listManagedBots(signal, true)).filter((b) => (b.id && b.id === id) || (b.agentId && b.agentId === id));
  if (hits.length > 1) throw new Error("More than one bot has that id. Nothing was deleted.");
  const bot = hits[0];
  if (!bot) throw new Error(`No bot with id "${clean(id, 80)}" on this account. Nothing was deleted.`);
  if (!bot.canManage) throw new Error(`You cannot delete "${bot.name}": it is not yours to manage. Nothing was deleted.`);
  if (!bot.id) throw new Error(`The Grok Bot app gave no id for "${bot.name}", which deleting needs. Nothing was deleted.`);
  // retried = true: no automatic replay of the write after a 401.
  await rpc("DeleteGrokBotAgent", { id: bot.id }, signal, true);
  return { id: bot.id, name: bot.name };
}

/** Starts a fresh conversation (a new session) with a bot; the old transcript stays in the app's history. */
export async function startFreshConversation(ref: string, signal?: AbortSignal): Promise<{ name: string }> {
  const bot = pickManaged(await listManagedBots(signal, true), ref);
  if (!bot.agentId) throw new Error(`The Grok Bot app gave no agent id for "${bot.name}". Nothing was changed.`);
  if (bot.canResetConversation === false)
    throw new Error("Reset is not supported for temporal bots by the current Grok Bot server. The existing conversation was left intact.");
  await rpc("StartFreshGrokBotConversation", { agentId: bot.agentId }, signal, true);
  return { name: bot.name };
}

// --- MCP tools -----------------------------------------------------------------------------------------

type Reply = { content: { type: "text"; text: string }[]; isError?: boolean };
const reply = (text: string, isError = false): Reply => ({ content: [{ type: "text", text: capOutput(text) }], ...(isError ? { isError: true } : {}) });

function safe<A>(handler: (args: A, signal: AbortSignal) => Promise<Reply>) {
  return async (args: A, extra: { signal: AbortSignal }): Promise<Reply> => {
    try {
      return await handler(args, extra.signal);
    } catch (err) {
      return reply(errText(err instanceof Error ? err.message : String(err)), true);
    }
  };
}

export function registerManageTools(server: McpServer): void {
  server.registerTool(
    "bot_update",
    {
      title: "Update a Grok Bot bot",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      description:
        "Rename one of the user's Grok Bot bots or change its description, title or public description. Only the fields given " +
        "change. The bot is found by its exact name or id. Note: the app exposes no separate 'instructions' field here; " +
        "the description is the bot's blurb.",
      inputSchema: {
        bot: z.string().min(1).max(128).describe("Exact bot name or id"),
        name: z.string().max(MANAGE_LIMITS.name).optional(),
        description: z.string().max(MANAGE_LIMITS.description).optional(),
        title: z.string().max(MANAGE_LIMITS.title).optional(),
        public_description: z.string().max(MANAGE_LIMITS.publicDescription).optional(),
      },
    },
    safe(async ({ bot, public_description, ...rest }: { bot: string; name?: string; description?: string; title?: string; public_description?: string }, signal) => {
      const r = await updateBot(bot, { ...rest, ...(public_description === undefined ? {} : { publicDescription: public_description }) }, signal);
      return reply(`Updated ${r.name} (${r.id}).`);
    }),
  );

  server.registerTool(
    "bot_delete",
    {
      title: "Delete a Grok Bot bot",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      description:
        "PERMANENTLY delete one of the user's Grok Bot bots with its history. Needs the bot's exact id as the Grok Bot app shows it " +
        "(bot_list can print ids), not a name. Only call it when the user has explicitly asked to delete that bot.",
      inputSchema: { id: z.string().min(1).max(128).describe("Exact bot id") },
    },
    safe(async ({ id }: { id: string }, signal) => {
      const r = await deleteBot(id, signal);
      return reply(`Deleted ${r.name} (${r.id}).`);
    }),
  );

  server.registerTool(
    "bot_fresh_conversation",
    {
      title: "Start a fresh conversation with a bot",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description: "Reset a supported legacy bot's conversation. The current server does not support reset for temporal bots (bot_info reports availability). The bot is found by its exact name or id.",
      inputSchema: { bot: z.string().min(1).max(128).describe("Exact bot name or id") },
    },
    safe(async ({ bot }: { bot: string }, signal) => {
      const r = await startFreshConversation(bot, signal);
      return reply(`Started a fresh conversation with ${r.name}.`);
    }),
  );
}

// --- CLI: `grokbot bot update|rm|fresh ...` ------------------------------------------------------------

export const MANAGE_USAGE = `Usage:
  grokbot bot update BOT [--name NAME] [--description TEXT] [--title TEXT] [--public-description TEXT]
                                    rename a bot or change what it says about itself (BOT: exact id or exact name)
  grokbot bot rm ID --yes           delete a bot and its history for good (exact id; --yes is required)
  grokbot bot fresh BOT             start a fresh conversation with a bot`;

function take(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
  return args.splice(i, 2)[1];
}

const takeFlag = (args: string[], flag: string): boolean => {
  const i = args.indexOf(flag);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};

function done(args: string[], positionals: number): string[] {
  const flag = args.find((a) => a.startsWith("--"));
  if (flag) throw new Error(`Unknown option ${flag}`);
  if (args.length > positionals) throw new Error(`Too many arguments: ${args.slice(positionals).join(" ")}`);
  return args;
}

/** argv is what follows `bot`: [cmd, ...args]. Returns the exit code. */
export async function manageCommand(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    const signal = controller.signal;
    if (cmd === "update") {
      const name = take(args, "--name");
      const description = take(args, "--description");
      const title = take(args, "--title");
      const publicDescription = take(args, "--public-description");
      const [ref] = done(args, 1);
      if (!ref) throw new Error("Which bot? `grokbot bot update BOT --name NEW`.");
      const r = await updateBot(
        ref,
        {
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
          ...(title === undefined ? {} : { title }),
          ...(publicDescription === undefined ? {} : { publicDescription }),
        },
        signal,
      );
      console.log(`Updated ${r.name} (${r.id}).`);
      return 0;
    }
    if (cmd === "rm") {
      const yes = takeFlag(args, "--yes");
      const [id] = done(args, 1);
      if (!id) throw new Error("Which bot? `grokbot bot rm ID --yes` (the exact id).");
      if (!yes) throw new Error("This deletes the bot and its history for good. Run it again with --yes to confirm. Nothing was deleted.");
      const r = await deleteBot(id, signal);
      console.log(`Deleted ${r.name} (${r.id}).`);
      return 0;
    }
    if (cmd === "fresh") {
      const [ref] = done(args, 1);
      if (!ref) throw new Error("Which bot? `grokbot bot fresh BOT`.");
      const r = await startFreshConversation(ref, signal);
      console.log(`Started a fresh conversation with ${r.name}.`);
      return 0;
    }
    console.error(MANAGE_USAGE);
    return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 1;
  } catch (err) {
    console.error(errText(err instanceof Error ? err.message : String(err)));
    return 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
