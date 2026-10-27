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

Works on **Linux, macOS and Windows** (Node.js ≥ 22.19).

```
                ┌─ grokbot (TUI) ── you
pi + grok ext ──┤
                └─ grokbot mcp ──── Claude Code ─ grok_ask · grok_search_x · grok_search_web
                                                  grok_generate_image · grok_generate_video
                                                  grok_agent ─▶ grokbot --mode json (files, shell, its own MCPs)
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
and keep waiting while it is pending.

```bash
grokbot bot computers                             # computers with the Grok Bot app open
grokbot bot send --computer "Try the signup flow on http://localhost:3000"
grokbot bot send --computer=work-laptop "..."     # pick one when several are open
```

Inside `grokbot` itself, each bot is also a model: pick one with `/model` (or `grokbot --model grok-bot`) and chat
with it right in the TUI; switch bots the same way. Messages appear in the app as sent by you.

Claude Code gets the same through MCP: `bot_send` (with `files` (images), `computer` and `download_dir`; screenshots come back
inline, so Claude sees them, and the bot's activity arrives as progress), `bot_wait`, `bot_read`, `bot_stop`,
`bot_list`, `bot_create`, `bot_computers`, `bot_files` and `bot_download`. For example: _"build the page, then have
the Design QA bot click through it on my computer and fix what it finds"_.

This is an **unofficial** client of the app's private API (the requests the app itself makes, with your own login): it
can break when the app updates, and using it is at your own risk under xAI's and Cursor's terms. The token comes from
`cursor-agent login` (the macOS Keychain, or `~/.config/cursor/auth.json` on Linux) or `CURSOR_ACCESS_TOKEN`
(`GROKBOT_KEYCHAIN=0` skips the Keychain); it is only sent to the API, over HTTPS.

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
- The Cursor token only goes to `*.cursor.sh` over HTTPS, without following redirects.

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
node scripts/smoke.mjs "node dist/cli.js"   # or after `npm i -g .`: node scripts/smoke.mjs
```

| File | Role |
|---|---|
| `src/cli.ts` | Entry: `grokbot mcp` → MCP server, everything else → pi's `main()` with the grok extension |
| `src/extension.ts` | pi extension: Grok tools + grokbot header |
| `src/mcp.ts` | MCP server |
| `src/xai.ts` | xAI search / image / video calls (shared by both) |
| `src/setup.ts` | Config dir, env aliases, default model |

Releases: bump `version`, publish a GitHub release, and `.github/workflows/publish.yml` publishes to npm
(needs an `NPM_TOKEN` repo secret).

## Credits

Built on [pi](https://github.com/earendil-works/pi) by Earendil (MIT). Search and media code ported from
[superagent-ai/grok-cli](https://github.com/superagent-ai/grok-cli) (MIT). Not affiliated with xAI. "Grok" is a
trademark of xAI Corp.
