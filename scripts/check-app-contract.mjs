// Static inspection only: never execute the installed Electron bundle or read user data.
import assert from "node:assert/strict";
import { openSync, readSync, closeSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--asar")) {
  console.error("Usage: npm run check:app -- [--asar /path/to/app.asar]"); process.exit(2);
}
const path = args[1] ?? "/Applications/Grok Bot.app/Contents/Resources/app.asar";
const expected = JSON.parse(readFileSync(new URL("../fixtures/grokbot-app-contract.json", import.meta.url), "utf8"));
let fd;
try {
  fd = openSync(path, "r");
  const header = Buffer.alloc(16); assert.equal(readSync(fd, header, 0, 16, 0), 16, "Truncated asar header");
  const length = header.readUInt32LE(12), offset = 8 + header.readUInt32LE(4);
  assert(length > 0 && length < 8 * 1024 * 1024 && offset >= length + 16, "Invalid asar index");
  const buffer = Buffer.alloc(length); assert.equal(readSync(fd, buffer, 0, length, 16), length, "Truncated asar index");
  const tree = JSON.parse(buffer.toString("utf8"));
  function* files(node) {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      if (value.files) yield* files(value);
      else if (!value.unpacked && !value.link && /\.(?:js|cjs)$/.test(name)) yield value;
    }
  }
  const found = { enums: {}, messages: {} };
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const entry of files(tree)) {
    assert(Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size < 64 * 1024 * 1024, "Invalid asar file size");
    const at = offset + Number(entry.offset); assert(Number.isSafeInteger(at) && at >= offset, "Invalid asar file offset");
    const data = Buffer.alloc(entry.size); assert.equal(readSync(fd, data, 0, data.length, at), data.length, "Truncated asar file");
    const text = data.toString("utf8");
    for (const name of Object.keys(expected.messages)) {
      const match = text.match(new RegExp('"' + escape(name) + '\\|([^"\\n]+)"'));
      if (match) found.messages[name] = match[1];
    }
    for (const name of Object.keys(expected.enums)) {
      const match = text.match(new RegExp('"' + escape(name) + '",([\\[\\]0-9,"A-Z_]+),1\\)'));
      if (match) found.enums[name] = JSON.parse(match[1]).map(x => x[1]);
    }
  }
  for (const [name, value] of Object.entries(expected.messages)) assert.equal(found.messages[name], value, `Message contract changed or missing: ${name}`);
  for (const [name, value] of Object.entries(expected.enums)) assert.deepEqual(found.enums[name], value, `Enum contract changed or missing: ${name}`);
  console.log(`ok: ${Object.keys(found.messages).length} message contracts and ${Object.keys(found.enums).length} enum contract match installed app`);
} catch (err) { console.error("App contract check failed:", err.message); process.exitCode = 1; }
finally { if (fd !== undefined) closeSync(fd); }
