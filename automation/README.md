# Automation v2

Chat-first local AI orchestrator for Telegram + Linear + Codex.

## What it runs

- `task-hub`: local API and canonical task database
- `telegram-bot`: Telegram long polling intake and reply channel
- `chat-orchestrator`: Codex-powered chat worker with internal tools
- `linear-sync`: Linear import/comment sync
- `workers`: chat, triage, and execute via local Codex runtime

## Runtime data

All runtime files live under `.rbxmcp/automation/`:

- `config.local.json`
- `db.sqlite`
- `artifacts/`
- `logs/`
- `tmp/`

## Start

From the repo root:

```powershell
npm.cmd run automation:dev
```

Or double-click:

```cmd
tools\start-automation.cmd
```

The first run creates `.rbxmcp/automation/config.local.json` and seeds `projectMappings` from launcher profiles.

## Minimal setup

Fill these sections in `.rbxmcp/automation/config.local.json`:

- `telegram.botToken`
- `telegram.enabled = true`
- `linear.apiKey`
- `linear.enabled = true`
- `projectMappings[].telegramChatId`
- `projectMappings[]` Linear mapping fields if needed

## Codex worker runtime

Default runtime is `wsl`.

Current supported modes:

- `wsl`
- `windows`
- `mock`

`wsl` mode requires:

- WSL installed
- a working Codex CLI command in `codex.wslCommand`

Example shape:

```json
{
  "codex": {
    "runtime": "wsl",
    "timeoutMs": 900000,
    "wslDistro": "",
    "wslCommand": "your-codex-worker-command-here",
    "linuxWorkspaceRoot": "",
    "windowsCommand": ""
  }
}
```

If WSL is not available yet, set `codex.runtime` to `mock` while wiring Telegram/Linear.

## Local API

Task Hub listens on `http://127.0.0.1:5130` by default.

Useful endpoints:

- `GET /healthz`
- `GET /profiles`
- `GET /tasks`
- `GET /tasks/:id`
- `POST /events/telegram`
- `POST /events/linear`
- `POST /tasks/:id/commands`

## Behavior

- Telegram is now chat-first. The normal UX is free-form Russian conversation.
- The agent can:
  - search live Linear issues
  - inspect local unfinished or blocked tasks
  - explain Roblox/launcher/MCP blockers
  - suggest simple tasks
  - propose execution in natural language
- Safe read/search/summarize actions run immediately.
- Execution still requires explicit confirmation.
- The old explicit commands still work as fallback:
  - `run <task-id>`
  - `status <task-id>`
  - `cancel <task-id>`
  - `ready <task-id>`
  - `retry <task-id>`
  - `model <name> [reasoning]`

## Local API

In addition to the old endpoints, v2 exposes:

- `POST /chat/telegram-event`
- `GET /tasks/search?q=...`
- `GET /tasks/blocked`
- `GET /linear/search?q=...`
- `GET /linear/issues/:identifier`
- `POST /tasks/:id/propose-execution`
- `POST /tasks/:id/confirm-execution`
