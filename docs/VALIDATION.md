# Validation and known limitations

The vault, management, diagnostics and compact-response changes were checked against Grok Bot 1.0.3.
The app API is unofficial and can change independently of this client.

## Offline checks

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run smoke
```

The suite currently contains 200 test cases in eight files, with platform-specific inbox cases selected by OS.
It covers authorization and exact target selection,
single-use inbox handling, metadata-only secret output, omitted protobuf repeated fields, malformed/incomplete
responses, diagnostics uncertainty, response previews and incremental wait cursors. Cursor tests include pending
owner requests and streaming entries that mutate in place, including initially empty placeholders.

The stdio smoke starts the real MCP process and checks the 29 default tools. Admin tools remain opt-in with
`GROKBOT_MCP_ADMIN=1`. CI runs the regular test/build/package smoke on Linux, macOS and Windows with Node 22 and 24;
local verification alone does not establish the result of those remote jobs.

## Installed-app contract check

```bash
npm run check:app
npm run check:app -- --asar /path/to/app.asar
```

This reads static descriptors, without executing Electron code or reading app user data. It compares nine message
contracts and one enum with the captured fixture. In particular, automation permissions contain OPEN, TOGGLE,
EDIT and DELETE; there is no RUN action. Manual runs retain owner/manager checks and server authorization.
This optional check requires an installed app and is separate from the regular CI suite.

## Opt-in live smoke

```bash
npm run test:live -- --write
```

This consumes the authenticated account's Grok Bot plan and performs live writes. It creates a disposable bot and
synthetic records under `example.com`; it checks bot metadata and rename, skill CRUD, vault login/form CRUD,
unsupported-operation preflights, a structured OTP request delivered through MCP, and a disabled synthetic routine
that is toggled, run to completion, and deleted. A subsequent cursor-based wait must not repeat the final reply.
Cleanup runs in `finally`, attempts deletion even if stopping fails, and reports failures in a private temp report.
Existing bots and routines are not test fixtures. This lifecycle passed during development.

Team-secret success and conversion of an inherited plugin skill need suitable shared fixtures and were not covered
by the personal-bot smoke. The current server restricts named secrets to team-shared bots and rejects conversation
reset for temporal bots; the client reports these restrictions before dispatching an unsupported write.
Single-use inbox protections do not isolate files from another process running as the same local user.
The claimed file stays open throughout delivery and cleanup so immediate inode reuse cannot hide replacement.
Native Windows inboxes fail closed because POSIX ownership/mode checks cannot verify Windows ACL privacy;
use WSL or explicit CLI stdin instead. POSIX inbox tests run on macOS/Linux, and Windows runs the refusal checks.
Secret/skill file readers reject symlinks even when native `O_NOFOLLOW` is unavailable. Output artifacts use POSIX
mode `0600`; native Windows users should keep their output directory under an appropriate private ACL.

## Reproducible context measurements

```bash
npm run measure:context
npm run measure:context -- --live
```

The default command makes no model calls. It reports synthetic response sizes and the stdio MCP tool-definition
size; `--live` additionally makes read-only doctor/status calls and reports their full versus compact sizes.
The long-answer fixture goes from a 60,029-character truncated response to a 12,000-character preview (80% less),
with a link to the complete private artifact. A 610-step repeated tool trail goes from 3,738 to 35 characters.
Errors, warnings, unknown states and bot scope remain visible in compact diagnostics; `details: true` returns the
full MCP report. Inline images require explicit opt-in on send/wait calls.

Measurements count UTF-16 characters, not model tokens or billed usage, and do not predict subscription savings.
