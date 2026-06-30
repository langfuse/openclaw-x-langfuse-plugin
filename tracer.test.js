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
        // Mirror the real SDK: metadata merges additively across updates; other
        // attributes (including name) overwrite.
        const { metadata, ...rest } = u ?? {};
        Object.assign(node.attributes, rest);
        if (rest.name !== undefined) node.name = rest.name;
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

// A full webchat turn, modeled on a real capture: every event shares one W3C
// traceId; model.usage has no runId and hangs off the harness span (not the run).
const TRACE = "c09b6e7a5c25";
function runSequence() {
  return [
    { type: "run.started", ts: 1000, runId: "r1", sessionId: "s1", channel: "webchat", trace: { traceId: TRACE, spanId: "RUN", parentSpanId: "HARNESS" } },
    { type: "context.assembled", ts: 1010, runId: "r1", messageCount: 5, channel: "webchat", trace: { traceId: TRACE, spanId: "CTX", parentSpanId: "RUN" } },
    { type: "tool.execution.started", ts: 1100, runId: "r1", toolName: "web_search", toolCallId: "tc1", toolSource: "core", trace: { traceId: TRACE, spanId: "T1", parentSpanId: "RUN" } },
    { type: "tool.execution.completed", ts: 1200, runId: "r1", toolName: "web_search", toolCallId: "tc1", durationMs: 100, trace: { traceId: TRACE, spanId: "T1", parentSpanId: "RUN" } },
    { type: "run.completed", ts: 1400, runId: "r1", sessionId: "s1", channel: "webchat", durationMs: 400, outcome: "completed", trace: { traceId: TRACE, spanId: "RUN", parentSpanId: "HARNESS" } },
    // model.usage arrives AFTER run.completed, with NO runId, parented to harness.
    { type: "model.usage", ts: 1410, sessionId: "s1", channel: "webchat", model: "claude-opus-4-8", provider: "anthropic", usage: { input: 100, output: 50, total: 150 }, costUsd: 0.002, trace: { traceId: TRACE, spanId: "USAGE", parentSpanId: "HARNESS" } },
  ];
}

const ioResolver = () => ({
  tc1: { name: "web_search", input: '{"q":"x"}', output: "result text", isError: false },
});

test("a full turn builds one trace with everything under a single root", () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, {
    resolveContent: () => ({ input: "q", output: "a", sessionInput: "q" }),
    resolveToolIO: ioResolver,
  });
  for (const evt of runSequence()) assert.equal(engine.handle(evt), true);

  // Exactly one root, even though usage/tool/run hang off different OC spans.
  const roots = t.roots();
  assert.equal(roots.length, 1);
  const root = roots[0];
  assert.equal(root.opts.asType, "agent");
  assert.equal(root.name, "webchat");
  assert.equal(root.spanAttrs["langfuse.trace.name"], "webchat");
  assert.equal(root.spanAttrs["session.id"], "s1");
  assert.equal(root.ended, true);
  assert.deepEqual(root.traceIO, { input: "q", output: "a" });

  // Children: context span, generation, retriever — ALL under the one root.
  const kinds = root.children.map((c) => c.opts.asType).sort();
  assert.deepEqual(kinds, ["generation", "retriever", "span"]);
  for (const c of root.children) assert.equal(c.parent, root);
});

test("the generation (from model.usage, post-run.completed) nests under the run's trace", () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, {
    resolveContent: () => ({ input: "q", output: "a", sessionInput: "q" }),
  });
  for (const evt of runSequence()) engine.handle(evt);

  assert.equal(t.roots().length, 1); // not orphaned into its own trace
  const gens = t.all.filter((o) => o.opts.asType === "generation");
  assert.equal(gens.length, 1);
  const gen = gens[0];
  assert.equal(gen.parent, t.roots()[0]); // <- the bug this fixes
  assert.equal(gen.attributes.model, "claude-opus-4-8");
  assert.deepEqual(gen.attributes.usageDetails, { input: 100, output: 50, total: 150 });
  assert.deepEqual(gen.attributes.costDetails, { totalCost: 0.002 });
  assert.equal(gen.attributes.input, "q");
  assert.equal(gen.ended, true);
});

test("RAG/search tools become retriever observations enriched with I/O", () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, { resolveToolIO: ioResolver });
  for (const evt of runSequence()) engine.handle(evt);

  const ret = t.all.find((o) => o.opts.asType === "retriever");
  assert.ok(ret, "expected a retriever observation");
  assert.equal(ret.name, "web_search");
  assert.equal(ret.attributes.metadata.toolSource, "core");
  assert.equal(ret.attributes.input, '{"q":"x"}');
  assert.equal(ret.attributes.output, "result text");
  assert.equal(ret.ended, true);
  assert.equal(ret.parent, t.roots()[0]);
});

test("non-search tools become tool observations", () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, {});
  engine.handle({ type: "run.started", ts: 1, runId: "r1", sessionId: "s", channel: "webchat", trace: { traceId: "tt", spanId: "RUN" } });
  engine.handle({ type: "tool.execution.started", ts: 2, runId: "r1", toolName: "edit", toolCallId: "tcE", trace: { traceId: "tt", spanId: "TE", parentSpanId: "RUN" } });
  engine.handle({ type: "tool.execution.completed", ts: 3, runId: "r1", toolName: "edit", toolCallId: "tcE", durationMs: 1, trace: { traceId: "tt", spanId: "TE", parentSpanId: "RUN" } });
  const edit = t.byName("edit");
  assert.equal(edit.opts.asType, "tool");
  assert.equal(edit.parent, t.roots()[0]);
});

test("events sharing a traceId join one trace even with no run.started", () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, {});
  // No run.started; a tool and a usage event share the same traceId.
  engine.handle({ type: "tool.execution.started", ts: 10, runId: "r1", toolName: "web_search", toolCallId: "tc", channel: "webchat", trace: { traceId: "T", spanId: "TE", parentSpanId: "RUN" } });
  engine.handle({ type: "tool.execution.completed", ts: 20, runId: "r1", toolName: "web_search", toolCallId: "tc", durationMs: 10, trace: { traceId: "T", spanId: "TE", parentSpanId: "RUN" } });
  engine.handle({ type: "model.usage", ts: 30, sessionId: "s", channel: "webchat", model: "m", usage: { input: 1, output: 2 }, trace: { traceId: "T", spanId: "U", parentSpanId: "HARNESS" } });

  const roots = t.roots();
  assert.equal(roots.length, 1); // one trace, lazily created from the first event
  assert.equal(roots[0].name, "webchat");
  const kinds = roots[0].children.map((c) => c.opts.asType).sort();
  assert.deepEqual(kinds, ["generation", "retriever"]);
});

test("a tool.execution.completed with no prior start synthesizes a span", () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, {});
  engine.handle({ type: "tool.execution.completed", ts: 500, toolName: "search_web", toolCallId: "x", durationMs: 40, trace: { traceId: "T" } });
  const ret = t.byName("search_web");
  assert.ok(ret);
  assert.equal(ret.opts.asType, "retriever");
  assert.equal(ret.ended, true);
  assert.equal(ret.opts.startTime.getTime(), 500 - 40); // backdated by duration
});

test("model.usage with no traceId falls back to a standalone generation root", () => {
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
  engine.handle({ type: "run.started", ts: 0, runId: "r1", sessionId: "s", channel: "webchat", trace: { traceId: "T", spanId: "RUN" } });
  const root = t.roots()[0];
  assert.equal(root.ended, false);
  clock = 2000;
  engine.sweep();
  assert.equal(root.ended, true);
});

test("flushAll ends every live observation", () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, {});
  engine.handle({ type: "run.started", ts: 0, runId: "r1", sessionId: "s", channel: "webchat", trace: { traceId: "T", spanId: "RUN" } });
  engine.handle({ type: "tool.execution.started", ts: 1, runId: "r1", toolName: "edit", toolCallId: "tc", trace: { traceId: "T", spanId: "TE", parentSpanId: "RUN" } });
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
  assert.equal(engine.handle({ type: "run.started", ts: 0, runId: "r", trace: { traceId: "T" } }), false);
  assert.match(logged, /handler failed/);
});

test("unknown event types are ignored", () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, {});
  assert.equal(engine.handle({ type: "webhook.received" }), false);
  assert.equal(engine.handle(undefined), false);
  assert.equal(t.all.length, 0);
});
