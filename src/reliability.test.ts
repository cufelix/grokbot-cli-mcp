import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteAutomation, runAutomationNow, toAutomation } from "./automations.js";
import { putBotSecretFromInbox, putBotSecret, listBotSecrets, findSecretBot } from "./secrets.js";
import { startFreshConversation } from "./manage.js";
import { createLoginFromInbox, putFormEntry, vaultInbox } from "./vault.js";
import { secretInbox } from "./secrets.js";
import { requirePosixInbox } from "./local-files.js";
import contract from "../fixtures/grokbot-app-contract.json";
import { makeSkillPrivate } from "./bot-skills.js";

const agent = { id: "101", agentId: "uuid-1", name: "Personal", viewerIsOwner: true, visibility: "GROK_BOT_AGENT_VISIBILITY_OWNER", harness: "temporal" };
const raw = { automationId: "auto-1", recordJson: JSON.stringify({ name: "Synthetic routine" }), viewerPermissions: { allowedActions: contract.enums.GrokBotAutomationAction.filter(a => a !== "UNSPECIFIED").map(a => "GROK_BOT_AUTOMATION_ACTION_" + a) } };
const target = toAutomation(raw, agent);
let calls: { method: string; body: any }[], reply: (method: string) => unknown;
beforeEach(() => {
  vi.stubEnv("CURSOR_ACCESS_TOKEN", "test-token"); calls = [];
  reply = method => method === "ListGrokBotAgents" ? { agents: [agent] } : {};
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const method = String(url).split("/").pop()!; calls.push({ method, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(reply(method)));
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("live API contract regressions", () => {
  it("fails closed for Windows inboxes with a supported alternative", () => {
    expect(() => requirePosixInbox("win32")).toThrow(/WSL.*stdin/);
  });
  it("retains POSIX inbox support", () => {
    for (const platform of ["linux", "darwin"] as const) expect(() => requirePosixInbox(platform)).not.toThrow();
  });
  it.runIf(process.platform === "win32")("refuses actual native Windows inbox operations before creating directories", () => {
    expect(() => vaultInbox()).toThrow(/WSL/);
    expect(() => secretInbox()).toThrow(/WSL/);
  });
  it("runs an owned routine with the real four-member permission enum", async () => {
    await runAutomationNow(target);
    expect(calls.filter(c => c.method === "RunGrokBotAgentAutomationNow")).toEqual([{ method: "RunGrokBotAgentAutomationNow", body: { agentId: "uuid-1", automationId: "auto-1" } }]);
  });
  it("refuses runs for unknown or non-manager bot ownership", async () => {
    reply = () => ({ agents: [{ ...agent, viewerIsOwner: false }] });
    await expect(runAutomationNow(target)).rejects.toThrow(/owner or manager/);
    expect(calls.some(c => c.method === "RunGrokBotAgentAutomationNow")).toBe(false);
  });
  it("accepts omitted protobuf repeated fields after independently verifying deletion", async () => {
    expect(await deleteAutomation(target)).toBe(0);
    expect(calls.map(c => c.method)).toEqual(["DeleteGrokBotAgentAutomation", "ListGrokBotAgentAutomations"]);
  });
  it("does not confirm an omitted delete result if the target still exists", async () => {
    reply = method => method === "ListGrokBotAgentAutomations" ? { automations: [raw] } : {};
    await expect(deleteAutomation(target)).rejects.toThrow(/still lists/);
    expect(calls.filter(c => c.method === "DeleteGrokBotAgentAutomation")).toHaveLength(1);
  });
  it("does not confirm deletion by discarding unreadable verification rows", async () => {
    reply = method => method === "ListGrokBotAgentAutomations" ? { automations: [null, { recordJson: "{}" }] } : {};
    await expect(deleteAutomation(target)).rejects.toThrow(/without a valid id/);
    expect(calls.filter(c => c.method === "DeleteGrokBotAgentAutomation")).toHaveLength(1);
  });
  it("refuses personal named secrets before opening or consuming the staged file", async () => {
    const inbox = mkdtempSync(join(tmpdir(), "preflight-")); vi.stubEnv("GROKBOT_SECRET_INBOX", inbox);
    const file = join(inbox, "put.uuid-1.API_KEY"); writeFileSync(file, "synthetic-value");
    await expect(putBotSecretFromInbox(agent, { name: "API_KEY" })).rejects.toThrow(/shared with your team/);
    expect(readFileSync(file, "utf8")).toBe("synthetic-value");
    expect(calls.some(c => c.method === "PutGrokBotSecret")).toBe(false);
  });
  it("explains group secret unavailability without a failing secret API call", async () => {
    reply = () => ({ agents: [{ ...agent, kind: "GROK_BOT_AGENT_KIND_ROOM" }] });
    const group = await findSecretBot("101", { exact: true });
    await expect(listBotSecrets(group)).rejects.toThrow(/Group conversations/);
    expect(calls.map(c => c.method)).toEqual(["ListGrokBotAgents"]);
  });
  it("does not expose server text from a failed capability preflight", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("SYNTHETIC_SECRET_ECHO"); }));
    await expect(putBotSecret(agent, { name: "API_KEY", value: "SYNTHETIC_SECRET_ECHO" })).rejects.toThrow("Could not verify this bot's team sharing and management rights; no value was sent.");
  });
  it("refuses unsupported temporal reset before any reset RPC", async () => {
    await expect(startFreshConversation("uuid-1")).rejects.toThrow(/not supported for temporal/);
    expect(calls.some(c => c.method === "StartFreshGrokBotConversation")).toBe(false);
  });
  it("rejects the previously advertised profile form kind before a write", async () => {
    await expect(putFormEntry({ kind: "profile", label: "name", value: "Synthetic" })).rejects.toThrow(/Unsupported form kind/);
    expect(calls).toHaveLength(0);
  });
  it("does not try to convert a non-plugin skill to private", async () => {
    reply = method => method === "ListGrokBotAgentSkills" ? { skills: [{ id: "skill1", name: "own", source: "recipe", body: "Synthetic" }] } : {};
    await expect(makeSkillPrivate("uuid-1", "own")).rejects.toThrow(/Only an inherited plugin/);
    expect(calls.some(c => c.method === "MakeGrokBotAgentSkillPrivate")).toBe(false);
  });
  it.skipIf(process.platform === "win32")("applies the same stale-file protection to login and OTP inboxes", async () => {
    const root = mkdtempSync(join(tmpdir(), "vault-stale-")), inbox = join(root, "inbox");
    mkdirSync(inbox, { mode: 0o700 }); vi.stubEnv("GROKBOT_VAULT_INBOX", inbox);
    const file = join(inbox, "audit.example.com"); writeFileSync(file, "synthetic-value");
    const old = new Date(Date.now() - 16 * 60_000); utimesSync(file, old, old);
    await expect(createLoginFromInbox({ site: "audit.example.com", title: "test", username: "test" })).rejects.toThrow(/older than 15 minutes/);
    expect(existsSync(file)).toBe(true); expect(calls).toHaveLength(0);
  });
});
