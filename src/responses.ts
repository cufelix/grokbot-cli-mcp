// Bound model-facing output while preserving a complete result for selective local inspection.
export const DEFAULT_MCP_TEXT = 12_000;
export function responseLimit(value = process.env.GROKBOT_MCP_MAX_TEXT): number {
  if (value === undefined) return DEFAULT_MCP_TEXT;
  if (!/^\d+$/.test(value) || Number(value) < 1000 || Number(value) > 60_000)
    throw new Error("GROKBOT_MCP_MAX_TEXT must be an integer from 1000 to 60000.");
  return Number(value);
}

export function previewText(text: string, save: (full: string) => string, limit = responseLimit()): string {
  if (text.length <= limit) return text;
  let note: string;
  try { note = `\n\n[Preview of ${text.length} characters. Full untrusted output: ${save(text)}. Read only the relevant part.]`; }
  catch { note = "\n\n[Preview only; the full reply could not be saved locally. Increase GROKBOT_MCP_MAX_TEXT or read the bot transcript.]"; }
  if (note.length >= limit) note = "\n\n[Preview only; the saved artifact path exceeds the response limit.]";
  let head = text.slice(0, Math.max(0, limit - note.length));
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head + note;
}

export function summarizeToolTrail(tools: Array<{ name: string; ok: boolean }>): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const key = tool.ok ? tool.name : `${tool.name}(failed)`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([name, n]) => n > 1 ? `${name}×${n}` : name).join(", ");
}
