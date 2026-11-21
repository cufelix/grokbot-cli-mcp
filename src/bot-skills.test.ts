import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkSkillName, getSkill, listSkills, makeSkillPrivate, putSkill, registerSkillTools, removeSkill, SKILL_LIMITS, skillsCommand } from "./bot-skills.js";

interface Call {
  method: string;
  body: Record<string, unknown>;
}

let calls: Call[];
let skills: unknown[];
let privateReply: unknown;
let retry401: boolean;

beforeEach(() => {
  calls = [];
  privateReply = { skillId: "sk_new" };
  retry401 = false;
  skills = [
    { id: "sk_1", name: "demo-skill", description: "Fake demo\u001b[31m skill", body: "# Demo\nline two\u0007", source: "user" },
    { id: "sk_2", name: "plugin-skill", description: "From a fake plugin", body: "x".repeat(SKILL_LIMITS.body + 50), source: "plugin:fake" },
  ];
  process.env.CURSOR_ACCESS_TOKEN = "fake-token-for-tests";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      const method = String(url).split("/").pop() as string;
      const body = JSON.parse(init.body);
      calls.push({ method, body });
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (method === "ListGrokBotAgents") return json({ agents: [{ agentId: "agent-1", name: "Fake Bot" }] });
      if (method === "ListGrokBotAgentSkills") return json({ skills });
      if (!method.startsWith("List") && retry401) return new Response("no", { status: 401 });
      if (method === "MakeGrokBotAgentSkillPrivate") return json(privateReply);
      return json({});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const writes = () => calls.filter((c) => !c.method.startsWith("List"));

describe("bot skills", () => {
  it("lists skills with cleaned, capped text", async () => {
    const list = await listSkills("agent-1");
    expect(calls[0]).toEqual({ method: "ListGrokBotAgentSkills", body: { agentId: "agent-1" } });
    expect(list[0]).toMatchObject({ id: "sk_1", name: "demo-skill", source: "user", truncated: false });
    expect(list[0].description).not.toMatch(/\u001b/);
    expect(list[0].body).toBe("# Demo\nline two ");
    expect(list[1].truncated).toBe(true);
    expect(list[1].body.length).toBeLessThan(SKILL_LIMITS.body + 60);
  });

  it("gets one skill by name, case-insensitively, or fails", async () => {
    expect((await getSkill("agent-1", "DEMO-skill")).id).toBe("sk_1");
    await expect(getSkill("agent-1", "nope")).rejects.toThrow(/No skill named/);
  });

  it("replaces an existing skill with Update and adds a new one with Add", async () => {
    expect(await putSkill("agent-1", { name: "demo-skill", content: "new text", description: "d" })).toEqual({ name: "demo-skill", created: false });
    expect(await putSkill("agent-1", { name: "fresh-skill", content: "text" })).toEqual({ name: "fresh-skill", created: true });
    expect(writes()).toEqual([
      { method: "UpdateGrokBotAgentSkill", body: { agentId: "agent-1", name: "demo-skill", content: "new text", description: "d" } },
      { method: "AddGrokBotAgentSkill", body: { agentId: "agent-1", name: "fresh-skill", content: "text" } },
    ]);
  });

  it("refuses bad names, empty or oversized content before any call", async () => {
    expect(() => checkSkillName("../etc")).toThrow(/not a skill name/);
    await expect(putSkill("agent-1", { name: "ok", content: "  " })).rejects.toThrow(/content/);
    await expect(putSkill("agent-1", { name: "ok", content: "x".repeat(SKILL_LIMITS.body + 1) })).rejects.toThrow(/longer than/);
    await expect(putSkill("agent-1", { name: "ok", content: "a", description: "bad\nline" })).rejects.toThrow(/description/);
    await expect(removeSkill("bad id!", "ok")).rejects.toThrow(/Which bot/);
    expect(calls).toEqual([]);
  });

  it("removes a skill and makes one private", async () => {
    await removeSkill("agent-1", "demo-skill");
    expect(await makeSkillPrivate("agent-1", "plugin-skill")).toBe("sk_new");
    expect(writes()).toEqual([
      { method: "RemoveGrokBotAgentSkill", body: { agentId: "agent-1", name: "demo-skill" } },
      { method: "MakeGrokBotAgentSkillPrivate", body: { agentId: "agent-1", name: "plugin-skill" } },
    ]);
  });

  it("fails when making private returns no skill id", async () => {
    privateReply = {};
    await expect(makeSkillPrivate("agent-1", "plugin-skill")).rejects.toThrow(/did not confirm/);
  });

  it("does not replay writes after a 401", async () => {
    retry401 = true;
    await expect(removeSkill("agent-1", "demo-skill")).rejects.toThrow(/401/);
    await expect(makeSkillPrivate("agent-1", "plugin-skill")).rejects.toThrow(/401/);
    expect(writes().map((c) => c.method)).toEqual(["RemoveGrokBotAgentSkill", "MakeGrokBotAgentSkillPrivate"]);
  });

  it("reads a skill file with one open: refuses symlinks, directories and big files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-test-"));
    writeFileSync(join(dir, "ok.md"), "hello skill");
    writeFileSync(join(dir, "big.md"), "x".repeat(SKILL_LIMITS.body * 4 + 1));
    symlinkSync(join(dir, "ok.md"), join(dir, "link.md"));
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await skillsCommand(["put", "s", "--bot", "Fake Bot", "--file", join(dir, "ok.md")])).toBe(0);
    expect(writes().at(-1)?.body).toMatchObject({ content: "hello skill" });
    const n = writes().length;
    for (const f of ["link.md", "big.md", "."]) expect(await skillsCommand(["put", "s", "--bot", "Fake Bot", "--file", join(dir, f)])).toBe(1);
    expect(writes().length).toBe(n);
    err.mockRestore();
    vi.restoreAllMocks();
  });

  it("CLI writes need an exact --bot", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await skillsCommand(["rm", "demo-skill"])).toBe(1);
    expect(await skillsCommand(["rm", "demo-skill", "--bot", "fak"])).toBe(1);
    expect(writes()).toEqual([]);
    err.mockRestore();
  });

  it("registers the four tools with the right hints and runs them", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerSkillTools(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.annotations]));
    expect(Object.keys(tools).sort()).toEqual(["bot_skill_make_private", "bot_skill_put", "bot_skill_remove", "bot_skills_list"]);
    expect(tools.bot_skills_list).toMatchObject({ readOnlyHint: true });
    for (const n of ["bot_skill_put", "bot_skill_remove", "bot_skill_make_private"]) expect(tools[n]).toMatchObject({ destructiveHint: true });

    const list = (await client.callTool({ name: "bot_skills_list", arguments: {} })) as { content: { text: string }[] };
    expect(list.content[0].text).toMatch(/Fake Bot has 2 skills/);
    const one = (await client.callTool({ name: "bot_skills_list", arguments: { name: "demo-skill" } })) as { content: { text: string }[] };
    expect(one.content[0].text).toMatch(/^UNTRUSTED DATA/);
    expect(one.content[0].text).toContain("# Demo\nline two");
    expect((await client.listTools()).tools.find((t) => t.name === "bot_skills_list")?.description).toMatch(/UNTRUSTED/);
    const noBot = (await client.callTool({ name: "bot_skill_remove", arguments: { name: "demo-skill" } })) as { isError?: boolean };
    expect(noBot.isError).toBe(true);
    const prefix = (await client.callTool({ name: "bot_skill_remove", arguments: { bot: "Fake", name: "demo-skill" } })) as { isError?: boolean };
    expect(prefix.isError).toBe(true);
    expect(writes()).toEqual([]);
    const bad = (await client.callTool({ name: "bot_skill_remove", arguments: { bot: "Fake Bot", name: "no way" } })) as { isError?: boolean };
    expect(bad.isError).toBe(true);
    await client.callTool({ name: "bot_skill_remove", arguments: { bot: "Fake Bot", name: "demo-skill" } });
    expect(writes()).toEqual([{ method: "RemoveGrokBotAgentSkill", body: { agentId: "agent-1", name: "demo-skill" } }]);
  });

  it("CLI: list works, unknown commands and options return 1", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await skillsCommand(["list"])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toMatch(/demo-skill \[user\]/);
    expect(await skillsCommand(["rm", "demo-skill", "--bogus"])).toBe(1);
    expect(await skillsCommand(["put", "x"])).toBe(1);
    expect(await skillsCommand(["nonsense"])).toBe(1);
    expect(await skillsCommand([])).toBe(0);
    expect(writes()).toEqual([]);
    log.mockRestore();
    err.mockRestore();
  });
});
