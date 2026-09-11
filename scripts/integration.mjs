// End-to-end integration check (not shipped in the published package).
//
// Drives the REAL plugin entry (definePluginEntry/registerService/start)
// against the REAL OpenClaw diagnostics bus, with the real Langfuse v5 OTel
// exporter pointed at a local capture server. Emits a synthetic *run* — a
// run.started, a context.assembled, a model call, a retrieval (RAG) tool call,
// model.usage, and run.completed — then asserts the nested span tree that
// reaches the wire as OTLP/JSON: a run root, a generation, and a `retriever`
// observation, all in one trace.
//
// When the host exposes the session transcript API (OpenClaw >= 2026.8) the
// check also seeds a real transcript for the session — through the host's own
// writer, into its SQLite store under a throwaway state dir — and asserts that
// the prompt, the answer and the tool's arguments/result reach the wire as
// observation input/output. That is the path that fills Langfuse's Input and
// Output columns.
//
// Run: node scripts/integration.mjs
//
// The transcript half needs a Node whose bundled SQLite OpenClaw accepts
// (>= 22.22.3 / 24.15.0 / 25.9.0); on anything older the script still runs and
// verifies the legacy-fallback path instead.

import http from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The state dir must be set before any OpenClaw module initializes, so every
// openclaw/plugin import below is dynamic.
const stateDir = mkdtempSync(path.join(tmpdir(), "lf-bridge-int-"));
process.env.OPENCLAW_STATE_DIR = stateDir;

const bus = await import("openclaw/plugin-sdk/diagnostic-runtime");
const { default: pluginEntry } = await import("../index.js");

const PORT = 3999;
const SESSION_ID = "integration-session";
const AGENT_ID = "main";

// --- 1. Local capture server standing in for Langfuse OTLP ingestion ----------
const spans = [];
function attrMap(span) {
  const out = {};
  for (const a of span.attributes ?? []) {
    const v = a.value ?? {};
    out[a.key] =
      v.stringValue ??
      v.intValue ??
      v.doubleValue ??
      v.boolValue ??
      (v.intValue === 0 ? 0 : undefined);
  }
  return out;
}
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.url?.includes("/otel/v1/traces")) {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        for (const rs of body.resourceSpans ?? []) {
          for (const ss of rs.scopeSpans ?? []) {
            for (const s of ss.spans ?? []) spans.push(s);
          }
        }
      } catch (err) {
        console.error("capture parse error:", err.message);
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
server.listen(PORT);
await once(server, "listening");

// --- 2. Seed a real session transcript, when the host has the API -------------
// This is the content source the bridge reads: the same store OpenClaw's own
// runtime writes turns into. Without it, observations carry structure only.
const conversation = [
  { role: "user", content: "find the docs", timestamp: Date.now() },
  {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-4-8",
    content: [
      { type: "text", text: "I'll search." },
      { type: "toolCall", id: "tool-1", name: "vector_search", arguments: { query: "docs" } },
    ],
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { total: 0.001 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  },
  {
    role: "toolResult",
    toolCallId: "tool-1",
    toolName: "vector_search",
    content: [{ type: "text", text: "doc A\ndoc B" }],
    isError: false,
    timestamp: Date.now(),
  },
  {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-4-8",
    content: [{ type: "text", text: "The docs are in doc A." }],
    usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 220, cost: { total: 0.002 } },
    stopReason: "stop",
    timestamp: Date.now(),
  },
];

let seeded = false;
try {
  const { appendSessionTranscriptMessageByIdentity: append } = await import(
    "openclaw/plugin-sdk/session-transcript-runtime"
  );
  for (const message of conversation) {
    await append({ agentId: AGENT_ID, sessionId: SESSION_ID, sessionKey: SESSION_ID, message });
  }
  seeded = true;
  console.log(`[seed] wrote ${conversation.length} transcript messages under ${stateDir}`);
} catch (err) {
  console.log(`[seed] transcript API unavailable, checking the fallback path only (${err.message})`);
}

// --- 3. Register the real plugin and start its service ------------------------
let service = null;
const fakeApi = {
  pluginConfig: {
    publicKey: "pk-lf-integration",
    secretKey: "sk-lf-integration",
    baseUrl: `http://localhost:${PORT}`,
  },
  registerService: (svc) => {
    service = svc;
  },
};

pluginEntry.register(fakeApi);
if (!service) throw new Error("FAIL: plugin did not register a service");
if (service.id !== "langfuse-bridge")
  throw new Error(`FAIL: unexpected service id ${service.id}`);

const ctx = {
  config: {},
  stateDir,
  logger: {
    info: (m) => console.log("[info]", m),
    warn: (m) => console.log("[warn]", m),
    error: (m) => console.log("[error]", m),
  },
};

await service.start(ctx);

// --- 4. Emit a synthetic run through the real bus -----------------------------
// Trace context links the events: a run span (RUN) with a model call and a
// retrieval tool as children. The bus delivers these to our listener verbatim.
const t0 = Date.now();
const T = "0123456789abcdef0123456789abcdef";
const emit = (e) => bus.emitTrustedDiagnosticEvent(e);

emit({ type: "run.started", ts: t0, runId: "run-int", sessionId: SESSION_ID, agentId: AGENT_ID, channel: "imessage", trace: { traceId: T, spanId: "1111111111111111" } });
emit({ type: "context.assembled", ts: t0 + 5, runId: "run-int", provider: "anthropic", model: "claude-opus-4-8", messageCount: 3, promptChars: 200, trace: { traceId: T, spanId: "2222222222222222", parentSpanId: "1111111111111111" } });
emit({ type: "model.call.started", ts: t0 + 10, runId: "run-int", callId: "call-1", provider: "anthropic", model: "claude-opus-4-8", trace: { traceId: T, spanId: "3333333333333333", parentSpanId: "1111111111111111" } });
emit({ type: "tool.execution.started", ts: t0 + 20, runId: "run-int", toolName: "vector_search", toolCallId: "tool-1", toolSource: "mcp", agentId: AGENT_ID, trace: { traceId: T, spanId: "4444444444444444", parentSpanId: "1111111111111111" } });
emit({ type: "tool.execution.completed", ts: t0 + 60, runId: "run-int", toolName: "vector_search", toolCallId: "tool-1", durationMs: 40, agentId: AGENT_ID, trace: { traceId: T, spanId: "4444444444444444", parentSpanId: "1111111111111111" } });
emit({ type: "model.call.completed", ts: t0 + 90, runId: "run-int", callId: "call-1", provider: "anthropic", model: "claude-opus-4-8", durationMs: 80, trace: { traceId: T, spanId: "3333333333333333", parentSpanId: "1111111111111111" } });
emit({ type: "model.usage", ts: t0 + 95, sessionId: SESSION_ID, agentId: AGENT_ID, channel: "imessage", provider: "anthropic", model: "claude-opus-4-8", usage: { input: 1200, output: 340, cacheRead: 50, total: 1540 }, context: { limit: 200000, used: 1540 }, costUsd: 0.0123, durationMs: 80, trace: { traceId: T, spanId: "5555555555555555", parentSpanId: "1111111111111111" } });
emit({ type: "run.completed", ts: t0 + 100, runId: "run-int", sessionId: SESSION_ID, agentId: AGENT_ID, durationMs: 100, outcome: "completed", trace: { traceId: T, spanId: "1111111111111111" } });

// Allow listeners to run, then flush Langfuse via the service's stop().
await new Promise((r) => setTimeout(r, 150));
await service.stop();
await new Promise((r) => setTimeout(r, 400));
server.close();

// --- 5. Assert the nested span tree reached the wire --------------------------
const named = spans.map((s) => ({ s, a: attrMap(s) }));
const typeOf = (a) => a["langfuse.observation.type"];
const IN = "langfuse.observation.input";
const OUT = "langfuse.observation.output";

console.log("\n--- captured spans (name : observation.type) ---");
for (const { s, a } of named) console.log(`${s.name} : ${typeOf(a) ?? "(span)"}`);

const fail = (msg) => {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
};

if (spans.length === 0) fail("no spans reached the wire.");

const gen = named.find((x) => typeOf(x.a) === "generation");
if (!gen) fail("no generation observation on the wire.");

const retriever = named.find((x) => typeOf(x.a) === "retriever");
if (!retriever) fail("RAG tool did not become a `retriever` observation.");
if (retriever.s.name !== "vector_search")
  fail(`retriever span misnamed: ${retriever.s.name}`);

const root = named.find((x) => typeOf(x.a) === "agent");
if (!root) fail("no run root (agent) observation on the wire.");

// Everything should share one trace, and the retriever/generation should not be
// trace roots — i.e. they nest under the run.
const traceIds = new Set(spans.map((s) => s.traceId));
if (traceIds.size !== 1) fail(`expected one trace, got ${traceIds.size}`);
if (!retriever.s.parentSpanId || !gen.s.parentSpanId)
  fail("generation/retriever are not nested (no parentSpanId).");

// The session id is a correlating attribute on every observation.
for (const { s, a } of named) {
  if (a["session.id"] !== SESSION_ID) fail(`session.id missing on span ${s.name}`);
}

const model = gen.a["langfuse.observation.model.name"];
const usage = gen.a["langfuse.observation.usage_details"];
const cost = gen.a["langfuse.observation.cost_details"];
console.log("\n--- generation ---");
console.log({ model, usage, cost, input: gen.a[IN], output: gen.a[OUT] });
if (model !== "claude-opus-4-8") fail(`model missing/wrong on generation: ${model}`);

if (seeded) {
  // Content recovered from the transcript store: this is the Input/Output that
  // was missing on OpenClaw 2026.8.x hosts.
  console.log("\n--- content recovered from the session transcript ---");
  console.log({
    traceInput: root.a["langfuse.trace.input"],
    traceOutput: root.a["langfuse.trace.output"],
    toolInput: retriever.a[IN],
    toolOutput: retriever.a[OUT],
  });
  if (!String(gen.a[IN] ?? "").includes("find the docs"))
    fail(`generation input missing the prompt: ${gen.a[IN]}`);
  if (!String(gen.a[OUT] ?? "").includes("The docs are in doc A."))
    fail(`generation output missing the answer: ${gen.a[OUT]}`);
  if (!String(root.a[IN] ?? "").includes("find the docs"))
    fail("run root input missing the prompt.");
  if (!String(root.a["langfuse.trace.input"] ?? "").includes("find the docs"))
    fail("trace-level input missing the prompt.");
  if (!String(retriever.a[IN] ?? "").includes("docs"))
    fail(`retriever input missing the tool arguments: ${retriever.a[IN]}`);
  if (!String(retriever.a[OUT] ?? "").includes("doc B"))
    fail(`retriever output missing the tool result: ${retriever.a[OUT]}`);
  // Per-call tokens/cost from the transcript take precedence over the run's
  // cumulative model.usage.
  if (!String(usage).includes("220")) fail(`expected per-call usage, got ${usage}`);
  if (!String(cost).includes("0.002")) fail(`expected per-call cost, got ${cost}`);
  console.log(
    `\nPASS: real bus -> plugin -> Langfuse OTLP. ${spans.length} spans, one trace, ` +
      "generation + retriever nested under the run, per-call usage/cost, and " +
      "prompt/answer/tool I/O recovered from the session transcript.",
  );
} else {
  // No transcript API: structure and usage must still be intact, from the
  // cumulative model.usage event.
  if (!usage || !String(usage).includes("1200")) fail("usageDetails missing/wrong on generation.");
  if (!cost || !String(cost).includes("0.0123")) fail("costDetails missing/wrong on generation.");
  console.log(
    `\nPASS (fallback path): real bus -> plugin -> Langfuse OTLP. ${spans.length} spans, ` +
      "one trace, generation + retriever nested under the run, cumulative usage/cost folded. " +
      "Content was not asserted: this host exposes no transcript API.",
  );
}
process.exit(0);
