// Live end-to-end check against the REAL Langfuse project.
//
// Drives the REAL plugin entry against the REAL OpenClaw diagnostics bus, with a
// real Langfuse client pointed at the project from .env. Emits a `model.usage`
// event through the SAME bus function OpenClaw's runReplyAgent uses
// (emitTrustedDiagnosticEvent), then flushes. The caller then queries the
// Langfuse observations API to confirm it landed in the correct format.
//
// Run: node scripts/integration-live.mjs <traceId>

import * as bus from "openclaw/plugin-sdk/diagnostic-runtime";
import pluginEntry from "../index.js";

const traceId = process.argv[2];
if (!traceId) throw new Error("usage: node integration-live.mjs <traceId>");

let service = null;
pluginEntry.register({
  pluginConfig: {
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  },
  registerService: (svc) => (service = svc),
});
if (!service) throw new Error("FAIL: plugin did not register a service");

const ctx = {
  config: { diagnostics: { enabled: true } },
  logger: {
    info: (m) => console.log("[info]", m),
    warn: (m) => console.log("[warn]", m),
    error: (m) => console.log("[error]", m),
  },
};

await service.start(ctx);

// Exactly the shape OpenClaw's agent-runner emits for type "model.usage".
bus.emitTrustedDiagnosticEvent({
  type: "model.usage",
  ts: Date.now(),
  seq: 1,
  sessionId: traceId,
  sessionKey: `agent:main:${traceId}`,
  channel: "qa-live",
  agentId: "main",
  provider: "anthropic",
  model: "claude-opus-4-8",
  usage: {
    input: 1234,
    output: 56,
    cacheRead: 78,
    cacheWrite: 90,
    promptTokens: 1402,
    total: 1458,
  },
  context: { limit: 1048576, used: 1402 },
  costUsd: 0.004567,
  durationMs: 1857,
});

await new Promise((r) => setTimeout(r, 200));
await service.stop(); // flushes + shuts down the Langfuse client
console.log("emitted + flushed model.usage for traceId:", traceId);
