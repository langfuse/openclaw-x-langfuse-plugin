// Pure mapping helpers: translate OpenClaw diagnostic events into the shapes the
// Langfuse v5 (OpenTelemetry) SDK expects. These functions hold no state and do
// no I/O, so they can be unit-tested in isolation. The stateful nesting of
// observations into per-run traces lives in `tracer.js`.

// Langfuse OTel attribute keys (from @langfuse/core LangfuseOtelSpanAttributes).
export const TRACE_NAME = "langfuse.trace.name";
export const TRACE_SESSION_ID = "session.id";

/** Drop undefined/null values so we never send empty fields to Langfuse. */
export function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/**
 * Write trace-level name/sessionId onto an observation's root OTel span. We set
 * these straight on the span (rather than via `propagateAttributes`, which needs
 * a global OTel context manager we deliberately don't register) so Langfuse
 * promotes them to the trace. Only meaningful on a trace's root observation.
 */
export function setTraceFields(obs, name, sessionId) {
  const span = obs?.otelSpan;
  if (!span || typeof span.setAttribute !== "function") return;
  if (name !== undefined && name !== null) span.setAttribute(TRACE_NAME, name);
  if (sessionId !== undefined && sessionId !== null) {
    span.setAttribute(TRACE_SESSION_ID, sessionId);
  }
}

// Tool names whose work is retrieval/search — these become Langfuse `retriever`
// observations so RAG steps render distinctly from ordinary tool calls. Matched
// case-insensitively as a substring of the tool name.
const RETRIEVER_NAME_RE =
  /(search|retriev|rag\b|vector|embed|semantic|lookup|recall|knowledge|grep|memory|index|web[_-]?fetch|fetch[_-]?url|find)/i;

/**
 * Classify a tool by name into a Langfuse observation type: "retriever" for
 * retrieval/search/RAG tools, "tool" otherwise. The toolSource ("mcp", "core",
 * etc.) is not used for classification but is carried in metadata.
 */
export function classifyToolType(toolName) {
  return typeof toolName === "string" && RETRIEVER_NAME_RE.test(toolName)
    ? "retriever"
    : "tool";
}

/** Map an OpenClaw usage object to Langfuse usageDetails (snake_case keys). */
export function usageDetails(usage = {}) {
  return compact({
    input: usage.input,
    output: usage.output,
    cache_read: usage.cacheRead,
    cache_write: usage.cacheWrite,
    total: usage.total,
  });
}

/** Convert an epoch-ms timestamp to a Date, or undefined. */
export function toDate(ms) {
  return typeof ms === "number" ? new Date(ms) : undefined;
}

/** Attributes for a `generation` observation built from a model.call event. */
export function generationAttributes(evt) {
  return compact({
    model: evt.model,
    metadata: compact({
      provider: evt.provider,
      api: evt.api,
      transport: evt.transport,
      callId: evt.callId,
      runId: evt.runId,
      contextTokenBudget: evt.contextTokenBudget,
      contextWindowSource: evt.contextWindowSource,
    }),
  });
}

/** Attributes for a `tool`/`retriever` observation from a tool.execution event. */
export function toolAttributes(evt) {
  return compact({
    metadata: compact({
      toolSource: evt.toolSource,
      toolOwner: evt.toolOwner,
      toolCallId: evt.toolCallId,
      runId: evt.runId,
      paramsSummary: evt.paramsSummary,
    }),
  });
}

/** Attributes for the per-run root observation. */
export function runAttributes(evt) {
  return compact({
    metadata: compact({
      runId: evt.runId,
      provider: evt.provider,
      model: evt.model,
      trigger: evt.trigger,
      channel: evt.channel,
    }),
  });
}

/** Attributes for a `context.assembled` observation. */
export function contextAttributes(evt) {
  return compact({
    metadata: compact({
      runId: evt.runId,
      messageCount: evt.messageCount,
      historyTextChars: evt.historyTextChars,
      systemPromptChars: evt.systemPromptChars,
      promptChars: evt.promptChars,
      promptImages: evt.promptImages,
      contextTokenBudget: evt.contextTokenBudget,
    }),
  });
}

/**
 * Human-readable one-line summary of a `context.assembled` event's sizes, used
 * as the observation's `output` so the row isn't blank. The event carries only
 * counts (no text), so this surfaces the numbers that are otherwise buried in
 * metadata. Returns undefined when there's nothing to summarize.
 */
export function contextSummary(evt) {
  const parts = [];
  const add = (label, v) => {
    if (typeof v === "number") parts.push(`${label}=${v}`);
  };
  add("messages", evt.messageCount);
  add("promptChars", evt.promptChars);
  add("systemPromptChars", evt.systemPromptChars);
  add("historyTextChars", evt.historyTextChars);
  add("promptImages", evt.promptImages);
  add("historyImageBlocks", evt.historyImageBlocks);
  add("tokenBudget", evt.contextTokenBudget);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Attributes for an ERROR observation (model.call.error / tool.execution.error). */
export function errorAttributes(evt) {
  return compact({
    level: "ERROR",
    statusMessage: evt.errorCategory ?? evt.failureKind ?? evt.deniedReason,
    metadata: compact({
      provider: evt.provider,
      model: evt.model,
      errorCategory: evt.errorCategory,
      errorCode: evt.errorCode,
      failureKind: evt.failureKind,
      callId: evt.callId,
      runId: evt.runId,
      toolCallId: evt.toolCallId,
    }),
  });
}
