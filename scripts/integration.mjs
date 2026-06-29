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
// Run: node scripts/integration.mjs

import http from "node:http";
import { once } from "node:events";
import * as bus from "/usr/local/lib/node_modules/openclaw/dist/plugin-sdk/diagnostic-runtime.js";
import pluginEntry from "../index.js";

const PORT = 3999;

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

// --- 2. Register the real plugin and start its service ------------------------
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
  stateDir: "/tmp",
  logger: {
    info: (m) => console.log("[info]", m),
    warn: (m) => console.log("[warn]", m),
    error: (m) => console.log("[error]", m),
  },
};

await service.start(ctx);

// --- 3. Emit a synthetic run through the real bus -----------------------------
// Trace context links the events: a run span (RUN) with a model call and a
// retrieval tool as children. The bus delivers these to our listener verbatim.
const t0 = Date.now();
const T = "0123456789abcdef0123456789abcdef";
const emit = (e) => bus.emitTrustedDiagnosticEvent(e);

emit({ type: "run.started", ts: t0, runId: "run-int", sessionId: "integration-session", channel: "imessage", trace: { traceId: T, spanId: "1111111111111111" } });
emit({ type: "context.assembled", ts: t0 + 5, runId: "run-int", provider: "anthropic", model: "claude-opus-4-8", messageCount: 3, promptChars: 200, trace: { traceId: T, spanId: "2222222222222222", parentSpanId: "1111111111111111" } });
emit({ type: "model.call.started", ts: t0 + 10, runId: "run-int", callId: "call-1", provider: "anthropic", model: "claude-opus-4-8", trace: { traceId: T, spanId: "3333333333333333", parentSpanId: "1111111111111111" } });
emit({ type: "tool.execution.started", ts: t0 + 20, runId: "run-int", toolName: "vector_search", toolCallId: "tool-1", toolSource: "mcp", trace: { traceId: T, spanId: "4444444444444444", parentSpanId: "1111111111111111" } });
emit({ type: "tool.execution.completed", ts: t0 + 60, runId: "run-int", toolName: "vector_search", toolCallId: "tool-1", durationMs: 40, trace: { traceId: T, spanId: "4444444444444444", parentSpanId: "1111111111111111" } });
emit({ type: "model.call.completed", ts: t0 + 90, runId: "run-int", callId: "call-1", provider: "anthropic", model: "claude-opus-4-8", durationMs: 80, trace: { traceId: T, spanId: "3333333333333333", parentSpanId: "1111111111111111" } });
emit({ type: "model.usage", ts: t0 + 95, sessionId: "integration-session", channel: "imessage", provider: "anthropic", model: "claude-opus-4-8", usage: { input: 1200, output: 340, cacheRead: 50, total: 1540 }, context: { limit: 200000, used: 1540 }, costUsd: 0.0123, durationMs: 80, trace: { traceId: T, spanId: "5555555555555555", parentSpanId: "1111111111111111" } });
emit({ type: "run.completed", ts: t0 + 100, runId: "run-int", sessionId: "integration-session", durationMs: 100, outcome: "completed", trace: { traceId: T, spanId: "1111111111111111" } });

// Allow listeners to run, then flush Langfuse via the service's stop().
await new Promise((r) => setTimeout(r, 150));
await service.stop();
await new Promise((r) => setTimeout(r, 400));
server.close();

// --- 4. Assert the nested span tree reached the wire --------------------------
const named = spans.map((s) => ({ s, a: attrMap(s) }));
const typeOf = (a) => a["langfuse.observation.type"];

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

// Everything should share one trace, and the retriever/generation should not be
// trace roots — i.e. they nest under the run.
const traceIds = new Set(spans.map((s) => s.traceId));
if (traceIds.size !== 1) fail(`expected one trace, got ${traceIds.size}`);
if (!retriever.s.parentSpanId || !gen.s.parentSpanId)
  fail("generation/retriever are not nested (no parentSpanId).");

// Usage + cost folded onto the generation.
const model = gen.a["langfuse.observation.model.name"];
const usage = gen.a["langfuse.observation.usage_details"];
const cost = gen.a["langfuse.observation.cost_details"];
console.log("\n--- generation ---");
console.log({ model, usage, cost });
if (model !== "claude-opus-4-8") fail(`model missing/wrong on generation: ${model}`);
if (!usage || !String(usage).includes("1200")) fail("usageDetails missing/wrong on generation.");
if (!cost || !String(cost).includes("0.0123")) fail("costDetails missing/wrong on generation.");

console.log(
  `\nPASS: real bus -> plugin -> Langfuse OTLP. ${spans.length} spans, one trace, ` +
    "generation + retriever nested under the run, usage/cost folded.",
);
process.exit(0);
