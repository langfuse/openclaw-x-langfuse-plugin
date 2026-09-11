import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compact,
  classifyToolType,
  usageDetails,
  messageCostUsd,
  costDetails,
  generationAttributes,
  toolAttributes,
  contextSummary,
  errorAttributes,
} from "./mapping.js";

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
  assert.equal(usageDetails(), undefined);
  assert.equal(usageDetails({}), undefined);
});

test("usageDetails accepts both usage shapes (event and transcript message)", () => {
  // model.call.completed (OpenClaw 2026.8+) reports reasoning tokens.
  assert.deepEqual(usageDetails({ input: 4, output: 2, reasoningTokens: 9, total: 15 }), {
    input: 4,
    output: 2,
    reasoning: 9,
    total: 15,
  });
  // A transcript assistant message spells the total `totalTokens`.
  assert.deepEqual(usageDetails({ input: 7, output: 3, totalTokens: 10 }), {
    input: 7,
    output: 3,
    total: 10,
  });
});

test("per-call cost comes from a transcript message's usage.cost.total", () => {
  assert.equal(messageCostUsd({ input: 1, cost: { total: 0.0042 } }), 0.0042);
  assert.equal(messageCostUsd({ input: 1 }), undefined);
  assert.equal(messageCostUsd(undefined), undefined);
  assert.deepEqual(costDetails(0.5), { totalCost: 0.5 });
  assert.equal(costDetails(undefined), undefined);
  assert.equal(costDetails(Number.NaN), undefined);
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
