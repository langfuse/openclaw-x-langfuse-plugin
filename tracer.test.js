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
    gens: () => all.filter((n) => n.opts.asType === "generation"),
    byName: (n) => all.find((o) => o.name === n),
    startObservation(name, attrs, opts) {
      return make(name, attrs, opts, null).handle;
    },
  };
}

/** Let the engine's fire-and-forget async paths (late tool enrichment) settle. */
function settle() {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

function makeEngine(t, opts = {}) {
  const deferred = [];
  const engine = createTraceEngine(t, { defer: (fn) => deferred.push(fn), ...opts });
  return {
    engine,
    async feed(events) {
      for (const e of events) engine.handle(e);
      while (deferred.length) await deferred.shift()();
      await settle();
    },
  };
}

// A real-shaped webchat turn: ONE run, TWO model calls (call → tool → call),
// one cumulative model.usage. All share one W3C traceId. model.call.* are keyed
// by span id; model.usage arrives last and carries the run's total tokens/cost.
const TRACE = "c09b6e7a5c25";
function runSequence() {
  return [
    { type: "run.started", ts: 1000, runId: "r1", sessionId: "s1", channel: "webchat", trace: { traceId: TRACE, spanId: "RUN", parentSpanId: "HARNESS" } },
    { type: "context.assembled", ts: 1010, runId: "r1", messageCount: 5, channel: "webchat", trace: { traceId: TRACE, spanId: "CTX", parentSpanId: "RUN" } },
    { type: "model.call.started", ts: 1020, runId: "r1", callId: "r1", provider: "anthropic", model: "claude-opus-4-8", trace: { traceId: TRACE, spanId: "MC1", parentSpanId: "RUN" } },
    { type: "model.call.completed", ts: 1100, runId: "r1", callId: "r1", model: "claude-opus-4-8", durationMs: 80, trace: { traceId: TRACE, spanId: "MC1", parentSpanId: "RUN" } },
    { type: "tool.execution.started", ts: 1110, runId: "r1", toolName: "web_search", toolCallId: "tc1", toolSource: "core", trace: { traceId: TRACE, spanId: "T1", parentSpanId: "RUN" } },
    { type: "tool.execution.completed", ts: 1200, runId: "r1", toolName: "web_search", toolCallId: "tc1", durationMs: 90, trace: { traceId: TRACE, spanId: "T1", parentSpanId: "RUN" } },
    { type: "model.call.started", ts: 1210, runId: "r1", callId: "r1", provider: "anthropic", model: "claude-opus-4-8", trace: { traceId: TRACE, spanId: "MC2", parentSpanId: "RUN" } },
    { type: "model.call.completed", ts: 1300, runId: "r1", callId: "r1", model: "claude-opus-4-8", durationMs: 90, trace: { traceId: TRACE, spanId: "MC2", parentSpanId: "RUN" } },
    { type: "run.completed", ts: 1400, runId: "r1", sessionId: "s1", channel: "webchat", durationMs: 400, outcome: "completed", trace: { traceId: TRACE, spanId: "RUN", parentSpanId: "HARNESS" } },
    { type: "model.usage", ts: 1410, sessionId: "s1", agentId: "main", channel: "webchat", model: "claude-opus-4-8", provider: "anthropic", usage: { input: 100, output: 50, total: 150 }, costUsd: 0.002, trace: { traceId: TRACE, spanId: "USAGE", parentSpanId: "HARNESS" } },
  ];
}

// Turn content as transcript.js resolves it from the session transcript: the
// prompt, the final answer, one entry per model call, and per-tool I/O.
const content = {
  input: "the question",
  output: "the final answer",
  turns: [{ output: "I'll look that up." }, { output: "the final answer" }],
  toolIO: { tc1: { name: "web_search", input: '{"q":"x"}', output: "search results", isError: false } },
};
const resolvers = { resolveTurn: async () => content };

test("a full turn builds one trace, one generation per model call", async () => {
  const t = fakeTracing();
  const { feed } = makeEngine(t, resolvers);
  await feed(runSequence());

  const roots = t.roots();
  assert.equal(roots.length, 1);
  const root = roots[0];
  assert.equal(root.name, "webchat");
  assert.equal(root.spanAttrs["session.id"], "s1");
  assert.equal(root.ended, true);
  // Observations-first: input/output on the root observation, mirrored onto the
  // trace for trace-level evaluators.
  assert.equal(root.attributes.input, "the question");
  assert.equal(root.attributes.output, "the final answer");
  assert.deepEqual(root.traceIO, { input: "the question", output: "the final answer" });

  // One generation per model call (2), plus the retriever and context span.
  assert.equal(t.gens().length, 2);
  const kinds = root.children.map((c) => c.opts.asType).sort();
  assert.deepEqual(kinds, ["generation", "generation", "retriever", "span"]);
  for (const c of root.children) assert.equal(c.parent, root);
  // The session id is a correlating attribute on every observation, not just
  // the root.
  for (const c of root.children) assert.equal(c.spanAttrs["session.id"], "s1");
});

test("each generation gets its OWN output (not all calls joined together)", async () => {
  const t = fakeTracing();
  const { feed } = makeEngine(t, resolvers);
  await feed(runSequence());

  const gens = t.gens();
  assert.equal(gens.length, 2);
  assert.equal(gens[0].attributes.output, "I'll look that up.");
  assert.equal(gens[1].attributes.output, "the final answer");
  // First generation's input is the user prompt; the second's is the tool output
  // that fed it.
  assert.equal(gens[0].attributes.input, "the question");
  assert.match(gens[1].attributes.input, /\[web_search\]\nsearch results/);
});

test("per-call tokens and cost come from the transcript when it has them", async () => {
  const t = fakeTracing();
  const { feed } = makeEngine(t, {
    resolveTurn: async () => ({
      ...content,
      turns: [
        { output: "I'll look that up.", usage: { input: 100, output: 10, totalTokens: 110, cost: { total: 0.001 } } },
        { output: "the final answer", usage: { input: 300, output: 40, totalTokens: 340, cost: { total: 0.003 } } },
      ],
    }),
  });
  await feed(runSequence());

  const gens = t.gens();
  assert.deepEqual(gens[0].attributes.usageDetails, { input: 100, output: 10, total: 110 });
  assert.deepEqual(gens[0].attributes.costDetails, { totalCost: 0.001 });
  assert.deepEqual(gens[1].attributes.usageDetails, { input: 300, output: 40, total: 340 });
  assert.deepEqual(gens[1].attributes.costDetails, { totalCost: 0.003 });
});

test("per-call usage falls back to model.call.completed.usage (OpenClaw 2026.8+)", async () => {
  const t = fakeTracing();
  const { feed } = makeEngine(t, resolvers); // transcript turns carry no usage
  const seq = runSequence().map((e) =>
    e.type === "model.call.completed" && e.trace.spanId === "MC1"
      ? { ...e, usage: { input: 90, output: 12, reasoningTokens: 4, total: 106 } }
      : e,
  );
  await feed(seq);

  const gens = t.gens();
  assert.deepEqual(gens[0].attributes.usageDetails, {
    input: 90,
    output: 12,
    reasoning: 4,
    total: 106,
  });
  // The run's cumulative model.usage is not also applied: per-call data won.
  assert.equal(gens[1].attributes.usageDetails, undefined);
  // Cost is only cumulative here, so it lands on the last generation.
  assert.deepEqual(gens[1].attributes.costDetails, { totalCost: 0.002 });
});

test("with no per-call data, cumulative tokens/cost land on the LAST generation", async () => {
  const t = fakeTracing();
  const { feed } = makeEngine(t, resolvers);
  await feed(runSequence());
  const gens = t.gens();
  assert.equal(gens[0].attributes.usageDetails, undefined); // not on the first
  assert.deepEqual(gens[1].attributes.usageDetails, { input: 100, output: 50, total: 150 });
  assert.deepEqual(gens[1].attributes.costDetails, { totalCost: 0.002 });
  assert.equal(gens[0].ended, true);
  assert.equal(gens[1].ended, true);
});

test("RAG/search tools become retriever observations enriched with I/O", async () => {
  const t = fakeTracing();
  const { feed } = makeEngine(t, resolvers);
  await feed(runSequence());
  const ret = t.byName("web_search");
  assert.equal(ret.opts.asType, "retriever");
  assert.equal(ret.attributes.input, '{"q":"x"}');
  assert.equal(ret.attributes.output, "search results");
  assert.equal(ret.parent, t.roots()[0]);
});

test("the transcript is read once per turn, not once per late tool event", async () => {
  let reads = 0;
  const t = fakeTracing();
  const { feed } = makeEngine(t, {
    resolveTurn: async () => {
      reads++;
      return content;
    },
  });
  // Real delivery order: sync run.* + usage first, then the queued tool events,
  // each of which arrives after run.completed and wants the tool's I/O.
  const seq = runSequence();
  const isAsync = (e) => /^(model\.call|tool\.execution|context)/.test(e.type);
  await feed([...seq.filter((e) => !isAsync(e)), ...seq.filter(isAsync)]);
  assert.equal(reads, 1);
});

test("context.assembled carries a readable size summary", async () => {
  const t = fakeTracing();
  const { feed } = makeEngine(t, resolvers);
  await feed(runSequence());
  assert.equal(t.byName("context.assembled").attributes.output, "messages=5");
});

test("non-search tools become tool observations", async () => {
  const t = fakeTracing();
  const { feed } = makeEngine(t, {});
  await feed([
    { type: "run.started", ts: 1, runId: "r1", sessionId: "s", channel: "webchat", trace: { traceId: "tt", spanId: "RUN" } },
    { type: "tool.execution.started", ts: 2, runId: "r1", toolName: "edit", toolCallId: "tcE", trace: { traceId: "tt", spanId: "TE", parentSpanId: "RUN" } },
    { type: "tool.execution.completed", ts: 3, runId: "r1", toolName: "edit", toolCallId: "tcE", durationMs: 1, trace: { traceId: "tt", spanId: "TE", parentSpanId: "RUN" } },
    { type: "run.completed", ts: 4, runId: "r1", sessionId: "s", channel: "webchat", outcome: "completed", trace: { traceId: "tt", spanId: "RUN" } },
  ]);
  const edit = t.byName("edit");
  assert.equal(edit.opts.asType, "tool");
  assert.equal(edit.ended, true);
});

test("late async model.call/tool events still nest in the one run trace", async () => {
  // Real delivery order: sync run.* + usage first, async model.call/tool after.
  const t = fakeTracing();
  const { feed } = makeEngine(t, resolvers);
  const seq = runSequence();
  const isAsync = (e) => /^(model\.call|tool\.execution|context)/.test(e.type);
  await feed([...seq.filter((e) => !isAsync(e)), ...seq.filter(isAsync)]);

  assert.equal(t.roots().length, 1); // not split into a second orphan trace
  assert.equal(t.gens().length, 2);
});

test("model.usage with no traceId falls back to a standalone generation root", async () => {
  const t = fakeTracing();
  const { feed } = makeEngine(t, {
    resolveTurn: async () => ({ input: "hi", output: "yo", turns: [] }),
  });
  await feed([{ type: "model.usage", ts: 700, sessionId: "sX", model: "m", usage: { input: 1, output: 2 } }]);
  const roots = t.roots();
  assert.equal(roots.length, 1);
  assert.equal(roots[0].opts.asType, "generation");
  assert.deepEqual(roots[0].attributes.usageDetails, { input: 1, output: 2 });
  assert.deepEqual(roots[0].traceIO, { input: "hi", output: "yo" });
  assert.equal(roots[0].ended, true);
});

test("an orphan tool.execution.completed (no run) synthesizes and ends a span", async () => {
  const t = fakeTracing();
  const { feed } = makeEngine(t, {
    resolveTurn: async () => ({ turns: [], toolIO: { x: { input: "i", output: "o" } } }),
  });
  await feed([{ type: "tool.execution.completed", ts: 500, toolName: "search_web", toolCallId: "x", durationMs: 40 }]);
  const ret = t.byName("search_web");
  assert.equal(ret.opts.asType, "retriever");
  assert.equal(ret.ended, true);
  assert.equal(ret.attributes.input, "i");
  assert.equal(ret.opts.startTime.getTime(), 500 - 40);
});

test("the reaper finalizes/ends observations idle past the TTL", async () => {
  let clock = 0;
  const t = fakeTracing();
  const engine = createTraceEngine(t, { now: () => clock, ttlMs: 1000, defer: () => {} });
  engine.handle({ type: "run.started", ts: 0, runId: "r1", sessionId: "s", channel: "webchat", trace: { traceId: "T", spanId: "RUN" } });
  engine.handle({ type: "model.call.started", ts: 1, runId: "r1", model: "m", trace: { traceId: "T", spanId: "MC", parentSpanId: "RUN" } });
  const root = t.roots()[0];
  assert.equal(root.ended, false);
  clock = 2000;
  await engine.sweep();
  assert.equal(root.ended, true);
  assert.equal(t.byName("m").ended, true); // the open generation got finalized
});

test("flushAll ends every live observation", async () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, { defer: () => {} });
  engine.handle({ type: "run.started", ts: 0, runId: "r1", sessionId: "s", channel: "webchat", trace: { traceId: "T", spanId: "RUN" } });
  engine.handle({ type: "model.call.started", ts: 1, runId: "r1", model: "m", trace: { traceId: "T", spanId: "MC", parentSpanId: "RUN" } });
  assert.ok(t.all.some((o) => !o.ended));
  await engine.flushAll();
  assert.ok(t.all.every((o) => o.ended));
});

test("a transcript read that throws never breaks finalization", async () => {
  const t = fakeTracing();
  const { feed } = makeEngine(t, {
    resolveTurn: async () => {
      throw new Error("sqlite unavailable");
    },
  });
  await feed(runSequence());
  const root = t.roots()[0];
  assert.equal(root.ended, true);
  assert.equal(root.traceIO, undefined); // no content, but structure is intact
  assert.equal(t.gens().length, 2);
  for (const g of t.gens()) assert.equal(g.ended, true);
  // Usage still lands: it comes from the event stream, not the transcript.
  assert.deepEqual(t.gens()[1].attributes.usageDetails, { input: 100, output: 50, total: 150 });
});

test("handler never throws and reports failures", () => {
  const t = fakeTracing();
  t.startObservation = () => {
    throw new Error("boom");
  };
  let logged = "";
  const engine = createTraceEngine(t, { logger: { error: (m) => (logged = m) }, defer: () => {} });
  assert.equal(engine.handle({ type: "run.started", ts: 0, runId: "r", trace: { traceId: "T" } }), false);
  assert.match(logged, /handler failed/);
});

test("unknown event types are ignored", () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, { defer: () => {} });
  assert.equal(engine.handle({ type: "webhook.received" }), false);
  assert.equal(engine.handle(undefined), false);
  assert.equal(t.all.length, 0);
});
