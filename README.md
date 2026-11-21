# grokbot   

[![npm](https://img.shields.io/npm/v/grokbot-cli-mcp)](https://www.npmjs.com/package/grokbot-cli-mcp) [![CI](https://github.com/cufelix/grokbot-cli-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/cufelix/grokbot-cli-mcp/actions)

![grokbot in 11 seconds](https://raw.githubusercontent.com/cufelix/grokbot-cli-mcp/main/docs/film.gif)

**Grok in your terminal, and Grok inside Claude Code.**

`grokbot` is two things in one npm package:

1. **A terminal coding agent powered by xAI Grok**, built on [pi](https://github.com/earendil-works/pi)'s polished TUI
   (sessions, branching, `/model`, themes, skills, extensions, MCP client), with Grok-native tools added:
   live **X search**, **web search**, **image** and **video** generation.
2. **An MCP server** (`grokbot mcp`) so Claude Code, Cursor, Codex or any MCP host can use Grok:
   ask it, search X/web through it, generate media, or delegate a whole task to the grokbot agent.

It also drives your bots in the **Grok Bot** desktop app (`grokbot bot`, `bot_*` MCP tools): message them, wait for the
real end of their work, send and fetch files, and let them test sites in a real browser, even on your own computer
([details](#your-bots-in-the-grok-bot-app)).

Works on **Linux, macOS and Windows** (Node.js ≥ 22.19).

```
                ┌─ grokbot (TUI) ── you
pi + grok ext ──┤
                └─ grokbot mcp ──── Claude Code ─ grok_ask · grok_search_x · grok_search_web
                                                  grok_generate_image · grok_generate_video
                                                  grok_agent ─▶ grokbot --mode json (files, shell, its own MCPs)
                                                  bot_send · bot_wait · bot_download … ─▶ Grok Bot app bots
```

## Install

```bash
npm install -g grokbot-cli-mcp   # needs Node.js >= 22.19
grokbot
```

Update with `npm install -g grokbot-cli-mcp@latest`, remove with `npm uninstall -g grokbot-cli-mcp`.

Sign in once:

```bash
grokbot login            # pick: Cursor, xAI account, or xAI API key
grokbot login --cursor   # Grok through your Cursor account (needs the Cursor CLI, `cursor-agent`)
grokbot login --xai      # opens x.ai in your browser: sign in with Google, X or email, confirm the code
grokbot login --api-key  # or paste an API key from console.x.ai
grokbot logout
```

The same works inside the TUI with `/login` (Cursor first, then xAI), or set `XAI_API_KEY` (`GROK_API_KEY` works too).
xAI browser sign-in uses your SuperGrok / X Premium subscription; the CLI and `grokbot mcp` share the login.

**Cursor sign-in** runs Grok 4.7 through the [Cursor CLI](https://cursor.com/cli) (`cursor-agent`), picked
automatically when it is your only login (or `/model` → "Grok 4.7 … (Cursor)"). Grok then reads, edits and runs commands
with Cursor's own tools in your workspace, shown as `⚙ edit file.py` lines, and calls grokbot's tools through a
prompt protocol. `web_search`, `x_search`, image/video generation and the MCP server still need xAI credentials. Each
turn is one `cursor-agent` run, so it is slower than the xAI API and uses your Cursor plan under Cursor's terms. grokbot
passes `--trust` to `cursor-agent` for the folder you start it in. Cursor's tools can't be limited, so `grok_agent`
`read_only` runs refuse Cursor models and need xAI.

Grok (`grok-4.7`) is the default model. Switch anytime with `/model` (any pi provider works).

## The CLI

![grokbot in the terminal](https://raw.githubusercontent.com/cufelix/grokbot-cli-mcp/main/docs/grokbot-demo.gif)

```bash
grokbot                                   # interactive TUI
grokbot "fix the failing test"            # TUI with an opening prompt
grokbot -p "summarize this repo"          # print mode: answer to stdout, then exit
git diff | grokbot -p "review this"       # pipe input
grokbot --mode json "..." > events.jsonl  # JSONL event stream
grokbot -c                                # continue the last session
```

Inside the TUI, just ask: _"what is X saying about the Bun 2 release?"_, _"generate a logo for this project
into assets/logo.png"_. The extra tools: `web_search`, `x_search`, `generate_image`, `generate_video`. Everything
else is pi: see `/` for commands, and [pi's docs](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs)
for skills, extensions, themes and keybindings.

Config lives in `~/.grokbot/agent/` (separate from a stock pi install). Project-level `.pi/` folders and
`~/.agents/skills` are picked up as in pi.

## Use it from Claude Code

```bash
claude mcp add --scope user grokbot -- grokbot mcp
```

On native Windows: `claude mcp add --scope user grokbot -- cmd /c grokbot mcp`.

Then ask Claude things like _"use grok to search X for reactions to the new React compiler"_ or
_"have the grok agent audit src/auth and report back"_.

| Tool | What it does |
|---|---|
| `grok_ask` | One-shot prompt to a Grok model; pass `images` (paths/URLs) for vision. Second opinions, brainstorming. |
| `grok_search_web` | Live web search with cited sources. `allowed_domains`, `excluded_domains`. |
| `grok_search_x` | Real-time X (Twitter) search. `handles`, `excluded_handles`, `from_date`, `to_date`. |
| `grok_generate_image` | Text-to-image or image edit (`source`). Saved locally, returns paths. |
| `grok_generate_video` | Text-to-video or image-to-video. Saved locally, returns the path. |
| `grok_agent` | Runs the full grokbot agent in `directory`. Returns its answer, tool trail, cost and a `session_id` you can pass back to continue. Sends MCP progress per tool call. `read_only: true` limits it to read/search tools (no shell, no edits, no MCP servers). |
| `grok_models` | Lists Grok model ids, context sizes and prices. |
| `bot_*` | Your Grok Bot app bots: `bot_send`, `bot_wait`, `bot_read`, `bot_stop`, `bot_list`, `bot_create`, `bot_computers`, `bot_files`, `bot_download` ([below](#your-bots-in-the-grok-bot-app)). |
| `vault_*` | The app's vault: `vault_list`, `vault_add_login`, `vault_delete`, `vault_forms`, `vault_form_put`, `vault_form_delete`. Logins go in, passwords never come out ([below](#the-vault-logins-your-bots-fill-in)). |

The MCP server uses the same credentials as the CLI (`XAI_API_KEY`, or whatever you signed in with via `/login`).

Other MCP hosts take the same command, e.g. `.mcp.json`:

```json
{ "mcpServers": { "grokbot": { "command": "grokbot", "args": ["mcp"] } } }
```

### Give Grok access to email (or anything else)

`grok_agent` runs grokbot with its own MCP servers, so whatever you connect to grokbot, Claude can reach through it.
Add servers with pi's MCP commands (stored in `~/.grokbot/agent/mcp.json`, see
[pi's MCP docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)), e.g. a Gmail server:

```bash
grokbot mcp add gmail -- npx -y @gongrzhe/server-gmail-autoauth-mcp
```

Check with `grokbot mcp list`, then from Claude: _"ask the grok agent to summarize today's unread email"_.

## Your bots in the Grok Bot app

grokbot also talks to the bots in xAI's official **Grok Bot** desktop app (signed in with the same Cursor account):

```bash
grokbot bot list                                  # your bots
grokbot bot send "summarize my unread email"      # message your main bot, print its replies
grokbot bot send --bot "giggle work" --no-wait "..."
grokbot bot read --bot "Grok Bot" 20              # last 20 messages
grokbot bot create "Design QA" "Clicks through sites like a real user"
```

`send` waits until the bot has really finished (bots often reply "on it" first and keep working) and shows what it is
doing meanwhile. Bots work on their own computer, with a real browser, so they can test a site the way a user would:

```bash
grokbot bot send --bot "Design QA" --download ./qa \
  "Open https://example.com, sign up, check out, screenshot desktop and mobile, list every design and UX problem"
grokbot bot send --file mockup.png "Does the live page match this mockup?"   # attach local files
grokbot bot wait --download ./qa                  # still working after a timeout? wait for the rest
grokbot bot stop                                  # stop whatever it is doing
grokbot bot files                                 # files the bot saved
grokbot bot download <path> ./qa                  # any file it sent or saved (never overwrites)
```

**On your own computer.** With the Grok Bot app open on a computer, a bot can work there instead, so it can test
`localhost`. Each command it wants to run there asks for your approval in the app; `send` and `wait` show the request
and return with a waiting notice while it is pending. Continue with wait after approving.

```bash
grokbot bot computers                             # computers with the Grok Bot app open
grokbot bot send --computer "Try the signup flow on http://localhost:3000"
grokbot bot send --computer=work-laptop "..."     # pick one when several are open
```

Inside `grokbot` itself, each bot is also a model: pick one with `/model` (or `grokbot --model grok-bot`) and chat
with it right in the TUI; switch bots the same way. Messages appear in the app as sent by you.

Claude Code gets the same through MCP: `bot_send` (with `files` (images), `computer` and `download_dir`; screenshots are saved locally,
`inline_images: true` includes selected previews, and the bot's activity arrives as progress), `bot_wait`, `bot_read`, `bot_stop`,
`bot_list`, `bot_create`, `bot_computers`, `bot_files` and `bot_download`. For example: _"build the page, then have
the Design QA bot click through it on my computer and fix what it finds"_.

This is an **unofficial** client of the app's private API (the requests the app itself makes, with your own login): it
can break when the app updates, and using it is at your own risk under xAI's and Cursor's terms. The token comes from
`cursor-agent login` (the macOS Keychain, or `~/.config/cursor/auth.json` on Linux) or `CURSOR_ACCESS_TOKEN`
(`GROKBOT_KEYCHAIN=0` skips the Keychain); it is only sent to the API, over HTTPS.

## Bot diagnostics and status

```bash
grokbot help
grokbot bot list --ids                    # numeric ids and UUIDs
grokbot bot list --json                   # structured metadata
grokbot bot info "Account Agent"          # details and operation availability
grokbot bot status                        # one overview of every bot
grokbot bot status --bot "Account Agent" --json
grokbot doctor                           # authentication, vault counts, skills and routines
grokbot doctor --bot "Account Agent" --require-skill account-chores --json
```

`bot status` distinguishes `running`, `waiting_for_secret`, `waiting_for_approval`, `error`, `idle` and
`unknown`. It reads live state and at most 100 recent transcript entries per bot, with up to four transcript reads
at once. Missing, malformed or incomplete evidence is reported rather than guessed. A known pending request or
working state can still be shown alongside an uncertainty note. Message bodies and submitted values are omitted.
The command exits 1 when a bot's state is unknown.

`doctor` is read-only. It lists skill names and vault counts, checks required skills, reports disabled/failed
routines and explains server restrictions. It never reads inbox files or includes form values, passwords, API keys
or skill bodies in its output. `ok: false` / exit 1 means a check failed; warnings, such as an empty login vault,
remain visible without making the report fail. Scope a large account with `--bot`; diagnostics inspect at most 100
bots within a 60-second deadline. `--require-skill NAME` can be repeated up to 20 times.

MCP exposes `bot_info`, `bot_status`, and `grokbot_doctor` as read-only tools. `bot_list` accepts `ids: true` or
`json: true`. An oversized JSON response returns a clear error instead of truncated JSON. Restart an existing MCP
host to refresh its tool list after rebuilding this checkout.

## MCP context budget

Bot replies and agent answers use a 12,000-character preview by default. Longer results are saved in full as private
text files under `.grokbot/bot-files`; the response links to the file so the host can read just the relevant part.
Session ids and wait cursors precede the answer and remain visible. If saving fails, the preview says so. The
server-owned `GROKBOT_MCP_MAX_TEXT` environment variable accepts 1000–60000 characters.

`bot_status` and `grokbot_doctor` use compact JSON by default; pass `details: true` for the full MCP result. Errors,
warnings, unknown states and bot scope are retained. CLI JSON remains complete. Agent tool trails aggregate repeated
calls with counts, and the subprocess summary consumes events incrementally rather than retaining full tool outputs.

`bot_send` returns `next_after_seq`. Pass it to `bot_wait` as `after_seq` on the **same bot** to omit already seen
replies. The cursor stays before pending owner requests and streaming entries because they can update in place,
including initially empty placeholders. A wait returns promptly with `done: false` when owner input is required;
a resolved/dismissed widget never implies that a secret was supplied or permission was granted.

Automatic file downloads return paths by default. `inline_images: true` opts into at most four images and 8 MiB
combined per send/wait call; individual images remain capped at 4 MiB. `bot_download` still returns a deliberately
requested image inline by default; `inline_image: false` saves it without adding image content to context.

```bash
npm run measure:context                   # synthetic sizes and MCP definition size; no model calls
npm run measure:context -- --live          # additionally measure read-only doctor/status responses
```

These measurements count characters, not billed tokens. They do not predict a subscription quota reduction.
See [validation and known limitations](docs/VALIDATION.md) for the test coverage and reproducible size measurements.

## Bot skills, one-time values and server restrictions

```bash
grokbot skills put account-chores --bot "Account Agent" --file skills/account-chores/SKILL.md
grokbot skills list --bot "Account Agent"
grokbot submit "Account Agent"            # pending requests with entry ids
grokbot submit "Account Agent" ENTRY_ID --value-stdin
grokbot secrets put "Team Bot" API_KEY --value-stdin
```

The account-chores file is an instruction template in this checkout. It limits browser chores to authorized sites,
uses vault logins, requests one-time values through the structured secret UI, and waits for a concrete brief before
acting. Uploading the template does not start any chore.

Named secrets are a **team-shared bot feature** on the current server. The client verifies team sharing and
management rights before opening a staged file or sending a value. It never shares a personal bot automatically.
Personal bots can still receive one-time values and use vault logins. For MCP, named values use
`~/.grokbot/secret-inbox/put.<agent UUID>.<name>` and one-time values use
`~/.grokbot/secret-inbox/submit.<agent UUID>.<entry id>`; files are bound to that purpose, expire after 15 minutes,
and are consumed only after successful delivery. Errors from calls carrying values use fixed local messages.

The current backend rejects conversation reset for temporal bots. `bot fresh` detects this before sending a reset;
`bot info` reports the restriction. Making a skill private is offered only for a skill reported as inherited from
a plugin; unsupported conversion fails clearly and never claims a private copy was made. Regular skill
create/read/update/remove operations work independently.

Manual routine runs require a bot this account owns or manages, explicit OPEN permission, exact target resolution,
and the server's own authorization. MCP additionally requires `GROKBOT_MCP_ADMIN=1`. There is no invented RUN enum
permission. Deleting the last routine handles omitted protobuf repeated fields with an independent readback;
malformed or incomplete verification data is refused without replaying the write.

## The vault: logins your bots fill in

The app keeps the logins, cards and contact details a bot fills into forms for you. grokbot can see what is in there
and put new logins in — but no client can read a password back out, because the app's API has no field for one. A
password goes in, and only the app and the bot filling the form ever see it again.

```bash
grokbot vault list                                # what is in it (titles, user names, sites, card ••1234)
grokbot vault list --kind login --ids              # with ids, for rm
grokbot vault add --title "Acme staging" --site app.example.com --user me@example.com --password-stdin
pbpaste | grokbot vault add --title Acme --site example.com --password-stdin
grokbot vault add --title Acme --site example.com --password-file ./pw
grokbot vault add --id <id> --title Acme --site example.com --password-stdin   # replace an existing login
grokbot vault rm <id>                             # the password is not recoverable afterwards
grokbot vault card <id> --expiry 09/28            # fix up a card's holder, expiry or nickname (never its number)
```

The password is never a command-line argument or an environment variable: it comes from stdin (echo off on a
terminal) or a small regular file you own (no symlinks), so it stays out of your shell history, `ps` and child
processes.

Separately from the logins there are the plain **form answers** a bot reuses — a name, a phone number, an address
line. Supported kinds are `name`, `email`, `phone`, `address`, and `extra` (`profile` is not supported). These
values are readable on purpose, so secrets are refused there and pointed at `vault add` instead:

```bash
grokbot vault forms                               # saved answers
grokbot vault form-put --kind phone --label phone --value "+420 600 000 000"
grokbot vault form-rm <id>
```

Claude Code gets the same through MCP: `vault_list`, `vault_add_login`, `vault_delete`, `vault_forms`,
`vault_form_put`, `vault_form_delete`. `vault_add_login` has no password argument at all. You leave the password in
`~/.grokbot/vault-inbox/<site>` (`pbpaste > ~/.grokbot/vault-inbox/app.example.com`); the server reads it, saves it
for that site only, and deletes the file. The model never sees the value and can't choose where it comes from or
which site gets it. Replacing an existing login stays a CLI step. A request like _"save the staging login I put in the
inbox, then have the bot sign in and set up my profile"_ never hands the model a secret.

## Skills

grokbot uses pi's [skills](https://agentskills.io) (`~/.agents/skills`, `~/.grokbot/agent/skills`, project
`.agents/skills`). A skill's instructions load only when a task needs them. With more than 30 skills installed, even
the list of names and descriptions stays out of the prompt: Grok looks skills up with the `find_skill` tool instead,
which keeps a turn around 20k tokens rather than 100k+. `/skill:name` still loads one directly.

## Security

The grokbot agent (and so `grok_agent`) reads and writes files and runs shell commands as your user, like pi and
Claude Code do. Point `grok_agent` only at directories you trust, and prefer `read_only: true` for research and reviews.
The MCP tools carry annotations (`grok_agent` is marked destructive), so hosts like Claude Code ask before running it
unless you allow it. Image sources must be real images, downloads only reach public hosts, and generated files stay
inside the working directory.

Bots browse pages anyone can write, and their replies reach the model calling the MCP tools, so the bot tools treat
what that model asks for as untrusted:

- `bot_send` attaches only real images, never hidden files (no `~/.ssh`, no `.env`). To let it send other files from
  the working directory, start the server with `GROKBOT_MCP_SEND_FILES=1`; the model can't turn that on.
- Files from a bot are saved in a temp folder, or under `.grokbot/bot-files` in the working directory (never where a
  test runner or linter picks files up), under plain names, never over an existing file, readable only by you.
- Bot text loses terminal control characters and is capped; the tool descriptions mark it as untrusted.
- Tools that delete, overwrite a bot's instructions or make a bot act outward (`bot_update`, `bot_delete`,
  `bot_fresh_conversation`, `bot_skill_put|remove|make_private`, `bot_secret_delete`, `automation_run|set_enabled|delete`)
  are only offered when you start the server with `GROKBOT_MCP_ADMIN=1`; the model can't turn that on. The CLI
  (`grokbot bot rm`, `grokbot automations run`, ...) always has them.
- The Cursor token only goes to `*.cursor.sh` over HTTPS, without following redirects.

The vault tools are built so a secret never has to pass through a model:

- Nothing returns a password, a card number or a CVV — the API itself has no field for them, so `vault_list` can show
  that a login exists without being able to leak it.
- `vault_add_login` has no password, env-var or path argument. The only source is `~/.grokbot/vault-inbox/<site>`
  (a `700` directory; a regular file you own, no symlinks, at most 1 KB), deleted once saved. So a prompt-injected
  model can't send your Cursor token or an SSH key to a site of its choosing, and the file's name binds the password to
  the site you meant. Over MCP logins can only be created, never overwritten.
- A call that carries a password never shows the server's reply: errors become a fixed local message,
  and confirmations are built only from what was sent. Neither status codes nor server-generated ids are echoed from
  a secret-bearing response. Both inboxes reject stale, linked, replaced or oversized files and use atomic claims;
  same-user processes that can write these directories are outside this boundary.
- Everything read from the vault is cleaned of control characters and capped before it reaches a terminal or a model;
  response bodies are read with a size limit.
- Form answers, which *are* readable, refuse password-, code-, token- and key-shaped fields and point at a login. That
  is a guard against mistakes, not a boundary: don't keep secrets there.
- A site is a bare DNS host name, so a typo can't widen a login to a whole domain or a URL with a path.
- `vault_delete` is marked destructive and is offered over MCP only in admin mode: a deleted password is not
  recoverable from anywhere. CLI deletion remains an explicit user operation.

Still, `bot_send`, `bot_create` and `bot_stop` are marked destructive: a bot can browse, email and act as you, and
with `computer` it runs commands on your machine. Approve each command in the Grok Bot app rather than "always", and
use `bot_stop` if a run goes wrong. `grok_agent` runs as your user, so it could read the Cursor login too: keep it on
directories you trust. pi's [security notes](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)
apply; its example `sandbox` and `permission-gate` extensions can add a boundary or approvals.

## Development

```bash
git clone https://github.com/cufelix/grokbot-cli-mcp && cd grokbot-cli-mcp
npm ci
npm test
npm run build && node dist/cli.js
npm run smoke                            # stdio MCP startup and tool registration; no live writes
npm run check:app                        # compare installed Electron schemas to the captured contract
npm run test:live -- --write              # opt-in synthetic live MCP lifecycle test; uses your Grok Bot plan
```

| File | Role |
|---|---|
| `src/cli.ts` | Entry: `grokbot mcp` → MCP server, everything else → pi's `main()` with the grok extension |
| `src/extension.ts` | pi extension: Grok tools + grokbot header |
| `src/mcp.ts` | MCP server |
| `src/xai.ts` | xAI search / image / video calls (shared by both) |
| `src/setup.ts` | Config dir, env aliases, default model |
| `src/login.ts` | `grokbot login` / `logout` |
| `src/cursor.ts` | Grok through `cursor-agent` (Cursor sign-in) |
| `src/skills.ts` | `find_skill`: skills on demand |
| `src/bots.ts` | Grok Bot app client (send, wait, files, computers) |
| `src/bot-cli.ts` | `grokbot bot ...` commands |
| `src/vault.ts` | The app's vault: logins in (never out), cards, form answers |
| `src/vault-cli.ts` | `grokbot vault ...` commands |
| `src/bot-provider.ts` | Bots as `/model` models in the TUI |
| `src/inspection.ts` | Read-only doctor, status, ids and bot details |
| `src/inbox.ts` | Shared single-use inbox handling |
| `fixtures/grokbot-app-contract.json` | Captured app schemas used to detect API drift |

Releases: bump `version`, publish a GitHub release, and `.github/workflows/publish.yml` publishes to npm
(needs an `NPM_TOKEN` repo secret).

The live test creates a randomly named disposable bot, uses synthetic values under `example.com`, and removes its
own bot, routine and vault data in `finally`. It checks OTP delivery and a routine running to completion through the
actual MCP process. Failures and cleanup results are saved in a private temp report. Team-secret success and private
conversion require suitable shared fixtures and are not claimed by this personal-bot smoke test.

`check:app` defaults to the macOS Grok Bot installation; use `--asar /path/to/app.asar` on another installation. It
reads static descriptors without executing Electron code or accessing user data, and fails on contract drift.

## Credits

Built on [pi](https://github.com/earendil-works/pi) by Earendil (MIT). Search and media code ported from
[superagent-ai/grok-cli](https://github.com/superagent-ai/grok-cli) (MIT). Not affiliated with xAI. "Grok" is a
trademark of xAI Corp.
