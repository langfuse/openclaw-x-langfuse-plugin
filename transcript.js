// Best-effort capture of prompt/response content for a model.usage event.
//
// OpenClaw does not deliver prompt/completion text to third-party plugins (the
// `model.usage` diagnostic carries usage/cost only; message content is private
// data handed exclusively to bundled diagnostics services). To still populate
// the Langfuse generation's input/output, we read OpenClaw's per-session
// transcript. Storage locations, tried in order:
//
//   - Current (OpenClaw ≥2026.7): the per-agent SQLite DB
//     `agents/<id>/agent/openclaw-agent.sqlite`, table `transcript_events`
//     (one JSON entry per row — same shapes as the JSONL formats below).
//   - File transcript `agents/<id>/sessions/{sessionId}.jsonl` — an append-only
//     message log. Each line is `{type:"message", message:{role, content, ...}}`
//     where user prompts are `role:"user"` messages and replies are
//     `role:"assistant"` messages with content blocks. Tool calls are assistant
//     `toolCall` blocks and tool results are `role:"toolResult"` messages
//     carrying `toolCallId`.
//   - Legacy: `{sessionId}.trajectory.jsonl` — `model.completed` entries with
//     `finalPromptText`/`assistantTexts` and a cumulative `messagesSnapshot`.
//
// This is intentionally best-effort: any failure (store missing, not yet
// flushed, format change) returns null and never blocks usage forwarding.

import { openSync, readSync, readFileSync, statSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// node:sqlite ships with Node ≥22.5; required lazily so older runtimes that
// never reach the SQLite path can still load this module.
const require = createRequire(import.meta.url);
let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = undefined;
}

// Cap how much of a (potentially long-lived) transcript we read; we only need
// the tail (most recent turn) and a small head (the session's first prompt).
const MAX_READ_BYTES = 2_000_000;
const HEAD_READ_BYTES = 256_000;
// Row caps for the SQLite path (same role as the byte caps above).
const TAIL_ROW_LIMIT = 400;
const HEAD_ROW_LIMIT = 100;

/** Resolve OpenClaw's state dir: ctx.stateDir, then env, then ~/.openclaw. */
export function resolveStateDir(stateDir) {
  if (typeof stateDir === "string" && stateDir.length > 0) return stateDir;
  if (process.env.OPENCLAW_STATE_DIR) return process.env.OPENCLAW_STATE_DIR;
  return path.join(homedir(), ".openclaw");
}

function sessionsDir(stateDir, agentId) {
  return path.join(resolveStateDir(stateDir), "agents", agentId || "main", "sessions");
}

/** Path to a session's primary transcript (current OpenClaw: `{id}.jsonl`). */
export function transcriptPath(stateDir, agentId, sessionId) {
  return path.join(sessionsDir(stateDir, agentId), `${sessionId}.jsonl`);
}

/** Path to a session's legacy trajectory transcript (`{id}.trajectory.jsonl`). */
export function trajectoryPath(stateDir, agentId, sessionId) {
  return path.join(sessionsDir(stateDir, agentId), `${sessionId}.trajectory.jsonl`);
}

/** Path to an agent's state DB (current OpenClaw stores transcripts there). */
export function agentDbPath(stateDir, agentId) {
  return path.join(
    resolveStateDir(stateDir),
    "agents",
    agentId || "main",
    "agent",
    "openclaw-agent.sqlite",
  );
}

/**
 * Read a session's transcript rows from the agent SQLite DB. Returns
 * { tailText, headText } (rows joined as JSONL text) or null when the DB or
 * session is unavailable. Never throws; readers tolerate concurrent writers
 * (readonly connection over WAL).
 */
function readSqliteTranscript(stateDir, evt, logger) {
  if (!DatabaseSync) return null;
  const sessionId = evt?.sessionId ?? evt?.sessionKey;
  if (!sessionId) return null;
  const dbFile = agentDbPath(stateDir, evt?.agentId);
  let db;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const tailRows = db
      .prepare(
        "SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq DESC LIMIT ?",
      )
      .all(sessionId, TAIL_ROW_LIMIT);
    if (!tailRows || tailRows.length === 0) return null;
    // Query was DESC (newest first); reverse into chronological order.
    const tailText = tailRows.map((r) => r.event_json).reverse().join("\n");
    const headRows = db
      .prepare(
        "SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq ASC LIMIT ?",
      )
      .all(sessionId, HEAD_ROW_LIMIT);
    const headText =
      tailRows.length < TAIL_ROW_LIMIT
        ? tailText // whole session fits in the tail window
        : headRows.map((r) => r.event_json).join("\n");
    return { tailText, headText };
  } catch (err) {
    logger?.debug?.(
      `langfuse-bridge: could not read agent db transcript (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort */
    }
  }
}

/** Read a byte window of a file as UTF-8 text. `from: "head" | "tail"`. */
function readWindow(file, maxBytes, from) {
  const { size } = statSync(file);
  if (size <= maxBytes) return readFileSync(file, "utf8");
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const start = from === "tail" ? size - maxBytes : 0;
    const bytes = readSync(fd, buf, 0, maxBytes, start);
    return buf.toString("utf8", 0, bytes);
  } finally {
    closeSync(fd);
  }
}

/** Extract a prompt/response from a single parsed transcript entry. Handles
 * both the current message-log format and the legacy trajectory format. */
function entryIO(obj) {
  // Current format: {type:"message", message:{role, content, ...}}.
  if (obj?.type === "message") {
    const msg = obj.message;
    if (!msg || typeof msg !== "object") return {};
    if (msg.role === "user") {
      const input = contentToText(msg.content);
      return input !== undefined ? { input } : {};
    }
    if (msg.role === "assistant") {
      // Only text blocks carry the reply (thinking blocks have no `text`).
      const output = contentToText(msg.content);
      return output !== undefined ? { output } : {};
    }
    return {};
  }
  // Legacy format: model.completed / prompt.submitted entries.
  const data = obj?.data;
  if (!data) return {};
  if (obj.type === "model.completed") {
    const io = {};
    if (typeof data.finalPromptText === "string") io.input = data.finalPromptText;
    if (Array.isArray(data.assistantTexts) && data.assistantTexts.length > 0) {
      io.output = data.assistantTexts.join("\n");
    }
    return io;
  }
  if (obj.type === "prompt.submitted" && typeof data.prompt === "string") {
    return { input: data.prompt };
  }
  return {};
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

/** Flatten a tool-result `content` value (string | array of text blocks) to text. */
function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (block && typeof block.text === "string") parts.push(block.text);
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return undefined;
}

/**
 * Pure: extract per-tool input/output from transcript JSONL text, keyed by the
 * tool call id (which matches the `toolCallId` on `tool.execution.*` diagnostic
 * events). Supports both formats:
 *
 *   - Current message log: `{type:"message", message:{...}}` lines; tool inputs
 *     live on assistant `toolCall` blocks ({ id, name, arguments }) and tool
 *     outputs on `role:"toolResult"` messages ({ toolCallId, toolName, content,
 *     isError }).
 *   - Legacy trajectory: the LAST `model.completed` entry's cumulative
 *     `messagesSnapshot` holds the same message shapes.
 *
 * Returns a plain object { [toolCallId]: { name, input, output, isError } } or
 * null when none found.
 */
export function extractToolIO(text) {
  const lines = text.split("\n");
  let snapshot;
  const logged = [];
  for (const line of lines) {
    const obj = parseLine(line);
    if (!obj) continue;
    if (obj.type === "message" && obj.message && typeof obj.message === "object") {
      logged.push(obj.message);
      continue;
    }
    // Legacy: keep the latest snapshot (cumulative, so last wins).
    if (obj.type === "model.completed" && Array.isArray(obj?.data?.messagesSnapshot)) {
      snapshot = obj.data.messagesSnapshot;
    }
  }
  const messages = logged.length > 0 ? logged : snapshot;
  if (!messages) return null;

  const byId = {};
  const ensure = (id) => (byId[id] ??= {});
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    // Tool outputs: dedicated toolResult messages.
    if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
      const entry = ensure(msg.toolCallId);
      const out = contentToText(msg.content);
      if (out !== undefined) entry.output = out;
      if (typeof msg.toolName === "string") entry.name ??= msg.toolName;
      if (typeof msg.isError === "boolean") entry.isError = msg.isError;
      continue;
    }
    // Tool inputs: assistant toolCall content blocks.
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
      const entry = ensure(block.id);
      if (typeof block.name === "string") entry.name = block.name;
      if (block.arguments !== undefined) {
        entry.input =
          typeof block.arguments === "string"
            ? block.arguments
            : JSON.stringify(block.arguments);
      }
    }
  }
  return Object.keys(byId).length > 0 ? byId : null;
}

/**
 * Pure: extract turn content from transcript JSONL text (current message log
 * or legacy trajectory). Returns { input, output, sessionInput } where
 * `input`/`output` are the latest turn (for the generation) and `sessionInput`
 * is the first prompt in the text (for trace-level aggregation). Returns null
 * when nothing usable is found.
 */
export function extractContent(text) {
  const lines = text.split("\n");
  let input;
  let output;
  let sessionInput;
  for (const line of lines) {
    const obj = parseLine(line);
    if (!obj) continue;
    const io = entryIO(obj);
    if (io.input !== undefined) {
      input = io.input;
      if (sessionInput === undefined) sessionInput = io.input;
    }
    if (io.output !== undefined) output = io.output;
  }
  if (input === undefined && output === undefined) return null;
  const out = {};
  if (input !== undefined) out.input = input;
  if (output !== undefined) out.output = output;
  if (sessionInput !== undefined) out.sessionInput = sessionInput;
  return out;
}

/** Read the transcript text for an event's session. Tries the agent SQLite DB
 * (current storage), then the `{id}.jsonl` file transcript, then the legacy
 * `{id}.trajectory.jsonl`. Returns { tailText, headText } or null. Never
 * throws. */
function readTrajectoryText(stateDir, evt, logger) {
  const sqlite = readSqliteTranscript(stateDir, evt, logger);
  if (sqlite) return sqlite;
  try {
    const sessionId = evt?.sessionId ?? evt?.sessionKey;
    if (!sessionId) return null;
    const candidates = [
      transcriptPath(stateDir, evt?.agentId, sessionId),
      trajectoryPath(stateDir, evt?.agentId, sessionId),
    ];
    const file = candidates.find((f) => {
      try {
        return statSync(f).isFile();
      } catch {
        return false;
      }
    });
    if (!file) throw new Error("transcript not found");
    const { size } = statSync(file);
    if (size <= MAX_READ_BYTES) {
      const whole = readFileSync(file, "utf8");
      return { tailText: whole, headText: whole };
    }
    return {
      tailText: readWindow(file, MAX_READ_BYTES, "tail"),
      headText: readWindow(file, HEAD_READ_BYTES, "head"),
    };
  } catch (err) {
    // File may not exist yet or be mid-write; this is best-effort.
    logger?.debug?.(
      `langfuse-bridge: could not read transcript (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return null;
  }
}

/**
 * Build a content resolver bound to a state dir. Returns a function that, given
 * a model.usage event, reads the session transcript and returns
 * { input, output, sessionInput } or null. Never throws.
 */
export function makeContentResolver(stateDir, logger) {
  return (evt) => {
    const text = readTrajectoryText(stateDir, evt, logger);
    if (!text) return null;
    // For short sessions tail===head (whole file): one pass yields turn + first
    // prompt. For long sessions: current turn from tail, first prompt from head.
    const tail = extractContent(text.tailText);
    if (!tail) return null;
    if (text.headText === text.tailText) return tail;
    const head = extractContent(text.headText);
    return { ...tail, sessionInput: head?.sessionInput ?? tail.input };
  };
}

/**
 * Build a tool-I/O resolver bound to a state dir. Returns a function that, given
 * an event with a session id, reads the session transcript and returns the
 * per-tool I/O map { [toolCallId]: { name, input, output, isError } } or null.
 * Always reads the tail (most recent, cumulative snapshot). Never throws.
 */
export function makeToolIOResolver(stateDir, logger) {
  return (evt) => {
    const text = readTrajectoryText(stateDir, evt, logger);
    if (!text) return null;
    return extractToolIO(text.tailText);
  };
}
