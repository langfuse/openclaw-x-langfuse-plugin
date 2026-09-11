# openclaw-x-langfuse-plugin

Forward [OpenClaw](https://openclaw.ai) model-usage diagnostics to
[Langfuse](https://langfuse.com).

The plugin registers a background service that subscribes to OpenClaw's internal
diagnostics bus and reconstructs each turn as a **nested Langfuse trace**: one
root per turn (grouped by the W3C trace id OpenClaw stamps on every event), with
a child observation for every model call, tool call, and retrieval step in it.
Traces are tagged with the OpenClaw session id so a conversation's turns group
together in Langfuse's Sessions view.

Crucially, **tool calls and RAG/retrieval steps appear as their own
observations** (`tool` and `retriever` types) nested under the run — so you can
see the retrieval that fed a generation instead of the context just appearing in
the next prompt out of nowhere.

Built on the Langfuse **v5 SDK** (`@langfuse/tracing` + `@langfuse/otel`, the
OpenTelemetry-based generation that replaced the v3 client), so traces appear in
Langfuse's observations-first UI. Following the SDK's documented isolation
pattern, the Langfuse `SpanProcessor` runs on a dedicated `TracerProvider`
registered with `setLangfuseTracerProvider` — never the global one, which
OpenClaw's bundled `diagnostics-otel` service may own. Correlating attributes
(the session id) are set on every observation, not just the trace, and each
observation carries its own input/output, matching the v5 data model.

Requires OpenClaw **2026.6.1+**; message content (Input/Output) additionally
needs **2026.8+**, where the host exposes a session transcript API — see
[Content](#content-input--output).

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

Each OpenClaw turn becomes one Langfuse trace (keyed by the shared W3C trace id),
named after the channel, with `session.id` set to the OpenClaw session id so a
conversation's turns group in the Sessions view. Under that root:

- **Turn root** (`agent`) — anchored by `run.started`/`run.completed`, with
  `outcome` and `durationMs`. Its trace-level input/output mirror the turn's
  prompt and final response. (OpenClaw's per-event span parents are inconsistent
  — `model.usage` hangs off the harness span while tools hang off the run span —
  so children are attached directly to this one root rather than reconstructing
  that internal chain.)
- **Generations** — one per LLM call (`model.call.*`), in order, so a multi-step
  run shows each model turn separately interleaved with its tools (instead of all
  turns collapsed into one). Each generation's `output` is that call's own
  assistant text; its `input` is the user prompt (first call) or the preceding
  tool results (later calls). Tokens and cost are per call, taken from the
  transcript's own per-message `usage` (which records a per-call cost), falling
  back to `model.call.completed.usage` (OpenClaw 2026.8+) and finally to the
  run's single cumulative `model.usage`, which is then attached to the **last**
  generation.
- **Tool / Retriever** — one observation per `tool.execution.*`, named after the
  tool. Retrieval/search tools (vector search, RAG, grep, web fetch, memory
  recall, …) are classified as Langfuse `retriever` observations; everything else
  is a `tool`. Carries `toolSource`, `paramsSummary`, duration, and — when
  recoverable — the tool's arguments and result as input/output.
- **Context** — `context.assembled` becomes a short span with message/prompt
  size metadata.
- **Errors** — `model.call.error` becomes an ERROR observation with the failure
  category/kind.

### Content (Input / Output)

Message content — prompts, responses, tool arguments and results — is **not**
delivered to third-party plugins. OpenClaw carries it as *private data* on the
diagnostics bus and injects the listener that receives it
(`ctx.internalDiagnostics`) only for its own bundled `diagnostics-otel` /
`diagnostics-prometheus` services. The public event stream this bridge
subscribes to has structure, timings and usage, but no text.

So the bridge reads the turn back out of the session transcript, from the first
of these that works:

1. **The host's session transcript API** (`readVisibleSessionTranscriptMessageEntries`
   from `openclaw/plugin-sdk/session-transcript-runtime`), which reads whatever
   store the running host uses — the SQLite store at
   `<stateDir>/agents/<agentId>/agent/openclaw-agent.sqlite` on OpenClaw
   **2026.8+**. This is the normal path.
2. **The legacy sidecar**
   `<stateDir>/agents/<agentId>/sessions/<sessionId>.trajectory.jsonl`, which
   pre-2026.8 hosts wrote and 2026.8+ no longer produces.

Which one is in use is logged once at startup:

```
langfuse-bridge: subscribed to diagnostics; exporting nested run traces to
https://cloud.langfuse.com (content source: session transcript API)
```

If that line says `legacy trajectory sidecar` on a 2026.8+ host, the transcript
module could not be loaded (the preceding log line says why — most often a Node
build whose bundled SQLite OpenClaw rejects) and Input/Output will be empty. The
structure — which step ran, when, how long, tokens, cost — is always present
either way; content is strictly best-effort and never blocks forwarding.

### Robustness

OpenClaw delivers `tool.execution.*` and `model.call.*` events asynchronously
(they're queued and can be dropped under heavy load), while `run.*` and
`model.usage` are synchronous — so `run.completed` reaches the bridge *before*
its own tool events, and `model.usage` arrives *after* it. The engine handles
this by soft-ending the turn root (fixing its duration) while keeping it
resolvable, so late-arriving children still attach to it, and an idle reaper
closes any observation orphaned by a dropped terminal event.

Because content lives in the session transcript rather than on the event stream,
a turn is finalized asynchronously, once after the event burst — and the
transcript is read once per turn, not once per late tool event. Shutdown flushes
in-flight observations before the exporter closes.

## How it works

```js
import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { startObservation, setLangfuseTracerProvider } from "@langfuse/tracing";
import { createTraceEngine } from "./tracer.js";
import { loadTranscriptMessageReader, makeTurnResolver } from "./transcript.js";

api.registerService({
  id: "langfuse-bridge",
  async start(ctx) {
    // Isolated OTel pipeline -> never touches OpenClaw's global tracer provider.
    const provider = new NodeTracerProvider({
      spanProcessors: [new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl })],
    });
    setLangfuseTracerProvider(provider);

    // Content source: the host's session transcript API when it has one,
    // otherwise the legacy per-session sidecar under ctx.stateDir.
    const readMessages = await loadTranscriptMessageReader(ctx.logger);
    const resolveTurn = makeTurnResolver({ stateDir: ctx.stateDir, readMessages });

    // The engine groups observations into one trace per turn, keyed by the W3C
    // trace id OpenClaw stamps on every event, and attaches the model calls,
    // tool executions and context.assembled as children of that turn root.
    const engine = createTraceEngine({ startObservation }, { resolveTurn });
    const unsubscribe = onInternalDiagnosticEvent((evt) => engine.handle(evt));
    setInterval(() => void engine.sweep(), 60_000).unref(); // reap orphans
  },
});
```

> Note: these events are emitted on OpenClaw's reply/delivery path (channel
> messages, webchat/TUI turns) — not on direct `openclaw agent` CLI runs, which
> use the embedded runner and don't emit them.

## Development

```bash
npm install
npm test             # unit tests: mapping, transcript extraction, trace engine
```

The unit tests need no OpenClaw install. The end-to-end check does — it drives
the real plugin entry against the real diagnostics bus and asserts the span tree
that reaches the wire — so install the host version you want to check against:

```bash
npm i --no-save openclaw@2026.9.3   # not a declared dependency: the host provides it
node scripts/integration.mjs        # real bus -> plugin -> captured OTLP
```

The script seeds a real session transcript in a throwaway state dir, so its
content half needs a Node whose bundled SQLite OpenClaw accepts (>= 22.22.3 /
24.15.0 / 25.9.0); on older builds it verifies the legacy-fallback path instead.

## License

MIT
