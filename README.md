# openclaw-x-langfuse-plugin

Forward [OpenClaw](https://openclaw.ai) model-usage diagnostics to
[Langfuse](https://langfuse.com).

The plugin registers a background service that subscribes to OpenClaw's internal
diagnostics bus and reconstructs each agent run as a **nested Langfuse trace**:
one root per run, with a child observation for every model call, tool call, and
retrieval step that happened inside it. Traces are tagged with the OpenClaw
session id so a conversation's runs group together in Langfuse's Sessions view.

Crucially, **tool calls and RAG/retrieval steps appear as their own
observations** (`tool` and `retriever` types) nested under the run — so you can
see the retrieval that fed a generation instead of the context just appearing in
the next prompt out of nowhere.

Built on the Langfuse **v5 SDK** (OpenTelemetry-based), so traces appear in
Langfuse's new observations-first ("fast") UI. The Langfuse `SpanProcessor` runs
on a dedicated, isolated OTel `TracerProvider` (`setLangfuseTracerProvider`) so
it never touches the global OpenTelemetry state OpenClaw's bundled
`diagnostics-otel` service owns.

It subscribes via the public `onInternalDiagnosticEvent` SDK export. (The
`ctx.internalDiagnostics.onEvent` capability is privileged — the runtime injects
it only for the bundled `diagnostics-otel`/`diagnostics-prometheus` services, so
third-party plugins never receive it.) The public listener delivers the
`run.*`, `model.usage`, `tool.execution.*`, `context.assembled`, and
`model.call.error` event bodies this bridge maps (minus private message content
— see below).

## Install

```bash
openclaw plugins install openclaw-x-langfuse-plugin
```

OpenClaw resolves through ClawHub first and falls back to npm. For local
development, install from a path with `--link`:

```bash
openclaw plugins install ./openclaw-x-langfuse-plugin --link
```

## Configure

Enable the plugin and provide Langfuse credentials in `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["langfuse-bridge"],
    "entries": {
      "langfuse-bridge": {
        "enabled": true,
        "config": {
          "publicKey": "pk-lf-...",
          "secretKey": "sk-lf-...",
          "baseUrl": "https://cloud.langfuse.com"
        }
      }
    }
  }
}
```

Credentials may also be supplied via environment variables, which take effect
when the corresponding config field is absent:

| Config field | Environment fallback   | Default                        |
| ------------ | ---------------------- | ------------------------------ |
| `publicKey`  | `LANGFUSE_PUBLIC_KEY`  | —                              |
| `secretKey`  | `LANGFUSE_SECRET_KEY`  | —                              |
| `baseUrl`    | `LANGFUSE_BASE_URL`    | `https://cloud.langfuse.com`   |

Then restart the gateway:

```bash
openclaw gateway restart
```

If `publicKey`/`secretKey` are missing, the service logs a warning and does not
start — it never blocks the gateway.

## What gets sent

Each OpenClaw run becomes one Langfuse trace, named after the channel, with
`session.id` set to the OpenClaw session id so a conversation's runs group in the
Sessions view. Under that root:

- **Run root** (`agent`) — the whole agent run, with `outcome` and `durationMs`.
  Its trace-level input/output mirror the turn's prompt and final response.
- **Generation** — built from `model.usage`: `model`, `usageDetails` (`input`,
  `output`, `cache_read`, `cache_write`, `total`), `costDetails.totalCost` (USD),
  timing, plus provider metadata and the turn's prompt/response text as
  input/output.
- **Tool / Retriever** — one observation per `tool.execution.*`, named after the
  tool. Retrieval/search tools (vector search, RAG, grep, web fetch, memory
  recall, …) are classified as Langfuse `retriever` observations; everything else
  is a `tool`. Carries `toolSource`, `paramsSummary`, duration, and — when
  recoverable — the tool's arguments and result as input/output.
- **Context** — `context.assembled` becomes a short span with message/prompt
  size metadata.
- **Errors** — `model.call.error` becomes an ERROR observation with the failure
  category/kind.

Message content (prompts, responses, tool arguments and results) is **not**
delivered to third-party plugins — OpenClaw hands it only to bundled diagnostics
services. The bridge recovers it best-effort from the per-session trajectory
transcript
(`<stateDir>/agents/<agentId>/sessions/<sessionId>.trajectory.jsonl`). If the
transcript is unavailable, observations are still forwarded with empty
input/output; the structure (which step ran, when, how long) is always present.

### Robustness

OpenClaw delivers `tool.execution.*` and `model.call.*` events asynchronously
(they're queued and can be dropped under heavy load), while `run.*` and
`model.usage` are synchronous — so a run's `run.completed` reaches the bridge
*before* its own tool events. The engine handles this by soft-ending the run
(fixing its duration) while keeping it resolvable, so late-arriving children
still nest correctly, and an idle reaper closes any observation orphaned by a
dropped terminal event.

## How it works

```js
import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { startObservation, setLangfuseTracerProvider } from "@langfuse/tracing";
import { createTraceEngine } from "./tracer.js";

api.registerService({
  id: "langfuse-bridge",
  start(ctx) {
    // Isolated OTel pipeline -> never touches OpenClaw's global tracer provider.
    const provider = new NodeTracerProvider({
      spanProcessors: [new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl })],
    });
    setLangfuseTracerProvider(provider);

    // The engine keeps per-run state and nests observations: each event resolves
    // its parent via the W3C `trace` context OpenClaw stamps on every event
    // (traceId / spanId / parentSpanId), falling back to the runId.
    const engine = createTraceEngine({ startObservation }, { /* resolvers */ });
    const unsubscribe = onInternalDiagnosticEvent((evt) => engine.handle(evt));
    setInterval(() => engine.sweep(), 60_000).unref(); // reap orphans
  },
});
```

> Note: these events are emitted on OpenClaw's reply/delivery path (channel
> messages, webchat/TUI turns) — not on direct `openclaw agent` CLI runs, which
> use the embedded runner and don't emit them.

## License

MIT
