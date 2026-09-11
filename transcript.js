// Best-effort recovery of prompt/response and tool I/O for a turn.
//
// OpenClaw never hands message content to third-party plugins: prompts,
// responses, tool arguments and tool results travel as *private data* on the
// diagnostics bus and are delivered only to the bundled `diagnostics-otel` /
// `diagnostics-prometheus` services (the runtime injects
// `ctx.internalDiagnostics` — the only listener that receives private data —
// solely for those two service ids). The public `onInternalDiagnosticEvent`
// stream this bridge uses carries structure, timings and usage but no text.
//
// So we read the turn's content back out of the session transcript. There are
// two sources, feeding one extractor:
//
//   1. The host's transcript API (`readVisibleSessionTranscriptMessageEntries`
//      from `openclaw/plugin-sdk/session-transcript-runtime`). It reads whatever
//      store the running host uses — SQLite (`<stateDir>/agents/<agentId>/agent/
//      openclaw-agent.sqlite`) on OpenClaw >= 2026.8 — and returns the ordered
//      conversation messages. This is the primary source.
//   2. The legacy per-session `<sessionId>.trajectory.jsonl` sidecar, which
//      older hosts wrote next to the session store and 2026.8+ no longer
//      produces. This is the fallback for pre-2026.8 hosts.
//
// Both paths end up in `extractTurnContent`, because the sidecar's
// `model.completed.messagesSnapshot` holds the same message shapes the
// transcript API returns.
//
// Everything here is best-effort: a missing store, an unavailable SDK module or
// a format change returns null and never blocks event forwarding.

import { openSync, readSync, readFileSync, statSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Cap how much of a (potentially long-lived) legacy sidecar we read; we only
// need the tail, which holds the most recent cumulative snapshot.
const MAX_READ_BYTES = 2_000_000;

/** Resolve OpenClaw's state dir: ctx.stateDir, then env, then ~/.openclaw. */
export function resolveStateDir(stateDir) {
  if (typeof stateDir === "string" && stateDir.length > 0) return stateDir;
  if (process.env.OPENCLAW_STATE_DIR) return process.env.OPENCLAW_STATE_DIR;
  return path.join(homedir(), ".openclaw");
}

/** Path to a session's legacy trajectory sidecar (pre-2026.8 hosts). */
export function trajectoryPath(stateDir, agentId, sessionId) {
  return path.join(
    resolveStateDir(stateDir),
    "agents",
    agentId || "main",
    "sessions",
    `${sessionId}.trajectory.jsonl`,
  );
}

/**
 * Agent id embedded in a scoped session key (`agent:<agentId>:<rest>`). The
 * transcript API requires an agent id, and some diagnostic events carry the
 * session key but not `agentId`.
 */
export function agentIdFromSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") return undefined;
  const m = /^agent:([^:]+):/.exec(sessionKey);
  return m ? m[1] : undefined;
}

/** Flatten message content (string | array of blocks) to plain text. */
function blocksToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** Serialize tool arguments for an observation's input. */
function argsToText(args) {
  if (args === undefined) return undefined;
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return undefined;
  }
}

/**
 * Pure: extract one turn's content from an ordered conversation.
 *
 * A trace is a single turn, so we slice the conversation at the last real user
 * message (`runtimeContextCarrier` messages are per-turn runtime scaffolding,
 * not the user's prompt) and read only that tail:
 *
 *   - `input`  — the user's prompt for this turn.
 *   - `output` — the last assistant text of the turn (its final answer).
 *   - `turns`  — one entry per assistant message, in order, so each generation
 *                can be given its OWN output instead of all of them joined.
 *                Carries the message's per-call `usage` when the store has it.
 *   - `toolIO` — `{ [toolCallId]: { name, input, output, isError } }`, matching
 *                the `toolCallId` on `tool.execution.*` diagnostic events.
 *
 * Returns null when nothing usable is found.
 */
export function extractTurnContent(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;

  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "user" && msg.runtimeContextCarrier !== true) {
      start = i;
      break;
    }
  }
  const turn = start >= 0 ? messages.slice(start) : messages;
  const input = start >= 0 ? blocksToText(messages[start].content) || undefined : undefined;

  const turns = [];
  const toolIO = {};
  let output;

  for (const msg of turn) {
    if (msg?.role === "assistant") {
      const text = blocksToText(msg.content);
      const toolCalls = [];
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
          const entry = (toolIO[block.id] ??= {});
          if (typeof block.name === "string") {
            entry.name = block.name;
            toolCalls.push(block.name);
          }
          const args = argsToText(block.arguments);
          if (args !== undefined) entry.input = args;
        }
      }
      turns.push({
        output: text || (toolCalls.length > 0 ? `→ called: ${toolCalls.join(", ")}` : ""),
        toolCalls,
        usage: msg.usage,
        model: typeof msg.model === "string" ? msg.model : undefined,
      });
      if (text) output = text;
      continue;
    }
    if (msg?.role === "toolResult" && typeof msg.toolCallId === "string") {
      const entry = (toolIO[msg.toolCallId] ??= {});
      const out = blocksToText(msg.content);
      if (out) entry.output = out;
      if (typeof msg.toolName === "string") entry.name ??= msg.toolName;
      if (typeof msg.isError === "boolean") entry.isError = msg.isError;
    }
  }

  const hasToolIO = Object.keys(toolIO).length > 0;
  if (input === undefined && output === undefined && turns.length === 0 && !hasToolIO) {
    return null;
  }
  const out = { turns };
  if (input !== undefined) out.input = input;
  if (output !== undefined) out.output = output;
  if (hasToolIO) out.toolIO = toolIO;
  return out;
}

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null; // tolerate a truncated boundary line from a windowed read
  }
}

/**
 * Pure: extract turn content from legacy trajectory JSONL text. The last
 * `model.completed` entry carries `messagesSnapshot` — the cumulative
 * conversation in the same message shapes the transcript API returns — so it
 * goes straight through `extractTurnContent`. Hosts that recorded only
 * `finalPromptText`/`assistantTexts` fall back to those fields.
 */
export function extractFromTrajectory(text) {
  let snapshot;
  let promptText;
  let assistantText;
  for (const line of String(text ?? "").split("\n")) {
    const obj = parseLine(line);
    if (!obj) continue;
    const data = obj.data;
    if (obj.type === "model.completed") {
      if (Array.isArray(data?.messagesSnapshot)) snapshot = data.messagesSnapshot;
      if (typeof data?.finalPromptText === "string") promptText = data.finalPromptText;
      if (Array.isArray(data?.assistantTexts) && data.assistantTexts.length > 0) {
        assistantText = data.assistantTexts.join("\n");
      }
    } else if (obj.type === "prompt.submitted" && typeof data?.prompt === "string") {
      promptText = data.prompt;
    }
  }
  const fromSnapshot = extractTurnContent(snapshot);
  if (fromSnapshot) return fromSnapshot;
  if (promptText === undefined && assistantText === undefined) return null;
  const out = { turns: assistantText !== undefined ? [{ output: assistantText, toolCalls: [] }] : [] };
  if (promptText !== undefined) out.input = promptText;
  if (assistantText !== undefined) out.output = assistantText;
  return out;
}

/** Read the tail of a file as UTF-8 text (whole file when small enough). */
function readTail(file, maxBytes) {
  const { size } = statSync(file);
  if (size <= maxBytes) return readFileSync(file, "utf8");
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, size - maxBytes);
    return buf.toString("utf8", 0, bytes);
  } finally {
    closeSync(fd);
  }
}

/** Legacy sidecar read for one session. Returns content or null; never throws. */
function readLegacyTrajectory(stateDir, ident, logger) {
  try {
    const sessionId = ident?.sessionId ?? ident?.sessionKey;
    if (!sessionId) return null;
    const file = trajectoryPath(
      stateDir,
      ident?.agentId ?? agentIdFromSessionKey(ident?.sessionKey),
      sessionId,
    );
    return extractFromTrajectory(readTail(file, MAX_READ_BYTES));
  } catch (err) {
    // No sidecar on 2026.8+ hosts, or it is mid-write; this is best-effort.
    logger?.debug?.(
      `langfuse-bridge: no legacy transcript sidecar (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return null;
  }
}

/**
 * Load the host's transcript reader. Returns
 * `(ident) => Promise<messages[] | null>` or null when the running host does
 * not expose the module (pre-2026.8) — importing it also opens the state
 * database, which can throw on an unsupported Node/SQLite build, so the import
 * itself is guarded and a failure just means "use the legacy sidecar".
 */
export async function loadTranscriptMessageReader(logger) {
  let read;
  try {
    const mod = await import("openclaw/plugin-sdk/session-transcript-runtime");
    read = mod?.readVisibleSessionTranscriptMessageEntries;
  } catch (err) {
    logger?.info?.(
      `langfuse-bridge: host transcript API unavailable, falling back to the legacy trajectory sidecar (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return null;
  }
  if (typeof read !== "function") {
    logger?.info?.(
      "langfuse-bridge: host transcript API unavailable, falling back to the legacy trajectory sidecar",
    );
    return null;
  }
  return async (ident) => {
    const sessionId = ident?.sessionId;
    // The reader resolves a transcript from agentId + sessionId; the session key
    // is accepted either bare or already agent-scoped (it is not re-prefixed).
    const agentId = ident?.agentId ?? agentIdFromSessionKey(ident?.sessionKey) ?? "main";
    if (!sessionId) return null;
    const params = { sessionId, agentId };
    if (ident?.sessionKey) params.sessionKey = ident.sessionKey;
    const entries = await read(params);
    if (!Array.isArray(entries)) return null;
    return entries.map((entry) => entry?.message).filter(Boolean);
  };
}

/**
 * Build the turn-content resolver used by the trace engine. Prefers the host
 * transcript API and falls back to the legacy sidecar; returns
 * `async (ident) => content | null` and never throws.
 */
export function makeTurnResolver({ stateDir, logger, readMessages } = {}) {
  return async (ident) => {
    if (typeof readMessages === "function") {
      try {
        const content = extractTurnContent(await readMessages(ident));
        if (content) return content;
      } catch (err) {
        logger?.debug?.(
          `langfuse-bridge: transcript read failed (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
    }
    return readLegacyTrajectory(stateDir, ident, logger);
  };
}
