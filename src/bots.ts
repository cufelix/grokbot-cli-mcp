// Client for the official Grok Bot app's bots (xAI's desktop agent, served by Cursor's backend).
// Unofficial: it calls the same private Connect API the app uses (aiserver.v1.GrokBotService), with the user's own
// Cursor login, so messages and replies show up in the app. It can break whenever the app's API changes.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

export const API = process.env.GROKBOT_BOTS_API ?? "https://api2.cursor.sh/aiserver.v1.GrokBotService";

export interface Bot {
  id?: string;
  agentId: string;
  name: string;
  description?: string;
}

export interface BotEntry {
  seq: number;
  from: "you" | "bot";
  text: string;
  /** Set when the message is a file (a screenshot, a report...): download it with downloadBotFile. */
  file?: { path: string; name: string };
  /** Set when the bot asks to act on the user's computer; the user answers in the Grok Bot app. */
  approval?: { action: string; target: string; status: string };
  secretRequest?: { pending: boolean };
  /** The same entry may be updated in place until streaming finishes. */
  streaming?: boolean;
}

/** One of the user's own computers the bot can work on, through a running Grok Bot app. */
export interface Computer {
  machineId: string;
  label: string;
  kind: string;
  lastSeenAtMs: number;
}

export interface BotFile {
  name: string;
  path: string;
  sizeBytes: number;
  contentType: string;
  updatedAtMs: number;
}

let cachedToken: string | undefined;

/** Cursor's login token, read once per process (again after a 401). */
function token(): string {
  return (cachedToken ??= readToken());
}

/** CURSOR_ACCESS_TOKEN, the macOS Keychain item cursor-agent writes, or its Linux/XDG file. */
function readToken(): string {
  if (process.env.CURSOR_ACCESS_TOKEN) return process.env.CURSOR_ACCESS_TOKEN;
  if (process.platform === "darwin" && process.env.GROKBOT_KEYCHAIN !== "0") {
    try {
      const t = execFileSync("security", ["find-generic-password", "-s", "cursor-access-token", "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      }).trim();
      if (t) return t;
    } catch {
      // not signed in with cursor-agent on this Mac: fall through
    }
  }
  const file = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cursor", "auth.json");
  try {
    const t = JSON.parse(readFileSync(file, "utf8")).accessToken;
    if (typeof t === "string" && t) return t;
  } catch {
    // fall through to the error below
  }
  throw new Error("Not signed in to Cursor. Run `grokbot login --cursor` (or `cursor-agent login`), or set CURSOR_ACCESS_TOKEN.");
}

/** One Connect call against the app's API. Shared with vault.ts, which talks to the same service. */
export async function rpc<T>(method: string, body: object, signal?: AbortSignal, retried = false): Promise<T> {
  // The token goes with every call: only to Cursor's own servers over HTTPS, also when GROKBOT_BOTS_API is overridden.
  if (!/^https:\/\/[a-z0-9.-]+\.cursor\.sh\//.test(API)) throw new Error(`GROKBOT_BOTS_API must be an https://….cursor.sh/ URL, not ${API}`);
  const timeout = AbortSignal.timeout(30_000);
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json", "connect-protocol-version": "1" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (res.status === 401 && !retried) {
    await res.body?.cancel().catch(() => {});
    cachedToken = undefined;
    // An expired token: running cursor-agent refreshes the stored one.
    try {
      execFileSync("cursor-agent", ["status"], { stdio: "ignore", timeout: 30_000, shell: process.platform === "win32" });
    } catch {
      // the retry below reports the auth error
    }
    return rpc(method, body, signal, true);
  }
  if (!res.ok) {
    // The error body is the server's text: control characters (newlines, escapes, bidi marks) go, it is capped, and it is
    // labelled as what it is, so it can't pose as output of ours.
    const detail = (await readCapped(res, 4096, false)).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 300);
    throw new Error(`Grok Bot API ${method} failed (${res.status}); the server said: «${detail}»`);
  }
  const text = await readCapped(res, MAX_RESPONSE);
  try {
    return JSON.parse(text) as T;
  } catch {
    // The parser's own message quotes the body: keep it out of errors.
    throw new Error(`Grok Bot API ${method} returned something that is not JSON.`);
  }
}

/** A response body is at most this big; a transcript page or vault listing is far smaller. */
const MAX_RESPONSE = 16 * 1024 * 1024;

/**
 * Reads a body of at most max bytes. Past the limit it stops: strict (a successful reply) throws, otherwise (an error
 * page) the start is kept. Never holds more than max bytes, however big a single chunk is.
 */
async function readCapped(res: Response, max: number, strict = true): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let over = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (size + value.byteLength > max) {
        chunks.push(value.subarray(0, max - size));
        size = max;
        over = true;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    // Cancelling an unfinished stream must not hang the call.
    await Promise.race([reader.cancel().catch(() => {}), new Promise((r) => setTimeout(r, 1000).unref())]);
  }
  if (over && strict) throw new Error("The Grok Bot API sent a response that is too big.");
  return Buffer.concat(chunks).toString("utf8");
}

export async function listBots(): Promise<Bot[]> {
  const { agents } = await rpc<{ agents?: unknown }>("ListGrokBotAgents", {});
  if (agents !== undefined && !Array.isArray(agents)) throw new Error("The app returned a bot list in an unexpected shape.");
  if (Array.isArray(agents) && agents.length > 500) throw new Error("Too many bots to resolve a unique target safely.");
  const text = (x: unknown, max: number) => typeof x === "string" ? x.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, max) : "";
  return (Array.isArray(agents) ? agents : []).map(raw => {
    const a = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    return { id: (typeof a.id !== "number" || Number.isSafeInteger(a.id)) && /^\d{1,20}$/.test(String(a.id ?? "")) ? String(a.id) : "", agentId: typeof a.agentId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(a.agentId) ? a.agentId : "", name: text(a.name, 100), description: text(a.description, 500) };
  });
}

/** Finds a bot by id, exact name, or name prefix (case-insensitive). With no ref, the first bot (the main one). */
export function pickBot(bots: Bot[], ref?: string): Bot {
  if (!bots.length) throw new Error("No Grok Bot bots on this account. Create one in the Grok Bot app first.");
  if (!ref) return bots[0];
  const r = ref.toLowerCase();
  const bot =
    bots.find((b) => b.id === ref || b.agentId === ref || b.name.toLowerCase() === r) ?? bots.find((b) => b.name.toLowerCase().startsWith(r));
  if (!bot) throw new Error(`No bot named "${ref}". Bots: ${bots.map((b) => b.name).join(", ")}`);
  return bot;
}

/** For writes that cannot be undone or that act outward: the id or the exact name of one bot, never a prefix or "the first". */
export function pickBotExact(bots: Bot[], ref: string | undefined): Bot {
  if (!ref) throw new Error("Name the bot (its exact name or id): this action will not guess which one.");
  const r = ref.toLowerCase();
  const hits = bots.filter((b) => b.id === ref || b.agentId === ref || b.name.toLowerCase() === r);
  if (hits.length !== 1) throw new Error(hits.length ? "More than one bot has that name: use its id." : "No bot has exactly that name or id.");
  return hits[0];
}

export async function createBot(name: string, description = ""): Promise<Bot> {
  const agentId = randomUUID();
  const { agent } = await rpc<{ agent?: Bot }>("CreateGrokBotTemporalAgent", {
    agentId,
    name,
    description,
    title: "",
    avatarShape: "",
    avatarColor: "",
    harness: "GROK_BOT_AGENT_HARNESS_KIND_TEMPORAL",
    kickstartRequested: false,
    introductionSuppressed: true,
  });
  if (agent?.agentId !== agentId) throw new Error("The Grok Bot app did not confirm the new bot.");
  return { agentId, name: agent.name, description: agent.description };
}

/** Stops whatever the bot is doing (as the app's stop button does). Returns whether it was working. */
export async function stopBot(bot: Bot): Promise<boolean> {
  const res = await rpc<{ hadActiveRun?: boolean }>("InterruptGrokBotAgentRun", { agentId: bot.agentId, reason: "user_interrupt" });
  return res.hadActiveRun === true;
}

/** Computers signed in to the Grok Bot app (and running it) that a bot can be pointed at. */
export async function listComputers(): Promise<Computer[]> {
  const { computers = [] } = await rpc<{
    computers?: { machineId: string; hello?: { label?: string; kind?: string }; lastSeenAtMs?: string }[];
  }>("ListGrokBotUserComputers", {});
  return computers.map((c) => ({
    machineId: c.machineId,
    label: c.hello?.label || c.machineId,
    kind: c.hello?.kind ?? "",
    lastSeenAtMs: Number(c.lastSeenAtMs ?? 0),
  }));
}

/** Finds a computer by machine id or label (prefix, case-insensitive). With no ref, the only one, if there is one. */
export function pickComputer(computers: Computer[], ref?: string): Computer {
  if (!computers.length) throw new Error("No computer is connected. Open the Grok Bot app on the computer the bot should use.");
  if (!ref) {
    if (computers.length > 1) throw new Error(`Several computers are connected; pick one: ${computers.map((c) => c.label).join(", ")}`);
    return computers[0];
  }
  const r = ref.toLowerCase();
  const exact = computers.find((c) => c.machineId === ref || c.label.toLowerCase() === r);
  if (exact) return exact;
  const prefixed = computers.filter((c) => c.label.toLowerCase().startsWith(r));
  if (prefixed.length === 1) return prefixed[0];
  const names = (prefixed.length ? prefixed : computers).map((c) => c.label).join(", ");
  throw new Error(prefixed.length ? `"${ref}" matches several computers: ${names}` : `No computer named "${ref}". Computers: ${names}`);
}

/** The bot's saved files (its Files tab in the app). */
export async function listBotFiles(bot: Bot): Promise<BotFile[]> {
  const out: BotFile[] = [];
  const seen = new Set<string>();
  let pageToken = "";
  do {
    if (seen.size >= 50) throw new Error("The bot has too many files to list; see its Files tab in the Grok Bot app.");
    seen.add(pageToken);
    const res = await rpc<{
      files?: { name: string; path: string; sizeBytes?: string; contentType?: string; updatedAtMs?: string }[];
      nextPageToken?: string;
    }>("ListGrokBotAgentFiles", { agentId: bot.agentId, pageToken });
    for (const f of res.files ?? [])
      out.push({ name: f.name, path: f.path, sizeBytes: Number(f.sizeBytes ?? 0), contentType: f.contentType ?? "", updatedAtMs: Number(f.updatedAtMs ?? 0) });
    pageToken = res.nextPageToken ?? "";
    if (pageToken && seen.has(pageToken)) throw new Error("The Grok Bot app repeated a page of files.");
  } while (pageToken);
  return out;
}

const CHUNK = 4 * 1024 * 1024;
const MAX_DOWNLOAD = 200 * 1024 * 1024;
const MAX_UPLOAD = 100 * 1024 * 1024;

/**
 * Signed storage URLs come from the API; still, only plain HTTPS to a public host is fetched, without redirects, so a
 * bad response can't point the client at localhost or the local network.
 */
async function publicHttps(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error(`Refusing a non-HTTPS storage URL: ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  // ponytail: checked at lookup time like xai.ts, so DNS rebinding between lookup and fetch is not covered.
  // Lazy: xai.js pulls in the AI SDK, which the bot commands otherwise never load.
  const { isPrivateAddress } = await import("./xai.js");
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new Error(`Refusing a storage URL on a private or local address: ${url.host}`);
  return url;
}

/** A file name from the bot (untrusted) as a plain, visible name: no folders, control characters or leading dots. */
export function safeName(name: string): string {
  return (
    basename(name.replace(/\\/g, "/"))
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/^\.+/, "")
      .slice(0, 200) || "file"
  );
}

/** Writes data as a new file in dir, never over an existing one (or through a symlink): name, name-2, name-3... */
export function writeNew(dir: string, name: string, data: Uint8Array): string {
  mkdirSync(dir, { recursive: true });
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length) || "file";
  for (let n = 1; n < 1000; n++) {
    const target = join(dir, n === 1 ? `${stem}${ext}` : `${stem}-${n}${ext}`);
    try {
      writeFileSync(target, data, { flag: "wx", mode: 0o600 });
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`Too many files named ${name} in ${dir}`);
}

async function fetchCapped(url: URL, signal?: AbortSignal): Promise<Buffer> {
  const timeout = AbortSignal.timeout(120_000);
  const res = await fetch(url, { redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  if (Number(res.headers.get("content-length")) > MAX_DOWNLOAD) throw new Error(`The file is larger than ${MAX_DOWNLOAD / 1024 / 1024} MB.`);
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of res.body) {
    size += part.length;
    if (size > MAX_DOWNLOAD) throw new Error(`The file is larger than ${MAX_DOWNLOAD / 1024 / 1024} MB.`);
    parts.push(part);
  }
  return Buffer.concat(parts);
}

async function readChunks(path: string, signal?: AbortSignal): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total: number | undefined;
  for (let offset = 0; total === undefined || offset < total; ) {
    const chunk = await rpc<{ data?: string; totalSize?: string }>(
      "ReadGrokBotAgentAttachmentChunk",
      { path, offset: String(offset), length: CHUNK },
      signal,
    );
    const size = Number(chunk.totalSize ?? 0);
    if (!Number.isSafeInteger(size) || size < 0 || (total !== undefined && size !== total)) throw new Error(`Bad size for ${path}: ${chunk.totalSize}`);
    if (size > MAX_DOWNLOAD) throw new Error(`${path} is larger than ${MAX_DOWNLOAD / 1024 / 1024} MB.`);
    total = size;
    const data = Buffer.from(chunk.data ?? "", "base64");
    if (data.length > Math.min(CHUNK, total - offset)) throw new Error(`The Grok Bot app sent more of ${path} than it holds.`);
    if (!data.length && offset < total) throw new Error(`Download of ${path} stalled at ${offset} of ${total} bytes.`);
    parts.push(data);
    offset += data.length;
  }
  return Buffer.concat(parts);
}

/**
 * Downloads a file the bot sent or saved (a BotEntry.file.path or a BotFile.path) as a new file in dir (never
 * overwriting) and returns its local path. Uses the signed URL the app would use, else reads it through the API.
 */
export async function downloadBotFile(bot: Bot, path: string, dir: string, name?: string, signal?: AbortSignal): Promise<string> {
  const { reads = [] } = await rpc<{ reads?: { path: string; url?: string }[] }>(
    "ResolveGrokBotAttachmentReads",
    { agentId: bot.agentId, paths: [path] },
    signal,
  );
  const url = reads.find((r) => r.path === path)?.url;
  const data = url ? await fetchCapped(await publicHttps(url), signal) : await readChunks(path, signal);
  return writeNew(resolve(dir), safeName(name || path), data);
}

/**
 * Uploads a local file for the bot and returns the path SendGrokBotUserMessage takes: an alias in the attachment store,
 * or, for bots that keep files on their own computer, the path it was written to there.
 */
export async function uploadBotFile(bot: Bot, file: string, signal?: AbortSignal): Promise<{ alias: string; name: string }> {
  const name = basename(file);
  const data = readUpload(file);
  const begin = await rpc<{
    mode?: string;
    uploadToken?: string;
    put?: { url: string; headers?: Record<string, string> };
    refusal?: unknown;
  }>(
    "BeginGrokBotAttachmentUpload",
    { agentId: bot.agentId, fileName: name, sizeBytes: String(data.length), supportsStoreAttachmentRefs: true, supportsMultipart: false },
    signal,
  );
  if (begin.mode === "GROK_BOT_ATTACHMENT_UPLOAD_MODE_USE_BOX") return { alias: await uploadToBox(bot, name, data, signal), name };
  if (begin.mode !== "GROK_BOT_ATTACHMENT_UPLOAD_MODE_SINGLE_PUT" || !begin.put || !begin.uploadToken)
    throw new Error(`The Grok Bot app refused ${name} (${begin.mode ?? "no mode"}${begin.refusal ? `: ${JSON.stringify(begin.refusal)}` : ""}).`);
  const timeout = AbortSignal.timeout(120_000);
  const put = await fetch(await publicHttps(begin.put.url), {
    method: "PUT",
    headers: begin.put.headers ?? {},
    body: new Uint8Array(data),
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!put.ok) throw new Error(`Upload of ${name} failed (${put.status})`);
  const done = await rpc<{ alias?: string; refusal?: unknown }>("CompleteGrokBotAttachmentUpload", { uploadToken: begin.uploadToken }, signal);
  if (!done.alias) throw new Error(`The Grok Bot app did not store ${name}${done.refusal ? `: ${JSON.stringify(done.refusal)}` : "."}`);
  return { alias: done.alias, name };
}

/** Reads a regular file of at most MAX_UPLOAD bytes, checked on the open descriptor so it can't be swapped meanwhile. */
function readUpload(file: string): Buffer {
  const fd = openSync(file, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${file}`);
    if (stat.size > MAX_UPLOAD) throw new Error(`${basename(file)} is larger than ${MAX_UPLOAD / 1024 / 1024} MB.`);
    // One spare byte shows a file that grew after fstat.
    const data = Buffer.alloc(stat.size + 1);
    let size = 0;
    for (let n = 1; n > 0 && size < data.length; size += n) n = readSync(fd, data, size, data.length - size, null);
    if (size !== stat.size) throw new Error(`${basename(file)} changed while it was being read.`);
    return data.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

/** Writes the file straight onto the bot's computer, in chunks, as the app does when the store isn't used. */
async function uploadToBox(bot: Bot, name: string, data: Buffer, signal?: AbortSignal): Promise<string> {
  const uploadId = randomUUID();
  let path: string | undefined;
  // At least one call, so an empty file is still created.
  for (let offset = 0; offset === 0 || offset < data.length; offset += CHUNK) {
    const res = await rpc<{ path?: string }>(
      "UploadGrokBotAgentAttachmentChunk",
      {
        agentId: bot.agentId,
        uploadId,
        fileName: name,
        offset: String(offset),
        totalSize: String(data.length),
        data: data.subarray(offset, offset + CHUNK).toString("base64"),
      },
      signal,
    );
    path = res.path || path;
  }
  if (!path) throw new Error(`The bot's computer did not confirm ${name}.`);
  return path;
}

interface RawEntry {
  seq: string | number;
  body: string;
}

// C0 controls except tab and newline, DEL, and C1 controls (\u009b starts an escape sequence too).
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Turns transcript entries into plain messages; tool runs and other internal entries are dropped. */
export function parseEntries(entries: RawEntry[]): BotEntry[] {
  const out: BotEntry[] = [];
  for (const e of entries) {
    let body: {
      kind?: string;
      role?: string;
      content?: unknown;
      file_path?: unknown;
      file_name?: unknown;
      secretProvided?: unknown;
      widgetDismissed?: unknown;
      respondedValue?: unknown;
      streaming?: unknown;
      message?: { type?: string; content?: unknown; file_name?: unknown; url?: unknown; ask?: { action?: unknown; target?: unknown; status?: unknown }; approval?: { status?: unknown } };
    };
    try {
      body = JSON.parse(Buffer.from(e.body, "base64").toString("utf8"));
    } catch {
      continue;
    }
    const seq = Number(e.seq);
    if (!Number.isSafeInteger(seq) || seq < 1 || !body) continue;
    // Terminal control characters (ANSI escapes...) are dropped: bot text often quotes web pages.
    const str = (v: unknown) => (typeof v === "string" && v ? v.replace(CONTROL, "") || undefined : undefined);
    if (body.kind === "message" && body.role === "user" && str(body.content)) {
      out.push({ seq, from: "you", text: str(body.content)! });
    } else if (body.kind === "user-attachment" && str(body.file_path)) {
      const path = str(body.file_path)!;
      const name = str(body.file_name) ?? basename(path);
      out.push({ seq, from: "you", text: `[file: ${name}]`, file: { path, name } });
    } else if (body.kind === "send-message" && body.message) {
      const m = body.message;
      if (m.type === "attachment") {
        const name = str(m.file_name) ?? "attachment";
        const path = str(m.url);
        out.push({ seq, from: "bot", text: `[file: ${name}]`, ...(path ? { file: { path, name } } : {}) });
      } else if (m.type === "local-tool-permission" && m.ask) {
        const closed = body.widgetDismissed === true || body.respondedValue != null;
        const approval = { action: str(m.ask.action) ?? "act", target: str(m.ask.target) ?? "", status: closed ? "closed" : str(m.ask.status) ?? "pending" };
        const state = approval.status === "pending" ? "waiting for approval in the Grok Bot app" : approval.status;
        out.push({ seq, from: "bot", text: `[asks to ${approval.action} on your computer (${state}): ${approval.target}]`, approval });
      } else if (m.type === "secret-request") {
        const pending = body.secretProvided !== true && body.widgetDismissed !== true && body.respondedValue == null;
        out.push({ seq, from: "bot", text: pending ? "[waiting for a secret; use bot_secrets_list for the request id]" : body.secretProvided === true ? "[secret provided]" : "[secret request closed]", secretRequest: { pending } });
      } else if (["auto-review-approval", "meeting-join-consent", "cookie-origin-approval", "virtual-card-approval", "connector-grant"].includes(m.type ?? "")) {
        const status = body.widgetDismissed === true || body.respondedValue != null ? "closed" : str(m.type === "connector-grant" ? m.ask?.status : m.approval?.status) ?? "pending";
        out.push({ seq, from: "bot", text: `[${m.type}: ${status}; approve in the Grok Bot app]`, approval: { action: m.type!, target: "", status } });
      } else if (m.type === "text" && (typeof m.content === "string" || body.streaming === true))
        out.push({ seq, from: "bot", text: str(m.content) ?? "", ...(body.streaming === true ? { streaming: true } : {}) });
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

async function rawEntries(bot: Bot, limit: number, beforeSeq?: number, signal?: AbortSignal): Promise<RawEntry[]> {
  const { entries = [] } = await rpc<{ entries?: RawEntry[] }>(
    "ListGrokBotTranscriptEntries",
    { agentId: bot.agentId, limit, sessionId: "", ...(beforeSeq === undefined ? {} : { beforeSeq: String(beforeSeq) }) },
    signal,
  );
  return entries;
}

const maxSeq = (entries: RawEntry[]) => entries.reduce((m, e) => Math.max(m, Number(e.seq) || 0), 0);

const PAGE = 100;
const MAX_PAGES = 50;

/**
 * Pages back through the transcript (newest first) until stop says enough or the start is reached. Internal entries
 * (tool runs...) take up most of a busy chat, so a raw limit alone would return too few messages.
 */
async function pageBack(bot: Bot, stop: (raw: RawEntry[]) => boolean, signal?: AbortSignal): Promise<RawEntry[]> {
  const raw: RawEntry[] = [];
  let beforeSeq: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const entries = await rawEntries(bot, PAGE, beforeSeq, signal);
    raw.push(...entries);
    const oldest = entries.reduce((m, e) => Math.min(m, Number(e.seq) || 0), Infinity);
    if (entries.length < PAGE || stop(raw) || !(oldest < (beforeSeq ?? Infinity))) return raw;
    beforeSeq = oldest;
  }
  throw new Error(`The chat has more than ${MAX_PAGES * PAGE} entries to go through; read it in the Grok Bot app.`);
}

export async function readBot(bot: Bot, limit = 20): Promise<BotEntry[]> {
  return parseEntries(await pageBack(bot, (raw) => parseEntries(raw).length >= limit)).slice(-limit);
}

/** Every message after seq. */
async function entriesAfter(bot: Bot, after: number, signal?: AbortSignal): Promise<BotEntry[]> {
  const raw = await pageBack(bot, (raw) => raw.some((e) => Number(e.seq) <= after), signal);
  return parseEntries(raw.filter((e) => Number(e.seq) > after));
}

export interface BotStatus {
  /** The bot is still working, which can go on after its turn settles (it often says "on it" first). */
  running: boolean;
  settledAtMs: number;
  /** What it is doing right now, e.g. "is verifying playwright installation". */
  activity?: string;
}

export async function botStatus(bot: Bot, signal?: AbortSignal): Promise<BotStatus> {
  const { statuses = [] } = await rpc<{
    statuses?: {
      agentId: string;
      isRunning?: boolean;
      live?: {
        isRunning?: boolean;
        isComposingMessage?: boolean;
        isRetrying?: boolean;
        hasRunningSubagents?: boolean;
        lastTurnSettlement?: { settledAtMs?: string };
        activity?: { tool?: string; detail?: string };
      };
    }[];
  }>("ListGrokBotAgentStatuses", {}, signal);
  const row = statuses.find((s) => s.agentId === bot.agentId), live = row?.live;
  // isRunning as reported: judging staleness from updatedAtMs would compare the server's clock with ours.
  return {
    running: row?.isRunning === true || live?.isRunning === true || live?.isComposingMessage === true || live?.isRetrying === true || live?.hasRunningSubagents === true,
    settledAtMs: Number(live?.lastTurnSettlement?.settledAtMs ?? 0),
    activity: live?.activity?.detail || live?.activity?.tool || undefined,
  };
}

export interface SendOptions {
  wait?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onReply?: (e: BotEntry) => void;
  /** Called when the bot's current activity changes, e.g. "is opening the browser". */
  onActivity?: (activity: string) => void;
  /** Local files to attach (screenshots, specs...). */
  files?: string[];
  /** Machine id of one of the user's computers (listComputers) to run the task on, instead of the bot's own. */
  machineId?: string;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
  });

export interface WaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onReply?: (e: BotEntry) => void;
  /** Called when the bot's current activity changes, e.g. "is opening the browser". */
  onActivity?: (activity: string) => void;
}

export interface SendOptions extends WaitOptions {
  wait?: boolean;
  /** Local files to attach (screenshots, specs...). */
  files?: string[];
  /** Machine id of one of the user's computers (listComputers) to run the task on, instead of the bot's own. */
  machineId?: string;
}

/**
 * Sends a message as the user (it shows up in the app) and, unless wait is off, returns the bot's replies once it has
 * finished working (see waitForBot).
 */
export interface BotRun {
  replies: BotEntry[];
  done: boolean;
  afterSeq: number;
  blocked?: "secret" | "approval";
}

export async function sendToBot(bot: Bot, text: string, opts: SendOptions = {}): Promise<BotRun> {
  const { signal } = opts;
  const uploads = [];
  for (const f of opts.files ?? []) uploads.push(await uploadBotFile(bot, f, signal));
  // Raw seq and the server's own settlement time, so internal entries and clock skew can't confuse what is new.
  const after = maxSeq(await rawEntries(bot, 1, undefined, signal));
  if (!Number.isSafeInteger(after) || after < 0) throw new Error("The transcript has an invalid sequence number; no message was sent.");
  const settledBefore = (await botStatus(bot, signal)).settledAtMs;
  const res = await rpc<{ dispatched?: boolean; refusal?: unknown }>(
    "SendGrokBotUserMessage",
    {
      agentId: bot.agentId,
      messageId: randomUUID(),
      text,
      sentAtMs: String(Date.now()),
      sessionId: "",
      attachmentPaths: uploads.map((u) => u.alias),
      attachmentNames: uploads.map((u) => u.name),
      ...(opts.machineId ? { machineId: opts.machineId } : {}),
    },
    signal,
  );
  if (!res.dispatched) throw new Error(`The bot did not accept the message${res.refusal ? `: ${JSON.stringify(res.refusal)}` : "."}`);
  if (opts.wait === false) return { replies: [], done: false, afterSeq: after };
  return waitForBot(bot, { ...opts, after, settledBefore });
}

/**
 * Waits until the bot has finished working on the user's last message (or on what came after seq `after`): a turn
 * settled after `settledBefore`, it is no longer running, and nothing waits for the user's approval. Bots often reply
 * "on it", settle and keep working, so settling alone is not enough. Returns the bot's replies since then.
 */
export async function waitForBot(
  bot: Bot,
  opts: WaitOptions & { after?: number; settledBefore?: number } = {},
): Promise<BotRun> {
  if (opts.after !== undefined && (!Number.isSafeInteger(opts.after) || opts.after < 0)) throw new Error("after_seq must be a non-negative safe integer.");
  const after = opts.after ?? (await readBot(bot, 30)).findLast((e) => e.from === "you")?.seq ?? 0;
  const settledBefore = opts.settledBefore ?? 0;
  const replies: BotEntry[] = [];
  const mutable = (entry: BotEntry) => entry.streaming || entry.secretRequest?.pending || entry.approval?.status === "pending";
  const cursor = () => {
    const pending = replies.filter(mutable);
    if (pending.length) return Math.max(after, Math.min(...pending.map(entry => entry.seq)) - 1);
    return replies.reduce((seq, entry) => Math.max(seq, entry.seq), after);
  };
  const pollSignal = AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 10 * 60_000), ...(opts.signal ? [opts.signal] : [])]);
  let idlePolls = 0;
  let activity = "";
  try {
    for (let first = true; !pollSignal.aborted; first = false) {
      if (!first || opts.after !== undefined) await sleep(3000, pollSignal);
      if (pollSignal.aborted) break;
      // Checked before reading, so replies written just before the bot stopped are still collected.
      const status = await botStatus(bot, pollSignal);
      for (const e of (await entriesAfter(bot, after, pollSignal)).filter((e) => e.from === "bot")) {
        const i = replies.findIndex((r) => r.seq === e.seq);
        // Approvals are updated in place (pending -> allowed), so keep the latest version.
        if (i >= 0) replies[i] = e;
        else {
          replies.push(e);
          opts.onReply?.(e);
        }
      }
      const pendingSecret = replies.find(r => r.secretRequest?.pending);
      const pending = replies.find((r) => r.approval?.status === "pending");
      if (pendingSecret || pending) {
        // Keep a mutable pending entry within the next read window: its state can change without a new seq.
        return { replies, done: false, blocked: pendingSecret ? "secret" : "approval", afterSeq: cursor() };
      }
      const now = status.running ? status.activity : "";
      if (now && now !== activity) opts.onActivity?.((activity = now));
      // Three idle polls in a row: a bot can pause between its "on it" turn and the real work. A bot waiting for the
      // user's approval is not running either, but it isn't done.
      idlePolls = status.settledAtMs > settledBefore && !status.running && !replies.some(mutable) ? idlePolls + 1 : 0;
      if (idlePolls >= 3) return { replies, done: true, afterSeq: cursor() };
    }
  } catch (err) {
    if (!pollSignal.aborted) throw err;
  }
  return { replies, done: false, afterSeq: cursor() };
}

/** Readable, unique model ids: "Grok Bot" -> "grok-bot"; duplicates get -2, -3. */
export function botSlugs(bots: Bot[]): string[] {
  const seen = new Map<string, number>();
  return bots.map((b) => {
    const base = b.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "bot";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}
