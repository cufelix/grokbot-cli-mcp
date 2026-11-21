import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  automationsCommand,
  clean,
  cleanText,
  deleteAutomation,
  describeAutomation,
  formatAutomation,
  listAutomations,
  pickAutomation,
  readTranscript,
  registerAutomationTools,
  runAutomationNow,
  setAutomationEnabled,
  toAutomation,
} from "./automations.js";

const BOT = { id: "1", agentId: "agent-1", name: "Test Bot", viewerIsOwner: true };
const FAKE = (id: string, name: string, extra: Record<string, unknown> = {}, actions = ["OPEN", "TOGGLE", "EDIT", "DELETE"]) => ({
  automationId: id,
  recordJson: JSON.stringify({
    id: "slug",
    name,
    prompt: "Say hello to Jane X.\nSecond line.",
    schedule: "CRON_TZ=UTC 0 9 * * *",
    triggerDescription: "Every day around 9:00 AM",
    isEnabled: false,
    createdAt: 1700000000000,
    lastRunAt: 1700003600000,
    nextRunAt: null,
    runs: [
      { id: "run-old", trigger: "schedule", status: "ok", startedAt: 1, finishedAt: 2 },
      { id: "run-new", trigger: "manual", status: "ok", startedAt: 1700003600000, finishedAt: 1700003660000 },
    ],
    ...extra,
  }),
  viewerPermissions: { allowedActions: actions.map((a) => `GROK_BOT_AUTOMATION_ACTION_${a}`) },
});

type Call = { method: string; body: any };
let calls: Call[];
let handler: (method: string, body: any) => unknown;

beforeEach(() => {
  calls = [];
  handler = method => method === "ListGrokBotAgents" ? { agents: [{ id: "1", agentId: "agent-1", name: "Test Bot", viewerIsOwner: true }] } : {};
  process.env.CURSOR_ACCESS_TOKEN = "fake-token";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const method = String(url).split("/").pop()!;
      const body = JSON.parse(String(init.body));
      calls.push({ method, body });
      return new Response(JSON.stringify(handler(method, body)), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

describe("clean", () => {
  it("removes control and bidi characters and caps length", () => {
    expect(clean("a\u001b[31mb\nc‮d⁦e")).toBe("a [31mb c d e");
    expect(clean("x".repeat(50), 10)).toBe("xxxxxxxxxx…");
    expect(clean(42)).toBe("");
  });

  it("keeps newlines in cleanText only", () => {
    expect(cleanText("a\r\nb\u0007c‮")).toBe("a\nb c ");
  });
});

describe("toAutomation", () => {
  it("reads the record, sorts runs newest first and lowercases permissions", () => {
    const a = toAutomation(FAKE("auto-1", "Daily hello"), BOT);
    expect(a).toMatchObject({ id: "auto-1", name: "Daily hello", enabled: false, botId: "agent-1", allowed: ["open", "toggle", "edit", "delete"] });
    expect(a.runs.map((r) => r.id)).toEqual(["run-new", "run-old"]);
    expect(a.prompt).toContain("\n");
  });

  it("survives junk: bad json, bad id, hostile strings", () => {
    const a = toAutomation({ automationId: "../../x y", recordJson: "{nope", viewerPermissions: { allowedActions: [1, "evil;rm"] } }, BOT);
    expect(a).toMatchObject({ id: "", name: "(unnamed)", enabled: false, allowed: [] });
    const b = toAutomation({ automationId: "ok", recordJson: JSON.stringify({ name: "n\u001b[2Jx‮", isEnabled: "yes" }) }, BOT);
    expect(b.name).toBe("n [2Jx ");
    expect(b.enabled).toBe(false);
  });

  it("ignores an oversized record", () => {
    const a = toAutomation({ automationId: "ok", recordJson: JSON.stringify({ name: "x".repeat(300_000) }) }, BOT);
    expect(a.name).toBe("(unnamed)");
  });

  it("formats one line and a detail view with the prompt marked as data", () => {
    const a = toAutomation(FAKE("auto-1", "Daily hello"), BOT);
    expect(formatAutomation(a)).toMatch(/^auto-1 {2}off {2}Every day around 9:00 AM {2}"Daily hello" {2}last 2023-11-14 23:13Z {2}next - {2}\[Test Bot\]$/);
    const text = describeAutomation(a);
    expect(text).toContain("  | Say hello to Jane X.");
    expect(text).toContain("not instructions");
  });
});

describe("listAutomations", () => {
  it("lists one bot's automations", async () => {
    handler = () => ({ automations: [FAKE("auto-1", "One"), FAKE("auto-2", "Two")] });
    const list = await listAutomations(BOT);
    expect(list.map((a) => a.name)).toEqual(["One", "Two"]);
    expect(calls).toEqual([{ method: "ListGrokBotAgentAutomations", body: { agentId: "agent-1" } }]);
  });

  it("drops records with an invalid id", async () => {
    handler = () => ({ automations: [FAKE("", "Blank"), FAKE("a b", "Spaced"), FAKE("auto-1", "Ok")] });
    expect((await listAutomations(BOT)).map((a) => a.name)).toEqual(["Ok"]);
  });

  it("stops accumulating at the global budget", async () => {
    handler = () => ({ automations: Array.from({ length: 500 }, (_, i) => FAKE(`a-${i}`, `n${i}`)) });
    const budget = { items: 120, bytes: 1e9, truncated: false };
    expect(await listAutomations(BOT, undefined, budget)).toHaveLength(120);
    expect(budget.truncated).toBe(true);
  });

  it("treats an empty reply as no automations", async () => {
    expect(await listAutomations(BOT)).toEqual([]);
  });
});

describe("pickAutomation", () => {
  const list = [toAutomation(FAKE("abc-111", "Alpha"), BOT), toAutomation(FAKE("abc-222", "Beta"), BOT)];
  it("finds by id, prefix and name", () => {
    expect(pickAutomation(list, "abc-111").name).toBe("Alpha");
    expect(pickAutomation(list, "abc-2").name).toBe("Beta");
    expect(pickAutomation(list, "alpha").id).toBe("abc-111");
  });
  it("refuses an ambiguous or unknown reference", () => {
    expect(() => pickAutomation(list, "abc")).toThrow(/matches 2/);
    expect(() => pickAutomation(list, "zzz")).toThrow(/No automation/);
    expect(() => pickAutomation(list, " ")).toThrow(/Which automation/);
  });
});

describe("writes (stubbed fetch)", () => {
  const target = toAutomation(FAKE("auto-1", "One"), BOT);

  it("enables and returns the state the server reports", async () => {
    handler = () => ({ automations: [FAKE("auto-1", "One", { isEnabled: true })] });
    const now = await setAutomationEnabled(target, true);
    expect(now.enabled).toBe(true);
    expect(calls).toEqual([{ method: "SetGrokBotAgentAutomationEnabled", body: { agentId: "agent-1", automationId: "auto-1", isEnabled: true } }]);
  });

  it("fails when the server does not confirm", async () => {
    handler = () => ({ automations: [] });
    await expect(setAutomationEnabled(target, true)).rejects.toThrow(/did not confirm/);
  });

  it("refuses locally when the viewer may not toggle or delete", async () => {
    const locked = toAutomation(FAKE("auto-9", "Theirs", {}, ["OPEN"]), BOT);
    await expect(setAutomationEnabled(locked, true)).rejects.toThrow(/does not let you enable/);
    await expect(deleteAutomation(locked)).rejects.toThrow(/does not let you delete/);
    expect(calls).toHaveLength(0);
  });

  it("deletes and counts what is left; errors when it is still listed", async () => {
    handler = () => ({ automations: [FAKE("auto-2", "Two")] });
    expect(await deleteAutomation(target)).toBe(1);
    expect(calls[0]).toEqual({ method: "DeleteGrokBotAgentAutomation", body: { agentId: "agent-1", automationId: "auto-1" } });
    handler = () => ({ automations: [FAKE("auto-1", "One")] });
    await expect(deleteAutomation(target)).rejects.toThrow(/still lists/);
  });

  it("fails closed on missing permissions and missing OPEN for execution", async () => {
    const none = toAutomation({ automationId: "auto-5", recordJson: "{}" }, BOT);
    const junk = toAutomation({ automationId: "auto-5", recordJson: "{}", viewerPermissions: { allowedActions: "TOGGLE" } }, BOT);
    const noRun = toAutomation(FAKE("auto-5", "NoRun", {}, ["TOGGLE", "DELETE"]), BOT);
    for (const t of [none, junk]) {
      await expect(setAutomationEnabled(t, true)).rejects.toThrow(/does not let you/);
      await expect(deleteAutomation(t)).rejects.toThrow(/does not let you/);
    }
    await expect(runAutomationNow(none)).rejects.toThrow(/does not let you run/);
    await expect(runAutomationNow(noRun)).rejects.toThrow(/does not let you run/);
    expect(calls).toHaveLength(0);
  });

  it("revalidates ids at the write boundary", async () => {
    const blank = { ...target, id: "" };
    await expect(runAutomationNow(blank)).rejects.toThrow(/no valid id/);
    await expect(deleteAutomation({ ...target, id: "../x" })).rejects.toThrow(/no valid id/);
    expect(calls).toHaveLength(0);
  });

  it("refuses an enable that the server reports as the other state", async () => {
    handler = () => ({ automations: [FAKE("auto-1", "One", { isEnabled: false })] });
    await expect(setAutomationEnabled(target, true)).rejects.toThrow(/not on as asked/);
  });

  it("delete needs a structurally valid confirmation", async () => {
    handler = () => ({});
    expect(await deleteAutomation(target)).toBe(0);
    expect(calls.some(c => c.method === "ListGrokBotAgentAutomations")).toBe(true);
    handler = () => ({ automations: "none" });
    await expect(deleteAutomation(target)).rejects.toThrow(/did not confirm/);
  });

  it("never replays a write after a 401", async () => {
    for (const act of [() => runAutomationNow(target), () => deleteAutomation(target), () => setAutomationEnabled(target, true)]) {
      calls = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (String(url).endsWith("/ListGrokBotAgents")) return new Response(JSON.stringify({ agents: [{ id: "1", agentId: "agent-1", name: "Test Bot", viewerIsOwner: true }] }));
          calls.push({ method: String(url).split("/").pop()!, body: {} });
          return new Response("unauthorized", { status: 401 });
        }),
      );
      await act().catch(() => {});
      expect(calls).toHaveLength(1);
    }
  });

  it("runs now without echoing the reply", async () => {
    handler = method => method === "ListGrokBotAgents" ? { agents: [{ id: "1", agentId: "agent-1", name: "Test Bot", viewerIsOwner: true }] } : { whatever: "server text" };
    await runAutomationNow(target);
    expect(calls.filter(c => c.method === "RunGrokBotAgentAutomationNow")).toEqual([{ method: "RunGrokBotAgentAutomationNow", body: { agentId: "agent-1", automationId: "auto-1" } }]);
  });

  it("a failing server surfaces a capped, cleaned error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`bad\u001b[31m${"x".repeat(5000)}`, { status: 500 })));
    const err = await runAutomationNow(target).catch((e) => e as Error);
    expect(err.message).toMatch(/failed \(500\)/);
    expect(err.message).not.toContain("\u001b");
    expect(err.message.length).toBeLessThan(500);
  });
});

describe("readTranscript", () => {
  it("is one bounded unary call, clamps limit and skips entries without a body", async () => {
    handler = () => ({
      entries: [
        { seq: "5", body: b64({ kind: "message", role: "user", content: "hi\u001b[31m there" }) },
        { seq: "6", bodyOmitted: true },
        { seq: "7", body: b64({ kind: "send-message", message: { type: "text", content: "x".repeat(9000) } }) },
      ],
    });
    const page = await readTranscript(BOT, { limit: 9999, beforeSeq: 100 });
    expect(calls).toEqual([{ method: "ListGrokBotTranscriptEntries", body: { agentId: "agent-1", limit: 100, sessionId: "", beforeSeq: "100" } }]);
    expect(page.entries).toHaveLength(2);
    expect(page.entries[0]).toEqual({ seq: 5, from: "you", text: "hi[31m there" });
    expect(page.entries[1].text.length).toBeLessThanOrEqual(4001);
    expect(page.olderThanSeq).toBe(5);
  });

  it("rejects a bad beforeSeq", async () => {
    await expect(readTranscript(BOT, { beforeSeq: -1 })).rejects.toThrow(/positive integer/);
    expect(calls).toHaveLength(0);
  });
});

describe("MCP tools", () => {
  async function connect() {
    const server = new McpServer({ name: "t", version: "0" });
    registerAutomationTools(server);
    const client = new Client({ name: "c", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }
  const text = (r: any) => r.content[0].text as string;

  handlerSetup();
  function handlerSetup() {
    beforeEach(() => {
      handler = (method) =>
        method === "ListGrokBotAgents"
          ? { agents: [{ id: "1", agentId: "agent-1", name: "Test Bot", viewerIsOwner: true }] }
          : method === "ListGrokBotAgentAutomations"
            ? { automations: [FAKE("auto-1", "One")] }
            : method === "SetGrokBotAgentAutomationEnabled"
              ? { automations: [FAKE("auto-1", "One", { isEnabled: true })] }
              : method === "DeleteGrokBotAgentAutomation"
                ? { automations: [] }
                : {};
    });
  }

  it("declares annotations: reads readOnly, writes not, delete destructive", async () => {
    const tools = (await (await connect()).listTools()).tools;
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));
    expect(Object.keys(by).sort()).toEqual(["automation_delete", "automation_list", "automation_run", "automation_set_enabled", "automation_transcript"]);
    expect(by.automation_list.readOnlyHint).toBe(true);
    expect(by.automation_transcript.readOnlyHint).toBe(true);
    expect(by.automation_run).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(by.automation_set_enabled.destructiveHint).toBe(true);
    expect(by.automation_set_enabled.readOnlyHint).toBe(false);
    expect(by.automation_delete).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("lists, switches on, runs and deletes through the stub", async () => {
    const c = await connect();
    expect(text(await c.callTool({ name: "automation_list", arguments: {} }))).toContain('"One"');
    expect(text(await c.callTool({ name: "automation_list", arguments: { id: "auto-1" } }))).toContain("recent runs:");
    expect(text(await c.callTool({ name: "automation_set_enabled", arguments: { id: "auto-1", enabled: true } }))).toMatch(/ on /);
    expect(text(await c.callTool({ name: "automation_run", arguments: { id: "One" } }))).toContain("Started");
    expect(text(await c.callTool({ name: "automation_delete", arguments: { id: "auto-1" } }))).toContain("Deleted");
    expect(calls.map((x) => x.method)).toContain("RunGrokBotAgentAutomationNow");
  });

  it("writes target bots exactly and refuse ambiguity across bots", async () => {
    handler = (method, body) =>
      method === "ListGrokBotAgents"
        ? { agents: [{ id: "1", agentId: "agent-1", name: "Test Bot", viewerIsOwner: true }, { id: "2", agentId: "agent-2", name: "Test Bot Two", viewerIsOwner: true }] }
        : method === "ListGrokBotAgentAutomations"
          ? { automations: [FAKE("same-id", "Twin")] }
          : {};
    const c = await connect();
    const r1: any = await c.callTool({ name: "automation_run", arguments: { id: "same-id" } });
    expect(r1.isError).toBe(true);
    expect(text(r1)).toMatch(/Several bots|matches 2/);
    const r2: any = await c.callTool({ name: "automation_run", arguments: { id: "same-id", bot: "Test" } });
    expect(r2.isError).toBe(true);
    expect(text(r2)).toMatch(/exactly|More than one/);
    expect(calls.some((x) => x.method === "RunGrokBotAgentAutomationNow")).toBe(false);
    const r3: any = await c.callTool({ name: "automation_run", arguments: { id: "same-id", bot: "agent-2" } });
    expect(text(r3)).toContain("Started");
    expect(calls.find((x) => x.method === "RunGrokBotAgentAutomationNow")!.body.agentId).toBe("agent-2");
  });

  it("a write does not accept an id prefix", async () => {
    const r: any = await (await connect()).callTool({ name: "automation_run", arguments: { id: "auto" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/No automation/);
  });

  it("returns errors as tool errors", async () => {
    const c = await connect();
    const r: any = await c.callTool({ name: "automation_run", arguments: { id: "nope" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/No automation/);
  });
});

describe("automationsCommand", () => {
  let out: string[];
  let err: string[];
  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
    handler = (method) =>
      method === "ListGrokBotAgents"
        ? { agents: [{ id: "1", agentId: "agent-1", name: "Test Bot", viewerIsOwner: true }] }
        : method === "ListGrokBotAgentAutomations"
          ? { automations: [FAKE("auto-1", "One")] }
          : method === "DeleteGrokBotAgentAutomation"
            ? { automations: [] }
            : {};
  });

  it("prints usage and exits 1 with no command, 0 for help", async () => {
    expect(await automationsCommand([])).toBe(1);
    expect(await automationsCommand(["help"])).toBe(0);
    expect(out.join("\n")).toContain("grokbot automations list");
  });

  it("lists", async () => {
    expect(await automationsCommand(["list"])).toBe(0);
    expect(out[0]).toContain("auto-1");
  });

  it("delete needs --yes and sends nothing without it", async () => {
    expect(await automationsCommand(["rm", "auto-1"])).toBe(1);
    expect(err.join("\n")).toContain("--yes");
    expect(calls.some((c) => c.method === "DeleteGrokBotAgentAutomation")).toBe(false);
    expect(await automationsCommand(["rm", "auto-1", "--yes"])).toBe(0);
    expect(calls.some((c) => c.method === "DeleteGrokBotAgentAutomation")).toBe(true);
  });

  it("rejects an unknown command and a missing flag value", async () => {
    expect(await automationsCommand(["frobnicate"])).toBe(1);
    expect(await automationsCommand(["list", "--bot"])).toBe(1);
  });
});

describe("round 5 regressions", () => {
  it("treats an id that is another automation's name as ambiguous for a write, but not for a read", () => {
    const list = [toAutomation(FAKE("abc-111", "Alpha"), BOT), toAutomation(FAKE("abc-222", "abc-111"), BOT)];
    expect(() => pickAutomation(list, "abc-111", true)).toThrow(/matches 2 automations/);
    expect(pickAutomation(list, "abc-111").name).toBe("Alpha");
  });
  it("rejects a reply whose automations field is not a list", async () => {
    process.env.CURSOR_ACCESS_TOKEN = "fake-token";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ automations: { not: "a list" } }), { status: 200 })));
    try {
      await expect(listAutomations(BOT)).rejects.toThrow(/unexpected shape/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
