// Stateful engine: turns OpenClaw's diagnostic event stream into one nested
// Langfuse trace per turn.
//
// Why this exists: OpenClaw emits a rich event stream — run.*, model.call.*,
// tool.execution.*, context.assembled, model.usage — and stamps a W3C `trace`
// context ({ traceId, spanId, parentSpanId }) on every event. The old bridge
// ignored it and made each `model.usage` its own flat root trace, so tool calls
// and RAG retrievals (which happen between model calls) never appeared: a
// generation said "I'll look it up", then the next generation's input already
// contained the retrieved context, with no visible step.
//
// Grouping key — the W3C traceId. Captured from a live run, one webchat turn's
// span hierarchy looks like:
//
//   <message scope>                         (parent=None)   ← shared trace root "D"
//   └─ harness.run                          (parent=D)
//      ├─ run                               (parent=harness)
//      │  ├─ context.assembled              (parent=run)
//      │  └─ model.call                     (parent=run)
//      └─ model.usage                       (parent=harness) ← sibling of run, NOT under it
//
// Every event of the turn shares one traceId, but the span *parent* chain is
// inconsistent (model.usage hangs off the harness, tools/context hang off the
// run). So we don't try to reconstruct that internal chain. Instead we create
// one Langfuse root per W3C traceId and hang the interesting observations under
// it — flat:
//
//   <turn> (agent)                          one per W3C traceId
//   ├─ context.assembled (span)
//   ├─ <model> (generation)                 from model.usage: tokens + cost + IO
//   ├─ <tool> (tool | retriever)            from tool.execution.* — retriever for RAG
//   └─ <model> (generation)
//
// The SDK gives no way to set a span's own id, so children are created via
// `root.startObservation(...)` (Langfuse-generated ids); OpenClaw's traceId is
// the only correlation key we need. Tool start/terminal pairs match on
// toolCallId. Every handler is best-effort and never throws into the bus.

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
  //   { obs, kind, traceId, keys:[], lastMs, ended }
  const live = new Set();
  const roots = new Map(); // W3C traceId -> root Entry
  const byKey = new Map(); // toolCallId|callId -> child Entry (start↔terminal match)

  function touch(entry) {
    entry.lastMs = now();
    return entry;
  }

  function register(entry, keys = []) {
    live.add(entry);
    for (const k of keys) {
      if (k) {
        entry.keys.push(k);
        byKey.set(k, entry);
      }
    }
    if (live.size > maxEntries) evictOldest();
    return entry;
  }

  function forget(entry) {
    live.delete(entry);
    for (const k of entry.keys) if (byKey.get(k) === entry) byKey.delete(k);
    if (entry.traceId && roots.get(entry.traceId) === entry) roots.delete(entry.traceId);
  }

  /**
   * End an observation once. By default it is dropped from the indexes; pass
   * `keep` to end the OTel span (fixing its duration) while leaving the entry
   * registered, so late-arriving events for the same trace still resolve it as a
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
    for (const e of live) if (!oldest || e.lastMs < oldest.lastMs) oldest = e;
    if (oldest) endEntry(oldest, now());
  }

  /**
   * Get-or-create the per-turn root observation, keyed by the event's W3C
   * traceId. Returns null when the event carries no traceId (caller then makes a
   * standalone root). Refreshes name/session when a later event supplies a better
   * channel/session than whatever created the root.
   */
  function ensureRoot(evt) {
    const tid = evt?.trace?.traceId;
    if (!tid) return null;
    const existing = roots.get(tid);
    if (existing) {
      maybeRefreshRoot(existing, evt);
      return touch(existing);
    }
    const name = evt.channel ?? "openclaw run";
    const obs = tracing.startObservation(
      name,
      runAttributes(evt),
      compact({ asType: "agent", startTime: toDate(evt.ts) }),
    );
    setTraceFields(obs, name, sessionOf(evt));
    const entry = {
      obs,
      kind: "root",
      traceId: tid,
      named: Boolean(evt.channel),
      sessioned: Boolean(sessionOf(evt)),
      keys: [],
      lastMs: now(),
      ended: false,
    };
    register(entry);
    roots.set(tid, entry);
    return entry;
  }

  /** Fill in the root's name/session once an event carries them (events vary). */
  function maybeRefreshRoot(root, evt) {
    if (root.ended) return;
    if (!root.named && evt.channel) {
      try {
        root.obs.update({ name: evt.channel });
        setTraceFields(root.obs, evt.channel, undefined);
      } catch {
        /* best-effort */
      }
      root.named = true;
    }
    if (!root.sessioned && sessionOf(evt)) {
      setTraceFields(root.obs, undefined, sessionOf(evt));
      root.sessioned = true;
    }
  }

  /**
   * Create a child observation under the turn root (or a session-tagged
   * standalone root when the event has no traceId). `extraKeys` index it so a
   * later terminal event can find and finish it.
   */
  function createChild(evt, root, { name, asType, attributes, startMs }, extraKeys = []) {
    const optsObj = compact({ asType, startTime: toDate(startMs ?? evt.ts) });
    const obs = root
      ? root.obs.startObservation(name, attributes, optsObj)
      : tracing.startObservation(name, attributes, optsObj);
    if (!root) setTraceFields(obs, evt.channel ?? "openclaw", sessionOf(evt));
    const entry = {
      obs,
      kind: asType,
      traceId: evt?.trace?.traceId,
      keys: [],
      lastMs: now(),
      ended: false,
    };
    register(entry, extraKeys);
    return entry;
  }

  // --- event handlers --------------------------------------------------------

  function onRunStarted(evt) {
    ensureRoot(evt); // anchor the turn root; children attach to it
  }

  function onRunCompleted(evt) {
    const root = ensureRoot(evt);
    if (!root) return;
    let content;
    if (typeof resolveContent === "function") {
      try {
        content = resolveContent(evt);
      } catch {
        content = undefined;
      }
    }
    try {
      root.obs.update(
        compact({ metadata: compact({ outcome: evt.outcome, durationMs: evt.durationMs }) }),
      );
      const io = compact({ input: content?.sessionInput, output: content?.output });
      if (Object.keys(io).length > 0 && typeof root.obs.setTraceIO === "function") {
        root.obs.setTraceIO(io);
      }
    } catch {
      // best-effort
    }
    // Soft-end: fix the root's duration but keep it resolvable — model.usage and
    // other events arrive *after* run.completed and must still attach here.
    endEntry(root, evt.ts, true);
  }

  // The generation is modeled from `model.usage` (the only event carrying tokens
  // + cost), nested under the turn root. We deliberately ignore model.call.* for
  // observation creation: those would duplicate the usage generation, and their
  // span parent is the run while usage's is the harness — so there is no clean
  // shared subtree to reconstruct anyway.
  function onModelUsage(evt) {
    const root = ensureRoot(evt);
    let content;
    if (typeof resolveContent === "function") {
      try {
        content = resolveContent(evt);
      } catch {
        content = undefined;
      }
    }
    const entry = createChild(evt, root, {
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
    if (!root) {
      // No traceId (degenerate / dropped): standalone root — mirror IO onto its
      // own trace, preserving the pre-nesting behavior.
      const io = compact({ input: content?.input, output: content?.output });
      if (Object.keys(io).length > 0 && typeof entry.obs.setTraceIO === "function") {
        entry.obs.setTraceIO(io);
      }
    }
    endEntry(entry, evt.ts);
  }

  function onModelCallError(evt) {
    const root = ensureRoot(evt);
    endEntry(
      createChild(evt, root, {
        name: "model.call.error",
        asType: "span",
        attributes: errorAttributes(evt),
      }),
      evt.ts,
    );
  }

  function onToolStarted(evt) {
    const root = ensureRoot(evt);
    const asType = classifyToolType(evt.toolName);
    const entry = createChild(
      evt,
      root,
      { name: evt.toolName ?? asType, asType, attributes: toolAttributes(evt) },
      [evt.toolCallId],
    );
    entry.toolCallId = evt.toolCallId;
  }

  function onToolTerminal(evt) {
    let entry = evt.toolCallId ? byKey.get(evt.toolCallId) : null;
    if (!entry || entry.ended) {
      // started was dropped: synthesize the span, backdating its start.
      const root = ensureRoot(evt);
      const asType = classifyToolType(evt.toolName);
      entry = createChild(
        evt,
        root,
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
    const isError =
      evt.type === "tool.execution.error" || evt.type === "tool.execution.blocked";

    // Best-effort tool I/O (args + result) from the trajectory, by toolCallId.
    let io;
    if (evt.toolCallId && typeof resolveToolIO === "function") {
      try {
        io = resolveToolIO(evt)?.[evt.toolCallId];
      } catch {
        io = undefined;
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
    const root = ensureRoot(evt);
    endEntry(
      createChild(evt, root, {
        name: "context.assembled",
        asType: "span",
        attributes: contextAttributes(evt),
      }),
      evt.ts,
    );
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
   * dropped terminal events, and forget soft-ended roots once they go idle.
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
