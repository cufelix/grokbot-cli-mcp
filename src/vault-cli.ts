// `grokbot vault ...`: the logins, cards and form answers your bots fill in for you, from a terminal.
import {
  deleteFormEntry,
  deleteVaultItem,
  listFormEntries,
  listFormKeys,
  listVault,
  createLogin,
  putFormEntry,
  resolveSecret,
  updateLogin,
  updateCard,
  type VaultItem,
  type VaultKind,
} from "./vault.js";

const USAGE = `Usage:
  grokbot vault list [--kind login|card|contact] [--ids]
                                           what is in your vault (never the passwords: the API does not return them)
  grokbot vault add --title TITLE --site HOST [--site HOST]... [--user NAME] [--notes TEXT]
                    (--password-stdin | --password-file PATH) [--id ID]
                                           save a login (with --id: replace that one, password included); the password
                                           comes from stdin or a file, never from the command line, and is never printed
  grokbot vault rm ID                      delete an item (the password is not recoverable afterwards)
  grokbot vault card ID [--holder NAME] [--expiry MM/YY] [--nickname NAME] [--notes TEXT]
                                           fix up what the app shows for a card (not the number or the CVV)
  grokbot vault forms [--ids]              saved form answers (names, addresses: readable, so not for secrets)
  grokbot vault form-keys                  the extra keys answers are filed under, and their host
  grokbot vault form-put --kind name|email|phone|address|extra --label LABEL --value TEXT [--site HOST] [--id ID]
                                           save one form answer
  grokbot vault form-rm ID                 forget one form answer

The vault lives in the Grok Bot app; a bot fills a saved login into a form without the value passing through this CLI,
the MCP server or a model's context.`;

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

const takeFlag = (args: string[], flag: string): boolean => {
  const i = args.indexOf(flag);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};

/** Nothing unrecognised is left: a mistyped flag must not silently drop a site or a password source. */
function done(args: string[], positionals = 0): string[] {
  const flag = args.find((a) => a.startsWith("--"));
  if (flag) throw new Error(`Unknown option ${flag}`);
  if (args.length > positionals) throw new Error(`Too many arguments: ${args.slice(positionals).join(" ")}`);
  return args;
}

const when = (ms: number) => (ms ? new Date(ms).toISOString().slice(0, 10) : "");

function describe(item: VaultItem, ids: boolean): string {
  const what =
    item.kind === "card"
      ? `${item.card?.brand || "card"} ••${item.card?.last4 || "??"}${item.card?.expiry ? ` ${item.card.expiry}` : ""}`
      : item.kind === "contact"
        ? item.contact?.email || "contact"
        : item.username || "(no user name)";
  const where = item.sites.length ? `  ${item.sites.join(" ")}` : "";
  const managed = item.managedBy ? "  [managed by the app]" : "";
  return `${ids ? `${item.id}  ` : ""}${item.kind.padEnd(7)} ${item.title}  ${what}${where}${managed}  ${when(item.updatedAtMs)}`;
}

export async function vaultCommand(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  const controller = new AbortController();
  const signal = controller.signal;
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    if (cmd === "list") {
      const kind = take(args, "--kind") as VaultKind | undefined;
      const ids = takeFlag(args, "--ids");
      done(args);
      if (kind && !["login", "card", "contact"].includes(kind)) throw new Error("--kind is login, card or contact.");
      const items = await listVault({ ...(kind ? { kinds: [kind] } : {}), signal });
      if (!items.length) console.log("The vault is empty. Save a login with `grokbot vault add`.");
      for (const item of items) console.log(describe(item, ids));
      return 0;
    }
    if (cmd === "add") {
      const title = take(args, "--title");
      const sites = takeAll(args, "--site");
      const user = take(args, "--user") ?? "";
      const notes = take(args, "--notes");
      const id = take(args, "--id");
      const file = take(args, "--password-file");
      const stdin = takeFlag(args, "--password-stdin");
      if (args.includes("--password-env")) throw new Error("--password-env is gone: the environment leaks to child processes and `ps eww`. Use --password-stdin.");
      done(args);
      if (!title) throw new Error("--title is required, e.g. --title \"Acme staging\".");
      if (!sites.length) throw new Error("--site is required, e.g. --site app.example.com.");
      const password = await resolveSecret({ ...(file ? { file } : {}), ...(stdin ? { stdin } : {}) });
      const login = { title, username: user, password, sites, ...(notes ? { notes } : {}) };
      const saved = id ? await updateLogin(id, login, signal) : await createLogin(login, signal);
      console.log(`${id ? "Replaced" : "Saved"} ${saved.title} for ${saved.sites.join(" ")} Your bots can fill it in; nothing can read it back.`);
      return 0;
    }
    if (cmd === "rm") {
      const [id] = done(args, 1);
      await deleteVaultItem(id, signal);
      console.log("Deleted.");
      return 0;
    }
    if (cmd === "card") {
      const holderName = take(args, "--holder");
      const expiry = take(args, "--expiry");
      const nickname = take(args, "--nickname");
      const notes = take(args, "--notes");
      const [id] = done(args, 1);
      if (!id) throw new Error("Which card? `grokbot vault list --kind card --ids`.");
      if (holderName === undefined && expiry === undefined && nickname === undefined && notes === undefined)
        throw new Error("Nothing to change. Add a card itself in the Grok Bot app: its number never goes through this CLI.");
      const saved = await updateCard({
        id,
        ...(holderName === undefined ? {} : { holderName }),
        ...(expiry === undefined ? {} : { expiry }),
        ...(nickname === undefined ? {} : { nickname }),
        ...(notes === undefined ? {} : { notes }),
      }, signal);
      console.log(`Updated ${saved.title}.`);
      return 0;
    }
    if (cmd === "forms") {
      const ids = takeFlag(args, "--ids");
      done(args);
      const entries = await listFormEntries(signal);
      if (!entries.length) console.log("No saved form answers yet.");
      for (const e of entries)
        console.log(`${ids ? `${e.entryId}  ` : ""}${e.kind}/${e.label}: ${e.value}${e.originHost ? `  ${e.originHost}` : ""}`);
      return 0;
    }
    if (cmd === "form-keys") {
      done(args);
      const keys = await listFormKeys(signal);
      console.log(keys.map((k) => `${k.extraKey}${k.originHost ? `  ${k.originHost}` : ""}`).join("\n") || "No answers filed under an extra key.");
      return 0;
    }
    if (cmd === "form-put") {
      const kind = take(args, "--kind");
      const label = take(args, "--label");
      const value = take(args, "--value");
      const site = take(args, "--site");
      const entryId = take(args, "--id");
      done(args);
      if (!kind || !label || value === undefined) throw new Error("--kind, --label and --value are required.");
      const saved = await putFormEntry({ ...(entryId ? { entryId } : {}), kind, label, value, ...(site ? { originHost: site } : {}) }, signal);
      console.log(`Saved ${saved.kind}/${saved.label}.`);
      return 0;
    }
    if (cmd === "form-rm") {
      const [id] = done(args, 1);
      await deleteFormEntry(id, signal);
      console.log("Forgotten.");
      return 0;
    }
    console.log(USAGE);
    return cmd ? 1 : 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
