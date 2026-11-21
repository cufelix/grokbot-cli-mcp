// The Grok Bot app's vault: the logins, cards and contact details a bot fills into forms on the user's behalf.
// Unofficial, like bots.ts: the same private Connect API (aiserver.v1.GrokBotService) with the user's own Cursor login.
//
// Secrets go one way. Creating or updating a login takes a password; GrokBotVaultCredential, what every read returns,
// has no password field. On top of that, nothing derived from a secret-bearing call's response is shown: errors become
// fixed local messages (an error body could echo the request) and a confirmation is built from what we sent.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { withInboxValue } from "./inbox.js";
import { domainToUnicode } from "node:url";
import { randomUUID } from "node:crypto";
import { rpc } from "./bots.js";

/** LOGIN | CARD | CONTACT, as the app's GrokBotVaultItemKind enum numbers them. */
export const KINDS = { login: 1, card: 2, contact: 3 } as const;
export type VaultKind = keyof typeof KINDS;

const KIND_NAMES = new Map<unknown, VaultKind>([
  [1, "login"],
  [2, "card"],
  [3, "contact"],
  ["GROK_BOT_VAULT_ITEM_KIND_LOGIN", "login"],
  ["GROK_BOT_VAULT_ITEM_KIND_CARD", "card"],
  ["GROK_BOT_VAULT_ITEM_KIND_CONTACT", "contact"],
]);

/** Limits on what we send, checked here so the CLI and any other caller get them too, not only the MCP schemas. */
export const LIMITS = { title: 200, username: 200, notes: 1000, sites: 10, password: 1024, formValue: 2000 } as const;

/** C0/C1 control characters (terminal escapes, newlines that could forge output lines). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
/** The same set without /g, for .test(): a global regex keeps lastIndex between calls. */
const HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A string from the API as something safe to print: no control characters, bounded. */
export function clean(value: unknown, max = 300): string {
  if (typeof value !== "string") return "";
  const text = value.replace(CONTROL, " ");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** An item id as an id: anything else (e.g. a server putting other data there) is dropped. */
const cleanId = (value: unknown): string => (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : "");

/** A vault entry as the API hands it back: what it is and where it is used, never the secret itself. */
export interface VaultItem {
  id: string;
  title: string;
  /** "other" for a kind this client does not know, rather than pretending it is a login. */
  kind: VaultKind | "other";
  username: string;
  sites: string[];
  notes: string;
  createdAtMs: number;
  updatedAtMs: number;
  card?: { brand: string; last4: string; expiry: string; holderName: string; nickname: string };
  contact?: { email: string; defaultShipping: boolean };
  managedBy?: string;
}

export interface NewLogin {
  title: string;
  username: string;
  password: string;
  sites: string[];
  notes?: string;
}

/** A count or a millisecond timestamp; out-of-range ones become 0 (new Date() throws past 8.64e15). */
const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n >= 0 && n <= 8.64e15 ? n : 0;
};

const strings = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.slice(0, max).map((s) => clean(s, 253)).filter(Boolean) : []);

function toItem(raw: unknown): VaultItem {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const card = c.card && typeof c.card === "object" ? c.card : undefined;
  const contact = c.contact && typeof c.contact === "object" ? c.contact : undefined;
  const expMonth = num(card?.expMonth);
  const expYear = num(card?.expYear);
  return {
    id: cleanId(c.id),
    title: clean(c.title, LIMITS.title),
    kind: KIND_NAMES.get(c.kind) ?? "other",
    username: clean(c.username, LIMITS.username),
    sites: strings(c.sites, 50),
    notes: clean(c.notes, LIMITS.notes),
    createdAtMs: num(c.createdAtMs),
    updatedAtMs: num(c.updatedAtMs),
    ...(card
      ? {
          card: {
            brand: clean(card.brand, 30),
            last4: /^\d{4}$/.test(String(card.last4 ?? "")) ? String(card.last4) : "",
            expiry: expMonth >= 1 && expMonth <= 12 && expYear ? `${String(expMonth).padStart(2, "0")}/${expYear}` : "",
            holderName: clean(card.holderName, 100),
            nickname: clean(card.nickname, 100),
          },
        }
      : {}),
    ...(contact ? { contact: { email: clean(contact.email, 254), defaultShipping: contact.defaultShipping === true } } : {}),
    ...(typeof c.managedBy === "string" && /^GROK_BOT_VAULT_ITEM_MANAGER_[A-Z_]+$/.test(c.managedBy) && !c.managedBy.endsWith("UNSPECIFIED")
      ? { managedBy: c.managedBy.replace("GROK_BOT_VAULT_ITEM_MANAGER_", "").toLowerCase() }
      : {}),
  };
}

/**
 * What is in the vault: titles, user names, sites, card brands and last four digits. No passwords, card numbers or
 * CVVs — the API does not return them.
 */
export async function listVault(options: { kinds?: VaultKind[]; signal?: AbortSignal } = {}): Promise<VaultItem[]> {
  const kinds = options.kinds?.length ? options.kinds : (["login", "card", "contact"] as VaultKind[]);
  const res = await rpc<{ credentials?: unknown }>(
    "ListGrokBotVaultCredentials",
    { includeKinds: kinds.map((k) => KINDS[k]), includeManaged: true },
    options.signal,
  );
  if (res.credentials !== undefined && !Array.isArray(res.credentials)) throw new Error("The app returned vault items in an unexpected shape.");
  if (Array.isArray(res.credentials) && res.credentials.length > 1000) throw new Error("Too many vault items to read the complete list safely.");
  return Array.isArray(res.credentials) ? res.credentials.map(toItem) : [];
}

/**
 * A site a login may be offered on: a bare DNS host name (IDNA as punycode), so a typo can't turn into a wildcard, a
 * URL with a path, or a whole TLD.
 */
export function checkSite(site: string): string {
  const host = site.trim().toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  const ok =
    host.length <= 253 &&
    labels.length >= 2 &&
    labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) &&
    /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels[labels.length - 1]) &&
    labels.every((l) => !l.startsWith("xn--") || domainToUnicode(l) !== "");
  if (!ok) throw new Error(`"${clean(site, 80)}" is not a host name. Give the site as a bare host, e.g. app.example.com.`);
  return host;
}

function loginBody(login: NewLogin): { title: string; username: string; notes: string; sites: string[]; password: string } {
  const title = login.title.trim();
  if (!title) throw new Error("The login needs a title, e.g. the name of the site.");
  if (title.length > LIMITS.title) throw new Error(`The title is longer than ${LIMITS.title} characters.`);
  if (login.username.length > LIMITS.username) throw new Error(`The user name is longer than ${LIMITS.username} characters.`);
  if ((login.notes ?? "").length > LIMITS.notes) throw new Error(`The notes are longer than ${LIMITS.notes} characters.`);
  if (HAS_CONTROL.test(`${title}${login.username}`)) throw new Error("Control characters are not allowed in a title or user name.");
  if (!login.password) throw new Error("The login needs a password.");
  if (login.password.length > LIMITS.password) throw new Error(`The password is longer than ${LIMITS.password} characters.`);
  if (!login.sites.length) throw new Error("Give at least one site the login belongs to, e.g. app.example.com.");
  if (login.sites.length > LIMITS.sites) throw new Error(`At most ${LIMITS.sites} sites per login.`);
  return { title, username: login.username, notes: login.notes ?? "", sites: [...new Set(login.sites.map(checkSite))], password: login.password };
}

/**
 * A call that carries a password. Whatever goes wrong, the caller sees a fixed message with at most the HTTP status:
 * an error body, a JSON parse error or a server-written error string could each echo the request back.
 */
async function secretCall<T>(method: string, body: object, what: string, signal?: AbortSignal): Promise<T> {
  try {
    // No automatic retry after a 401: a replay would send the password twice and could save it twice.
    return await rpc<T>(method, body, signal, true);
  } catch (err) {
    if (signal?.aborted) throw new Error(`Cancelled; the ${what} may or may not have been saved — check with \`vault list\`.`);
    const message = err instanceof Error ? err.message : "";
    if (/^Not signed in to Cursor/.test(message)) throw new Error(message);
    // Not even the status code: for a short numeric password it could be the password, chosen by the server.
    throw new Error(`The vault did not save the ${what}. If your Cursor login expired, run \`cursor-agent status\` and try again.`);
  }
}

/** What a create returned: exactly one result, holding a credential with a real id. Its other fields are not used. */
function createdId(res: { results?: unknown }): string {
  const results = Array.isArray(res.results) ? res.results : [];
  const unsure = "The vault's reply was unclear: the login may or may not be saved — check `vault list` before trying again.";
  if (results.length !== 1) throw new Error(unsure);
  const r = (results[0] ?? {}) as Record<string, any>;
  if (typeof r.refusal === "string" && r.refusal.endsWith("VAULT_FULL")) throw new Error("The vault is full.");
  if (!cleanId(r.credential?.id)) throw new Error(unsure);
  return cleanId(r.credential?.id);
}

/**
 * A saved login as confirmed to the caller: only our own values. Not even the new id — it comes from the reply to a call
 * that carried the password; `listVault` shows it.
 */
export interface SavedLogin {
  title: string;
  sites: string[];
}

/**
 * Creates a login. The password reaches the app's vault and nothing else: the reply is reduced to the new id, so not
 * even a misbehaving server can put it in front of the caller.
 */
export async function createLogin(login: NewLogin, signal?: AbortSignal): Promise<SavedLogin> {
  const body = loginBody(login);
  const res = await secretCall<{ results?: unknown }>("BatchCreateGrokBotVaultCredentials", { logins: [body] }, "login", signal);
  createdId(res);
  return { title: body.title, sites: body.sites };
}

/**
 * Replaces an existing login (title, user name, sites and password together — the API has no partial update). Not
 * offered to MCP hosts: overwriting is the one way to destroy a saved password, so it stays a deliberate CLI step.
 */
export async function updateLogin(id: string, login: NewLogin, signal?: AbortSignal): Promise<SavedLogin> {
  if (!cleanId(id)) throw new Error("Which login? Take its id from `grokbot vault list --ids`.");
  const body = loginBody(login);
  const res = await secretCall<{ credential?: { id?: unknown } }>("PutGrokBotVaultCredential", { id, ...body }, "login", signal);
  if (cleanId(res.credential?.id) !== id) throw new Error("The vault's reply was unclear: check `vault list` before trying again.");
  return { title: body.title, sites: body.sites };
}

/** Removes an item from the vault. Gone for good: the password is not recoverable from anywhere else. */
export async function deleteVaultItem(id: string, signal?: AbortSignal): Promise<void> {
  if (!cleanId(id)) throw new Error("Which item? Take its id from `grokbot vault list --ids`.");
  await rpc("DeleteGrokBotVaultCredential", { id }, signal);
}

/**
 * Changes what the app shows for a card: holder, expiry, nickname, notes. The number and CVV are not touched.
 * Holder and expiry are plain proto3 strings, so leaving one out would send "" and clear it: missing ones are filled
 * from the card's current values first.
 */
export async function updateCard(
  card: { id: string; holderName?: string; expiry?: string; nickname?: string; notes?: string },
  signal?: AbortSignal,
): Promise<VaultItem> {
  if (!cleanId(card.id)) throw new Error("Which card? Take its id from `grokbot vault list --ids`.");
  if (card.expiry && !/^(0[1-9]|1[0-2])\/\d{2}(\d{2})?$/.test(card.expiry)) throw new Error("Expiry goes as MM/YY or MM/YYYY.");
  for (const [field, value, max] of [["holder", card.holderName, 100], ["nickname", card.nickname, 100], ["notes", card.notes, LIMITS.notes]] as const) {
    if (value !== undefined && (value.length > max || HAS_CONTROL.test(value))) throw new Error(`The ${field} is too long or has control characters.`);
  }
  // Read-modify-write: the API has no partial update. A change made elsewhere in between would be overwritten.
  const current = (await listVault({ kinds: ["card"], signal })).find((i) => i.id === card.id);
  if (!current?.card) throw new Error("No card with that id in the vault.");
  const res = await rpc<{ credential?: unknown }>(
    "UpdateGrokBotVaultCard",
    {
      id: card.id,
      holderName: card.holderName ?? current.card.holderName,
      expiry: card.expiry ?? current.card.expiry,
      ...(card.nickname === undefined ? {} : { nickname: card.nickname }),
      ...(card.notes === undefined ? {} : { notes: card.notes }),
    },
    signal,
  );
  if (!res.credential) throw new Error("The vault did not confirm the card.");
  return toItem(res.credential);
}

// --- the form vault: plain autofill answers, not secrets ------------------------------------------------

/**
 * An answer the bot has filled into a form before and may reuse: a name, a phone number, an address line. Unlike a
 * login, the value is readable — the "remember what I typed" half of autofill, not the secret half.
 */
export interface FormEntry {
  entryId: string;
  kind: string;
  label: string;
  value: string;
  extraKey?: string;
  originHost?: string;
  createdAtMs: number;
  lastUsedAtMs: number;
}

/** Kinds verified against the live server; values are readable profile data, never secrets. */
export const FORM_KINDS = ["name", "email", "phone", "address", "extra"] as const;
export type FormKind = (typeof FORM_KINDS)[number];

function toFormEntry(raw: unknown): FormEntry {
  const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    entryId: cleanId(e.entryId),
    kind: clean(e.kind, 60),
    label: clean(e.label, 120),
    value: clean(e.value, LIMITS.formValue),
    ...(typeof e.extraKey === "string" && e.extraKey ? { extraKey: clean(e.extraKey, 120) } : {}),
    ...(typeof e.originHost === "string" && e.originHost ? { originHost: clean(e.originHost, 253) } : {}),
    createdAtMs: num(e.createdAtMs),
    lastUsedAtMs: num(e.lastUsedAtMs),
  };
}

/** The saved form answers. Values are readable here, so treat the output as the user's personal data. */
export async function listFormEntries(signal?: AbortSignal): Promise<FormEntry[]> {
  const res = await rpc<{ entries?: unknown }>("ListGrokBotUserFormVaultEntries", {}, signal);
  if (res.entries !== undefined && !Array.isArray(res.entries)) throw new Error("The app returned form answers in an unexpected shape.");
  if (Array.isArray(res.entries) && res.entries.length > 1000) throw new Error("Too many form answers to read the complete list safely.");
  return Array.isArray(res.entries) ? res.entries.map(toFormEntry) : [];
}

/** The extra keys answers are filed under, and their host — the index of the form vault, without any values. */
export async function listFormKeys(signal?: AbortSignal): Promise<{ extraKey: string; originHost: string }[]> {
  const res = await rpc<{ keys?: unknown }>("ListGrokBotUserFormVaultKeys", {}, signal);
  if (!Array.isArray(res.keys)) return [];
  return res.keys.slice(0, 1000).map((k: any) => ({ extraKey: clean(k?.extraKey, 120), originHost: clean(k?.originHost, 253) }));
}

// Word boundaries, not anchors: the label is checked inside "<kind> <label> <extraKey>". A denylist can't be complete,
// so it is a guard against the honest mistake, not a boundary — the value is readable either way, which is why the
// docs and tool descriptions say not to put secrets here at all.
const SECRET_FIELD = new RegExp(
  [
    "pass(?:word|phrase|code)?",
    "pwd",
    "secrets?",
    "cvv2?",
    "cvc2?",
    "security[ _-]?code",
    "otp",
    "one[ _-]?time",
    "two[ _-]?factor",
    "2fa",
    "mfa",
    "totp",
    "tokens?",
    "(?:api|access|secret|private|ssh|license)[ _-]?keys?",
    "seed[ _-]?phrase",
    "mnemonic",
    "(?:recovery|backup|verification|auth|authentication)[ _-]?codes?",
    "pin",
    "cookies?",
    "session",
    "iban",
    "(?:credit )?card[ _-]?number",
    "refresh",
    "bearer",
    "ssn",
    "rodne[ _-]?cislo",
  ]
    .map((w) => `\\b${w}\\b`)
    .join("|"),
  "i",
);

/** Whether a form field looks like it would hold a secret. */
export const isSecretField = (text: string): boolean =>
  SECRET_FIELD.test(
    text
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "") // diacritics: rodné číslo → rodne cislo
      .replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, "") // zero-width and soft hyphen: pass\u200bword
      .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase: refreshToken → refresh Token (not 2FA → 2 FA)
      .replace(/[_.-]+/g, " "),
  );

/**
 * Saves one form answer: a new one, or a replacement when entryId is given (the CLI only). Refuses secret-shaped fields:
 * a form entry is readable by anything that can list the vault.
 */
export async function putFormEntry(
  entry: { entryId?: string; kind: string; label: string; value: string; extraKey?: string; originHost?: string },
  signal?: AbortSignal,
): Promise<FormEntry> {
  const kind = entry.kind.trim();
  const label = entry.label.trim();
  if (!kind || !label) throw new Error("A form answer needs a kind and a label.");
  if (kind.length > 60 || label.length > 120) throw new Error("The kind or label is too long.");
  if (entry.value.length > LIMITS.formValue) throw new Error(`The value is longer than ${LIMITS.formValue} characters.`);
  if (HAS_CONTROL.test(`${kind}${label}${entry.value}`)) throw new Error("Control characters are not allowed in a form answer.");
  if (isSecretField(`${kind} ${label} ${entry.extraKey ?? ""}`))
    throw new Error(`"${label}" looks like a secret. Save it as a login (\`grokbot vault add\`), where the value cannot be read back.`);
  if (!FORM_KINDS.includes(kind as FormKind)) throw new Error(`Unsupported form kind. Use ${FORM_KINDS.join(", ")}.`);
  if (entry.entryId !== undefined && !cleanId(entry.entryId)) throw new Error("That is not an entry id.");
  const sent = {
    entryId: entry.entryId ?? randomUUID(),
    kind,
    label,
    value: entry.value,
    ...(entry.extraKey ? { extraKey: entry.extraKey } : {}),
    ...(entry.originHost ? { originHost: checkSite(entry.originHost) } : {}),
  };
  // UpsertGrokBotUserFormVaultEntryResponse is an empty message: a successful call is the whole answer.
  await rpc("UpsertGrokBotUserFormVaultEntry", { entry: sent }, signal);
  return toFormEntry(sent);
}

/** Forgets one saved form answer. */
export async function deleteFormEntry(entryId: string, signal?: AbortSignal): Promise<void> {
  if (!cleanId(entryId)) throw new Error("Which answer? Take its id from `grokbot vault forms --ids`.");
  await rpc("DeleteGrokBotUserFormVaultEntry", { entryId }, signal);
}

// --- where a password comes from ------------------------------------------------------------------------

/**
 * Reads a small regular file the user owns, without following a symlink, and refuses anything else (a FIFO would block,
 * /dev/zero would never end). The content is the password; one trailing newline (LF or CRLF) is dropped, as editors and
 * `echo` add one — a password that really ends in a newline can't be given this way.
 */
export function readSecretFile(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(code === "ELOOP" ? `${path} is a symlink; give the file itself.` : `Can't open ${path} (${code ?? "error"}).`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} is not a regular file.`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${path} belongs to another user.`);
    // A hard link would let any file of the user's (an SSH key) pose as the inbox file of some site.
    if (st.nlink !== 1) throw new Error(`${path} has other hard links; put the password in a file of its own.`);
    if (st.size > LIMITS.password + 2) throw new Error(`${path} is too big to be a password.`);
    const buf = Buffer.alloc(LIMITS.password + 3);
    let n = 0;
    for (let got = -1; got !== 0 && n < buf.length; n += got) got = readSync(fd, buf, n, buf.length - n, n);
    if (n > LIMITS.password + 2) throw new Error(`${path} is too big to be a password.`);
    const value = buf.subarray(0, n).toString("utf8").replace(/\r?\n$/, "");
    if (!value) throw new Error(`${path} is empty.`);
    return value;
  } finally {
    closeSync(fd);
  }
}

/**
 * The drop box an MCP host may take a password from: ~/.grokbot/vault-inbox/<host>, one file per site, put there by
 * the user. The host name is the file name, so the password is bound to the site the user chose; a model can't point
 * it at an arbitrary env var or file (a Cursor token, an SSH key) or at a host of its own.
 */
export function vaultInbox(): string {
  const configured = join(process.env.GROKBOT_VAULT_INBOX || join(homedir(), ".grokbot", "vault-inbox"));
  mkdirSync(configured, { recursive: true, mode: 0o700 });
  const dir = join(realpathSync(dirname(configured)), basename(configured));
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} must be a real directory, not a symlink.`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user.`);
  if (st.mode & 0o077) throw new Error(`${dir} is readable by other users; run: chmod 700 ${dir}`);
  return dir;
}

/**
 * Takes the password the user left for a site in the inbox. The file is first claimed by an atomic rename, so two calls
 * can't both use it and a file put there meanwhile is never the one deleted; it is removed once the vault has the
 * login, and put back if saving fails.
 *
 * What this binds is file name to site. It is not a wall against a host that can write files itself (Claude Code with
 * its shell could copy any file here) — such a host could send that file anywhere directly, too.
 */
export async function createLoginFromInbox(
  login: Omit<NewLogin, "password" | "sites"> & { site: string },
  signal?: AbortSignal,
): Promise<SavedLogin & { warning?: string }> {
  const site = checkSite(login.site);
  const dir = vaultInbox();
  const file = join(dir, site);
  let saved: SavedLogin | undefined;
  const warning = await withInboxValue(dir, file, `password for ${site}`, readSecretFile, async (password) => {
    saved = await createLogin({ title: login.title, username: login.username, notes: login.notes, password, sites: [site] }, signal);
  });
  if (!saved) throw new Error("The vault did not confirm the login.");
  return { ...saved, ...(warning ? { warning } : {}) };
}

/** The password for the CLI: from a file, or stdin (echo off on a terminal). Never from an argument or the environment. */
export async function resolveSecret(from: { file?: string; stdin?: boolean }): Promise<string> {
  if (Boolean(from.file) === Boolean(from.stdin)) throw new Error("Give the password with exactly one of --password-stdin or --password-file.");
  if (from.file) return readSecretFile(from.file);
  const value = (await readStdin("password")).replace(/\r?\n$/, "");
  if (!value) throw new Error("No password on stdin.");
  if (value.length > LIMITS.password) throw new Error(`The password is longer than ${LIMITS.password} characters.`);
  return value;
}

/**
 * stdin, with echo off on a terminal: Backspace edits (by character, not UTF-16 unit), Enter ends, Ctrl-C/Ctrl-D cancel,
 * escape sequences (arrows, bracketed paste) are skipped, and the terminal mode is restored on every exit — including
 * SIGTERM/SIGHUP/SIGINT sent from outside.
 */
async function readStdin(label: string): Promise<string> {
  const stdin = process.stdin;
  const tty = stdin.isTTY === true;
  const wasRaw = tty && stdin.isRaw;
  const restore = () => {
    if (tty) stdin.setRawMode(wasRaw);
  };
  const onSignal = (sig: NodeJS.Signals) => {
    restore();
    process.stderr.write("\n");
    process.kill(process.pid, sig);
  };
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGHUP", "SIGINT"];
  if (tty) {
    process.stderr.write(`${label}: `);
    stdin.setRawMode(true);
    for (const sig of signals) process.once(sig, onSignal);
  }
  try {
    let out: string[] = [];
    let raw = "";
    stdin.setEncoding("utf8");
    for await (const chunk of stdin as AsyncIterable<string>) {
      if (!tty) {
        raw += chunk;
        if (raw.length > LIMITS.password + 2) throw new Error("Too much input for a password.");
        continue;
      }
      // Drop CSI/SS3 escape sequences whole (ESC [ … final byte, ESC O x), so an arrow key adds nothing.
      const text = chunk.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001bO.|\u001b/g, "");
      for (const ch of text) {
        if (ch === "\u0003" || ch === "\u0004") throw new Error("Cancelled.");
        if (ch === "\r" || ch === "\n") return out.join("");
        if (ch === "\u007f" || ch === "\b") out = out.slice(0, -1);
        else if (!HAS_CONTROL.test(ch)) out.push(ch);
        if (out.length > LIMITS.password) throw new Error("Too much input for a password.");
      }
    }
    return tty ? out.join("") : raw;
  } finally {
    if (tty) {
      for (const sig of signals) process.removeListener(sig, onSignal);
      restore();
      process.stderr.write("\n");
    }
    stdin.pause();
  }
}
