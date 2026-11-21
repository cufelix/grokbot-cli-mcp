// Single-use, purpose-bound inbox files shared by vault logins and bot secrets.
import { linkSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
export const INBOX_MAX_AGE_MS = 15 * 60 * 1000;
const STALE = "The staged file is older than 15 minutes. Delete it and stage the value again.";
const same = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino;
const stale = (mtimeMs: number) => Date.now() - mtimeMs > INBOX_MAX_AGE_MS || mtimeMs - Date.now() > 60_000;

/**
 * Takes a value the user left in the inbox. The file is first claimed by an atomic rename, so two calls can't both use
 * it; it is removed once `use` has succeeded (only if it is still the very file that was read: same device and inode,
 * in the same directory), and put back if `use` fails, without ever replacing a file staged meanwhile (link + unlink,
 * not rename). A file older than 15 minutes is refused. Node has no openat, so the directory is resolved to a real path
 * once and its identity re-checked before each step. (As with the vault inbox, this binds file name to purpose; it is no
 * wall against a host that can write files itself.)
 */
export async function withInboxValue(dir: string, file: string, what: string, readValue: (path: string) => string, use: (value: string) => Promise<void>): Promise<string | undefined> {
  const dirId = lstatSync(dir);
  const dirOk = () => {
    const now = lstatSync(dir);
    return now.isDirectory() && !now.isSymbolicLink() && same(now, dirId);
  };
  let staged;
  try {
    staged = lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`No ${what} waiting. Ask the user to put it in ${file} (e.g. \`pbpaste > ${file}\`), then try again.`);
    throw err;
  }
  if (stale(staged.mtimeMs)) throw new Error(STALE);
  const claimed = `${file}.taking-${randomUUID()}`;
  try {
    renameSync(file, claimed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`No ${what} waiting. Ask the user to put it in ${file} (e.g. \`pbpaste > ${file}\`), then try again.`);
    throw err;
  }
  const claimedId = lstatSync(claimed);
  // The rename must have moved the very file that was checked for age, in the directory that was checked.
  const swapped = !same(claimedId, staged) || !dirOk();
  /** Puts the claimed file back unless something is already staged there: never overwrites. */
  const restore = () => {
    try {
      if (!claimedId.isFile() || claimedId.nlink !== 1) {
        // A symlink or hard link is no secret of the user's: drop only the name we claimed, never what it points at.
        if (dirOk()) unlinkSync(claimed);
        return;
      }
      if (!dirOk() || !same(lstatSync(claimed), claimedId)) return;
      linkSync(claimed, file); // fails with EEXIST rather than replacing a newly staged file
      if (same(lstatSync(claimed), claimedId)) unlinkSync(claimed);
    } catch {
      // leave the claimed copy
    }
  };
  try {
    if (swapped) throw new Error("The staged file changed while it was being taken. Delete it and stage the value again.");
    if (stale(claimedId.mtimeMs)) throw new Error(STALE);
    const value = readValue(claimed);
    // The value was read by path: it counts only if the name still points at the file that was claimed.
    if (!dirOk() || !same(lstatSync(claimed), claimedId))
      throw new Error("The staged file changed while it was being read. Delete it and stage the value again.");
    await use(value);
  } catch (err) {
    restore();
    throw err;
  }
  try {
    if (!dirOk() || !same(lstatSync(claimed), claimedId)) throw new Error("changed");
    unlinkSync(claimed);
    return undefined;
  } catch {
    return `The staged file may still exist (${claimed}, or ${file}): delete it yourself.`;
  }
}
