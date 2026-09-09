import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  extractContent,
  extractToolIO,
  makeContentResolver,
  makeToolIOResolver,
  agentDbPath,
  transcriptPath,
  trajectoryPath,
} from "./transcript.js";

// Current OpenClaw format: append-only message log. Modeled on a real captured
// session ({sessionId}.jsonl): header, user message (string content), assistant
// message with thinking + text blocks, toolResult messages for tool output.
const CURRENT_FORMAT = [
  { type: "session", version: 3, id: "s1", timestamp: "2026-08-24T02:25:35.353Z" },
  { type: "message", message: { role: "user", content: "first question" } },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "let me think" },
        { type: "text", text: "first answer" },
      ],
    },
  },
  { type: "message", message: { role: "user", content: "second question" } },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc1", name: "web_search", arguments: { q: "x" } },
        { type: "text", text: "looking it up" },
      ],
    },
  },
  {
    type: "message",
    message: { role: "toolResult", toolCallId: "tc1", toolName: "web_search", content: "result text", isError: false },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "second answer" }],
    },
  },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

// Legacy format: model.completed entries with finalPromptText/assistantTexts
// and a cumulative messagesSnapshot.
const LEGACY_FORMAT = [
  { type: "prompt.submitted", data: { prompt: "old prompt" } },
  {
    type: "model.completed",
    data: {
      finalPromptText: "old prompt",
      assistantTexts: ["old answer"],
      messagesSnapshot: [
        { role: "user", content: "old prompt" },
        { role: "assistant", content: [{ type: "toolCall", id: "tc9", name: "read", arguments: '{"path":"a"}' }] },
        { role: "toolResult", toolCallId: "tc9", toolName: "read", content: "file body" },
        { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      ],
    },
  },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

test("extractContent reads the current message-log format", () => {
  const io = extractContent(CURRENT_FORMAT);
  assert.equal(io.input, "second question");
  assert.equal(io.output, "second answer");
  assert.equal(io.sessionInput, "first question");
});

test("extractContent still reads the legacy trajectory format", () => {
  const io = extractContent(LEGACY_FORMAT);
  assert.equal(io.input, "old prompt");
  assert.equal(io.output, "old answer");
  assert.equal(io.sessionInput, "old prompt");
});

test("extractToolIO reads toolCall blocks and toolResult messages from the current format", () => {
  const io = extractToolIO(CURRENT_FORMAT);
  assert.deepEqual(io, {
    tc1: { name: "web_search", input: '{"q":"x"}', output: "result text", isError: false },
  });
});

test("extractToolIO still reads the legacy messagesSnapshot", () => {
  const io = extractToolIO(LEGACY_FORMAT);
  assert.deepEqual(io, {
    tc9: { name: "read", input: '{"path":"a"}', output: "file body" },
  });
});

test("content resolver prefers {id}.jsonl over the legacy trajectory file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lf-bridge-"));
  try {
    const sessions = path.join(dir, "agents", "main", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(transcriptPath(dir, "main", "s1"), CURRENT_FORMAT);
    writeFileSync(trajectoryPath(dir, "main", "s1"), LEGACY_FORMAT);

    const evt = { sessionId: "s1", agentId: "main" };
    assert.deepEqual(makeContentResolver(dir)(evt), {
      input: "second question",
      output: "second answer",
      sessionInput: "first question",
    });
    assert.deepEqual(makeToolIOResolver(dir)(evt), {
      tc1: { name: "web_search", input: '{"q":"x"}', output: "result text", isError: false },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("content resolver falls back to the legacy trajectory file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lf-bridge-"));
  try {
    const sessions = path.join(dir, "agents", "main", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(trajectoryPath(dir, "main", "s1"), LEGACY_FORMAT);

    const evt = { sessionId: "s1", agentId: "main" };
    assert.equal(makeContentResolver(dir)(evt).output, "old answer");
    assert.equal(makeToolIOResolver(dir)(evt).tc9.output, "file body");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("content resolver reads from the agent SQLite DB (current storage)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lf-bridge-"));
  try {
    const agentDir = path.dirname(agentDbPath(dir, "main"));
    mkdirSync(agentDir, { recursive: true });
    const db = new DatabaseSync(agentDbPath(dir, "main"));
    db.exec(
      "CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, seq)) STRICT",
    );
    const insert = db.prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
    );
    CURRENT_FORMAT.split("\n").forEach((line, i) => insert.run("s1", i + 1, line, i + 1));

    const evt = { sessionId: "s1", agentId: "main" };
    assert.deepEqual(makeContentResolver(dir)(evt), {
      input: "second question",
      output: "second answer",
      sessionInput: "first question",
    });
    assert.deepEqual(makeToolIOResolver(dir)(evt), {
      tc1: { name: "web_search", input: '{"q":"x"}', output: "result text", isError: false },
    });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sqlite is preferred over the file transcripts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lf-bridge-"));
  try {
    const sessions = path.join(dir, "agents", "main", "sessions");
    const agentDir = path.join(dir, "agents", "main", "agent");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    const db = new DatabaseSync(agentDbPath(dir, "main"));
    db.exec(
      "CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, seq)) STRICT",
    );
    db.prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
    ).run("s1", 1, JSON.stringify({ type: "message", message: { role: "user", content: "from sqlite" } }), 1);
    db.close();
    writeFileSync(transcriptPath(dir, "main", "s1"), CURRENT_FORMAT);

    const io = makeContentResolver(dir)({ sessionId: "s1", agentId: "main" });
    assert.equal(io.input, "from sqlite");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing sqlite rows fall through to the file transcripts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lf-bridge-"));
  try {
    const agentDir = path.join(dir, "agents", "main", "agent");
    const sessions = path.join(dir, "agents", "main", "sessions");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    const db = new DatabaseSync(agentDbPath(dir, "main"));
    db.exec(
      "CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, seq)) STRICT",
    );
    db.close();
    writeFileSync(transcriptPath(dir, "main", "s1"), CURRENT_FORMAT);

    const io = makeContentResolver(dir)({ sessionId: "s1", agentId: "main" });
    assert.equal(io.input, "second question");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("content resolver returns null when no transcript exists", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lf-bridge-"));
  try {
    assert.equal(makeContentResolver(dir)({ sessionId: "nope", agentId: "main" }), null);
    assert.equal(makeToolIOResolver(dir)({ sessionId: "nope", agentId: "main" }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
