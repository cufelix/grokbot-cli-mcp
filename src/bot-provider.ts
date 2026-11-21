// The user's Grok Bot bots as pi "models": pick one with /model and chat with it in the grokbot TUI.
// Kept apart from bots.ts so `grokbot bot` and the MCP server don't load pi-ai.
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { API, type Bot, botSlugs, listBots, sendToBot } from "./bots.js";

export const BOTS_PROVIDER = "grok-bot-app";
const botIds = new Map<string, string>(); // model id (slug) -> agentId

/** The last user message is what gets sent: the bot keeps its own history in the app. */
function lastUserText(context: TranscriptContext): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const m = context.messages[i];
    if (m.role !== "user") continue;
    return typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  }
  return "";
}

export function streamBot(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const block = output.content[0] as { type: "text"; text: string };
  const add = (delta: string) => {
    block.text += delta;
    stream.push({ type: "text_delta", contentIndex: 0, delta, partial: output });
  };

  void (async () => {
    stream.push({ type: "start", partial: output });
    stream.push({ type: "text_start", contentIndex: 0, partial: output });
    const bot = { agentId: botIds.get(model.id) ?? model.id, name: model.name };
    const { done, blocked } = await sendToBot(bot, lastUserText(context), {
      signal: options?.signal,
      onReply: (e) => add(`${block.text ? "\n\n" : ""}${e.text}`),
    });
    if (options?.signal?.aborted) throw new Error("aborted");
    if (!done) add(`${block.text ? "\n\n" : ""}_${blocked ? `Waiting for owner input (${blocked}) in the Grok Bot app.` : `${model.name} is still working; the rest will show in the Grok Bot app.`}_`);
    stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: output });
    stream.push({ type: "done", reason: "stop", message: output });
    stream.end();
  })().catch((err: unknown) => {
    const aborted = options?.signal?.aborted ?? false;
    output.stopReason = aborted ? "aborted" : "error";
    output.errorMessage = aborted ? "Request was aborted" : err instanceof Error ? err.message : String(err);
    stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: output });
    stream.end();
  });
  return stream;
}

/** Registers the user's Grok Bot bots as models. Skipped quietly when there is no Cursor login or no network. */
export async function registerBotProvider(pi: ExtensionAPI): Promise<void> {
  let bots: Bot[];
  try {
    bots = await listBots();
  } catch {
    return;
  }
  if (!bots.length) return;
  const ids = botSlugs(bots);
  bots.forEach((b, i) => botIds.set(ids[i], b.agentId));
  pi.registerProvider(BOTS_PROVIDER, {
    name: "Grok Bot app",
    baseUrl: API,
    apiKey: "cursor-login", // the real token is read from the Cursor login on each request
    api: "grok-bot-app",
    streamSimple: streamBot,
    models: bots.map((b, i) => ({
      id: ids[i],
      name: `${b.name} (Grok Bot app)`,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 100_000,
    })),
  });
}
