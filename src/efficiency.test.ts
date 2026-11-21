import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactDoctor, compactOverview, type BotOverview, type DoctorReport } from "./inspection.js";
import { consumeAgentEvent, formatAgentRun, modelText, withFiles, type AgentRun } from "./mcp.js";
import { DEFAULT_MCP_TEXT, previewText, responseLimit, summarizeToolTrail } from "./responses.js";
import { botStatus, parseEntries, sendToBot, waitForBot } from "./bots.js";
import { pendingSecretRequests } from "./secrets.js";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "grokbot-efficient-")); dirs.push(dir); return dir; };
const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64");
const bot = { agentId: "bot-1", name: "Synthetic" };
beforeEach(() => { vi.stubEnv("CURSOR_ACCESS_TOKEN", "test-token"); });
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("bounded model output", () => {
  it("leaves short replies alone and validates the server-owned budget", () => {
    const save = vi.fn();
    expect(previewText("small", save)).toBe("small"); expect(save).not.toHaveBeenCalled();
    expect(responseLimit()).toBe(12_000);
    for (const value of ["0", "999", "60001", "NaN", "1e4", "12000.5", ""]) expect(() => responseLimit(value)).toThrow(/integer/);
    expect(responseLimit("60000")).toBe(60000);
  });
  it("preserves the complete long reply in a private, non-executable artifact", () => {
    const cwd = temp(), text = "synthetic ".repeat(10_000) + "LAST_LINE";
    const result = modelText(text, cwd);
    expect(result.length).toBeLessThanOrEqual(DEFAULT_MCP_TEXT);
    expect(result).toContain("Full untrusted output:");
    const file = result.match(/Full untrusted output: (.+?)\. Read/)![1];
    expect(file.startsWith(join(cwd, ".grokbot", "bot-files"))).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(text);
    if (process.platform !== "win32") expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(file.endsWith(".txt")).toBe(true);
  });
  it("does not follow an artifact directory symlink outside the workspace", () => {
    const cwd = temp(), outside = temp(); symlinkSync(outside, join(cwd, ".grokbot"));
    const result = modelText("large ".repeat(5000), cwd);
    expect(result).toContain("could not be saved");
    expect(result.length).toBeLessThanOrEqual(DEFAULT_MCP_TEXT);
    expect(readdirSync(outside)).toEqual([]);
  });
  it("keeps a truthful bounded fallback and does not cut a surrogate pair", () => {
    const result = previewText("🙂".repeat(15_000), () => { throw new Error("private local detail"); });
    expect(result.length).toBeLessThanOrEqual(DEFAULT_MCP_TEXT);
    expect(result).not.toContain("private local detail");
    expect(result).not.toMatch(/[\uD800-\uDBFF]\n/);
    expect(result).toContain("could not be saved");
  });
  it("compresses repeated internal tool steps while preserving failure counts and session metadata", () => {
    const tools = [...Array.from({ length: 100 }, () => ({ name: "read", ok: true })), { name: "read", ok: false }];
    expect(summarizeToolTrail(tools)).toBe("read×100, read(failed)");
    const result = formatAgentRun({ answer: "done", tools, costUsd: 0.1, sessionId: "resume-1" });
    expect(result.startsWith("session_id: resume-1")).toBe(true);
    expect(result).toContain("read×100");
    const run: AgentRun = { answer: "", tools: [], costUsd: 0 };
    consumeAgentEvent(run, { type: "tool_execution_end", toolName: "read", result: { text: "UNNEEDED_TOOL_BODY".repeat(1000) } });
    consumeAgentEvent(run, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final" }], usage: { cost: { total: 0.02 } } } });
    expect(run).toEqual({ answer: "final", tools: [{ name: "read", ok: true }], costUsd: 0.02 });
  });
});

describe("compact diagnostics", () => {
  it("retains blocked/unknown states and every uncertainty note", () => {
    const row: BotOverview = { id: "1", agentId: "uuid-1", name: "bot", state: "unknown", activity: "", settledAtMs: 0, pendingSecrets: 0, pendingApprovals: 0, issues: ["incomplete transcript"] };
    expect(compactOverview([row])[0]).toEqual({ agentId: "uuid-1", name: "bot", state: "unknown", issues: ["incomplete transcript"] });
    expect(compactOverview([{ ...row, state: "waiting_for_secret", pendingSecrets: 1 }])[0].pendingSecrets).toBe(1);
    expect(JSON.stringify(compactOverview([row])).length).toBeLessThan(JSON.stringify([row]).length);
  });
  it("groups informational checks without losing their bot scope or any failure", () => {
    const r: DoctorReport = { ok: false, bots: [], checks: [
      { code: "capabilities", level: "info", botId: "one", message: "restricted" },
      { code: "capabilities", level: "info", botId: "two", message: "restricted" },
      { code: "required_skill", level: "error", botId: "two", message: "missing" },
    ] };
    expect(compactDoctor(r)).toEqual({ ok: false, bots: [], notes: [{ message: "restricted", botIds: ["one", "two"] }], checks: [r.checks[2]] });
  });
});

describe("image context budget", () => {
  it("saves all images without inlining by default and limits explicit bulk inlining", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=", "base64");
    vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify(String(url).endsWith("/ReadGrokBotAgentAttachmentChunk") ? { data: png.toString("base64"), totalSize: String(png.length) } : {})));
    const entries = Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, from: "bot" as const, text: "image", file: { path: "box-" + i, name: "shot-" + i + ".png" } }));
    const out = temp();
    const normal = await withFiles(bot, "results", entries, out);
    expect(normal.content.filter(c => c.type === "image")).toHaveLength(0);
    expect(readdirSync(out)).toHaveLength(5);
    const explicit = await withFiles(bot, "results", entries, temp(), undefined, true);
    expect(explicit.content.filter(c => c.type === "image")).toHaveLength(4);
    expect(explicit.content.filter(c => c.type === "text" && c.text.startsWith("Saved "))).toHaveLength(5);
  });
});

describe("incremental waiting and owner input", () => {
  const setup = (entries: unknown[], live: object = { lastTurnSettlement: { settledAtMs: "20" } }) => {
    vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify(String(url).endsWith("/ListGrokBotAgentStatuses") ? { statuses: [{ agentId: bot.agentId, live }] } : { entries })));
  };
  it("returns only unseen replies and advances a reusable cursor", async () => {
    vi.useFakeTimers();
    setup([{ seq: "1", body: b64({ kind: "message", role: "user", content: "task" }) }, { seq: "2", body: b64({ kind: "send-message", message: { type: "text", content: "OLD" } }) }, { seq: "4", body: b64({ kind: "send-message", message: { type: "text", content: "NEW" } }) }]);
    const first = waitForBot(bot, { after: 2, timeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(9500);
    const result = await first;
    expect(result.done).toBe(true);
    expect(result.replies.map(e => e.text)).toEqual(["NEW"]); expect(result.afterSeq).toBe(4);
    const second = waitForBot(bot, { after: result.afterSeq, timeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(9500);
    expect(await second).toMatchObject({ done: true, replies: [], afterSeq: 4 });
  });
  it("returns promptly for a secret request without reading or echoing a provided value", async () => {
    vi.useFakeTimers();
    const entry = { seq: "5", body: b64({ kind: "send-message", value: "NEVER_ECHO", message: { type: "secret-request" } }) };
    setup([entry]);
    const pending = waitForBot(bot, { after: 1, timeoutMs: 900_000 });
    await vi.advanceTimersByTimeAsync(3500);
    const result = await pending;
    expect(result).toMatchObject({ done: false, blocked: "secret", afterSeq: 4 });
    expect(JSON.stringify(result)).not.toContain("NEVER_ECHO");
    const provided = parseEntries([{ ...entry, body: b64({ kind: "send-message", secretProvided: true, value: "NEVER_ECHO", message: { type: "secret-request" } }) }]);
    expect(provided[0].secretRequest?.pending).toBe(false);
    expect(JSON.stringify(provided)).not.toContain("NEVER_ECHO");
  });
  it("keeps pending approval entries inside the next cursor window", async () => {
    vi.useFakeTimers();
    setup([{ seq: "8", body: b64({ kind: "send-message", message: { type: "auto-review-approval", approval: { status: "pending" } } }) }]);
    const pending = waitForBot(bot, { after: 3, timeoutMs: 900_000 }); await vi.advanceTimersByTimeAsync(3500);
    expect(await pending).toMatchObject({ done: false, blocked: "approval", afterSeq: 7 });
  });
  it("never skips earlier mutable text or approval when a later secret is pending", async () => {
    vi.useFakeTimers();
    setup([
      { seq: "4", body: b64({ kind: "send-message", streaming: true, message: { type: "text", content: "PARTIAL" } }) },
      { seq: "5", body: b64({ kind: "send-message", message: { type: "local-tool-permission", ask: { status: "pending" } } }) },
      { seq: "8", body: b64({ kind: "send-message", message: { type: "secret-request" } }) },
    ]);
    const pending = waitForBot(bot, { after: 2 }); await vi.advanceTimersByTimeAsync(3500);
    expect(await pending).toMatchObject({ done: false, blocked: "secret", afterSeq: 3 });
  });
  it("re-reads a partial streaming entry after timeout and returns its final replacement", async () => {
    vi.useFakeTimers();
    setup([{ seq: "12", body: b64({ kind: "send-message", streaming: true, message: { type: "text", content: "PARTIAL" } }) }]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 4500);
    const first = waitForBot(bot, { after: 10, signal: controller.signal, timeoutMs: 90_000 });
    await vi.advanceTimersByTimeAsync(5000);
    const partial = await first;
    expect(partial).toMatchObject({ done: false, afterSeq: 11, replies: [{ text: "PARTIAL", streaming: true }] });
    setup([{ seq: "12", body: b64({ kind: "send-message", streaming: false, message: { type: "text", content: "FINAL ANSWER" } }) }]);
    const second = waitForBot(bot, { after: partial.afterSeq, timeoutMs: 90_000 });
    await vi.advanceTimersByTimeAsync(9500);
    expect(await second).toMatchObject({ done: true, afterSeq: 12, replies: [{ text: "FINAL ANSWER" }] });
  });
  it("keeps empty streaming placeholders before later stable replies in the cursor window", async () => {
    vi.useFakeTimers();
    const placeholder = { seq: "12", body: b64({ kind: "send-message", streaming: true, message: { type: "text", content: "" } }) };
    const stable = { seq: "13", body: b64({ kind: "send-message", message: { type: "text", content: "stable" } }) };
    setup([placeholder, stable]);
    const controller = new AbortController(); setTimeout(() => controller.abort(), 4500);
    const pending = waitForBot(bot, { after: 10, signal: controller.signal }); await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({ done: false, afterSeq: 11 });
    // A final empty update also clears a previously retained streaming placeholder.
    const finalEmpty = parseEntries([{ ...placeholder, body: b64({ kind: "send-message", streaming: false, message: { type: "text", content: "" } }) }]);
    expect(finalEmpty[0]).toMatchObject({ text: "" }); expect(finalEmpty[0].streaming).toBeUndefined();
  });
  it("closes dismissed or responded widgets without claiming approval or secret delivery", async () => {
    for (const marker of [{ widgetDismissed: true }, { respondedValue: "PRIVATE_VALUE" }]) {
      const entry = { seq: "5", entryId: "entry-5", body: b64({ ...marker, kind: "send-message", message: { type: "secret-request" } }) };
      const request = parseEntries([entry])[0]; expect(request.secretRequest?.pending).toBe(false);
      expect(request.text).toContain("closed"); expect(request.text).not.toContain("PRIVATE_VALUE");
      const approval = parseEntries([{ ...entry, body: b64({ ...marker, kind: "send-message", message: { type: "local-tool-permission", ask: { status: "pending" } } }) }])[0];
      expect(approval.approval?.status).toBe("closed");
      setup([entry]);
      expect(await pendingSecretRequests({ id: "1", agentId: bot.agentId })).toEqual([]);
    }
  });
  it("validates cursors before network and counts composing/retrying/subagents as work", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(waitForBot(bot, { after: -1 })).rejects.toThrow(/after_seq/);
    expect(fetch).not.toHaveBeenCalled();
    for (const field of ["isComposingMessage", "isRetrying", "hasRunningSubagents"]) {
      setup([], { [field]: true });
      expect((await botStatus(bot)).running).toBe(true);
    }
  });
  it("returns the baseline cursor for an asynchronous send", async () => {
    vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify(String(url).endsWith("/SendGrokBotUserMessage") ? { dispatched: true }
      : String(url).endsWith("/ListGrokBotTranscriptEntries") ? { entries: [{ seq: "12", body: b64({ kind: "send-message", message: { type: "text", content: "old" } }) }] }
      : { statuses: [] })));
    expect(await sendToBot(bot, "synthetic", { wait: false })).toMatchObject({ done: false, afterSeq: 12 });
  });
});
