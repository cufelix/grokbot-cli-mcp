import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { botInfo, botOverview, doctor, inspectionCommand, registerInspectionTools, summarizeBotState } from "./inspection.js";
import { listManagedBots } from "./manage.js";
import { botCommand } from "./bot-cli.js";

const SENTINEL = "NEVER_RETURN_THIS_VALUE";
const rawBot = { id: "101", agentId: "uuid-1", name: "Personal Bot", harness: "temporal", kind: "GROK_BOT_AGENT_KIND_AGENT", visibility: "GROK_BOT_AGENT_VISIBILITY_OWNER", viewerIsOwner: true };
const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64");
let calls: { method: string; body: any }[];
let respond: (method: string, body: any) => unknown;
beforeEach(() => {
  vi.stubEnv("CURSOR_ACCESS_TOKEN", "test-only");
  calls = [];
  respond = method => method === "ListGrokBotAgents" ? { agents: [rawBot] }
    : method === "ListGrokBotAgentStatuses" ? { statuses: [{ agentId: "uuid-1", client: {}, live: { isRunning: false } }] }
    : method === "ListGrokBotAgentSkills" ? { skills: [{ id: "s1", name: "existing", body: SENTINEL, source: "recipe" }] }
    : method === "ListGrokBotVaultCredentials" ? { credentials: [{ id: "v1", kind: 1, password: SENTINEL, username: SENTINEL }] }
    : method === "ListGrokBotUserFormVaultEntries" ? { entries: [{ entryId: "f1", value: SENTINEL }] } : {};
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const method = String(url).split("/").pop()!, body = JSON.parse(String(init.body));
    calls.push({ method, body });
    return new Response(JSON.stringify(respond(method, body)));
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("bot metadata and ids", () => {
  it("exposes both ids and known capability restrictions without credentials", async () => {
    const info = await botInfo("101");
    expect(info).toMatchObject({ id: "101", agentId: "uuid-1", capabilities: { namedSecrets: false, resetConversation: false } });
    expect(JSON.stringify(info)).not.toContain(SENTINEL);
  });
  it("does not guess ambiguous numeric ids and names", async () => {
    respond = () => ({ agents: [rawBot, { ...rawBot, id: "102", agentId: "uuid-2", name: "101" }] });
    await expect(botInfo("101")).rejects.toThrow(/More than one/);
  });
  it("prints parseable JSON ids in the actual bot list CLI", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await botCommand(["list", "--ids", "--json"])).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject([{ id: "101", agentId: "uuid-1" }]);
    const before = calls.length;
    expect(await botCommand(["list", "--bogus"])).toBe(1);
    expect(calls).toHaveLength(before);
  });
});

describe("unified status", () => {
  it("classifies all requested states using structured data", async () => {
    const bot = (await listManagedBots())[0];
    const state = (status: unknown, entries: unknown[] = []) => summarizeBotState(bot, status, entries).state;
    expect(state({ live: { isRunning: true } })).toBe("running");
    expect(state({ live: { hasRunningSubagents: true } })).toBe("running");
    expect(state({ live: { isRunning: false } })).toBe("idle");
    expect(state({ live: { lastTurnSettlement: { outcome: "error" } } })).toBe("error");
    expect(state(undefined)).toBe("unknown");
    const request = { seq: "8", body: b64({ kind: "send-message", message: { type: "secret-request", secretRequest: { label: SENTINEL } } }) };
    expect(state({ live: { isRunning: true } }, [request])).toBe("waiting_for_secret");
    expect(state({}, [{ seq: "9", body: b64({ kind: "send-message", message: { type: "local-tool-permission", ask: { status: "pending" } } }) }])).toBe("waiting_for_approval");
    expect(state({ client: { lastActivityAtMs: "1" } }, [{ ...request, body: b64({ kind: "send-message", secretProvided: true, message: { type: "secret-request" } }) }])).toBe("idle");
  });
  it("does not infer failure from prose or retain a recovered structured failure", async () => {
    const bot = (await listManagedBots())[0];
    const entries = [{ seq: "1", body: b64({ kind: "run-error" }) }, { seq: "2", body: b64({ kind: "send-message", message: { type: "text", content: "error " + SENTINEL } }) }];
    expect(summarizeBotState(bot, { live: { lastTurnSettlement: { outcome: "success" } } }, entries).state).toBe("idle");
  });
  it("fetches live statuses once, bounds transcripts and omits all message content", async () => {
    const base = respond;
    respond = (method, body) => method === "ListGrokBotTranscriptEntries" ? { entries: [{ seq: "1", body: b64({ kind: "send-message", message: { type: "text", content: SENTINEL } }) }] } : base(method, body);
    expect(await botOverview()).toMatchObject([{ name: "Personal Bot", state: "idle" }]);
    const result = JSON.stringify(await botOverview());
    expect(result).not.toContain(SENTINEL);
    expect(calls.filter(c => c.method === "ListGrokBotTranscriptEntries").every(c => c.body.limit === 100)).toBe(true);
    expect(calls.every(c => c.method.startsWith("List"))).toBe(true);
  });
  it("marks partial or malformed evidence instead of reporting idle", async () => {
    const base = respond;
    respond = (method, body) => method === "ListGrokBotTranscriptEntries" ? { entries: "broken" } : base(method, body);
    expect(await botOverview()).toMatchObject([{ state: "unknown", issues: ["Pending requests could not be read."] }]);
    respond = (method, body) => method === "ListGrokBotAgentStatuses" ? { statuses: [{ agentId: "uuid-1" }, { agentId: "uuid-1" }] } : base(method, body);
    expect(await botOverview()).toMatchObject([{ state: "unknown" }]);
  });
  it("treats corrupt bodies, malformed live state and unknown outcomes as unknown", async () => {
    const bot = (await listManagedBots())[0];
    expect(summarizeBotState(bot, { live: { isRunning: false } }, [{ seq: "1", body: "not-base64-json" }]).state).toBe("unknown");
    expect(summarizeBotState(bot, { live: "broken" }, []).state).toBe("unknown");
    expect(summarizeBotState(bot, { live: { lastTurnSettlement: { outcome: "new-outcome" } } }, []).state).toBe("unknown");
    expect(summarizeBotState(bot, { unrelated: true }, []).state).toBe("unknown");
    expect(summarizeBotState(bot, { live: { isRunning: false, awaiting: { reason: 17 } } }, []).state).toBe("unknown");
    expect(summarizeBotState(bot, { live: { isRunning: false, awaiting: {} } }, []).state).toBe("unknown");
    expect(summarizeBotState(bot, { live: { isComposingMessage: true } }, []).state).toBe("running");
    expect(summarizeBotState(bot, { live: { isRetrying: true } }, []).state).toBe("running");
  });
  it("recognizes pending approvals used by the installed app, including resolved states", async () => {
    const bot = (await listManagedBots())[0];
    for (const type of ["auto-review-approval", "meeting-join-consent", "cookie-origin-approval", "virtual-card-approval", "connector-grant", "local-tool-permission"]) {
      const key = ["connector-grant", "local-tool-permission"].includes(type) ? "ask" : "approval";
      const entry = status => ({ seq: "1", body: b64({ kind: "send-message", message: { type, [key]: { status } } }) });
      expect(summarizeBotState(bot, { isRunning: false }, [entry("pending")]).state, type).toBe("waiting_for_approval");
      expect(summarizeBotState(bot, { isRunning: false }, [entry("allowed")]).state, type).toBe("idle");
    }
  });
});

describe("doctor", () => {
  it("checks required skills and counts without returning values or writing", async () => {
    const r = await doctor({ bot: "Personal Bot", requiredSkills: ["existing", "missing"] });
    expect(r.ok).toBe(false);
    expect(r.checks).toContainEqual(expect.objectContaining({ code: "required_skill", level: "error", message: expect.stringContaining("missing") }));
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
    expect(calls.every(c => c.method.startsWith("List"))).toBe(true);
  });
  it("reports auth/transport failures using local text only", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(SENTINEL); }));
    const r = await doctor();
    expect(r.ok).toBe(false);
    expect(r.checks[0].code).toBe("connection");
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });
  it("does not turn malformed skill responses into a missing skill result", async () => {
    const base = respond;
    respond = (method, body) => method === "ListGrokBotAgentSkills" ? { skills: "broken" } : base(method, body);
    expect((await doctor()).checks).toContainEqual(expect.objectContaining({ code: "skills", level: "error" }));
  });
  it("emits valid JSON and meaningful exit codes; validates input before network", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await inspectionCommand("doctor", ["--bot", "101", "--require-skill", "existing", "--json"])).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0]).ok).toBe(true);
    expect(await inspectionCommand("doctor", ["--require-skill", "missing", "--json"])).toBe(1);
    const before = calls.length;
    expect(await inspectionCommand("status", ["--bogus"])).toBe(1);
    expect(await inspectionCommand("info", [])).toBe(1);
    expect(calls).toHaveLength(before);
  });
  it("exposes three read-only MCP tools and valid JSON", async () => {
    const server = new McpServer({ name: "test", version: "0" }); registerInspectionTools(server);
    const [left, right] = InMemoryTransport.createLinkedPair(), client = new Client({ name: "test", version: "0" });
    try {
      await Promise.all([server.connect(left), client.connect(right)]);
      const tools = (await client.listTools()).tools;
      expect(tools.map(t => t.name).sort()).toEqual(["bot_info", "bot_status", "grokbot_doctor"]);
      expect(tools.every(t => t.annotations?.readOnlyHint === true)).toBe(true);
      const r = await client.callTool({ name: "grokbot_doctor", arguments: { required_skills: ["existing"] } });
      expect(r.isError).not.toBe(true);
      expect(JSON.parse((r.content as { text: string }[])[0].text).ok).toBe(true);
    } finally { await client.close(); await server.close(); }
  });
});
