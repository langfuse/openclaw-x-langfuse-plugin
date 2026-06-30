import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compact,
  classifyToolType,
  usageDetails,
  generationAttributes,
  toolAttributes,
  contextSummary,
  errorAttributes,
} from "./mapping.js";
import { extractContent, extractToolIO, trajectoryPath } from "./transcript.js";

test("compact drops undefined and null", () => {
  assert.deepEqual(compact({ a: 1, b: undefined, c: null, d: 0, e: "" }), {
    a: 1,
    d: 0,
    e: "",
  });
});

test("classifyToolType: retrieval/search tools become retriever", () => {
  for (const name of [
    "vector_search",
    "rag",
    "semantic_lookup",
    "knowledge_base",
    "web_fetch",
    "grep",
    "memory_recall",
  ]) {
    assert.equal(classifyToolType(name), "retriever", name);
  }
  for (const name of ["edit", "bash", "write_file", "send_message", undefined]) {
    assert.equal(classifyToolType(name), "tool", String(name));
  }
});

test("usageDetails maps OpenClaw usage to snake_case, dropping empties", () => {
  assert.deepEqual(
    usageDetails({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 }),
    { input: 10, output: 5, cache_read: 2, cache_write: 1, total: 18 },
  );
  assert.deepEqual(usageDetails({ input: 3 }), { input: 3 });
  assert.deepEqual(usageDetails(), {});
});

test("generationAttributes carries model + correlation metadata", () => {
  const attrs = generationAttributes({
    model: "claude-opus-4-8",
    provider: "anthropic",
    api: "messages",
    callId: "c1",
    runId: "r1",
  });
  assert.equal(attrs.model, "claude-opus-4-8");
  assert.equal(attrs.metadata.provider, "anthropic");
  assert.equal(attrs.metadata.callId, "c1");
});

test("toolAttributes carries source/owner/paramsSummary", () => {
  const attrs = toolAttributes({
    toolSource: "mcp",
    toolOwner: "my-server",
    toolCallId: "tc1",
    paramsSummary: { kind: "object" },
  });
  assert.equal(attrs.metadata.toolSource, "mcp");
  assert.deepEqual(attrs.metadata.paramsSummary, { kind: "object" });
});

test("contextSummary formats present size fields and skips missing ones", () => {
  assert.equal(
    contextSummary({ messageCount: 5, promptChars: 64, systemPromptChars: 30753, contextTokenBudget: 1048576 }),
    "messages=5 · promptChars=64 · systemPromptChars=30753 · tokenBudget=1048576",
  );
  assert.equal(contextSummary({ messageCount: 0 }), "messages=0");
  assert.equal(contextSummary({}), undefined);
});

test("errorAttributes sets ERROR level + status from category/kind/denied", () => {
  assert.equal(errorAttributes({ errorCategory: "timeout" }).level, "ERROR");
  assert.equal(errorAttributes({ errorCategory: "timeout" }).statusMessage, "timeout");
  assert.equal(errorAttributes({ deniedReason: "policy" }).statusMessage, "policy");
});

test("extractContent reads the last model.completed turn", () => {
  const text = [
    JSON.stringify({ type: "prompt.submitted", data: { prompt: "old prompt" } }),
    JSON.stringify({
      type: "model.completed",
      data: { finalPromptText: "old prompt", assistantTexts: ["old answer"] },
    }),
    JSON.stringify({ type: "prompt.submitted", data: { prompt: "new prompt" } }),
    JSON.stringify({
      type: "model.completed",
      data: { finalPromptText: "new prompt", assistantTexts: ["line1", "line2"] },
    }),
    "", // trailing newline
  ].join("\n");
  assert.deepEqual(extractContent(text), {
    input: "new prompt",
    output: "line1\nline2",
    sessionInput: "old prompt", // first prompt in the session
  });
});

test("extractContent tolerates a truncated leading line and falls back to prompt.submitted", () => {
  const text = [
    '{"type":"model.compl', // truncated (windowed read) -> skipped
    JSON.stringify({ type: "prompt.submitted", data: { prompt: "only prompt" } }),
  ].join("\n");
  assert.deepEqual(extractContent(text), {
    input: "only prompt",
    sessionInput: "only prompt",
  });
});

test("extractContent returns null when nothing usable", () => {
  assert.equal(extractContent("\n\nnot json\n"), null);
});

test("extractToolIO pulls per-tool input/output from messagesSnapshot", () => {
  const text = JSON.stringify({
    type: "model.completed",
    data: {
      messagesSnapshot: [
        { role: "user", content: "find the docs" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll search." },
            {
              type: "toolCall",
              id: "tc1",
              name: "vector_search",
              arguments: { query: "docs" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "vector_search",
          content: [{ type: "text", text: "doc A\ndoc B" }],
          isError: false,
        },
      ],
    },
  });
  assert.deepEqual(extractToolIO(text), {
    tc1: {
      name: "vector_search",
      input: '{"query":"docs"}',
      output: "doc A\ndoc B",
      isError: false,
    },
  });
});

test("extractToolIO uses the latest (cumulative) snapshot and flags errors", () => {
  const text = [
    JSON.stringify({
      type: "model.completed",
      data: { messagesSnapshot: [{ role: "user", content: "old" }] },
    }),
    JSON.stringify({
      type: "model.completed",
      data: {
        messagesSnapshot: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "tc9", name: "bash", arguments: "ls" }],
          },
          {
            role: "toolResult",
            toolCallId: "tc9",
            toolName: "bash",
            content: "command not found",
            isError: true,
          },
        ],
      },
    }),
  ].join("\n");
  assert.deepEqual(extractToolIO(text), {
    tc9: { name: "bash", input: "ls", output: "command not found", isError: true },
  });
});

test("extractToolIO returns null when no tool activity", () => {
  const text = JSON.stringify({
    type: "model.completed",
    data: { messagesSnapshot: [{ role: "user", content: "hi" }] },
  });
  assert.equal(extractToolIO(text), null);
  assert.equal(extractToolIO("not json"), null);
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
