import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  checkSecretName,
  deleteBotSecret,
  listBotSecrets,
  pendingSecretRequests,
  putBotSecret,
  putBotSecretFromInbox,
  registerSecretTools,
  secretInbox,
  secretsCommand,
  submitBotSecret,
  submitBotSecretFromInbox,
} from "./secrets.js";

const tmp = () => mkdtempSync(join(tmpdir(), "grokbot-secrets-test-"));
const UUID = "11111111-2222-3333-4444-555555555555";
// The secrets methods want the numeric id (checked against the live API); the transcript and submit want the UUID.
const BOT = { agentId: UUID, id: "12345678" };
const VALUE = "482913-fake-code";

type Call = { method: string; body: Record<string, unknown>; auth: string | null };
let calls: Call[] = [];
const realFetch = globalThis.fetch;

/** Stubs the Connect API: `handlers` maps a method name to a status and a body (object = JSON, string = raw). */
function stub(handlers: Record<string, [number, unknown] | (() => [number, unknown])>) {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")), auth: new Headers(init?.headers).get("authorization") });
    const h = handlers[method];
    if (!h && method === "ListGrokBotAgents") return new Response(JSON.stringify({ agents: [{ ...BOT, name: "Kiwi", viewerIsOwner: true, visibility: "GROK_BOT_AGENT_VISIBILITY_TEAM" }] }));
    if (!h) return new Response("unexpected", { status: 500 });
    const [status, body] = typeof h === "function" ? h() : h;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

const entryBody = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64");

beforeAll(() => {
  process.env.CURSOR_ACCESS_TOKEN = "test-token";
  process.env.GROKBOT_KEYCHAIN = "0";
});

let inbox: string;
beforeEach(() => {
  inbox = join(tmp(), "secret-inbox");
  process.env.GROKBOT_SECRET_INBOX = inbox;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GROKBOT_SECRET_INBOX;
});

describe("names and ids", () => {
  it("takes a secret name that is safe as a file name", () => {
    expect(checkSecretName(" API_KEY.prod-1 ")).toBe("API_KEY.prod-1");
    for (const bad of ["", "a/b", "../x", ".hidden", "-x", "a b", "x\u0000y", "a\nb", "x".repeat(101)]) expect(() => checkSecretName(bad), bad).toThrow(/name/);
  });

  it("refuses a malformed bot id before any network call", async () => {
    stub({});
    await expect(listBotSecrets({ agentId: "../x", id: "1" })).rejects.toThrow(/Which bot/);
    await expect(listBotSecrets({ agentId: UUID, id: UUID })).rejects.toThrow(/Which bot/);
    await expect(deleteBotSecret({ agentId: "a/b", id: "1" }, "n")).rejects.toThrow(/Which bot/);
    expect(calls.filter(c => c.method !== "ListGrokBotAgents")).toHaveLength(0);
  });
});

describe("list", () => {
  it("sends the bot id and returns cleaned names and metadata only", async () => {
    stub({
      ListGrokBotSecrets: [
        200,
        {
          secrets: [
            { name: "API_KEY", description: "for \u001b[2Jthe\nbuild", createdAtMs: "1700000000000", updatedAtMs: 1700000100000, value: VALUE },
            { name: "x".repeat(500), description: 7 },
            { description: "no name" },
            null,
          ],
        },
      ],
    });
    const secrets = await listBotSecrets(BOT);
    expect(calls[0]).toMatchObject({ method: "ListGrokBotSecrets", body: { id: BOT.id } });
    expect(secrets).toHaveLength(2);
    expect(secrets[0]).toEqual({ name: "API_KEY", description: "for  [2Jthe build", createdAtMs: 1700000000000, updatedAtMs: 1700000100000 });
    expect(secrets[1].name.length).toBeLessThanOrEqual(101);
    expect(JSON.stringify(secrets)).not.toContain(VALUE);
  });

  it("copes with a reply that is not a list", async () => {
    stub({ ListGrokBotSecrets: [200, { secrets: "nope" }] });
    expect(await listBotSecrets(BOT)).toEqual([]);
  });
});

describe("put", () => {
  it("sends id, name, description and value, and confirms from what it sent", async () => {
    stub({ PutGrokBotSecret: [200, { secret: { name: "API_KEY", description: "SERVER-TEXT" } }] });
    const saved = await putBotSecret(BOT, { name: "API_KEY", description: "the key", value: VALUE });
    expect(calls.find(c => c.method === "PutGrokBotSecret")).toMatchObject({ method: "PutGrokBotSecret", body: { id: BOT.id, name: "API_KEY", description: "the key", value: VALUE } });
    expect(saved).toEqual({ name: "API_KEY", description: "the key" });
  });

  it("checks limits locally, before sending", async () => {
    stub({});
    await expect(putBotSecret(BOT, { name: "n", value: "" })).rejects.toThrow(/needs a value/);
    await expect(putBotSecret(BOT, { name: "n", value: "x".repeat(1025) })).rejects.toThrow(/longer than 1024/);
    await expect(putBotSecret(BOT, { name: "n", description: "a\nb", value: "v" })).rejects.toThrow(/Control characters/);
    await expect(putBotSecret(BOT, { name: "n", description: "d".repeat(201), value: "v" })).rejects.toThrow(/longer than 200/);
    expect(calls.filter(c => c.method !== "ListGrokBotAgents")).toHaveLength(0);
  });

  it("never shows anything from the reply to a call that carried the value", async () => {
    for (const [status, body] of [
      [400, `{"message":"bad","echo":"${VALUE}"}`],
      [200, `not json ${VALUE}`],
      [200, { secret: { name: VALUE } }],
      [200, { secret: { name: "API_KEY", value: VALUE } }],
      [200, { error: `rejected ${VALUE}` }],
      [500, VALUE],
      [403, "x"],
    ] as const) {
      stub({ PutGrokBotSecret: [status, body] });
      const outcome = await putBotSecret(BOT, { name: "API_KEY", value: VALUE }).then(
        (r) => JSON.stringify(r),
        (e: Error) => e.message,
      );
      expect(outcome).not.toContain(VALUE);
      expect(outcome).not.toMatch(/\b(400|500|403)\b/);
    }
  });

  it("does not replay a call after a 401, so the value is never sent twice", async () => {
    stub({ PutGrokBotSecret: [401, "expired"] });
    await expect(putBotSecret(BOT, { name: "API_KEY", value: VALUE })).rejects.toThrow(/did not take the secret/);
    expect(calls.filter((c) => c.method === "PutGrokBotSecret")).toHaveLength(1);
  });

  it("says a cancelled call may or may not have gone through", async () => {
    const controller = new AbortController();
    globalThis.fetch = (async () => {
      controller.abort();
      throw new Error(`boom ${VALUE}`);
    }) as typeof fetch;
    const err = await putBotSecret(BOT, { name: "API_KEY", value: VALUE }, controller.signal).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Cancelled/);
    expect((err as Error).message).not.toContain(VALUE);
  });
});

describe("delete", () => {
  it("sends the bot id and the name", async () => {
    stub({ DeleteGrokBotSecret: [200, {}] });
    await deleteBotSecret(BOT, "API_KEY");
    expect(calls[0]).toMatchObject({ method: "DeleteGrokBotSecret", body: { id: BOT.id, name: "API_KEY" } });
    await expect(deleteBotSecret(BOT, "../x")).rejects.toThrow(/name/);
  });
});

describe("delete replay", () => {
  it("does not replay a secret delete after a 401", async () => {
    stub({ DeleteGrokBotSecret: [401, "expired"] });
    await expect(deleteBotSecret(BOT, "API_KEY")).rejects.toThrow();
    expect(calls.filter((c) => c.method === "DeleteGrokBotSecret")).toHaveLength(1);
  });
});

describe("submit", () => {
  it("sends agentId, entryId and value; the session id only when given", async () => {
    stub({ SubmitGrokBotSecret: [200, { accepted: true }] });
    await submitBotSecret(BOT, "entry-1", VALUE);
    expect(calls[0]).toMatchObject({ method: "SubmitGrokBotSecret", body: { agentId: UUID, entryId: "entry-1", value: VALUE } });
    expect(calls[0].body).not.toHaveProperty("sessionId");
    await submitBotSecret(BOT, "entry-1", VALUE, { sessionId: "sess-9" });
    expect(calls[1].body).toMatchObject({ sessionId: "sess-9" });
  });

  it("treats a refusal or accepted=false as a failure with a fixed message", async () => {
    for (const body of [{ accepted: false }, {}, { accepted: true, refusal: { message: `no ${VALUE}` } }, { accepted: false, refusal: { message: VALUE } }]) {
      stub({ SubmitGrokBotSecret: [200, body] });
      const err = (await submitBotSecret(BOT, "entry-1", VALUE).catch((e: Error) => e)) as Error;
      expect(err.message).toMatch(/did not accept/);
      expect(err.message).not.toContain(VALUE);
    }
  });

  it("never shows a server error, and does not retry after a 401", async () => {
    stub({ SubmitGrokBotSecret: [401, `echo ${VALUE}`] });
    const err = (await submitBotSecret(BOT, "entry-1", VALUE).catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain(VALUE);
    expect(calls).toHaveLength(1);
    stub({ SubmitGrokBotSecret: [500, `echo ${VALUE}`] });
    expect(((await submitBotSecret(BOT, "entry-1", VALUE).catch((e: Error) => e)) as Error).message).not.toContain(VALUE);
  });

  it("refuses bad ids and empty or oversized values locally", async () => {
    stub({});
    await expect(submitBotSecret(BOT, "a/b", VALUE)).rejects.toThrow(/entry id/);
    await expect(submitBotSecret(BOT, "e1", "")).rejects.toThrow(/no value/);
    await expect(submitBotSecret(BOT, "e1", "x".repeat(1025))).rejects.toThrow(/longer than/);
    await expect(submitBotSecret(BOT, "e1", "v", { sessionId: "a b" })).rejects.toThrow(/session/);
    expect(calls.filter(c => c.method !== "ListGrokBotAgents")).toHaveLength(0);
  });
});

describe("waiting requests", () => {
  it("finds unanswered secret requests in the transcript and cleans the bot's words", async () => {
    stub({
      ListGrokBotTranscriptEntries: [
        200,
        {
          entries: [
            { seq: "1", entryId: "e-1", body: entryBody({ kind: "send-message", message: { type: "secret-request", secretRequest: { label: "Code \u001b[2J", description: "sent\nto you" } } }) },
            { seq: "2", entryId: "e-2", body: entryBody({ kind: "send-message", secretProvided: true, message: { type: "secret-request", secretRequest: { label: "done" } } }) },
            { seq: "3", entryId: "e-3", body: entryBody({ kind: "send-message", message: { type: "text", content: "hi" } }) },
            { seq: "4", entryId: "bad/id", body: entryBody({ kind: "send-message", message: { type: "secret-request", secretRequest: { label: "x" } } }) },
            { seq: "5", entryId: "e-5", body: "!!not base64 json" },
            { seq: "6", body: entryBody({ kind: "send-message", message: { type: "secret-request", secretRequest: { label: "no id" } } }) },
          ],
        },
      ],
    });
    expect(await pendingSecretRequests(BOT)).toEqual([{ entryId: "e-1", label: "Code  [2J", description: "sent to you" }]);
    expect(calls[0].body).toMatchObject({ agentId: UUID });
  });
});

describe("inbox", () => {
  it("is a private real directory", () => {
    const dir = secretInbox();
    expect(realpathSync(dir)).toBe(realpathSync(inbox));
    chmodSync(dir, 0o755);
    expect(() => secretInbox()).toThrow(/chmod 700/);
  });

  it("refuses an inbox that is a symlink", () => {
    const real = tmp();
    mkdirSync(join(real, "d"), { mode: 0o700 });
    symlinkSync(join(real, "d"), inbox);
    expect(() => secretInbox()).toThrow(/symlink/);
  });

  it("stores a value from put.<bot>.<name> and deletes the file", async () => {
    stub({ PutGrokBotSecret: [200, { secret: { name: "API_KEY" } }] });
    secretInbox();
    const file = join(inbox, `put.${UUID}.API_KEY`);
    writeFileSync(file, `${VALUE}\n`);
    const saved = await putBotSecretFromInbox(BOT, { name: "API_KEY", description: "d" });
    expect(saved).toEqual({ name: "API_KEY", description: "d" });
    expect(calls.find(c => c.method === "PutGrokBotSecret")?.body.value).toBe(VALUE);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(inbox)).toEqual([]);
  });

  it("names the exact path when nothing is waiting, without sending a value", async () => {
    stub({});
    await expect(putBotSecretFromInbox(BOT, { name: "API_KEY" })).rejects.toThrow(new RegExp(`No value waiting.*put\\.${UUID}\\.API_KEY`));
    await expect(submitBotSecretFromInbox(BOT, "e-1")).rejects.toThrow(new RegExp(`No answer waiting.*submit\\.${UUID}\\.e-1`));
    expect(calls.filter(c => c.method !== "ListGrokBotAgents")).toHaveLength(0);
  });

  it("gives the file back when delivery fails, and removes it when it works", async () => {
    secretInbox();
    const file = join(inbox, `submit.${UUID}.e-1`);
    writeFileSync(file, `${VALUE}\n`);
    stub({ SubmitGrokBotSecret: [200, { accepted: false }] });
    await expect(submitBotSecretFromInbox(BOT, "e-1")).rejects.toThrow(/did not accept/);
    expect(readFileSync(file, "utf8")).toBe(`${VALUE}\n`);
    expect(readdirSync(inbox)).toEqual([`submit.${UUID}.e-1`]);
    stub({ SubmitGrokBotSecret: [200, { accepted: true }] });
    expect(await submitBotSecretFromInbox(BOT, "e-1")).toEqual({});
    expect(calls[0].body).toMatchObject({ agentId: UUID, entryId: "e-1", value: VALUE });
    expect(readdirSync(inbox)).toEqual([]);
  });

  it("refuses an inbox file that is a symlink, a hard link, too big or empty, and keeps the file", async () => {
    stub({ PutGrokBotSecret: [200, { secret: { name: "N" } }] });
    secretInbox();
    const outside = join(tmp(), "ssh-key");
    writeFileSync(outside, "PRIVATE");
    const file = join(inbox, `put.${UUID}.N`);

    symlinkSync(outside, file);
    await expect(putBotSecretFromInbox(BOT, { name: "N" })).rejects.toThrow(/symlink/);
    expect(readFileSync(outside, "utf8")).toBe("PRIVATE");
    // only the claimed link name is dropped: the target is never followed or touched, and no clutter stays behind
    expect(readdirSync(inbox)).toEqual([]);

    linkSync(outside, file);
    await expect(putBotSecretFromInbox(BOT, { name: "N" })).rejects.toThrow(/hard links/);
    expect(readFileSync(outside, "utf8")).toBe("PRIVATE");
    expect(readdirSync(inbox)).toEqual([]);

    writeFileSync(file, "x".repeat(2000));
    await expect(putBotSecretFromInbox(BOT, { name: "N" })).rejects.toThrow(/too big/);
    rmFile(file);

    writeFileSync(file, "\n");
    await expect(putBotSecretFromInbox(BOT, { name: "N" })).rejects.toThrow(/empty/);
    expect(calls.filter(c => c.method !== "ListGrokBotAgents")).toHaveLength(0);
  });

  it("refuses a staged file older than 15 minutes with a constant message and leaves it alone", async () => {
    stub({ PutGrokBotSecret: [200, { secret: { name: "N" } }] });
    secretInbox();
    const file = join(inbox, `put.${UUID}.N`);
    writeFileSync(file, VALUE);
    const old = new Date(Date.now() - 16 * 60 * 1000);
    utimesSync(file, old, old);
    const err = (await putBotSecretFromInbox(BOT, { name: "N" }).catch((e: Error) => e)) as Error;
    expect(err.message).toBe("The staged file is older than 15 minutes. Delete it and stage the value again.");
    expect(readFileSync(file, "utf8")).toBe(VALUE);
    expect(calls.filter(c => c.method !== "ListGrokBotAgents")).toHaveLength(0);
    const fresh = new Date(Date.now() - 5 * 60 * 1000);
    utimesSync(file, fresh, fresh);
    await putBotSecretFromInbox(BOT, { name: "N" });
    expect(calls.filter(c => c.method === "PutGrokBotSecret")).toHaveLength(1);
  });

  it("never overwrites a file staged while the old one was being delivered", async () => {
    secretInbox();
    const file = join(inbox, `submit.${UUID}.e-1`);
    writeFileSync(file, "OLD-VALUE");
    globalThis.fetch = (async () => {
      writeFileSync(file, "NEW-VALUE"); // the user stages a replacement mid-call
      return new Response(JSON.stringify({ accepted: false }), { status: 200 });
    }) as typeof fetch;
    await expect(submitBotSecretFromInbox(BOT, "e-1")).rejects.toThrow(/did not accept/);
    expect(readFileSync(file, "utf8")).toBe("NEW-VALUE");
    // the old copy is kept under its claimed name rather than lost or replacing the new one
    const rest = readdirSync(inbox).filter((f) => f !== `submit.${UUID}.e-1`);
    expect(rest).toHaveLength(1);
    expect(readFileSync(join(inbox, rest[0]), "utf8")).toBe("OLD-VALUE");
  });

  it("does not delete a file that replaced the claimed one, and says so instead of claiming deletion", async () => {
    secretInbox();
    const file = join(inbox, `submit.${UUID}.e-1`);
    writeFileSync(file, VALUE);
    globalThis.fetch = (async () => {
      const claimed = readdirSync(inbox).find((f) => f.includes(".taking-"))!;
      unlinkSync(join(inbox, claimed));
      writeFileSync(join(inbox, claimed), "SOMEONE-ELSES");
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }) as typeof fetch;
    const out = await submitBotSecretFromInbox(BOT, "e-1");
    expect(out.warning).toMatch(/delete it yourself/);
    expect(readdirSync(inbox)).toHaveLength(1);
  });

  it("does not let the file name escape the inbox", async () => {
    stub({});
    await expect(putBotSecretFromInbox(BOT, { name: "../../etc/passwd" })).rejects.toThrow(/name/);
    await expect(submitBotSecretFromInbox(BOT, "../x")).rejects.toThrow(/entry id/);
    await expect(submitBotSecretFromInbox({ agentId: "../bot", id: "1" }, "e")).rejects.toThrow(/Which bot/);
  });
});

const rmFile = (p: string) => unlinkSync(p);

describe("MCP tools", () => {
  async function connect() {
    const server = new McpServer({ name: "t", version: "0" });
    registerSecretTools(server);
    const client = new Client({ name: "c", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }
  const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "") as string;
  const BOTS: [number, unknown] = [200, { agents: [{ id: BOT.id, agentId: UUID, name: "Kiwi", viewerIsOwner: true, visibility: "GROK_BOT_AGENT_VISIBILITY_TEAM" }] }];

  it("exposes four tools with the right hints and no argument that could carry a value", async () => {
    const { tools } = await (await connect()).listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(by).sort()).toEqual(["bot_secret_delete", "bot_secret_put", "bot_secrets_list", "bot_submit_secret"]);
    expect(by.bot_secrets_list.annotations).toMatchObject({ readOnlyHint: true });
    expect(by.bot_secret_delete.annotations).toMatchObject({ destructiveHint: true });
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
      for (const p of props) expect(p, `${t.name}.${p}`).not.toMatch(/value|password|secret_?value|code|env|path|file|token/i);
    }
  });

  it("lists names and waiting requests as data", async () => {
    stub({
      ListGrokBotAgents: BOTS,
      ListGrokBotSecrets: [200, { secrets: [{ name: "API_KEY", description: "k", updatedAtMs: 1700000000000 }] }],
      ListGrokBotTranscriptEntries: [200, { entries: [{ seq: "1", entryId: "e-1", body: entryBody({ kind: "send-message", message: { type: "secret-request", secretRequest: { label: "Code" } } }) }] }],
    });
    const out = text(await (await connect()).callTool({ name: "bot_secrets_list", arguments: {} }));
    expect(out).toContain("API_KEY");
    expect(out).toContain("e-1  Code");
  });

  it("answers a request from the inbox file and never echoes the value", async () => {
    stub({ ListGrokBotAgents: BOTS, SubmitGrokBotSecret: [200, { accepted: true, refusal: undefined }] });
    secretInbox();
    writeFileSync(join(inbox, `submit.${UUID}.e-1`), `${VALUE}\n`);
    const res = await (await connect()).callTool({ name: "bot_submit_secret", arguments: { bot: "kiwi", entry_id: "e-1" } });
    expect(text(res)).toMatch(/Delivered/);
    expect(text(res)).not.toContain(VALUE);
    expect(calls.find((c) => c.method === "SubmitGrokBotSecret")?.body.value).toBe(VALUE);
    expect(readdirSync(inbox)).toEqual([]);
  });

  it("returns a constant error with the file path when nothing is staged, and when the bot refuses", async () => {
    stub({ ListGrokBotAgents: BOTS, SubmitGrokBotSecret: [200, { accepted: false, refusal: { message: VALUE } }] });
    const client = await connect();
    const none = await client.callTool({ name: "bot_submit_secret", arguments: { bot: "Kiwi", entry_id: "e-1" } });
    expect(none.isError).toBe(true);
    expect(text(none)).toContain(`submit.${UUID}.e-1`);
    secretInbox();
    writeFileSync(join(inbox, `submit.${UUID}.e-1`), VALUE);
    const refused = await client.callTool({ name: "bot_submit_secret", arguments: { bot: "Kiwi", entry_id: "e-1" } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).not.toContain(VALUE);
  });

  it("writes need the exact bot: no default, no prefix, duplicates refused", async () => {
    const two: [number, unknown] = [200, { agents: [{ id: "1", agentId: UUID, name: "Kiwi" }, { id: "2", agentId: "aaaa-bbbb", name: "Kiwi" }, { id: "3", agentId: "cccc-dddd", name: "Kiwifruit" }] }];
    stub({ ListGrokBotAgents: two, DeleteGrokBotSecret: [200, {}] });
    const client = await connect();
    const noBot = await client.callTool({ name: "bot_secret_delete", arguments: { name: "X" } });
    expect(noBot.isError).toBe(true);
    for (const bot of ["Kiw", "Kiwi", "nobody"]) {
      const r = await client.callTool({ name: "bot_secret_delete", arguments: { bot, name: "X" } });
      expect(r.isError, bot).toBe(true);
    }
    expect(calls.filter((c) => c.method === "DeleteGrokBotSecret")).toHaveLength(0);
    const ok = await client.callTool({ name: "bot_secret_delete", arguments: { bot: "aaaa-bbbb", name: "X" } });
    expect(ok.isError).toBeFalsy();
    // a numeric id works too
    const num = await client.callTool({ name: "bot_secret_delete", arguments: { bot: "3", name: "X" } });
    expect(num.isError).toBeFalsy();
    expect(calls.filter((c) => c.method === "DeleteGrokBotSecret").map((c) => c.body.id)).toEqual(["2", "3"]);
  });

  it("caps the bot argument and cleans API-supplied text in errors", async () => {
    stub({ ListGrokBotAgents: [200, { agents: [{ id: BOT.id, agentId: UUID, name: "Ki\u001b[2Jwi\u202e" }] }] });
    const client = await connect();
    const long = await client.callTool({ name: "bot_secrets_list", arguments: { bot: "x".repeat(5000) } }).catch((e: Error) => e);
    expect(JSON.stringify(long).length).toBeLessThan(2000);
    const r = await client.callTool({ name: "bot_secrets_list", arguments: { bot: "nobody" } });
    expect(r.isError).toBe(true);
    expect(text(r)).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e]/);
  });

  it("does not claim deletion when the inbox file could not be deleted", async () => {
    stub({ ListGrokBotAgents: BOTS, SubmitGrokBotSecret: [200, { accepted: true }] });
    secretInbox();
    const file = join(inbox, `submit.${UUID}.e-1`);
    writeFileSync(file, VALUE);
    const orig = globalThis.fetch;
    globalThis.fetch = (async (u: string | URL | Request, i?: RequestInit) => {
      const res = await orig(u, i);
      if (String(u).endsWith("SubmitGrokBotSecret")) {
        const claimed = readdirSync(inbox).find((f) => f.includes(".taking-"))!;
        unlinkSync(join(inbox, claimed));
        writeFileSync(join(inbox, claimed), "other");
      }
      return res;
    }) as typeof fetch;
    const res = await (await connect()).callTool({ name: "bot_submit_secret", arguments: { bot: "Kiwi", entry_id: "e-1" } });
    expect(text(res)).toMatch(/NOT confirmed deleted/);
    expect(text(res)).not.toMatch(/inbox file is deleted/);
  });

  it("stores and deletes a secret by name", async () => {
    stub({ ListGrokBotAgents: BOTS, PutGrokBotSecret: [200, { secret: { name: "API_KEY" } }], DeleteGrokBotSecret: [200, {}] });
    secretInbox();
    writeFileSync(join(inbox, `put.${UUID}.API_KEY`), VALUE);
    const client = await connect();
    const put = await client.callTool({ name: "bot_secret_put", arguments: { bot: "Kiwi", name: "API_KEY", description: "d" } });
    expect(text(put)).toMatch(/Stored "API_KEY"/);
    expect(text(put)).not.toContain(VALUE);
    const del = await client.callTool({ name: "bot_secret_delete", arguments: { bot: "Kiwi", name: "API_KEY" } });
    expect(text(del)).toBe("Deleted.");
    expect(calls.find((c) => c.method === "DeleteGrokBotSecret")?.body).toEqual({ id: BOT.id, name: "API_KEY" });
  });
});

describe("CLI", () => {
  async function run(argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const log = console.log;
    const write = process.stderr.write.bind(process.stderr);
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    process.stderr.write = ((s: string) => (err.push(String(s)), true)) as typeof process.stderr.write;
    try {
      return { code: await secretsCommand(argv), out: out.join("\n"), err: err.join("") };
    } finally {
      console.log = log;
      process.stderr.write = write;
    }
  }

  it("prints usage for nothing and fails for an unknown command", async () => {
    expect((await run([])).code).toBe(0);
    const r = await run(["bogus"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("grokbot secrets put");
  });

  it("has no way to pass a value on the command line", async () => {
    stub({ ListGrokBotAgents: [200, { agents: [{ id: BOT.id, agentId: UUID, name: "Kiwi" }] }] });
    for (const argv of [["put", "kiwi", "N", "--value", VALUE], ["submit", "kiwi", "e-1", "--value", VALUE]]) {
      const r = await run(argv);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/no --value/);
      expect(r.err + r.out).not.toContain(VALUE);
    }
    const r = await run(["put", "kiwi", "N", VALUE]);
    expect(r.code).toBe(1);
    expect(r.err + r.out).not.toContain(VALUE);
    expect(calls.filter((c) => c.method === "PutGrokBotSecret")).toHaveLength(0);
  });

  it("needs exactly one value source and reads a file through the safe reader", async () => {
    stub({ ListGrokBotAgents: [200, { agents: [{ id: BOT.id, agentId: UUID, name: "Kiwi" }] }], SubmitGrokBotSecret: [200, { accepted: true }] });
    const none = await run(["submit", "kiwi", "e-1", "--value-stdin", "--value-file", "/x"]);
    expect(none.err).toMatch(/exactly one/);
    const dir = tmp();
    const target = join(dir, "real");
    writeFileSync(target, `${VALUE}\n`);
    symlinkSync(target, join(dir, "link"));
    const link = await run(["submit", "kiwi", "e-1", "--value-file", join(dir, "link")]);
    expect(link.code).toBe(1);
    expect(link.err).toMatch(/symlink/);
    const ok = await run(["submit", "kiwi", "e-1", "--value-file", target]);
    expect(ok.code).toBe(0);
    expect(ok.out).toBe("Delivered to the bot.");
    expect(calls.find((c) => c.method === "SubmitGrokBotSecret")?.body.value).toBe(VALUE);
  });

  it("lists and removes", async () => {
    stub({
      ListGrokBotAgents: [200, { agents: [{ id: BOT.id, agentId: UUID, name: "Kiwi" }] }],
      ListGrokBotSecrets: [200, { secrets: [{ name: "API_KEY", description: "k" }] }],
      ListGrokBotTranscriptEntries: [200, { entries: [] }],
      DeleteGrokBotSecret: [200, {}],
    });
    expect((await run(["list", "kiwi"])).out).toContain("API_KEY");
    expect((await run(["rm", "kiwi", "API_KEY"])).out).toBe("Deleted.");
  });
});
