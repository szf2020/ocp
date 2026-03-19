#!/usr/bin/env node
/**
 * openclaw-claude-proxy — OpenAI-compatible proxy for Claude CLI
 *
 * Translates OpenAI chat/completions requests into `claude -p` CLI calls,
 * letting you use your Claude Pro/Max subscription as an OpenClaw model provider.
 *
 * Features:
 *   - Process pool: pre-spawns CLI processes to eliminate cold start latency
 *   - SSE streaming + non-streaming responses
 *   - Concurrent request support
 *
 * Env vars:
 *   CLAUDE_PROXY_PORT  — listen port (default: 3456)
 *   CLAUDE_BIN         — path to claude binary (default: "claude")
 *   CLAUDE_TIMEOUT     — per-request timeout in ms (default: 120000)
 *   CLAUDE_POOL_SIZE   — warm process pool size per model (default: 1)
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const PORT = parseInt(process.env.CLAUDE_PROXY_PORT || "3456", 10);
const CLAUDE = process.env.CLAUDE_BIN || "claude";
const TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT || "300000", 10);
const POOL_SIZE = parseInt(process.env.CLAUDE_POOL_SIZE || "1", 10);
const POOL_MAX_IDLE = parseInt(process.env.CLAUDE_POOL_MAX_IDLE || "60000", 10); // max idle time before recycle

const VERSION = "1.4.0";
const START_TIME = Date.now();

// Model alias mapping: request model → claude CLI --model arg
const MODEL_MAP = {
  "claude-opus-4-6": "opus",
  "claude-opus-4": "opus",
  "claude-sonnet-4-6": "sonnet",
  "claude-sonnet-4": "sonnet",
  "claude-haiku-4": "haiku",
};

const MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4", name: "Claude Haiku 4" },
];

// ── Process Pool ──────────────────────────────────────────────────────────
// Pre-spawns `claude -p` processes that read prompts from stdin.
// When a request arrives, we grab a warm process and pipe the prompt in.
// After the process finishes, a new one is spawned to replace it.

const pool = new Map(); // model → [{ proc, ready }]

function spawnWarm(cliModel) {
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const proc = spawn(CLAUDE, [
    "-p", "--model", cliModel,
    "--output-format", "text",
    "--no-session-persistence",
    "--allowedTools", "Bash", "Read", "Write", "Edit", "Glob", "Grep",
  ], { env, stdio: ["pipe", "pipe", "pipe"] });

  const entry = { proc, cliModel, ready: true, spawnedAt: Date.now() };

  proc.on("error", (err) => {
    console.error(`[pool] spawn error model=${cliModel}: ${err.message}`);
    entry.ready = false;
  });

  proc.on("exit", () => {
    entry.ready = false;
    // Remove from pool
    const arr = pool.get(cliModel);
    if (arr) {
      const idx = arr.indexOf(entry);
      if (idx !== -1) arr.splice(idx, 1);
    }
    // Replenish
    replenishPool(cliModel);
  });

  return entry;
}

// Recycle idle processes to prevent stale connections
function recycleStaleProcesses() {
  const now = Date.now();
  for (const [cliModel, arr] of pool) {
    for (const entry of arr) {
      if (entry.ready && (now - entry.spawnedAt) > POOL_MAX_IDLE) {
        console.log(`[pool] recycling stale process model=${cliModel} (idle ${Math.round((now - entry.spawnedAt) / 1000)}s)`);
        entry.ready = false;
        entry.proc.kill();
        // exit handler will replenish
      }
    }
  }
}

setInterval(recycleStaleProcesses, 15000); // check every 15s

function replenishPool(cliModel) {
  if (!pool.has(cliModel)) pool.set(cliModel, []);
  const arr = pool.get(cliModel);
  const alive = arr.filter((e) => e.ready).length;
  for (let i = alive; i < POOL_SIZE; i++) {
    const entry = spawnWarm(cliModel);
    arr.push(entry);
    console.log(`[pool] pre-spawned model=${cliModel} (pool size: ${arr.filter(e => e.ready).length})`);
  }
}

function getWarmProcess(cliModel) {
  const arr = pool.get(cliModel) || [];
  const entry = arr.find((e) => e.ready);
  if (entry) {
    entry.ready = false; // mark as in-use
    const warmMs = Date.now() - entry.spawnedAt;
    console.log(`[pool] using warm process model=${cliModel} (warm for ${warmMs}ms)`);
    return entry.proc;
  }
  return null;
}

// Initialize pool for all models
function initPool() {
  for (const cliModel of new Set(Object.values(MODEL_MAP))) {
    replenishPool(cliModel);
  }
}

// ── Call claude CLI ─────────────────────────────────────────────────────
function callClaude(model, messages) {
  return new Promise((resolve, reject) => {
    const prompt = messages
      .map((m) => {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        if (m.role === "system") return `[System] ${text}`;
        if (m.role === "assistant") return `[Assistant] ${text}`;
        return text;
      })
      .join("\n\n");

    const cliModel = MODEL_MAP[model] || model;

    // Try to use a warm process from the pool
    let proc = getWarmProcess(cliModel);
    let usedPool = !!proc;

    if (!proc) {
      // Cold start fallback: spawn fresh
      console.log(`[pool] no warm process for model=${cliModel}, cold starting...`);
      const env = { ...process.env };
      delete env.CLAUDECODE;
      proc = spawn(CLAUDE, [
        "-p", "--model", cliModel,
        "--output-format", "text",
        "--no-session-persistence",
        "--allowedTools", "Bash", "Read", "Write", "Edit", "Glob", "Grep",
        "--", prompt,
      ], { env, stdio: ["ignore", "pipe", "pipe"] });
    }

    let stdout = "";
    let stderr = "";
    const t0 = Date.now();

    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => {
      const elapsed = Date.now() - t0;
      if (code !== 0) {
        console.error(`[claude] exit=${code} model=${cliModel} elapsed=${elapsed}ms stderr=${stderr.slice(0, 300)}`);
        reject(new Error(stderr || stdout || `exit ${code}`));
      } else {
        console.log(`[claude] ok model=${cliModel} chars=${stdout.length} elapsed=${elapsed}ms pool=${usedPool}`);
        resolve(stdout.trim());
      }
    });
    proc.on("error", reject);

    // Log prompt size for debugging
    console.log(`[claude] request model=${cliModel} prompt_chars=${prompt.length} pool=${usedPool}`);

    // If using pool process, send prompt via stdin
    if (usedPool) {
      proc.stdin.write(prompt);
      proc.stdin.end();
    }

    const timer = setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, TIMEOUT);
    proc.on("close", () => clearTimeout(timer));
  });
}

// ── Response helpers ────────────────────────────────────────────────────
function jsonResponse(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function streamResponse(res, id, model, content) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  const created = Math.floor(Date.now() / 1000);
  // Role chunk
  sendSSE(res, {
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });
  // Content chunks (~500 chars each)
  for (let i = 0; i < content.length; i += 500) {
    sendSSE(res, {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { content: content.slice(i, i + 500) }, finish_reason: null }],
    });
  }
  // Finish
  sendSSE(res, {
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

function completionResponse(res, id, model, content) {
  jsonResponse(res, 200, {
    id, object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

// ── Handle chat completions ─────────────────────────────────────────────
async function handleChatCompletions(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;

  let parsed;
  try { parsed = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: "Invalid JSON" }); }

  const messages = parsed.messages || parsed.input || [{ role: "user", content: parsed.prompt || "" }];
  const model = parsed.model || "claude-sonnet-4-6";
  const stream = parsed.stream;

  if (!messages?.length) return jsonResponse(res, 400, { error: "messages required" });

  try {
    const content = await callClaude(model, messages);
    const id = `chatcmpl-${randomUUID()}`;

    if (stream) {
      streamResponse(res, id, model, content);
    } else {
      completionResponse(res, id, model, content);
    }
  } catch (err) {
    console.error(`[proxy] error: ${err.message}`);
    jsonResponse(res, 500, { error: { message: err.message, type: "proxy_error" } });
  }
}

// ── HTTP server ─────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // GET /v1/models
  if (req.url === "/v1/models" && req.method === "GET") {
    return jsonResponse(res, 200, {
      object: "list",
      data: MODELS.map((m) => ({
        id: m.id, object: "model", owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      })),
    });
  }

  // POST /v1/chat/completions
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    return handleChatCompletions(req, res);
  }

  // GET /health — includes pool status, version, uptime
  if (req.url === "/health") {
    const poolStatus = {};
    for (const [model, arr] of pool) {
      const readyCount = arr.filter(e => e.ready).length;
      const errorCount = arr.filter(e => !e.ready).length;
      poolStatus[model] = {
        total: arr.length,
        ready: readyCount,
        error: errorCount,
        status: readyCount > 0 ? "ready" : "error",
      };
    }
    const uptimeMs = Date.now() - START_TIME;
    return jsonResponse(res, 200, {
      status: "ok",
      version: VERSION,
      uptime: uptimeMs,
      uptimeHuman: `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m ${Math.floor((uptimeMs % 60000) / 1000)}s`,
      pool: poolStatus,
    });
  }

  // Catch-all: try to handle any POST with messages
  if (req.method === "POST") {
    return handleChatCompletions(req, res);
  }

  jsonResponse(res, 404, { error: "Not found. Endpoints: GET /v1/models, POST /v1/chat/completions, GET /health" });
});

// ── Start ──────────────────────────────────────────────────────────────
initPool();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`openclaw-claude-proxy v${VERSION} listening on http://0.0.0.0:${PORT}`);
  console.log(`Models: ${MODELS.map((m) => m.id).join(", ")}`);
  console.log(`Claude binary: ${CLAUDE}`);
  console.log(`Timeout: ${TIMEOUT}ms`);
  console.log(`Pool size: ${POOL_SIZE} per model, max idle: ${POOL_MAX_IDLE / 1000}s`);
});
