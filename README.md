# openclaw-claude-proxy

> **Already paying for Claude Pro/Max? Use it as your OpenClaw model provider — $0 extra API cost.**

A lightweight, zero-dependency proxy that lets [OpenClaw](https://github.com/openclaw/openclaw) agents talk to Claude through your existing subscription. One command to set up, one file to run.

## v2.5.0 — Emergency Fix: Sliding-Window Circuit Breaker

**Incident (2026-03-22):** Multi-agent burst (ClawTeam with 5+ Opus agents) caused cascading timeout failure. The old consecutive-count circuit breaker (threshold=3) tripped within seconds, blocking ALL requests globally — including unrelated agents and new sessions. With fallback models removed, this resulted in complete service outage ("LLM request timed out." on every message).

**Root cause:** v2.4.0's circuit breaker counted consecutive failures per model. When ClawTeam spawned multiple concurrent Opus agents and Claude API had moderate latency, 3 quick timeouts opened the breaker for the entire model. With `fallbacks: []`, the gateway had no alternative path.

**What's new in v2.5.0:**
- **Sliding-window circuit breaker** — counts failures in a 5-minute window (default: 6 failures) instead of 3 consecutive. Multi-agent bursts no longer trip the breaker instantly.
- **Graduated backoff** — cooldown doubles on each re-open (120s → 240s → 300s cap), resets fully on first success. Prevents oscillation between open/half-open during extended API issues.
- **Multi-probe half-open** — allows 2 concurrent probe requests in half-open state (was 1), improving recovery speed.
- **Increased default timeouts** — Opus first-byte 60s→90s, Sonnet 45s→60s, overall 120s→300s, max concurrent 5→8. Designed for large agent system prompts (30K+ chars).
- **Health endpoint shows breaker state** — `/health` now exposes per-model breaker state (window failures, cooldown, reopen count). Status is "degraded" when any breaker is open.

**New env vars:**

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_BREAKER_WINDOW` | `300000` | Sliding window duration (ms) for failure counting |
| `CLAUDE_BREAKER_HALF_OPEN_MAX` | `2` | Max concurrent probe requests in half-open state |

**Updated defaults:**

| Variable | Old Default | New Default |
|----------|-------------|-------------|
| `CLAUDE_TIMEOUT` | `120000` | `300000` |
| `CLAUDE_FIRST_BYTE_TIMEOUT` | `45000` | `90000` |
| `CLAUDE_MAX_CONCURRENT` | `5` | `8` |
| `CLAUDE_BREAKER_THRESHOLD` | `3` | `6` |
| `CLAUDE_BREAKER_COOLDOWN` | `60000` | `120000` |

**Upgrade:** Pull latest and restart the proxy. The new defaults take effect immediately. If you have custom env vars set in your plist/service file, review and adjust them.

---

## v2.0.0 — Major Upgrade

**What's new:**
- **On-demand spawning** — eliminates the pool crash loops, DEGRADED states, and stdin timeout errors from v1.x. Each request spawns a fresh `claude -p` process with stdin written immediately. No more stale workers, no more backoff spirals.
- **Session management** — multi-turn conversations use `--resume` to avoid resending full history. Reduces token waste and enables Claude Code's built-in context compression on long conversations.
- **Full tool access** — expanded default tools (Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Agent). Configurable via `CLAUDE_ALLOWED_TOOLS` or bypass all checks with `CLAUDE_SKIP_PERMISSIONS=true`.
- **System prompt pass-through** — set `CLAUDE_SYSTEM_PROMPT` to inject context into every request.
- **MCP config support** — set `CLAUDE_MCP_CONFIG` to load MCP servers (Telegram, etc.) into claude -p calls.
- **Concurrency control** — `CLAUDE_MAX_CONCURRENT` prevents runaway process spawning (default: 5).
- **Auth health monitoring** — periodic `claude auth status` checks with status exposed on `/health`.
- **Session API** — `GET /sessions` to list, `DELETE /sessions` to clear active sessions.
- **Improved diagnostics** — `/health` endpoint shows stats, active sessions, recent errors, auth status, and full config.

**Coexistence with Claude Code interactive mode:**
OCP and Claude Code (interactive/Telegram) run on completely different paths and can coexist on the same machine without conflict:
- OCP: `localhost:3456` (HTTP) → spawns `claude -p` processes (per-request, stateless)
- CC: MCP protocol (in-process) → persistent interactive session
- No shared ports, no shared processes, no shared sessions

**Daemon advantage over CC:**
OCP runs as a system daemon (launchd/systemd) that auto-starts on boot and auto-recovers from crashes. Unlike Claude Code interactive mode, OCP does not require a terminal session to stay open — it survives disconnects, reboots, and SSH drops. Combined with OpenClaw's memory system, this means your agents never lose continuity.

## How it works

```
OpenClaw Gateway → proxy (localhost:3456) → claude -p CLI → Anthropic (via OAuth)
```

The proxy translates OpenAI-compatible `/v1/chat/completions` requests into `claude -p` CLI calls. Anthropic sees normal Claude Code usage under your subscription — no API billing, no separate key.

## Prerequisites

- **Node.js** >= 18
- **Claude CLI** installed and authenticated (`claude login`)
- **OpenClaw** installed

## Quick Start (Node.js)

```bash
git clone https://github.com/dtzp555-max/openclaw-claude-proxy.git
cd openclaw-claude-proxy

# Auto-configure OpenClaw + start proxy + install auto-start
node setup.mjs
```

That's it. The setup script will:
1. Verify Claude CLI is installed and authenticated
2. Add `claude-local` provider to `openclaw.json`
3. Add auth profiles to all agents
4. Start the proxy
5. Install auto-start on login (launchd on macOS, systemd on Linux)

Then set your preferred Claude model as default:
```bash
openclaw config set agents.defaults.model.primary "claude-local/claude-opus-4-6"
openclaw gateway restart
```

## Session Management (v2.0)

Multi-turn conversations can use sessions to avoid resending full message history on every request.

**How to enable:** Include a `session_id` or `conversation_id` field in your request body, or set the `X-Session-Id` / `X-Conversation-Id` header.

```json
{
  "model": "claude-opus-4-6",
  "session_id": "conv-abc-123",
  "messages": [
    {"role": "user", "content": "Hello"},
    {"role": "assistant", "content": "Hi there!"},
    {"role": "user", "content": "What did I just say?"}
  ]
}
```

**First request** with a new session_id: all messages are sent, session is persisted via `--session-id`.
**Subsequent requests** with the same session_id: only the latest user message is sent via `--resume`, reducing token consumption.

Sessions expire after 1 hour of inactivity (configurable via `CLAUDE_SESSION_TTL`).

**API endpoints:**
- `GET /sessions` — list all active sessions
- `DELETE /sessions` — clear all sessions

## Security

- **Localhost only** — the proxy binds to `127.0.0.1` and is not exposed to the internet or your local network
- **Bearer token auth (optional)** — set `PROXY_API_KEY` to require a Bearer token on all requests (except `/health`). When unset, auth is disabled for backwards compatibility
- **No API keys for Claude** — authentication to Anthropic goes through Claude CLI's OAuth session, no Anthropic credentials are stored in the proxy
- **Auto-start via launchd/systemd** — `node setup.mjs` installs a user-level launch agent (macOS) or systemd user service (Linux) so the proxy starts automatically on login
- **Remove auto-start** at any time:

```bash
node uninstall.mjs
```

## Manual Install

### 1. Start the proxy

```bash
node server.mjs
# or in background:
bash start.sh
```

### 2. Configure OpenClaw

Add to `~/.openclaw/openclaw.json` under `models.providers`:

```json
"claude-local": {
  "baseUrl": "http://127.0.0.1:3456/v1",
  "api": "openai-completions",
  "apiKey": "<your PROXY_API_KEY, or omit if auth disabled>",
  "models": [
    {
      "id": "claude-opus-4-6",
      "name": "Claude Opus 4.6",
      "reasoning": true,
      "input": ["text"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 200000,
      "maxTokens": 16384
    },
    {
      "id": "claude-sonnet-4-6",
      "name": "Claude Sonnet 4.6",
      "reasoning": true,
      "input": ["text"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 200000,
      "maxTokens": 16384
    },
    {
      "id": "claude-haiku-4",
      "name": "Claude Haiku 4",
      "reasoning": false,
      "input": ["text"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 200000,
      "maxTokens": 8192
    }
  ]
}
```

### 3. Set as default model

```bash
openclaw config set agents.defaults.model.primary "claude-local/claude-opus-4-6"
openclaw gateway restart
```

## Available Models

| Model ID | Claude CLI model | Notes |
|----------|-----------------|-------|
| `claude-opus-4-6` | claude-opus-4-6 | Most capable, slower |
| `claude-sonnet-4-6` | claude-sonnet-4-6 | Good balance of speed/quality |
| `claude-haiku-4` | claude-haiku-4-5-20251001 | Fastest, lightweight |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PROXY_PORT` | `3456` | Listen port |
| `CLAUDE_BIN` | *(auto-detect)* | Path to claude binary |
| `CLAUDE_TIMEOUT` | `300000` | Overall request timeout (ms) |
| `CLAUDE_FIRST_BYTE_TIMEOUT` | `90000` | Base first-byte timeout (ms), adaptive by model tier |
| `CLAUDE_ALLOWED_TOOLS` | `Bash,Read,...,Agent` | Comma-separated tools to pre-approve |
| `CLAUDE_SKIP_PERMISSIONS` | `false` | Set `true` to bypass all permission checks |
| `CLAUDE_SYSTEM_PROMPT` | *(empty)* | System prompt appended to all requests |
| `CLAUDE_MCP_CONFIG` | *(empty)* | Path to MCP server config JSON file |
| `CLAUDE_SESSION_TTL` | `3600000` | Session expiry in ms (default: 1 hour) |
| `CLAUDE_MAX_CONCURRENT` | `8` | Max concurrent claude processes |
| `CLAUDE_BREAKER_THRESHOLD` | `6` | Failures in window before circuit opens |
| `CLAUDE_BREAKER_COOLDOWN` | `120000` | Base cooldown (ms) before half-open (graduates on re-open) |
| `CLAUDE_BREAKER_WINDOW` | `300000` | Sliding window duration (ms) for failure counting |
| `CLAUDE_BREAKER_HALF_OPEN_MAX` | `2` | Max concurrent probe requests in half-open state |
| `PROXY_API_KEY` | *(unset)* | Bearer token for API authentication |

## API Endpoints

- `GET /v1/models` — List available models
- `POST /v1/chat/completions` — Chat completion (streaming + non-streaming)
- `GET /health` — Comprehensive health check (stats, sessions, auth, config)
- `GET /sessions` — List active sessions
- `DELETE /sessions` — Clear all sessions

## Authentication

The proxy supports optional Bearer token authentication via the `PROXY_API_KEY` environment variable.

**When `PROXY_API_KEY` is set**, all requests (except `GET /health`) must include a valid `Authorization: Bearer <token>` header. Requests with a missing or invalid token receive a `401 Unauthorized` response.

**When `PROXY_API_KEY` is not set**, authentication is disabled and all requests are accepted.

```bash
# Start with auth enabled
PROXY_API_KEY=my-secret-token node server.mjs
```

## Architecture: v1 vs v2

| | v1.x (pool) | v2.0 (on-demand) |
|---|---|---|
| Process lifecycle | Pre-spawn idle workers | Spawn per request |
| Crash handling | Backoff → DEGRADED → manual restart | No crash loops (no idle workers) |
| Session support | None (stateless) | --resume with session tracking |
| Tool access | 6 tools hardcoded | Configurable, expanded defaults |
| System prompt | None | CLAUDE_SYSTEM_PROMPT env |
| MCP support | None | CLAUDE_MCP_CONFIG env |
| Concurrency | Unlimited (dangerous) | CLAUDE_MAX_CONCURRENT limit |
| Auth monitoring | None | Periodic health checks |
| Diagnostics | Basic /health | Full stats, sessions, errors |

## Coexistence with Claude Code

OCP and Claude Code interactive mode (including Telegram bots) are completely independent:

| | OCP (this proxy) | CC interactive |
|---|---|---|
| Protocol | HTTP (localhost:3456) | MCP (in-process) |
| Process model | Per-request spawn | Persistent session |
| Lifecycle | Daemon (auto-start, auto-recover) | Requires terminal |
| Permission model | Pre-approved tools | Interactive prompts |
| Use case | Automated agent work | Human-in-the-loop |

Both can run on the same machine simultaneously. No shared state, no port conflicts.

## Recovery after OpenClaw upgrade

OpenClaw upgrades (`npm update -g openclaw`) **do not overwrite** the user config at `~/.openclaw/openclaw.json`. However, if the claude-local models stop working after an upgrade:

### One-command recovery

```bash
cd ~/.openclaw/projects/claude-proxy   # or wherever you cloned it
git pull                                # pull latest version
node setup.mjs                          # reconfigure OpenClaw + start proxy
openclaw gateway restart
```

## Notes

- Cost shows as $0 because billing goes through your Claude subscription
- Each request spawns a `claude -p` process; concurrent requests are capped by `CLAUDE_MAX_CONCURRENT`
- The proxy must run on the same machine as the Claude CLI (uses local OAuth)
- Session data is stored by Claude CLI on disk; session map is in-memory (lost on proxy restart)

## License

MIT
