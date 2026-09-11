// openclaw-langfuse-bridge
//
// Forwards OpenClaw's internal diagnostics bus to Langfuse. It registers a
// background service, subscribes to the diagnostics event stream, and rebuilds
// each turn as one nested Langfuse trace (see tracer.js).
//
// Built on the Langfuse v5 SDK, which is OpenTelemetry-based. To avoid touching
// OpenClaw's own global OTel setup (the bundled `diagnostics-otel` service), we
// run the Langfuse SpanProcessor inside a dedicated, isolated TracerProvider and
// register it via `setLangfuseTracerProvider`. The Langfuse tracing helpers then
// emit through our provider only; OpenClaw's global provider is untouched.
//
// Subscription note: we subscribe via the public `onInternalDiagnosticEvent`
// SDK export rather than `ctx.internalDiagnostics.onEvent`. The latter is a
// privileged capability the runtime injects only for the bundled
// `diagnostics-otel`/`diagnostics-prometheus` services (it carries captured
// prompt/response private data); third-party plugins never receive it. The
// public listener delivers the same event bodies minus private data — so every
// structural field we map lives on the event itself, while message content is
// recovered from the session transcript (see transcript.js).

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  onInternalDiagnosticEvent,
  isDiagnosticsEnabled,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  startObservation,
  setLangfuseTracerProvider,
} from "@langfuse/tracing";
import { createTraceEngine } from "./tracer.js";
import { loadTranscriptMessageReader, makeTurnResolver } from "./transcript.js";

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";

// How often the idle reaper ends dangling observations (orphaned by dropped
// start/complete events). Kept well under the engine's TTL.
const REAPER_INTERVAL_MS = 60_000;

/**
 * Resolve effective config from the plugin's scoped config block
 * (openclaw.json -> plugins.entries["langfuse-bridge"].config) with
 * environment-variable fallbacks.
 */
function resolveConfig(pluginConfig) {
  const cfg = pluginConfig ?? {};
  return {
    publicKey: cfg.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: cfg.secretKey ?? process.env.LANGFUSE_SECRET_KEY,
    baseUrl: cfg.baseUrl ?? process.env.LANGFUSE_BASE_URL ?? DEFAULT_BASE_URL,
  };
}

function createLangfuseBridgeService(getPluginConfig) {
  /** @type {import("@opentelemetry/sdk-trace-node").NodeTracerProvider | null} */
  let provider = null;
  /** @type {import("@langfuse/otel").LangfuseSpanProcessor | null} */
  let spanProcessor = null;
  /** @type {(() => void) | null} */
  let unsubscribe = null;
  /** @type {ReturnType<typeof createTraceEngine> | null} */
  let engine = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let reaper = null;

  return {
    id: "langfuse-bridge",

    async start(ctx) {
      const { publicKey, secretKey, baseUrl } = resolveConfig(
        getPluginConfig(),
      );

      if (!publicKey || !secretKey) {
        ctx.logger.warn(
          "langfuse-bridge: missing publicKey/secretKey (set plugin config or LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY); not starting",
        );
        return;
      }

      if (!isDiagnosticsEnabled(ctx.config)) {
        ctx.logger.warn(
          "langfuse-bridge: diagnostics are disabled (config.diagnostics.enabled === false); no events will be emitted, not starting",
        );
        return;
      }

      // Isolated OTel pipeline: our SpanProcessor lives on a dedicated provider,
      // and we point the Langfuse tracing helpers at it. This keeps us off the
      // global tracer provider that OpenClaw's diagnostics-otel may own.
      spanProcessor = new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl });
      provider = new NodeTracerProvider({ spanProcessors: [spanProcessor] });
      setLangfuseTracerProvider(provider);

      const tracing = { startObservation };

      // Prompt/response text and tool args/results are not delivered to
      // third-party plugins (they're private data given only to the bundled
      // diagnostics services), so we recover them best-effort from the session
      // transcript: via the host's transcript API when it exposes one (SQLite
      // store, OpenClaw >= 2026.8), else the legacy per-session
      // `<sessionId>.trajectory.jsonl` sidecar under ctx.stateDir.
      const readMessages = await loadTranscriptMessageReader(ctx.logger);
      const resolveTurn = makeTurnResolver({
        stateDir: ctx.stateDir,
        logger: ctx.logger,
        readMessages,
      });

      engine = createTraceEngine(tracing, { logger: ctx.logger, resolveTurn });

      // `onInternalDiagnosticEvent` invokes the listener as
      // (event, metadata) => void. We only need the event body; the engine
      // ignores unrelated event types and catches its own errors, so it never
      // throws into the bus.
      unsubscribe = onInternalDiagnosticEvent((evt) => engine?.handle(evt));

      // Idle reaper: ends observations orphaned by dropped start/complete events
      // (these event types are async-queued and droppable under load). Unref'd
      // so it never keeps the process alive.
      reaper = setInterval(() => void engine?.sweep(), REAPER_INTERVAL_MS);
      reaper.unref?.();

      ctx.logger.info(
        `langfuse-bridge: subscribed to diagnostics; exporting nested run traces to ${baseUrl} (content source: ${
          readMessages ? "session transcript API" : "legacy trajectory sidecar"
        })`,
      );
    },

    async stop() {
      try {
        unsubscribe?.();
      } finally {
        unsubscribe = null;
      }
      if (reaper) {
        clearInterval(reaper);
        reaper = null;
      }
      // End any still-open observations before the provider shuts down. This
      // reads the session transcript to fill in their content, so it is awaited.
      try {
        await engine?.flushAll();
      } catch {
        // best-effort flush of in-flight observations
      }
      engine = null;
      // Restore the default (global) provider for the Langfuse helpers.
      setLangfuseTracerProvider(null);
      if (spanProcessor) {
        try {
          await spanProcessor.forceFlush();
        } catch {
          // best-effort flush on shutdown
        }
      }
      if (provider) {
        try {
          await provider.shutdown();
        } catch {
          // best-effort shutdown
        }
      }
      spanProcessor = null;
      provider = null;
    },
  };
}

export default definePluginEntry({
  id: "langfuse-bridge",
  name: "Langfuse Bridge",
  description: "Forwards OpenClaw model usage diagnostics to Langfuse",
  register(api) {
    api.registerService(createLangfuseBridgeService(() => api.pluginConfig));
  },
});
