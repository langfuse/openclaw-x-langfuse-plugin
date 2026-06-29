// Stateful nesting engine: turns OpenClaw's flat diagnostic event stream into
// per-run nested Langfuse traces.
//
// Why this exists: OpenClaw emits a rich, hierarchical event stream — run.*,
// model.call.*, tool.execution.*, context.assembled, model.usage — and every
// event carries a W3C `trace` context ({ traceId, spanId, parentSpanId }) plus
// correlation ids (runId / callId / toolCallId). The old bridge ignored all of
// it and made each `model.usage` its own flat root trace, so tool calls and RAG
// retrievals (which happen *between* model calls) never appeared. The result:
// a generation that says "I'll look it up", then the next generation's input
// magically already contains the retrieved context, with no visible step.
//
// This engine rebuilds the tree the runtime already knows about:
//
//   run (agent)                         [run.started → run.completed]
//   ├─ context.assembled (span)         [context.assembled]
//   ├─ <model> (generation)             [model.call.* + model.usage folds tokens/cost]
//   ├─ <tool> (tool | retriever)        [tool.execution.*]  — retriever for RAG/search
//   ├─ <model> (generation)
//   └─ ...
//
// Nesting uses Langfuse-generated span ids (the SDK gives no way to force a
// span's own id), so we use OpenClaw's (spanId, parentSpanId, runId) purely as
// correlation keys: each created observation is indexed by its OpenClaw spanId,
// and a child resolves its parent by parentSpanId, falling back to the run root
// (by runId), then to a session-tagged standalone root.
//
// Robustness: tool/model-call events are async-queued and droppable under load
// for non-trusted listeners (which we are), so start/complete pairs can orphan.
// We therefore (a) lazily create the run root and tool spans from whichever
// event arrives, and (b) run an idle reaper that ends dangling observations so
// nothing leaks. Every handler is best-effort and never throws into the bus.

import {
  compact,
  setTraceFields,
  classifyToolType,
  usageDetails,
  toDate,
  toolAttributes,
  runAttributes,
  contextAttributes,
  errorAttributes,
} from "./mapping.js";

const DEFAULT_TTL_MS = 5 * 60_000; // end observations idle longer than this
const DEFAULT_MAX_ENTRIES = 5000; // hard cap on live observations (leak backstop)

/** Session id helper: prefer sessionId, fall back to sessionKey. */
function sessionOf(evt) {
  return evt?.sessionId ?? evt?.sessionKey;
}

/**
 * Create a trace engine. `tracing` is the injected @langfuse/tracing surface
 * ({ startObservation }); options carry the best-effort transcript resolvers and
 * tuning knobs. Returns { handle, sweep, flushAll }.
 */
export function createTraceEngine(tracing, opts = {}) {
  const {
    logger,
    resolveContent, // (evt) -> { input, output, sessionInput } | null
    resolveToolIO, // (evt) -> { [toolCallId]: { name, input, output, isError } } | null
    now = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
  } = opts;

  // Live observation registry + lookup indexes. An Entry is:
  //   { obs, kind, runId, spanId, keys:[], lastMs, ended, children:Set,
  //     lastGen, usageFolded, completedMs }
  const live = new Set();
  const spans = new Map(); // ocSpanId -> Entry
  const byKey = new Map(); // callId|toolCallId -> Entry
  const runs = new Map(); // runId -> run Entry

  function touch(entry) {
    entry.lastMs = now();
    return entry;
  }

  /** Index an entry under its OpenClaw span id and any correlation keys. */
  function register(entry, keys = []) {
    live.add(entry);
    if (entry.spanId) spans.set(entry.spanId, entry);
    for (const k of keys) {
      if (k) {
        entry.keys.push(k);
        byKey.set(k, entry);
      }
    }
    if (live.size > maxEntries) evictOldest();
    return entry;
  }

  /** Remove an entry from every index (after it has ended). */
  function forget(entry) {
    live.delete(entry);
    if (entry.spanId && spans.get(entry.spanId) === entry) spans.delete(entry.spanId);
    for (const k of entry.keys) {
      if (byKey.get(k) === entry) byKey.delete(k);
    }
    if (entry.runId && runs.get(entry.runId) === entry) runs.delete(entry.runId);
  }

  /**
   * End an observation once. By default it is also dropped from the indexes;
   * pass `keep` to end the OTel span (fixing its duration) while leaving the
   * entry registered, so late-arriving async children can still resolve it as a
   * parent. Kept entries are forgotten later by the reaper.
   */
  function endEntry(entry, endTimeMs, keep = false) {
    if (!entry || entry.ended) return;
    entry.ended = true;
    try {
      entry.obs.end(toDate(endTimeMs));
    } catch {
      // best-effort; never throw into the bus
    }
    if (!keep) forget(entry);
  }

  function evictOldest() {
    let oldest = null;
    for (const e of live) {
      if (!oldest || e.lastMs < oldest.lastMs) oldest = e;
    }
    if (oldest) endEntry(oldest, now());
  }

  /** Find an entry for an event by its span id, then by callId/toolCallId. */
  function lookup(evt) {
    const sid = evt?.trace?.spanId;
    if (sid && spans.has(sid)) return spans.get(sid);
    const key = evt?.callId ?? evt?.toolCallId;
    if (key && byKey.has(key)) return byKey.get(key);
    return null;
  }

  /**
   * Get-or-create the run root observation. `runSpanId` is the OpenClaw span id
   * of the run itself (so children referencing it via parentSpanId resolve here).
   */
  function ensureRun(evt, runSpanId, startMs) {
    const runId = evt.runId;
    if (runId && runs.has(runId)) return touch(runs.get(runId));

    const name = evt.channel ?? "openclaw run";
    const obs = tracing.startObservation(
      name,
      runAttributes(evt),
      compact({ asType: "agent", startTime: toDate(startMs ?? evt.ts) }),
    );
    setTraceFields(obs, name, sessionOf(evt));
    const entry = {
      obs,
      kind: "run",
      runId,
      spanId: runSpanId,
      keys: [],
      lastMs: now(),
      ended: false,
      children: new Set(),
      lastGen: null,
    };
    register(entry);
    if (runId) runs.set(runId, entry);
    return entry;
  }

  /** Resolve the parent entry for a child event (parentSpanId → run → none). */
  function resolveParent(evt) {
    const parentSpanId = evt?.trace?.parentSpanId;
    if (parentSpanId && spans.has(parentSpanId)) return spans.get(parentSpanId);
    if (evt?.runId) return ensureRun(evt, parentSpanId, evt.ts);
    return null;
  }

  /**
   * Create a child observation under `parent` (or a session-tagged standalone
   * root when there is no parent). `extraKeys` index it for later completion.
   */
  function createChild(evt, parent, { name, asType, attributes, startMs }, extraKeys = []) {
    const optsObj = compact({ asType, startTime: toDate(startMs ?? evt.ts) });
    const obs = parent
      ? parent.obs.startObservation(name, attributes, optsObj)
      : tracing.startObservation(name, attributes, optsObj);
    if (!parent) setTraceFields(obs, evt.channel ?? "openclaw", sessionOf(evt));
    const entry = {
      obs,
      kind: asType,
      runId: evt.runId,
      spanId: evt?.trace?.spanId,
      keys: [],
      lastMs: now(),
      ended: false,
    };
    register(entry, extraKeys);
    if (parent?.children) parent.children.add(entry);
    return entry;
  }

  // --- event handlers --------------------------------------------------------

  function onRunStarted(evt) {
    ensureRun(evt, evt?.trace?.spanId, evt.ts);
  }

  function onRunCompleted(evt) {
    const run = evt.runId && runs.has(evt.runId) ? runs.get(evt.runId) : resolveParent(evt);
    if (!run || run.kind !== "run") return;

    // Mirror the turn's final IO onto the run/trace.
    let content;
    if (typeof resolveContent === "function") {
      try {
        content = resolveContent(evt);
      } catch {
        content = undefined;
      }
    }
    try {
      run.obs.update(
        compact({ metadata: compact({ outcome: evt.outcome, durationMs: evt.durationMs }) }),
      );
      const io = compact({ input: content?.sessionInput, output: content?.output });
      if (Object.keys(io).length > 0 && typeof run.obs.setTraceIO === "function") {
        run.obs.setTraceIO(io);
      }
    } catch {
      // best-effort
    }
    // Soft-end: fix the run span's duration now, but keep the entry registered.
    // The run's own tool/model events are async-queued and arrive *after* this
    // (synchronous) run.completed, so they must still resolve this run as parent.
    // The reaper forgets the entry once it goes idle.
    endEntry(run, evt.ts, true);
  }

  // The generation is modeled from `model.usage` (the only event carrying tokens
  // + cost), nested under its run. We deliberately do NOT also create a
  // generation from model.call.started/completed: those are async-queued and
  // would (a) duplicate the usage generation and (b) race the synchronous
  // model.usage, since events do not arrive in emission order across that
  // sync/async boundary. model.call timing lives in the usage metadata instead.
  function onModelUsage(evt) {
    const parent = resolveParent(evt); // usage chains under the run via parentSpanId
    let content;
    if (typeof resolveContent === "function") {
      try {
        content = resolveContent(evt);
      } catch {
        content = undefined;
      }
    }

    const run = parent && parent.kind === "run" ? parent : null;
    const entry = createChild(evt, run, {
      name: evt.model ?? "model.usage",
      asType: "generation",
      attributes: compact({
        model: evt.model,
        input: content?.input,
        output: content?.output,
        usageDetails: usageDetails(evt.usage),
        costDetails:
          typeof evt.costUsd === "number" ? { totalCost: evt.costUsd } : undefined,
        metadata: compact({
          provider: evt.provider,
          promptTokens: evt.usage?.promptTokens,
          contextLimit: evt.context?.limit,
          contextUsed: evt.context?.used,
          durationMs: evt.durationMs,
        }),
      }),
      startMs: typeof evt.durationMs === "number" ? evt.ts - evt.durationMs : evt.ts,
    });
    if (!run) {
      // No run context (events dropped, or usage-only path): standalone root —
      // mirror IO onto its own trace, preserving the pre-nesting behavior.
      const io = compact({ input: content?.input, output: content?.output });
      if (Object.keys(io).length > 0 && typeof entry.obs.setTraceIO === "function") {
        entry.obs.setTraceIO(io);
      }
    }
    endEntry(entry, evt.ts);
  }

  function onModelCallError(evt) {
    const parent = resolveParent(evt);
    const entry = createChild(evt, parent, {
      name: "model.call.error",
      asType: "span",
      attributes: errorAttributes(evt),
    });
    endEntry(entry, evt.ts);
  }

  function onToolStarted(evt) {
    const parent = resolveParent(evt);
    const asType = classifyToolType(evt.toolName);
    const entry = createChild(
      evt,
      parent,
      {
        name: evt.toolName ?? asType,
        asType,
        attributes: toolAttributes(evt),
      },
      [evt.toolCallId],
    );
    entry.toolCallId = evt.toolCallId;
  }

  function onToolTerminal(evt) {
    let entry = lookup(evt);
    if (!entry) {
      // started was dropped: synthesize the span, backdating its start.
      const parent = resolveParent(evt);
      const asType = classifyToolType(evt.toolName);
      entry = createChild(
        evt,
        parent,
        {
          name: evt.toolName ?? asType,
          asType,
          attributes: toolAttributes(evt),
          startMs: typeof evt.durationMs === "number" ? evt.ts - evt.durationMs : evt.ts,
        },
        [evt.toolCallId],
      );
      entry.toolCallId = evt.toolCallId;
    }
    const isError = evt.type === "tool.execution.error" || evt.type === "tool.execution.blocked";

    // Best-effort tool I/O from the trajectory (args + result), keyed by
    // toolCallId. Tool terminal events are async-queued and typically arrive
    // after the turn has been flushed to the trajectory, so the result is
    // usually present by now.
    let io;
    if (evt.toolCallId && typeof resolveToolIO === "function") {
      try {
        io = resolveToolIO(evt)?.[evt.toolCallId];
      } catch {
        io = undefined; // best-effort
      }
    }
    try {
      entry.obs.update(
        compact({
          input: io?.input,
          output: io?.output,
          level: isError || io?.isError ? "ERROR" : undefined,
          statusMessage: evt.errorCategory ?? evt.deniedReason ?? evt.reason,
          metadata: compact({
            durationMs: evt.durationMs,
            errorCategory: evt.errorCategory,
            errorCode: evt.errorCode,
            deniedReason: evt.deniedReason,
          }),
        }),
      );
    } catch {
      // best-effort
    }
    endEntry(entry, evt.ts);
  }

  function onContextAssembled(evt) {
    const parent = resolveParent(evt);
    const entry = createChild(evt, parent, {
      name: "context.assembled",
      asType: "span",
      attributes: contextAttributes(evt),
    });
    endEntry(entry, evt.ts); // instant marker
  }

  /** Dispatch a single diagnostic event. Returns true if handled. */
  function handle(evt) {
    try {
      switch (evt?.type) {
        case "run.started":
          onRunStarted(evt);
          return true;
        case "run.completed":
          onRunCompleted(evt);
          return true;
        case "model.call.error":
          onModelCallError(evt);
          return true;
        case "model.usage":
          onModelUsage(evt);
          return true;
        case "tool.execution.started":
          onToolStarted(evt);
          return true;
        case "tool.execution.completed":
        case "tool.execution.error":
        case "tool.execution.blocked":
          onToolTerminal(evt);
          return true;
        case "context.assembled":
          onContextAssembled(evt);
          return true;
        default:
          return false;
      }
    } catch (err) {
      logger?.error?.(
        `langfuse-bridge: handler failed (${evt?.type}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  /**
   * Backstop for the async event stream: end observations left dangling by
   * dropped terminal events, and forget soft-ended runs once they go idle (their
   * span is already closed; this just releases the map entry).
   */
  function sweep(nowMs = now()) {
    const cutoff = nowMs - ttlMs;
    for (const entry of [...live]) {
      if (entry.lastMs >= cutoff) continue;
      if (entry.ended) forget(entry);
      else endEntry(entry, nowMs);
    }
  }

  /** End every live observation (called on shutdown). */
  function flushAll() {
    const nowMs = now();
    for (const entry of [...live]) {
      if (entry.ended) forget(entry);
      else endEntry(entry, nowMs);
    }
  }

  return { handle, sweep, flushAll };
}
