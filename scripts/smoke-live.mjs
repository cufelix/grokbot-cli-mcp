// Opt-in live MCP regression test. Only this run's randomly named bot and synthetic vault items are changed.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { listManagedBots, deleteBot } from "../dist/manage.js";
import { listVault, listFormEntries } from "../dist/vault.js";
import { listAutomations } from "../dist/automations.js";
import { pendingSecretRequests } from "../dist/secrets.js";
import { stopBot, rpc } from "../dist/bots.js";

if (process.argv.length !== 3 || process.argv[2] !== "--write") {
  console.error("Usage: npm run test:live -- --write\nCreates a disposable bot, exercises synthetic vault/OTP/routine operations, and removes its test resources. Uses your Grok Bot plan.");
  process.exit(2);
}
const directory = mkdtempSync(join(tmpdir(), "grokbot-live-"));
const vaultInbox = join(directory, "vault"), secretInbox = join(directory, "secrets");
mkdirSync(vaultInbox, { mode: 0o700 }); mkdirSync(secretInbox, { mode: 0o700 });
const reportFile = join(directory, "results.json"), checks = [], cleanup = [];
const suffix = randomUUID(), name = `Grokbot Smoke ${suffix.slice(0, 8)}`, site = `audit-${suffix}.example.com`, title = `GROKBOT_SMOKE_${suffix}`;
const before = await listManagedBots(undefined, true), beforeVault = await listVault(), beforeForms = await listFormEntries();
let bot, vaultId, formId, activeRoutine, client;
const persist = () => writeFileSync(reportFile, JSON.stringify({ startedAt, name, botId: bot?.agentId, checks, cleanup }, null, 2), { mode: 0o600 });
const startedAt = new Date().toISOString(); persist();
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
async function step(name, fn) {
  if (controller.signal.aborted) throw new Error("Test interrupted; cleaning up.");
  try { await fn(); checks.push({ name, ok: true }); console.log("PASS", name); }
  catch (err) { checks.push({ name, ok: false, error: err.message }); console.error("FAIL", name, err.message); throw err; }
  finally { persist(); }
}
async function call(name, args, expectError = false) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000, signal: controller.signal });
  const text = r.content.filter(x => x.type === "text").map(x => x.text).join("\n");
  assert.equal(r.isError === true, expectError, `${name}: ${text}`);
  return text;
}
const poll = async (fn, seconds = 70) => {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    controller.signal.throwIfAborted();
    const result = await fn(); if (result) return result;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error("Timed out waiting for the synthetic bot operation.");
};
try {
  client = new Client({ name: "grokbot-live-smoke", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "mcp"],
    env: { ...process.env, PI_OFFLINE: "1", GROKBOT_MCP_ADMIN: "1", GROKBOT_VAULT_INBOX: vaultInbox, GROKBOT_SECRET_INBOX: secretInbox }, stderr: "inherit" });
  await client.connect(transport);
  await step("create isolated bot through MCP", async () => {
    await call("bot_create", { name, description: "Disposable live integration test with synthetic data only." });
    bot = (await listManagedBots(undefined, true)).find(b => b.name === name);
    assert(bot?.id && bot?.agentId); persist();
  });
  await step("numeric ids, UUIDs and bot details", async () => {
    const ids = JSON.parse(await call("bot_list", { json: true }));
    assert(ids.some(b => b.id === bot.id && b.agentId === bot.agentId));
    assert.equal(JSON.parse(await call("bot_info", { bot: bot.id })).capabilities.resetConversation, false);
  });
  await step("rename bot and verify independent read", async () => {
    await call("bot_update", { bot: bot.agentId, name: name + " Updated", description: "Synthetic updated description" });
    assert.equal((await listManagedBots()).find(b => b.agentId === bot.agentId)?.name, name + " Updated");
  });
  await step("create, read, update and remove a bot skill", async () => {
    for (const content of ["# Synthetic smoke skill\nMARKER_ONE", "# Synthetic smoke skill\nMARKER_TWO"]) {
      await call("bot_skill_put", { bot: bot.agentId, name: "smoke-marker", content });
      assert((await call("bot_skills_list", { bot: bot.agentId, name: "smoke-marker" })).includes(content));
    }
    const diagnosis = JSON.parse(await call("grokbot_doctor", { bot: bot.agentId, required_skills: ["smoke-marker"] }));
    assert.equal(diagnosis.ok, true);
    assert((await call("bot_skill_make_private", { bot: bot.agentId, name: "smoke-marker" }, true)).includes("inherited plugin"));
    await call("bot_skill_remove", { bot: bot.agentId, name: "smoke-marker" });
  });
  await step("vault login through purpose-bound inbox", async () => {
    const file = join(vaultInbox, site); writeFileSync(file, randomBytes(24).toString("hex"), { mode: 0o600 });
    await call("vault_add_login", { site, title, username: "synthetic@example.com" });
    assert(!existsSync(file));
    const found = (await listVault()).find(v => v.title === title && v.sites.includes(site)); assert(found?.id);
    vaultId = found.id;
    await call("vault_delete", { id: vaultId }); assert(!(await listVault()).some(v => v.id === vaultId)); vaultId = undefined;
  });
  await step("form vault accepts supported kind and rejects profile", async () => {
    await call("vault_form_put", { kind: "name", label: title, value: "Synthetic Tester", site });
    const item = (await listFormEntries()).find(e => e.label === title); assert(item?.entryId); formId = item.entryId;
    await call("vault_form_delete", { id: formId }); assert(!(await listFormEntries()).some(e => e.entryId === formId)); formId = undefined;
    await call("vault_form_put", { kind: "profile", label: title, value: "Synthetic Tester" }, true);
  });
  await step("personal secret and temporal reset preflights", async () => {
    const file = join(secretInbox, `put.${bot.agentId}.SMOKE_KEY`); writeFileSync(file, randomBytes(24).toString("hex"), { mode: 0o600 });
    assert((await call("bot_secret_put", { bot: bot.agentId, name: "SMOKE_KEY" }, true)).includes("shared with your team"));
    assert(existsSync(file)); unlinkSync(file);
    assert((await call("bot_fresh_conversation", { bot: bot.agentId }, true)).includes("not supported for temporal"));
  });
  await step("real structured OTP request, status and MCP delivery", async () => {
    const sent = await call("bot_send", { bot: bot.agentId, timeout_s: 0, message: "Isolated synthetic integration test. Do not browse, send email or access any account. Use your built-in secret request tool to ask for a one-time value labelled GROKBOT_SMOKE_OTP. After it is provided, reply only GROKBOT_SMOKE_SECRET_RECEIVED. Never repeat the value." });
    const baseline = Number(sent.match(/next_after_seq: (\d+)/)?.[1]); assert(Number.isSafeInteger(baseline));
    const request = await poll(async () => (await pendingSecretRequests(bot, controller.signal))[0]);
    assert.equal(JSON.parse(await call("bot_status", { bot: bot.agentId }))[0].state, "waiting_for_secret");
    const file = join(secretInbox, `submit.${bot.agentId}.${request.entryId}`); writeFileSync(file, randomBytes(24).toString("hex"), { mode: 0o600 });
    await call("bot_submit_secret", { bot: bot.agentId, entry_id: request.entryId }); assert(!existsSync(file));
    const finished = await call("bot_wait", { bot: bot.agentId, timeout_s: 90, after_seq: baseline });
    assert(finished.includes("GROKBOT_SMOKE_SECRET_RECEIVED"));
    const cursor = Number(finished.match(/next_after_seq: (\d+)/)?.[1]); assert(Number.isSafeInteger(cursor));
    const incremental = await call("bot_wait", { bot: bot.agentId, timeout_s: 20, after_seq: cursor });
    assert(!incremental.includes("GROKBOT_SMOKE_SECRET_RECEIVED"));
    assert(incremental.includes("done: true"));
  });
  await step("create a synthetic disabled routine using the bot", async () => {
    const routineName = "SMOKE_ROUTINE_" + suffix;
    await call("bot_send", { bot: bot.agentId, timeout_s: 120, message: `Create exactly one DISABLED annual routine named ${routineName}, cron 0 0 1 1 * (January 1 at midnight), Europe/Prague. Prompt: "Do not use tools, browse, send messages to anyone or access any account. Reply only GROKBOT_SMOKE_ROUTINE_OK." This is an isolated integration test. Do not create other routines or perform other actions. Reply DONE after saving.` });
    activeRoutine = (await listAutomations(bot)).find(a => a.name === routineName); assert(activeRoutine); assert.equal(activeRoutine.enabled, false);
  });
  await step("toggle, run to completion and delete the last routine through MCP", async () => {
    const args = { bot: bot.agentId, id: activeRoutine.id };
    for (const enabled of [true, false]) {
      await call("automation_set_enabled", { ...args, enabled });
      assert.equal((await listAutomations(bot)).find(a => a.id === activeRoutine.id)?.enabled, enabled);
    }
    await call("automation_run", args);
    const completed = await poll(async () => {
      const run = (await listAutomations(bot)).find(a => a.id === activeRoutine.id)?.runs[0];
      return run && !["running", "queued", "pending"].includes(run.status) ? run : undefined;
    }, 90);
    assert.equal(completed.status, "ok");
    await call("automation_delete", args);
    assert(!(await listAutomations(bot)).some(a => a.id === activeRoutine.id)); activeRoutine = undefined;
  });
} catch (err) {
  process.exitCode = 1;
  console.error(err.message);
} finally {
  const clean = async (name, fn) => { try { await fn(); cleanup.push({ name, ok: true }); console.log("CLEAN", name); } catch (err) { cleanup.push({ name, ok: false, error: err.message }); process.exitCode = 1; console.error("CLEANUP FAILED", name, err.message); } persist(); };
  await clean("synthetic vault items", async () => { for (const item of await listVault()) if (item.title === title && !beforeVault.some(v => v.id === item.id)) await rpc("DeleteGrokBotVaultCredential", { id: item.id }, undefined, true); });
  await clean("synthetic form answers", async () => { for (const item of await listFormEntries()) if (item.label === title && !beforeForms.some(f => f.entryId === item.entryId)) await rpc("DeleteGrokBotUserFormVaultEntry", { entryId: item.entryId }, undefined, true); });
  await clean("test bot and its routines", async () => {
    bot ??= (await listManagedBots()).find(b => b.name === name);
    if (bot && !before.some(b => b.id === bot.id)) {
      try { await stopBot(bot); }
      catch (err) { cleanup.push({ name: "interrupt disposable bot", ok: false, error: err.message }); process.exitCode = 1; }
      // Interruption failure must not prevent attempting deletion of this run's known-owned disposable bot.
      await deleteBot(bot.id);
    }
    const remaining = await listManagedBots(undefined, true);
    assert.deepEqual(remaining.map(b => b.id).sort(), before.map(b => b.id).sort());
  });
  await clean("synthetic inbox files", async () => { for (const dir of [vaultInbox, secretInbox]) for (const name of readdirSync(dir)) unlinkSync(join(dir, name)); });
  await client?.close().catch(() => {});
  console.log(`Results: ${reportFile}`);
}
