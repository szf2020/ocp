# openclaw-claude-proxy v2.3.0

Use your **Claude Pro / Max** subscription as an **OpenAI-compatible local endpoint**.

`openclaw-claude-proxy` accepts OpenAI-style chat completion requests, then runs them through the local `claude` CLI. That means tools which only know how to talk to an OpenAI API can still use Claude models through a local base URL.

## Why v2 matters

v2 is not just a bugfix release. It changes the runtime model:

- **On-demand spawning** instead of fragile warm pools
- **Session resume** support for multi-turn conversations
- **Faster fallback** with first-byte timeout + lower default request timeout
- **Full tool access** via configurable allowed tools
- **MCP config + system prompt pass-through**
- **Health / sessions / diagnostics endpoints**
- **Safe coexistence with Claude Code channel / interactive mode**

## The short pitch

If Claude's new channel workflow feels useful, OCP v2 now covers the same practical ground for many local agent/tooling setups:

- multi-turn continuity
- tool-enabled Claude runs
- local orchestration
- stable process isolation
- coexistence with your normal Claude Code workflow

And it adds a few advantages that channel users usually still want:

- **OpenAI-compatible HTTP API** for existing tools
- **Works with OpenClaw, Cursor, Continue, Open WebUI, LangChain, and anything with custom base URL support**
- **Explicit health checks and diagnostics**
- **Model/provider failover can happen outside Claude itself**
- **No lock-in to a single client UX**

## Coexistence with Claude Code channel

This is the important part: **OCP v2 does not replace Claude Code channel, and it does not need to. They can coexist on the same machine.**

### Claude Code channel / interactive mode
- persistent interactive workflow
- MCP protocol / in-process experience
- great when you are directly driving Claude Code

### OCP v2
- local HTTP server on `localhost`
- OpenAI-compatible API surface
- per-request `claude -p` execution with session resume when you want continuity
- ideal for external tools, routers, orchestrators, OpenClaw providers, and local automation

### Practical takeaway
Use both:
- use **Claude Code channel** when you want Claude's native interactive workflow
- use **OCP v2** when another app expects an OpenAI-style API but you still want to use Claude

They solve adjacent problems, not identical ones.

## Unique advantages of OCP v2

1. **API compatibility**
   - Drop into tools that already support OpenAI-compatible endpoints.
   - No need to wait for each tool to add native Claude channel support.

2. **Routing freedom**
   - Put OCP behind OpenClaw or another router.
   - Mix Claude with fallback providers outside the Claude client itself.

3. **Operational visibility**
   - `/health`, `/sessions`, recent errors, auth state, resolved binary path, timeout config.
   - Much easier to debug than a black-box local integration.

4. **Safer runtime model**
   - v2 removes the old pre-spawn pool crash loop.
   - No stale workers, no degraded warm pool states, fewer hidden failure modes.

5. **Configurable tools and behavior**
   - allowed tools
   - skip permissions mode
   - system prompt append
   - MCP config passthrough
   - session TTL
   - concurrency limits

## Install

```bash
git clone https://github.com/dtzp555-max/openclaw-claude-proxy
cd openclaw-claude-proxy
npm install
node server.mjs
```

Default base URL:

```text
http://127.0.0.1:3456/v1
```

## Quick OpenAI-compatible config

```json
{
  "baseURL": "http://127.0.0.1:3456/v1",
  "apiKey": "anything"
}
```

If `PROXY_API_KEY` is unset, auth is disabled. If you set it, pass it as a Bearer token.

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `CLAUDE_PROXY_PORT` | `3456` | Listen port |
| `CLAUDE_BIN` | auto-detect | Claude CLI binary path |
| `CLAUDE_TIMEOUT` | `120000` | Overall per-request timeout |
| `CLAUDE_FIRST_BYTE_TIMEOUT` | `30000` | Abort if Claude produces no stdout quickly |
| `CLAUDE_ALLOWED_TOOLS` | expanded set | Comma-separated allowed tools |
| `CLAUDE_SKIP_PERMISSIONS` | `false` | Bypass permission checks |
| `CLAUDE_SYSTEM_PROMPT` | unset | Append a system prompt to every request |
| `CLAUDE_MCP_CONFIG` | unset | Path to MCP config JSON |
| `CLAUDE_SESSION_TTL` | `3600000` | Session TTL |
| `CLAUDE_MAX_CONCURRENT` | `5` | Max concurrent Claude processes |
| `PROXY_API_KEY` | unset | Optional Bearer token auth |

## Endpoints

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `GET /sessions`
- `DELETE /sessions`

## Example health response highlights

`/health` reports useful operational state such as:

- resolved Claude binary path
- whether the binary is executable
- auth status
- timeouts
- current sessions
- recent errors
- basic request stats

## Version highlights

### v2.3.0
- clarified v2 positioning and coexistence story in docs
- officially documents faster fallback defaults
- recommends OCP v2 as the API bridge layer for Claude-powered tools

### v2.2.0
- first-byte timeout
- reduced default timeout for faster fallback

### v2.0.0
- on-demand architecture
- session management
- full tool access
- MCP + system prompt passthrough
- concurrency control
- coexistence with Claude Code interactive mode

## When to use OCP v2 vs Claude channel

Choose **OCP v2** when:
- your app only supports OpenAI-compatible endpoints
- you want routing / failover outside Claude
- you want explicit health checks and local diagnostics
- you want Claude available to multiple local tools through one endpoint

Choose **Claude channel** when:
- you are primarily living inside Claude Code itself
- you want Claude's native interactive workflow directly

Use **both together** when you want the best of both worlds.

---

If you already pay for Claude Pro or Max, OCP v2 turns that subscription into a practical local API bridge for the rest of your tooling stack.
