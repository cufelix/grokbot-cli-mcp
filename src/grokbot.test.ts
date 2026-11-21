import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { botSlugs, parseEntries, pickBot, pickComputer, safeName, writeNew } from "./bots.js";
import { registerSkillSearch, SKILL_INDEX_LIMIT, searchSkills } from "./skills.js";
import { buildPrompt, canWrite, describeCursorTool, parseToolCalls, visibleText } from "./cursor.js";
import grokbotExtension, { isBareLogin, LOGIN_CHOICES } from "./extension.js";
import { ADMIN_TOOLS, type AgentEvent, agentArgs, attachable, createGrokMcpServer, formatAgentRun, saveDir, summarizeAgentEvents } from "./mcp.js";
import { browserCommand } from "./login.js";
import { configureEnv, DEFAULT_MODEL, seedDefaultModel } from "./setup.js";
import { isPrivateAddress, loadImage, outputPath, sniffImage } from "./xai.js";
import { checkSite, clean, createLogin, createLoginFromInbox, isSecretField, putFormEntry, readSecretFile, resolveSecret, vaultInbox } from "./vault.js";

const tmp = () => mkdtempSync(join(tmpdir(), "grokbot-test-"));

beforeAll(() => {
  // No credentials and no network: every test runs as a fresh, signed-out install.
  delete process.env.XAI_API_KEY;
  delete process.env.GROK_API_KEY;
  process.env.PI_CODING_AGENT_DIR = tmp();
  process.env.PI_OFFLINE = "1";
  // No Cursor login either: the bots provider must stay off without touching the network.
  delete process.env.CURSOR_ACCESS_TOKEN;
  process.env.GROKBOT_KEYCHAIN = "0";
  process.env.XDG_CONFIG_HOME = tmp();
});

describe("configureEnv", () => {
  it("defaults the agent dir, also when the variable is empty", () => {
    const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: "" };
    configureEnv(env);
    expect(env.PI_CODING_AGENT_DIR).toMatch(/[\\/]\.grokbot[\\/]agent$/);
  });

  it("keeps a user-set agent dir and maps GROK_API_KEY to XAI_API_KEY", () => {
    const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: "/x", GROK_API_KEY: "k" };
    configureEnv(env);
    expect(env).toMatchObject({ PI_CODING_AGENT_DIR: "/x", XAI_API_KEY: "k" });
  });

  it("does not override an explicit XAI_API_KEY", () => {
    const env: NodeJS.ProcessEnv = { GROK_API_KEY: "grok", XAI_API_KEY: "xai" };
    configureEnv(env);
    expect(env.XAI_API_KEY).toBe("xai");
  });
});

describe("seedDefaultModel", () => {
  const read = (dir: string) => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));

  it("makes Grok the default and keeps startup quiet on first run", () => {
    const dir = join(tmp(), "agent");
    seedDefaultModel(dir);
    expect(read(dir)).toEqual({ defaultProvider: "xai", defaultModel: DEFAULT_MODEL, quietStartup: "header" });
  });

  it("keeps other settings and never overrides a chosen model", () => {
    const dir = tmp();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "dark" }));
    seedDefaultModel(dir);
    expect(read(dir)).toEqual({ theme: "dark", defaultProvider: "xai", defaultModel: DEFAULT_MODEL, quietStartup: "header" });

    writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "anthropic", quietStartup: false }));
    seedDefaultModel(dir);
    expect(read(dir)).toEqual({ defaultProvider: "anthropic", quietStartup: false });
  });

  it("leaves an unparsable settings file untouched", () => {
    const dir = tmp();
    writeFileSync(join(dir, "settings.json"), "{ oops");
    seedDefaultModel(dir);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe("{ oops");
  });
});

describe("pi integration", () => {
  it("still ships the non-exported setupCli that cli.ts imports", async () => {
    const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
    expect(existsSync(fileURLToPath(new URL("./cli/setup.js", entry)))).toBe(true);
    const pi = await import("@earendil-works/pi-coding-agent");
    expect(typeof pi.main).toBe("function");
  });

  it("registers the Grok tools, the Cursor provider and a header", async () => {
    const tools: string[] = [];
    const events: string[] = [];
    const providers: string[] = [];
    const fakePi = {
      registerTool: (t: { name: string }) => tools.push(t.name),
      registerProvider: (name: string) => providers.push(name),
      on: (name: string) => events.push(name),
    };
    await grokbotExtension(fakePi as never);
    expect(tools).toEqual(["web_search", "x_search", "generate_image", "generate_video", "find_skill"]);
    expect(providers).toEqual(["cursor"]);
    expect(events).toContain("session_start");
  });
});

async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([createGrokMcpServer().connect(serverSide), client.connect(clientSide)]);
  return client;
}

describe("MCP server", () => {
  it("offers the tools that delete or act outward only with GROKBOT_MCP_ADMIN=1", async () => {
    const admin = [
      "automation_delete", "automation_run", "automation_set_enabled", "bot_delete", "bot_fresh_conversation",
      "bot_secret_delete", "bot_skill_make_private", "bot_skill_put", "bot_skill_remove", "bot_update",
      "vault_delete", "vault_form_delete",
    ];
    const names = async () => (await (await connect()).listTools()).tools.map((t) => t.name);
    expect((await names()).filter((n) => admin.includes(n))).toEqual([]);
    vi.stubEnv("GROKBOT_MCP_ADMIN", "1");
    try {
      const all = await names();
      for (const n of admin) expect(all).toContain(n);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("exposes the Grok tools", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "automation_list",
      "automation_transcript",
      "bot_computers",
      "bot_create",
      "bot_download",
      "bot_files",
      "bot_info",
      "bot_list",
      "bot_read",
      "bot_secret_put",
      "bot_secrets_list",
      "bot_send",
      "bot_skills_list",
      "bot_status",
      "bot_stop",
      "bot_submit_secret",
      "bot_wait",
      "grok_agent",
      "grok_ask",
      "grok_generate_image",
      "grok_generate_video",
      "grok_models",
      "grok_search_web",
      "grok_search_x",
      "grokbot_doctor",
      "vault_add_login",
      "vault_form_put",
      "vault_forms",
      "vault_list",
    ]);
  });

  it("marks grok_agent destructive so hosts ask before running it", async () => {
    const { tools } = await (await connect()).listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(byName.grok_agent).toMatchObject({ destructiveHint: true });
    expect(byName.grok_search_x).toMatchObject({ readOnlyHint: true });
    expect(byName.vault_list).toMatchObject({ readOnlyHint: true });
    expect(byName.vault_delete).toBeUndefined(); // admin only
  });

  it("refuses oversized JSON listings rather than returning clipped invalid JSON", async () => {
    vi.stubEnv("CURSOR_ACCESS_TOKEN", "test-only");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      agents: Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1), agentId: `uuid-${i}`, name: "n".repeat(100), description: "d".repeat(500), harness: "temporal", viewerIsOwner: true })),
    })));
    try {
      const client = await connect();
      try {
        const result = await client.callTool({ name: "bot_list", arguments: { json: true } });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("JSON output limit");
      } finally { await client.close(); }
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });

  it("annotates the admin-only tools as destructive when the switch is on", async () => {
    vi.stubEnv("GROKBOT_MCP_ADMIN", "1");
    try {
      const { tools } = await (await connect()).listTools();
      for (const t of tools.filter((t) => ADMIN_TOOLS.has(t.name))) expect(t.annotations, t.name).toMatchObject({ destructiveHint: true });
      expect(tools.filter((t) => ADMIN_TOOLS.has(t.name)).length).toBe(ADMIN_TOOLS.size);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("takes no password, env var or path in a vault tool's own arguments", async () => {
    const { tools } = await (await connect()).listTools();
    const add = tools.find((t) => t.name === "vault_add_login");
    // The password comes from ~/.grokbot/vault-inbox/<site>, which the user fills: a `password`, `password_env` or
    // path argument here would let the model see a secret, or send any local one (a Cursor token) to a host of its choice.
    expect(Object.keys(add?.inputSchema.properties ?? {}).sort()).toEqual(["notes", "site", "title", "username"]);
    const formPut = tools.find((t) => t.name === "vault_form_put");
    expect(Object.keys(formPut?.inputSchema.properties ?? {})).not.toContain("id");
  });

  it("restricts a read_only agent to read/search tools without MCP", () => {
    expect(agentArgs({ prompt: "-x", readOnly: true })).toEqual([
      "--mode",
      "json",
      "--tools",
      "read,grep,find,ls,web_search,x_search",
      "--no-mcp",
      "--",
      "-x",
    ]);
    expect(agentArgs({ prompt: "p", session: "s", model: "grok-4.3" })).toEqual([
      "--mode",
      "json",
      "--session",
      "s",
      "--provider",
      "xai",
      "--model",
      "grok-4.3",
      "--",
      "p",
    ]);
  });

  it("lists models without credentials", async () => {
    const res = await (await connect()).callTool({ name: "grok_models", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res.content)).toContain("grok-4");
  });

  it("returns a tool error, not a protocol error, when signed out", async () => {
    const res = await (await connect()).callTool({ name: "grok_ask", arguments: { prompt: "hi" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("No xAI credentials");
  });

  it("rejects a missing directory before calling xAI", async () => {
    process.env.XAI_API_KEY = "test";
    try {
      const res = await (await connect()).callTool({
        name: "grok_generate_image",
        arguments: { prompt: "cat", directory: join(tmp(), "nope") },
      });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain("Directory does not exist");
    } finally {
      delete process.env.XAI_API_KEY;
    }
  });
});

describe("summarizeAgentEvents", () => {
  const assistant = (text: string, cost: number, extra: object = {}) => ({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], usage: { cost: { total: cost } }, ...extra },
  });

  it("folds pi's JSON stream into answer, tools, session and cost", () => {
    const events: AgentEvent[] = [
      { type: "session", version: 3, id: "s-1", cwd: "/p" },
      { type: "message_end", message: { role: "user", content: "fix it" } },
      assistant("Looking.", 0.004),
      { type: "tool_execution_end", toolName: "bash", isError: false },
      { type: "tool_execution_end", toolName: "read", isError: true },
      assistant("Done: 3 tests fail.", 0.006),
    ];
    const run = summarizeAgentEvents(events);
    expect(run).toEqual({
      sessionId: "s-1",
      answer: "Done: 3 tests fail.",
      tools: [
        { name: "bash", ok: true },
        { name: "read", ok: false },
      ],
      costUsd: 0.01,
    });
    expect(formatAgentRun(run)).toBe(
      "session_id: s-1 | cost: $0.0100\n\nDone: 3 tests fail.\n\nTools used: bash, read(failed)",
    );
  });

  it("reports provider errors", () => {
    const run = summarizeAgentEvents([assistant("", 0, { stopReason: "error", errorMessage: "401 bad key" })]);
    expect(run.error).toBe("401 bad key");
    expect(formatAgentRun(run)).toContain("Error: 401 bad key");
  });
});

describe("outputPath", () => {
  it("numbers multiple outputs and adds the right extension", () => {
    const cwd = tmp();
    expect(outputPath(cwd, "image", "image/jpeg", "out/cat", 1, 2, "r")).toBe(join(cwd, "out", "cat-2.jpg"));
    expect(outputPath(cwd, "video", undefined, undefined, 0, 1, "r")).toBe(
      join(cwd, ".grokbot", "generated-media", "video-r.mp4"),
    );
  });
});

describe("untrusted tool arguments", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  it("only accepts real images as local sources", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----");
    writeFileSync(join(cwd, "cat.png"), "not really a png");
    writeFileSync(join(cwd, "ok.bin"), png);
    await expect(loadImage("id_rsa", cwd)).rejects.toThrow("Not a PNG, JPEG, GIF or WebP image");
    await expect(loadImage("cat.png", cwd)).rejects.toThrow("Not a PNG");
    expect((await loadImage("ok.bin", cwd)).mediaType).toBe("image/png");
    expect(sniffImage(Buffer.from("RIFF0000WEBPVP8 "))).toBe("image/webp");
  });

  it("refuses to download from private or local addresses", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.0.1", "::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "224.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
    await expect(loadImage("http://127.0.0.1:9/cat.png", tmp())).rejects.toThrow("private or local address");
    await expect(loadImage("http://[::1]/cat.png", tmp())).rejects.toThrow("private or local address");
    await expect(loadImage("http://localhost/cat.png", tmp())).rejects.toThrow("private or local address");
    await expect(loadImage("http://[::ffff:127.0.0.1]/cat.png", tmp())).rejects.toThrow("private or local address");
    await expect(loadImage("http://2130706433/cat.png", tmp())).rejects.toThrow("private or local address");
  });

  it("keeps outputs inside the working directory", () => {
    const cwd = tmp();
    expect(() => outputPath(cwd, "image", "image/png", "../escape.png", 0, 1, "r")).toThrow("inside the working directory");
    expect(() => outputPath(cwd, "image", "image/png", join(tmpdir(), "abs.png"), 0, 1, "r")).toThrow(
      "inside the working directory",
    );
  });
});

describe("browserCommand", () => {
  it("opens the login page without a shell on every OS", () => {
    const url = "https://accounts.x.ai/oauth2/device?user_code=AB&x=1";
    expect(browserCommand(url, "darwin")).toEqual(["open", [url]]);
    expect(browserCommand(url, "linux")).toEqual(["xdg-open", [url]]);
    expect(browserCommand(url, "win32")).toEqual(["rundll32", ["url.dll,FileProtocolHandler", url]]);
  });
});

describe("login menu", () => {
  it("offers Cursor first, then xAI, and only intercepts a bare /login", () => {
    expect(LOGIN_CHOICES.map(([, cmd]) => cmd)).toEqual(["/login cursor", "/login xai"]);
    expect(isBareLogin(" /login ")).toBe(true);
    expect(isBareLogin("/login anthropic")).toBe(false);
    expect(isBareLogin("explain /login")).toBe(false);
  });
});

describe("cursor provider", () => {
  it("holds back a partial <tool_call> tag while streaming", () => {
    expect(visibleText("Listing files <tool")).toBe("Listing files ");
    expect(visibleText('Done <tool_call>{"name"')).toBe("Done ");
    expect(visibleText("a < b")).toBe("a < b");
  });

  it("turns <tool_call> blocks into tool calls and keeps broken ones as text", () => {
    const { calls, leftover } = parseToolCalls(
      'Let me look.<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>\n<tool_call>{oops}</tool_call>',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ type: "toolCall", name: "bash", arguments: { command: "ls" } });
    expect(leftover).toContain("{oops}");
    expect(parseToolCalls("no tools here").calls).toEqual([]);
  });

  it("describes Cursor's own tool calls relative to the workspace", () => {
    const cwd = resolve("/w");
    expect(describeCursorTool({ readToolCall: { args: { path: join(cwd, "src", "a.py") } } }, cwd)).toBe(`read ${join("src", "a.py")}`);
    expect(describeCursorTool({ shellToolCall: { args: { command: "ls" } } }, cwd)).toBe("shell ls");
    expect(canWrite([{ name: "read" }, { name: "edit" }])).toBe(true);
    expect(canWrite([{ name: "read" }, { name: "grep" }])).toBe(false);
  });

  it("puts the tool protocol, tools and transcript into the prompt", () => {
    const prompt = buildPrompt({
      messages: [
        { role: "user", content: "fix it", timestamp: 0 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "1", name: "read", arguments: { path: "a.py" } }],
          api: "cursor-agent",
          provider: "cursor",
          model: "grok-4.7-low",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 0,
        },
        { role: "toolResult", toolCallId: "1", toolName: "read", content: [{ type: "text", text: "x = 1" }], isError: false, timestamp: 0 },
      ],
    });
    expect(prompt.indexOf("<protocol>")).toBe(0);
    expect(prompt).toContain('[assistant]\n<tool_call>{"name":"read","arguments":{"path":"a.py"}}</tool_call>');
    expect(prompt).toContain("[tool result read]\nx = 1");
  });
});

describe("skills on demand", () => {
  const skill = (name: string, description = `${name} helper`) => ({ name, description, filePath: `/s/${name}/SKILL.md`, disableModelInvocation: false });

  it("ranks name hits above description hits", () => {
    const skills = [skill("pdf", "Fill and merge PDF forms"), skill("docs", "Write docs, also exports to pdf"), skill("rust")];
    expect(searchSkills(skills, "PDF forms").map((s) => s.name)).toEqual(["pdf", "docs"]);
    expect(searchSkills(skills, "kubernetes")).toEqual([]);
  });

  it("takes a long skill index out of the prompt and serves it through find_skill", async () => {
    let handler: ((event: unknown) => void) | undefined;
    let tool: { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> } | undefined;
    registerSkillSearch({
      registerTool: (t: never) => (tool = t),
      on: (_name: string, h: (event: unknown) => void) => (handler = h),
    } as never);

    const many = Array.from({ length: SKILL_INDEX_LIMIT + 1 }, (_, i) => skill(`skill-${i}`));
    many.push(skill("pdf-tools", "Extract text from PDF files"));
    const options = { skills: many, sections: {} as Record<string, string> };
    handler?.({ systemPromptOptions: options });
    expect(options.skills).toEqual([]);
    expect(options.sections.skills).toContain("find_skill");
    const result = await tool?.execute("id", { query: "pdf text" });
    expect(result?.content[0].text).toContain("/s/pdf-tools/SKILL.md");

    const few = { skills: [skill("pdf")], sections: {} as Record<string, string> };
    handler?.({ systemPromptOptions: few });
    expect(few.skills).toHaveLength(1);
    expect(few.sections.skills).toBeUndefined();
  });
});

describe("Grok Bot app client", () => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64");

  it("keeps user and bot messages, in order, and drops internal entries", () => {
    const entries = parseEntries([
      { seq: "3", body: b64({ kind: "send-message", message: { type: "text", content: "pong" } }) },
      { seq: "2", body: b64({ kind: "message", role: "user", content: "ping" }) },
      { seq: "4", body: b64({ kind: "send-message", message: { type: "attachment", file_name: "a.xlsx" } }) },
      { seq: "5", body: b64({ kind: "tool-call", name: "shell" }) },
      { seq: "6", body: "not base64 json" },
      { seq: "7", body: b64({ kind: "send-message", message: { type: "attachment", file_name: "shot.png", url: "file:///box/assets/ab.png" } }) },
      { seq: "8", body: b64({ kind: "user-attachment", file_path: "store://spec.pdf", file_name: "spec.pdf" }) },
    ]);
    expect(entries).toEqual([
      { seq: 2, from: "you", text: "ping" },
      { seq: 3, from: "bot", text: "pong" },
      { seq: 4, from: "bot", text: "[file: a.xlsx]" },
      { seq: 7, from: "bot", text: "[file: shot.png]", file: { path: "file:///box/assets/ab.png", name: "shot.png" } },
      { seq: 8, from: "you", text: "[file: spec.pdf]", file: { path: "store://spec.pdf", name: "spec.pdf" } },
    ]);
  });

  it("picks a computer by id or label, and only defaults when there is exactly one", () => {
    const mac = { machineId: "m1", label: "Jane's MacBook", kind: "desktop", lastSeenAtMs: 0 };
    const pc = { machineId: "m2", label: "linux-box", kind: "desktop", lastSeenAtMs: 0 };
    expect(pickComputer([mac]).machineId).toBe("m1");
    expect(pickComputer([mac, pc], "LINUX").machineId).toBe("m2");
    expect(pickComputer([mac, pc], "m1").label).toBe("Jane's MacBook");
    expect(() => pickComputer([mac, pc])).toThrow(/Several computers/);
    expect(() => pickComputer([], undefined)).toThrow(/Open the Grok Bot app/);
    expect(() => pickComputer([mac], "nope")).toThrow(/Computers: Jane's MacBook/);
    expect(() => pickComputer([mac, { ...pc, label: "Jane's iMac" }], "jane")).toThrow(/matches several computers/);
  });

  it("shows the bot's requests to act on the user's computer, with their state", () => {
    const ask = (status: string) =>
      b64({ kind: "send-message", message: { type: "local-tool-permission", ask: { action: "run-command", target: "ls", status } } });
    expect(parseEntries([{ seq: "1", body: ask("pending") }, { seq: "2", body: ask("allowed") }])).toEqual([
      {
        seq: 1,
        from: "bot",
        text: "[asks to run-command on your computer (waiting for approval in the Grok Bot app): ls]",
        approval: { action: "run-command", target: "ls", status: "pending" },
      },
      { seq: 2, from: "bot", text: "[asks to run-command on your computer (allowed): ls]", approval: { action: "run-command", target: "ls", status: "allowed" } },
    ]);
  });

  it("ignores malformed transcript fields instead of failing the whole chat", () => {
    const entries = parseEntries([
      { seq: "1", body: b64({ kind: "send-message", message: { type: "attachment", file_name: 42, url: { evil: true } } }) },
      { seq: "2", body: b64({ kind: "user-attachment", file_path: ["x"] }) },
      { seq: "x", body: b64({ kind: "message", role: "user", content: "no seq" }) },
      { seq: "3", body: b64(null as never) },
    ]);
    expect(entries).toEqual([{ seq: 1, from: "bot", text: "[file: attachment]" }]);
  });

  it("only lets a tool call send images (project files when enabled), never hidden ones", () => {
    const cwd = tmp();
    const outside = tmp();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
    writeFileSync(join(cwd, "spec.md"), "# spec");
    writeFileSync(join(outside, "shot.png"), png);
    writeFileSync(join(outside, "id_rsa"), "-----BEGIN KEY-----");
    writeFileSync(join(cwd, ".env"), "SECRET=1");
    mkdirSync(join(outside, ".ssh"));
    writeFileSync(join(outside, ".ssh", "pic.png"), png);
    symlinkSync(join(outside, "id_rsa"), join(cwd, "innocent.txt"));
    expect(attachable(join(outside, "shot.png"), cwd)).toMatch(/shot\.png$/);
    expect(() => attachable("spec.md", cwd)).toThrow(/GROKBOT_MCP_SEND_FILES/);
    expect(attachable("spec.md", cwd, true)).toMatch(/spec\.md$/);
    expect(() => attachable(join(outside, "id_rsa"), cwd, true)).toThrow(/Only images/);
    expect(() => attachable("innocent.txt", cwd, true)).toThrow(/Only images/);
    expect(() => attachable(".env", cwd, true)).toThrow(/hidden/);
    expect(() => attachable(join(outside, ".ssh", "pic.png"), cwd)).toThrow(/hidden/);
  });

  it("saves into the temp folder as asked, project files only under .grokbot/bot-files, never elsewhere", () => {
    expect(saveDir("qa", tmp())).toMatch(/[\\/]\.grokbot[\\/]bot-files[\\/]qa$/);
    expect(saveDir(join(tmp(), "shots"))).toMatch(/shots$/);
    const project = mkdtempSync(join(process.cwd(), "grokbot-test-"));
    try {
      expect(saveDir(undefined, project)).toBe(join(project, ".grokbot", "bot-files"));
      expect(saveDir("tests", project)).toBe(join(project, ".grokbot", "bot-files", "tests"));
    } finally {
      rmSync(project, { recursive: true });
    }
    // A project inside the temp folder still gets .grokbot/bot-files, and a symlinked .grokbot can't lead out.
    const tmpProject = tmp();
    expect(saveDir(undefined, tmpProject)).toBe(join(tmpProject, ".grokbot", "bot-files"));
    const trap = tmp();
    const elsewhere = tmp();
    symlinkSync(elsewhere, join(trap, ".grokbot"));
    expect(() => saveDir(undefined, trap)).toThrow(/outside the working directory/);
    expect(existsSync(join(elsewhere, "bot-files"))).toBe(false);
    expect(() => saveDir(join(homedir(), "Library", "LaunchAgents"), tmp())).toThrow(/working directory/);
    expect(() => saveDir(".git/hooks", tmp())).toThrow(/hidden/);
    const work = tmp();
    symlinkSync(homedir(), join(work, "home"));
    expect(() => saveDir("home/evil", work)).toThrow(/working directory/);
  });

  it("turns the bot's file names into plain visible names", () => {
    expect(safeName("../../.zshrc")).toBe("zshrc");
    expect(safeName("..")).toBe("file");
    expect(safeName("a\\b\u0007c.png")).toBe("bc.png");
    expect(safeName("shot.png")).toBe("shot.png");
    const ansi = Buffer.from(JSON.stringify({ kind: "send-message", message: { type: "text", content: "ok\u001b[2J\u009b31m done" } })).toString("base64");
    expect(parseEntries([{ seq: "1", body: ansi }])[0].text).toBe("ok[2J31m done");
  });

  it("saves downloads as new files, never over an existing one or through a symlink", () => {
    const dir = tmp();
    writeFileSync(join(dir, "victim.txt"), "keep");
    symlinkSync(join(dir, "victim.txt"), join(dir, "shot.png"));
    expect(writeNew(dir, "shot.png", Buffer.from("a"))).toBe(join(dir, "shot-2.png"));
    expect(writeNew(dir, "shot.png", Buffer.from("b"))).toBe(join(dir, "shot-3.png"));
    expect(readFileSync(join(dir, "victim.txt"), "utf8")).toBe("keep");
  });

  it("picks a bot by id, name or prefix, defaulting to the main bot", () => {
    const bots = [{ agentId: "a1", name: "Grok Bot" }, { agentId: "a2", name: "giggle work" }];
    expect(pickBot(bots).agentId).toBe("a1");
    expect(pickBot(bots, "GIGGLE").agentId).toBe("a2");
    expect(pickBot(bots, "a2").name).toBe("giggle work");
    expect(() => pickBot(bots, "nope")).toThrow(/Bots: Grok Bot, giggle work/);
    expect(() => pickBot([], undefined)).toThrow(/No Grok Bot bots/);
    expect(botSlugs([...bots, { agentId: "a3", name: "Grok  Bot!" }])).toEqual(["grok-bot", "giggle-work", "grok-bot-2"]);
  });
});

describe("vault", () => {
  it("takes a bare DNS host as a site and refuses URLs, wildcards and malformed labels", () => {
    expect(checkSite("  App.Example.COM. ")).toBe("app.example.com");
    expect(checkSite("example.xn--p1ai")).toBe("example.xn--p1ai");
    for (const bad of ["https://app.example.com", "app.example.com/login", "*.example.com", "localhost", "example..com", ".example.com", "a.-b.com", "a-.example.com", `${"a".repeat(64)}.com`])
      expect(() => checkSite(bad)).toThrow(/host/);
  });

  it("flags secret-shaped form fields without catching ordinary ones", () => {
    for (const label of ["password", "Passphrase", "passcode", "CVV", "security code", "2FA", "one-time code", "recovery codes", "API key", "ssh_key", "seed phrase", "session cookie", "refreshToken", "clientSecret", "creditCardNumber", "pass\u200bword", "rodné číslo"])
      expect(isSecretField(`login ${label}`), label).toBe(true);
    for (const label of ["phone", "secretary", "street", "postal code", "company", "tokenization preference"])
      expect(isSecretField(`profile ${label}`)).toBe(false);
  });

  it("refuses a secret as a readable form answer before any network call", async () => {
    await expect(putFormEntry({ kind: "login", label: "password", value: "x" })).rejects.toThrow(/Save it as a login/);
    await expect(putFormEntry({ kind: "a", label: "b", value: "line\u001b[2Jfake" })).rejects.toThrow(/Control characters/);
  });

  it("reads a password only from a small regular file of the user's, never through a symlink or a FIFO", async () => {
    const dir = tmp();
    const file = join(dir, "pw");
    writeFileSync(file, "from-file\n");
    expect(readSecretFile(file)).toBe("from-file");
    symlinkSync(file, join(dir, "link"));
    expect(() => readSecretFile(join(dir, "link"))).toThrow(/symlink/);
    writeFileSync(join(dir, "big"), "x".repeat(5000));
    expect(() => readSecretFile(join(dir, "big"))).toThrow(/too big/);
    expect(() => readSecretFile(dir)).toThrow(/regular file/);
    linkSync(file, join(dir, "hard"));
    expect(() => readSecretFile(file)).toThrow(/hard links/);
    await expect(resolveSecret({})).rejects.toThrow(/exactly one/);
    await expect(resolveSecret({ file, stdin: true })).rejects.toThrow(/exactly one/);
  });

  it.skipIf(process.platform === "win32")("takes an MCP password only from the inbox file named after the site", async () => {
    const inbox = join(tmp(), "inbox");
    process.env.GROKBOT_VAULT_INBOX = inbox;
    try {
      await expect(createLoginFromInbox({ site: "app.example.com", title: "t", username: "u" })).rejects.toThrow(
        /No password for app\.example\.com waiting/,
      );
      // A failed save hands the staged file back instead of losing it (no token here, so the save fails).
      writeFileSync(join(inbox, "app.example.com"), "pw\n");
      await expect(createLoginFromInbox({ site: "app.example.com", title: "t", username: "u" })).rejects.toThrow();
      expect(readFileSync(join(inbox, "app.example.com"), "utf8")).toBe("pw\n");
      chmodSync(inbox, 0o755);
      expect(() => vaultInbox()).toThrow(/chmod 700/);
    } finally {
      delete process.env.GROKBOT_VAULT_INBOX;
    }
  });

  it("needs a title, a password and a site before it will save a login", async () => {
    const login = { title: "", username: "a", password: "b", sites: ["app.example.com"] };
    await expect(createLogin(login)).rejects.toThrow(/title/);
    await expect(createLogin({ ...login, title: "t", password: "" })).rejects.toThrow(/password/);
    await expect(createLogin({ ...login, title: "t", sites: [] })).rejects.toThrow(/site/);
    await expect(createLogin({ ...login, title: "t", sites: Array(11).fill("a.example.com") })).rejects.toThrow(/At most 10/);
  });

  it("cleans what the vault returns: control characters, unknown kinds, non-array fields", () => {
    expect(clean("ok\u001b[31mred\nnext")).toBe("ok [31mred next");
    expect(clean(42)).toBe("");
  });

  // Last in the file: it signs in with a fake token, which the bots client then keeps for the process.
  it("never shows the server's reply to a call that carried a password", async () => {
    const realFetch = globalThis.fetch;
    process.env.CURSOR_ACCESS_TOKEN = "test-token";
    const secret = "hunter2-very-secret";
    try {
      for (const [status, body] of [
        [400, `{"message":"bad request","echo":"${secret}"}`],
        [200, `not json ${secret}`],
        [200, JSON.stringify({ results: [{ error: `rejected ${secret}` }] })],
        [200, JSON.stringify({ results: [{ credential: { id: "ok-1", title: secret } }] })],
        [200, JSON.stringify({ results: [{ credential: { id: secret } }] })],
        [404, "x"],
      ] as const) {
        globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
        const outcome = await createLogin({ title: "Acme", username: "u", password: secret, sites: ["app.example.com"] }).then(
          (r) => JSON.stringify(r),
          (e: Error) => e.message,
        );
        expect(outcome).not.toContain(secret);
      }
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.CURSOR_ACCESS_TOKEN;
    }
  });
});
