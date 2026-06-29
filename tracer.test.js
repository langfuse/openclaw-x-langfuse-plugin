import { test } from "node:test";
import assert from "node:assert/strict";
import { createTraceEngine } from "./tracer.js";

/**
 * Fake tracing surface that records a full observation tree. Each observation
 * supports the methods the engine uses: child `startObservation`, `update`,
 * `setTraceIO`, `end`, and `otelSpan.setAttribute`. `all` holds every created
 * observation with `parent`/`children` links so the tree can be asserted.
 */
function fakeTracing() {
  const all = [];
  function make(name, attributes, opts, parent) {
    const spanAttrs = {};
    const node = {
      name,
      attributes: { ...attributes },
      opts: opts ?? {},
      parent,
      children: [],
      spanAttrs,
      traceIO: undefined,
      ended: false,
      endTime: undefined,
    };
    all.push(node);
    const handle = {
      otelSpan: { setAttribute: (k, v) => (spanAttrs[k] = v) },
      startObservation(n, a, o) {
        const child = make(n, a, o, node);
        node.children.push(child);
        return child.handle;
      },
      update(u) {
        // Mirror the real SDK: metadata is merged additively across updates,
        // other attributes are overwritten.
        const { metadata, ...rest } = u ?? {};
        Object.assign(node.attributes, rest);
        if (metadata) node.attributes.metadata = { ...node.attributes.metadata, ...metadata };
        return handle;
      },
      setTraceIO(io) {
        node.traceIO = io;
        return handle;
      },
      end(t) {
        node.ended = true;
        node.endTime = t;
      },
    };
    node.handle = handle;
    return node;
  }
  return {
    all,
    roots: () => all.filter((n) => n.parent === null),
    byName: (n) => all.find((o) => o.name === n),
    startObservation(name, attrs, opts) {
      return make(name, attrs, opts, null).handle;
    },
  };
}

// A full run in *emission* order. Note the runtime delivers run.*/model.usage
// synchronously but tool.execution.*/context.assembled asynchronously, so the
// `realisticOrder()` helper below replays the realistic (reordered) delivery.
function runSequence() {
  return [
    { type: "run.started", ts: 1000, runId: "r1", sessionId: "s1", channel: "imessage", trace: { traceId: "t", spanId: "RUN" } },
    { type: "context.assembled", ts: 1010, runId: "r1", messageCount: 5, trace: { traceId: "t", spanId: "CTX", parentSpanId: "RUN" } },
    { type: "tool.execution.started", ts: 1100, runId: "r1", toolName: "vector_search", toolCallId: "tc1", toolSource: "mcp", trace: { traceId: "t", spanId: "T1", parentSpanId: "RUN" } },
    { type: "tool.execution.completed", ts: 1200, runId: "r1", toolName: "vector_search", toolCallId: "tc1", durationMs: 100, trace: { traceId: "t", spanId: "T1", parentSpanId: "RUN" } },
    { type: "model.usage", ts: 1310, sessionId: "s1", model: "claude-opus-4-8", provider: "anthropic", usage: { input: 100, output: 50, total: 150 }, costUsd: 0.002, trace: { traceId: "t", spanId: "U1", parentSpanId: "RUN" } },
    { type: "run.completed", ts: 1400, runId: "r1", sessionId: "s1", durationMs: 400, outcome: "completed", trace: { traceId: "t", spanId: "RUN" } },
  ];
}

const ASYNC = new Set(["tool.execution.started", "tool.execution.completed", "context.assembled"]);

/** Reorder a sequence the way the real bus delivers it: sync events first (in
 * order), then the async-queued events (in order) — so run.completed lands
 * before its own tool/context events. */
function realisticOrder(seq) {
  const sync = seq.filter((e) => !ASYNC.has(e.type));
  const async = seq.filter((e) => ASYNC.has(e.type));
  return [...sync, ...async];
}

const ioResolver = () => ({
  tc1: { name: "vector_search", input: '{"query":"x"}', output: "doc A", isError: false },
});

test("a full run builds a nested tree under one run root", () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, {
    resolveContent: () => ({ input: "q", output: "a", sessionInput: "q" }),
    resolveToolIO: ioResolver,
  });
  for (const evt of runSequence()) assert.equal(engine.handle(evt), true);

  // Exactly one root: the run.
  const roots = t.roots();
  assert.equal(roots.length, 1);
  const run = roots[0];
  assert.equal(run.opts.asType, "agent");
  assert.equal(run.name, "imessage");
  assert.equal(run.spanAttrs["langfuse.trace.name"], "imessage");
  assert.equal(run.spanAttrs["session.id"], "s1");
  assert.equal(run.ended, true);
  assert.deepEqual(run.traceIO, { input: "q", output: "a" });

  // Children: context span, one generation, one retriever — all under the run.
  const kinds = run.children.map((c) => c.opts.asType).sort();
  assert.deepEqual(kinds, ["generation", "retriever", "span"]);
  for (const c of run.children) assert.equal(c.parent, run);
});

test("ordering: run.completed delivered before async tool events still nests under one run", () => {
  // This is the real delivery order (sync run.*/usage, then async tool/context).
  // Regression guard against creating a second orphan run + duplicate generation.
  const t = fakeTracing();
  const engine = createTraceEngine(t, { resolveToolIO: ioResolver });
  for (const evt of realisticOrder(runSequence())) engine.handle(evt);

  assert.equal(t.roots().length, 1); // one run root, not two
  const run = t.roots()[0];
  assert.equal(run.ended, true);
  // Late async children still resolved the (soft-ended) run as their parent.
  assert.equal(t.all.filter((o) => o.opts.asType === "generation").length, 1);
  assert.equal(t.all.filter((o) => o.opts.asType === "retriever").length, 1);
  for (const o of t.all) if (o !== run) assert.equal(o.parent, run);
});

test("model.usage becomes the run's generation with tokens + cost", () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, {
    resolveContent: () => ({ input: "q", output: "a", sessionInput: "q" }),
  });
  for (const evt of realisticOrder(runSequence())) engine.handle(evt);

  const gens = t.all.filter((o) => o.opts.asType === "generation");
  assert.equal(gens.length, 1); // not duplicated
  const gen = gens[0];
  assert.equal(gen.attributes.model, "claude-opus-4-8");
  assert.deepEqual(gen.attributes.usageDetails, { input: 100, output: 50, total: 150 });
  assert.deepEqual(gen.attributes.costDetails, { totalCost: 0.002 });
  assert.equal(gen.attributes.input, "q");
  assert.equal(gen.attributes.output, "a");
  assert.equal(gen.ended, true);
});

test("RAG/search tools become retriever observations enriched with I/O", () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, { resolveToolIO: ioResolver });
  for (const evt of realisticOrder(runSequence())) engine.handle(evt);

  const ret = t.all.find((o) => o.opts.asType === "retriever");
  assert.ok(ret, "expected a retriever observation");
  assert.equal(ret.name, "vector_search");
  assert.equal(ret.attributes.metadata.toolSource, "mcp");
  assert.equal(ret.attributes.input, '{"query":"x"}'); // enriched from trajectory
  assert.equal(ret.attributes.output, "doc A");
  assert.equal(ret.ended, true);
});

test("non-search tools become tool observations", () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, {});
  engine.handle({ type: "run.started", ts: 1, runId: "r1", sessionId: "s", trace: { traceId: "t", spanId: "RUN" } });
  engine.handle({ type: "tool.execution.started", ts: 2, runId: "r1", toolName: "edit", toolCallId: "tcE", trace: { traceId: "t", spanId: "TE", parentSpanId: "RUN" } });
  engine.handle({ type: "tool.execution.completed", ts: 3, runId: "r1", toolName: "edit", toolCallId: "tcE", durationMs: 1, trace: { traceId: "t", spanId: "TE", parentSpanId: "RUN" } });
  engine.handle({ type: "run.completed", ts: 4, runId: "r1", sessionId: "s", trace: { traceId: "t", spanId: "RUN" } });
  const edit = t.byName("edit");
  assert.equal(edit.opts.asType, "tool");
});

test("a dropped run.started still nests children via lazy run creation", () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, {});
  // No run.started; a tool references runId r1 with parentSpanId RUN.
  engine.handle({ type: "tool.execution.started", ts: 10, runId: "r1", toolName: "edit", toolCallId: "tc", trace: { traceId: "t", spanId: "TE", parentSpanId: "RUN" } });
  engine.handle({ type: "tool.execution.completed", ts: 20, runId: "r1", toolName: "edit", toolCallId: "tc", durationMs: 10, trace: { traceId: "t", spanId: "TE", parentSpanId: "RUN" } });

  const roots = t.roots();
  assert.equal(roots.length, 1);
  assert.equal(roots[0].opts.asType, "agent"); // lazily created run root
  assert.equal(roots[0].children.length, 1);
  assert.equal(roots[0].children[0].opts.asType, "tool");
});

test("a tool.execution.completed with no prior start synthesizes a span", () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, {});
  // Orphan terminal event, no run context at all.
  engine.handle({ type: "tool.execution.completed", ts: 500, toolName: "search_web", toolCallId: "x", durationMs: 40, trace: { traceId: "t", spanId: "T" } });
  const ret = t.byName("search_web");
  assert.ok(ret);
  assert.equal(ret.opts.asType, "retriever");
  assert.equal(ret.ended, true); // no run to wait for -> ended immediately
  // start backdated by durationMs
  assert.equal(ret.opts.startTime.getTime(), 500 - 40);
});

test("model.usage with no run context falls back to a standalone generation root", () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, {
    resolveContent: () => ({ input: "hi", output: "yo" }),
  });
  engine.handle({ type: "model.usage", ts: 700, sessionId: "sX", model: "m", usage: { input: 1, output: 2 } });
  const roots = t.roots();
  assert.equal(roots.length, 1);
  const gen = roots[0];
  assert.equal(gen.opts.asType, "generation");
  assert.equal(gen.spanAttrs["session.id"], "sX");
  assert.deepEqual(gen.traceIO, { input: "hi", output: "yo" });
  assert.equal(gen.ended, true);
});

test("the reaper ends observations idle past the TTL", () => {
  let clock = 0;
  const t = fakeTracing();
  const engine = createTraceEngine(t, { now: () => clock, ttlMs: 1000 });
  engine.handle({ type: "run.started", ts: 0, runId: "r1", sessionId: "s", trace: { traceId: "t", spanId: "RUN" } });
  const run = t.roots()[0];
  assert.equal(run.ended, false);
  clock = 2000; // advance past ttl
  engine.sweep();
  assert.equal(run.ended, true);
});

test("flushAll ends every live observation", () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, {});
  engine.handle({ type: "run.started", ts: 0, runId: "r1", sessionId: "s", trace: { traceId: "t", spanId: "RUN" } });
  engine.handle({ type: "tool.execution.started", ts: 1, runId: "r1", toolName: "edit", toolCallId: "tc", trace: { traceId: "t", spanId: "TE", parentSpanId: "RUN" } });
  assert.ok(t.all.some((o) => !o.ended));
  engine.flushAll();
  assert.ok(t.all.every((o) => o.ended));
});

test("handler never throws and reports failures", () => {
  const t = fakeTracing();
  t.startObservation = () => {
    throw new Error("boom");
  };
  let logged = "";
  const engine = createTraceEngine(t, { logger: { error: (m) => (logged = m) } });
  assert.equal(engine.handle({ type: "run.started", ts: 0, runId: "r", trace: {} }), false);
  assert.match(logged, /handler failed/);
});

test("unknown event types are ignored", () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, {});
  assert.equal(engine.handle({ type: "webhook.received" }), false);
  assert.equal(engine.handle(undefined), false);
  assert.equal(t.all.length, 0);
});
