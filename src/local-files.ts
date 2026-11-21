import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";

/** Check the path as well as the descriptor: O_NOFOLLOW is unavailable on native Windows. */
export function openRegularFile(path: string): number {
  const before = lstatSync(path);
  if (before.isSymbolicLink()) throw new Error(`${path} is a symlink; give the file itself.`);
  if (!before.isFile()) throw new Error(`${path} is not a regular file.`);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd), now = lstatSync(path);
    if (now.isSymbolicLink() || !opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || now.dev !== opened.dev || now.ino !== opened.ino)
      throw new Error(`${path} changed while being opened.`);
    return fd;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/** Inbox privacy currently relies on POSIX ownership/mode checks, rather than unchecked Windows ACLs. */
export function requirePosixInbox(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32")
    throw new Error("Secure inboxes require POSIX ownership and permissions. Use WSL, or the CLI --value-stdin / --password-stdin options on native Windows.");
}
