import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteBot, listManagedBots, manageCommand, registerManageTools, startFreshConversation, updateBot, updateBody } from "./manage.js";

const AGENTS = [
  { id: 101, agentId: "uuid-aaa", name: "Test Bot", description: "fake", viewerIsOwner: true },
  { id: "202", agentId: "uuid-bbb", name: "Other\u001b[31m Bot", description: "x", viewerIsOwner: false, viewerCanManage: false },
  { agentId: "uuid-ccc", name: "No Id Bot", viewerIsOwner: true },
  { id: 404, agentId: "uuid-ddd", name: "Unknown Owner Bot" },
];

let calls: { method: string; body: any }[];

beforeEach(() => {
  process.env.CURSOR_ACCESS_TOKEN = "fake-token";
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      const method = String(url).split("/").pop() as string;
      calls.push({ method, body: JSON.parse(init.body) });
      const out = method === "ListGrokBotAgents" ? { agents: AGENTS } : method === "UpdateGrokBotAgent" ? { agent: { name: "New\nName" } } : {};
      return new Response(JSON.stringify(out), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const writes = () => calls.filter((c) => c.method !== "ListGrokBotAgents");

describe("updateBody", () => {
  it("sends only the given fields with partialUpdate", () => {
    expect(updateBody("x", { name: " New " })).toEqual({ id: "x", partialUpdate: true, name: "New" });
  });
  it("rejects empty changes, empty names, control characters and long text", () => {
    expect(() => updateBody("x", {})).toThrow(/Nothing to change/);
    expect(() => updateBody("x", { name: "  " })).toThrow(/empty/);
    expect(() => updateBody("x", { name: "a\nb" })).toThrow(/Control/);
    expect(() => updateBody("x", { description: "a\u001bb" })).toThrow(/Control/);
    expect(() => updateBody("x", { description: "x".repeat(2001) })).toThrow(/longer/);
  });
  it("allows newlines in a description", () => {
    expect(updateBody("x", { description: "a\nb" }).description).toBe("a\nb");
  });
});

describe("management calls", () => {
  it("lists bots with cleaned names", async () => {
    const bots = await listManagedBots();
    expect(bots[1].name).toBe("Other [31m Bot");
    expect(bots[1].canManage).toBe(false);
  });

  it("updates by name using the bot's id and cleans the shown reply", async () => {
    const r = await updateBot("Test Bot", { name: "New Name" });
    expect(writes()).toEqual([{ method: "UpdateGrokBotAgent", body: { id: "101", partialUpdate: true, name: "New Name" } }]);
    expect(r.name).toBe("New Name");
  });

  it("refuses to update a bot the user cannot manage, without a write", async () => {
    await expect(updateBot("202", { name: "X" })).rejects.toThrow(/not yours/);
    expect(writes()).toEqual([]);
  });

  it("deletes only by exact id", async () => {
    await expect(deleteBot("Test Bot")).rejects.toThrow(/exact id/);
    await expect(deleteBot("nope")).rejects.toThrow(/No bot with id/);
    await expect(deleteBot("")).rejects.toThrow(/exact id/);
    expect(writes()).toEqual([]);
    expect(await deleteBot("101")).toEqual({ id: "101", name: "Test Bot" });
    expect(writes()).toEqual([{ method: "DeleteGrokBotAgent", body: { id: "101" } }]);
  });

  it("refuses to delete a bot it cannot manage", async () => {
    await expect(deleteBot("202")).rejects.toThrow(/not yours/);
    expect(writes()).toEqual([]);
  });

  it("keeps numeric ids and never falls back from id to the agent UUID", async () => {
    const bots = await listManagedBots();
    expect(bots[0]).toMatchObject({ id: "101", agentId: "uuid-aaa" });
    expect(bots[2]).toMatchObject({ id: "", agentId: "uuid-ccc" });
    await expect(updateBot("No Id Bot", { name: "X" })).rejects.toThrow(/no id/);
    await expect(deleteBot("uuid-ccc")).rejects.toThrow(/no id/);
    expect(writes()).toEqual([]);
  });

  it("treats missing ownership information as not manageable", async () => {
    expect((await listManagedBots())[3].canManage).toBe(false);
    await expect(updateBot("Unknown Owner Bot", { name: "X" })).rejects.toThrow(/not yours/);
    await expect(deleteBot("404")).rejects.toThrow(/not yours/);
    expect(writes()).toEqual([]);
  });

  it("targets exact names or ids only: no prefix, no default", async () => {
    await expect(updateBot("test", { name: "X" })).rejects.toThrow(/No bot has exactly/);
    await expect(updateBot("", { name: "X" })).rejects.toThrow(/Name the bot/);
    await expect(startFreshConversation("Test")).rejects.toThrow(/No bot has exactly/);
    expect(writes()).toEqual([]);
  });

  it("never lets a write be replayed after a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        const method = String(url).split("/").pop() as string;
        calls.push({ method, body: JSON.parse(init.body) });
        return method === "ListGrokBotAgents" ? new Response(JSON.stringify({ agents: AGENTS }), { status: 200 }) : new Response("no", { status: 401 });
      }),
    );
    await expect(deleteBot("101")).rejects.toThrow(/401/);
    await expect(startFreshConversation("Test Bot")).rejects.toThrow(/401/);
    await expect(updateBot("Test Bot", { name: "X" })).rejects.toThrow(/401/);
    expect(writes().map((c) => c.method)).toEqual(["DeleteGrokBotAgent", "StartFreshGrokBotConversation", "UpdateGrokBotAgent"]);
  });

  it("starts a fresh conversation", async () => {
    expect(await startFreshConversation("Test Bot")).toEqual({ name: "Test Bot" });
    expect(writes()).toEqual([{ method: "StartFreshGrokBotConversation", body: { agentId: "uuid-aaa" } }]);
  });
});

describe("manageCommand", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("rm needs --yes and an id", async () => {
    expect(await manageCommand(["rm", "101"])).toBe(1);
    expect(await manageCommand(["rm", "--yes"])).toBe(1);
    expect(calls).toEqual([]);
    expect(await manageCommand(["rm", "101", "--yes"])).toBe(0);
    expect(writes().map((c) => c.method)).toEqual(["DeleteGrokBotAgent"]);
  });

  it("update and fresh work; unknown options and commands fail", async () => {
    expect(await manageCommand(["update", "Test Bot", "--name", "Renamed"])).toBe(0);
    expect(await manageCommand(["fresh", "Test Bot"])).toBe(0);
    expect(await manageCommand(["update", "test", "--bogus", "1"])).toBe(1);
    expect(await manageCommand(["update", "test"])).toBe(1);
    expect(await manageCommand(["nope"])).toBe(1);
    expect(writes().map((c) => c.method)).toEqual(["UpdateGrokBotAgent", "StartFreshGrokBotConversation"]);
  });
});

describe("registerManageTools", () => {
  it("registers the three tools, delete marked destructive", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerManageTools(server);
    const client = new Client({ name: "c", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["bot_delete", "bot_fresh_conversation", "bot_update"]);
    for (const t of tools) expect(t.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "bot_delete")?.description).not.toMatch(/from bot_list/);
    const long = await client.callTool({ name: "bot_update", arguments: { bot: "x".repeat(500), name: "n" } });
    expect(long.isError).toBe(true);

    const bad = await client.callTool({ name: "bot_delete", arguments: { id: "nope" } });
    expect(bad.isError).toBe(true);
    const ok = await client.callTool({ name: "bot_update", arguments: { bot: "Test Bot", public_description: "hello" } });
    expect(ok.isError).toBeFalsy();
    expect(writes().at(-1)?.body).toEqual({ id: "101", partialUpdate: true, publicDescription: "hello" });
  });
});

describe("round 4 regressions", () => {
  it("does not take a NUL-prefixed index for a bot", async () => {
    await expect(updateBot("\u00000", { name: "Hijack" })).rejects.toThrow(/No bot has exactly/);
    expect(writes()).toEqual([]);
  });
  it("refuses a reference that is one bot's id and another bot's name", async () => {
    const saved = AGENTS.slice();
    AGENTS.push({ id: 505, agentId: "uuid-eee", name: "uuid-aaa", description: "x", viewerIsOwner: true } as (typeof AGENTS)[number]);
    try {
      await expect(updateBot("uuid-aaa", { name: "X" })).rejects.toThrow(/More than one bot/);
      expect(writes()).toEqual([]);
    } finally {
      AGENTS.splice(0, AGENTS.length, ...saved);
    }
  });
  it("accepts only a numeric id as the id of the update and delete calls", async () => {
    AGENTS.push({ id: "-1", agentId: "uuid-fff", name: "Odd Id Bot", viewerIsOwner: true } as (typeof AGENTS)[number]);
    try {
      await expect(updateBot("Odd Id Bot", { name: "X" })).rejects.toThrow(/no id/);
      expect(writes()).toEqual([]);
    } finally {
      AGENTS.pop();
    }
  });
});

describe("round 5 regressions", () => {
  it("refuses a write when the account has more bots than one list shows", async () => {
    const saved = AGENTS.slice();
    for (let i = 0; i < 500; i++) AGENTS.push({ id: 1000 + i, agentId: `uuid-x${i}`, name: `Filler ${i}`, viewerIsOwner: true } as (typeof AGENTS)[number]);
    try {
      await expect(updateBot("Test Bot", { name: "X" })).rejects.toThrow(/too many bots/);
      expect(writes()).toEqual([]);
    } finally {
      AGENTS.splice(0, AGENTS.length, ...saved);
    }
  });
});
