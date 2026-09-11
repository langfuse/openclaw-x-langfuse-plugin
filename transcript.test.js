import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  extractTurnContent,
  extractFromTrajectory,
  agentIdFromSessionKey,
  trajectoryPath,
  makeTurnResolver,
} from "./transcript.js";

// One turn as the host's transcript API returns it: the ordered conversation
// messages. These shapes were verified against openclaw 2026.8.2 and 2026.9.3
// by round-tripping through `readVisibleSessionTranscriptMessageEntries`.
function conversation() {
  return [
    // A previous turn — must NOT leak into this turn's content.
    { role: "user", content: "earlier question" },
    { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
    // This turn.
    { role: "user", content: "find the docs" },
    { role: "user", content: "<runtime context>", runtimeContextCarrier: true },
    {
      role: "assistant",
      model: "claude-opus-4-8",
      usage: { input: 100, output: 10, totalTokens: 110, cost: { total: 0.001 } },
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "I'll search." },
        { type: "toolCall", id: "tc1", name: "vector_search", arguments: { query: "docs" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "tc1",
      toolName: "vector_search",
      content: [{ type: "text", text: "doc A\ndoc B" }],
      isError: false,
    },
    {
      role: "assistant",
      model: "claude-opus-4-8",
      usage: { input: 200, output: 20, totalTokens: 220, cost: { total: 0.002 } },
      content: [{ type: "text", text: "The docs are in doc A." }],
    },
  ];
}

test("extractTurnContent reads only the latest turn, ignoring runtime carriers", () => {
  const c = extractTurnContent(conversation());
  assert.equal(c.input, "find the docs");
  assert.equal(c.output, "The docs are in doc A.");
  // Two model calls in this turn; the earlier turn's assistant text is excluded.
  assert.equal(c.turns.length, 2);
  assert.deepEqual(
    c.turns.map((t) => t.output),
    ["I'll search.", "The docs are in doc A."],
  );
});

test("extractTurnContent keeps per-call usage and cost for each assistant message", () => {
  const c = extractTurnContent(conversation());
  assert.deepEqual(c.turns[0].usage, {
    input: 100,
    output: 10,
    totalTokens: 110,
    cost: { total: 0.001 },
  });
  assert.equal(c.turns[1].usage.cost.total, 0.002);
});

test("extractTurnContent keys tool args/results by toolCallId", () => {
  assert.deepEqual(extractTurnContent(conversation()).toolIO, {
    tc1: {
      name: "vector_search",
      input: '{"query":"docs"}',
      output: "doc A\ndoc B",
      isError: false,
    },
  });
});

test("extractTurnContent names a tool-only assistant turn by its calls", () => {
  const c = extractTurnContent([
    { role: "user", content: "run it" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "bash", arguments: "ls" }],
    },
    { role: "toolResult", toolCallId: "t1", toolName: "bash", content: "a\nb", isError: false },
  ]);
  assert.equal(c.turns[0].output, "→ called: bash");
  assert.equal(c.output, undefined); // no assistant text yet
  assert.deepEqual(c.toolIO.t1, { name: "bash", input: "ls", output: "a\nb", isError: false });
});

test("extractTurnContent flags tool errors and handles string content", () => {
  const c = extractTurnContent([
    { role: "user", content: "run it" },
    { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: "nope" }] },
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "bash",
      content: "command not found",
      isError: true,
    },
  ]);
  assert.equal(c.toolIO.t1.isError, true);
  assert.equal(c.toolIO.t1.output, "command not found");
});

test("extractTurnContent returns null for nothing usable", () => {
  assert.equal(extractTurnContent([]), null);
  assert.equal(extractTurnContent(undefined), null);
  assert.equal(extractTurnContent([{ role: "user", content: "" }]), null);
});

test("extractFromTrajectory reads the legacy sidecar's messagesSnapshot", () => {
  const text = [
    '{"type":"model.compl', // truncated boundary line from a windowed read
    JSON.stringify({ type: "model.completed", data: { messagesSnapshot: [{ role: "user", content: "old" }] } }),
    JSON.stringify({ type: "model.completed", data: { messagesSnapshot: conversation() } }),
    "",
  ].join("\n");
  const c = extractFromTrajectory(text);
  assert.equal(c.input, "find the docs");
  assert.equal(c.output, "The docs are in doc A.");
  assert.equal(c.turns.length, 2);
  assert.equal(c.toolIO.tc1.output, "doc A\ndoc B");
});

test("extractFromTrajectory falls back to finalPromptText/assistantTexts", () => {
  const text = [
    JSON.stringify({ type: "prompt.submitted", data: { prompt: "only prompt" } }),
    JSON.stringify({
      type: "model.completed",
      data: { finalPromptText: "the prompt", assistantTexts: ["line1", "line2"] },
    }),
  ].join("\n");
  assert.deepEqual(extractFromTrajectory(text), {
    turns: [{ output: "line1\nline2", toolCalls: [] }],
    input: "the prompt",
    output: "line1\nline2",
  });
});

test("extractFromTrajectory returns null when nothing usable", () => {
  assert.equal(extractFromTrajectory("\n\nnot json\n"), null);
  assert.equal(extractFromTrajectory(undefined), null);
});

test("agentIdFromSessionKey reads the agent out of a scoped session key", () => {
  assert.equal(agentIdFromSessionKey("agent:main:mattermost:chan:1"), "main");
  assert.equal(agentIdFromSessionKey("mattermost:chan:1"), undefined);
  assert.equal(agentIdFromSessionKey(undefined), undefined);
});

test("trajectoryPath builds <stateDir>/agents/<agentId>/sessions/<id>.trajectory.jsonl", () => {
  assert.equal(
    trajectoryPath("/state", "main", "abc"),
    "/state/agents/main/sessions/abc.trajectory.jsonl",
  );
  assert.equal(
    trajectoryPath("/state", undefined, "abc"),
    "/state/agents/main/sessions/abc.trajectory.jsonl",
  );
});

test("makeTurnResolver prefers the host transcript API", async () => {
  const seen = [];
  const resolve = makeTurnResolver({
    stateDir: "/nonexistent",
    readMessages: async (ident) => {
      seen.push(ident);
      return conversation();
    },
  });
  const c = await resolve({ sessionId: "s1", sessionKey: "agent:main:x", agentId: "main" });
  assert.equal(c.input, "find the docs");
  assert.deepEqual(seen, [{ sessionId: "s1", sessionKey: "agent:main:x", agentId: "main" }]);
});

test("makeTurnResolver falls back to the legacy sidecar when the API yields nothing", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "lf-bridge-"));
  mkdirSync(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
  writeFileSync(
    trajectoryPath(stateDir, "main", "s1"),
    JSON.stringify({ type: "model.completed", data: { messagesSnapshot: conversation() } }),
  );

  // API missing entirely (pre-2026.8 host).
  const noApi = makeTurnResolver({ stateDir });
  assert.equal((await noApi({ sessionId: "s1", agentId: "main" })).input, "find the docs");

  // API present but empty (session not in the store).
  const emptyApi = makeTurnResolver({ stateDir, readMessages: async () => [] });
  assert.equal((await emptyApi({ sessionId: "s1", agentId: "main" })).input, "find the docs");

  // API throwing must not propagate.
  const throwingApi = makeTurnResolver({
    stateDir,
    readMessages: async () => {
      throw new Error("sqlite unavailable");
    },
  });
  assert.equal((await throwingApi({ sessionId: "s1", agentId: "main" })).input, "find the docs");
});

test("makeTurnResolver returns null when neither source has anything", async () => {
  const resolve = makeTurnResolver({ stateDir: "/nonexistent", readMessages: async () => null });
  assert.equal(await resolve({ sessionId: "missing", agentId: "main" }), null);
});
