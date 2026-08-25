# RallarAI Recipes

Date: 2026-06-05

These recipes show how to use RallarAI as an opt-in layer. AI output is always
candidate JSON; the application still owns domain validation, permissions, and
final state changes.

## Game Event Schema

Use an app-owned schema and register it through the shared helper when peers or
server code need stable schema hashes:

```ts
const gameEventSchema = {
    type: 'object',
    required: ['kind', 'amount'],
    properties: {
        kind: { type: 'string', enum: ['spawn', 'reward'] },
        amount: { type: 'integer', minimum: 1 }
    },
    additionalProperties: false
} as const;
```

## Browser-Only Flow

```ts
import { createRallarBrowserAi } from '@shared-web/browser/rallar-ai.ts';
import { createRallarAiMockProvider } from '@shared/rallar-ai/mod.ts';

const ai = createRallarBrowserAi({
    rallar,
    provider: createRallarAiMockProvider({
        value: { kind: 'spawn', amount: 1 }
    }),
    policy: { mode: 'browser-only', timeoutMs: 5_000 }
});

const result = await ai.generateJson({
    schemaId: 'game-event',
    schemaVersion: '1',
    schema: gameEventSchema,
    prompt: 'Generate the next room event.',
    baseStateRevision: currentRevision,
    dedupeKey: `room:${roomId}:turn:${turnId}`
});

await ai.broadcastJson({
    result,
    transport: 'realtime',
    roomId
});
```

Use the mock provider in tests. A real browser model provider should be imported
through a provider-specific module so the normal browser bundle does not include
large model runtime code by default.

```ts
const { createWebLlmRallarAiProvider } = await import(
    '@shared-web/browser/ai/providers/webllm-rallar-ai-provider.ts'
);

const provider = createWebLlmRallarAiProvider({
    modelId: selectedBrowserModelId,
    loadRuntime: loadAppWebLlmRuntime
});
```

The WebLLM provider module exists as an explicit import path and structural
wrapper. The app still passes or lazy-loads the actual WebLLM runtime, so
importing the adapter does not pull a model runtime into the default Rallar
browser bundle:

```ts
const provider = createWebLlmRallarAiProvider({
    modelId: selectedBrowserModelId,
    loadRuntime: async () => {
        const webllm = await import('@mlc-ai/web-llm');
        return createAppWebLlmRuntime(webllm, selectedBrowserModelId);
    }
});
```

## Browser Planning Proposals

For browser-only game helpers, keep AI output as a proposal and let existing
controls remain authoritative. Relic Hunters uses this shape for planning
companion notes:

```ts
const result = await ai.generateJson<RelicPlanningAiSuggestion>({
    schemaId: 'relic-hunters.planning-companion',
    schemaVersion: '1',
    schema: relicPlanningAiSuggestionSchema,
    prompt: 'Suggest one legal planning action.',
    context: redactedPlanningContext,
    baseStateRevision,
    dedupeKey: `relic-planning-ai:${roomId}:${round}:${playerId}`
});

const proposed = transitionRallarAiResultLifecycle(result, 'proposed');

await ai.broadcastJson({
    result: proposed,
    transport: 'messages.ws',
    roomId,
    topicId: 'room.relic.ai.planning',
    typeId: 'relic.ai.planning-proposal.v1'
});
```

Peers should display compatible proposals as read-only context. The local
browser can use a proposal to prime existing controls, but final submission
should still go through the normal validated command path.

## Server-Side Flow

```ts
import { createRallarServerAi } from '@shared-server/rallar-ai/mod.ts';
import { createRallarAiOllamaProvider } from '@shared-server/rallar-ai/providers/ollama.ts';

const ai = createRallarServerAi({
    rallar: server,
    provider: createRallarAiOllamaProvider({
        model: 'llama-test',
        baseUrl: 'http://127.0.0.1:11434'
    }),
    policy: { mode: 'server-only', timeoutMs: 15_000 },
    authorize: ({ action, actorId, roomId }) => canUseRoomAi({ action, actorId, roomId }),
    limits: {
        maxConcurrentGenerations: 4,
        maxRequestBytes: 256 * 1024
    }
});

ai.createRestRouteInstaller({ path: '/rallar-ai/generate-json' })(app);
ai.installGenerationTopic({
    requestTopicId: 'room.ai.generate',
    resultTopicId: 'room.ai.generated',
    resultFanout: 'outbox'
});
```

Keep Ollama or another model sidecar private to the server network. The public
surface should be the Rallar Server route or WebSocket topic, not the raw model
engine endpoint.

## Fallback Policy

For browser-first products, try the browser facade first and call the server
route only when local generation is unavailable, slow, or unsupported. For
server-first products, keep browser generation as an explicit fallback only when
the app can tolerate client-side variability.

The generated envelope is the stable handoff between modes:

- Deduplicate with `generationId`, `requestId`, or an app-level `dedupeKey`.
- Reject stale browser results when `baseStateRevision` no longer matches.
- Validate domain rules before applying the value to game state.

## Capability Detection

Use provider capabilities before choosing a browser or server execution path.
The browser facade should be created only after the app has selected a provider
that can run in the current browser session. If a browser model runtime is not
available, is still downloading, exceeds local memory limits, or times out, the
app should switch to a server route or disable RallarAI for that interaction.

Recommended fallback order:

1. Check the app's generation policy.
2. Check `provider.capabilities.target` and `supportsJsonSchema`.
3. Apply an app timeout with `timeoutMs`.
4. Use the server facade when browser generation is unavailable.
5. Surface disabled/unavailable state as application UI, not as a hidden retry
   loop.

## Host Approval And Dedupe

Approval mode is an app-level workflow:

1. Generate a result with lifecycle `draft`.
2. Broadcast it as a proposal.
3. Host or server validates domain rules and accepts or rejects it.
4. Accepted results are applied once by `dedupeKey` or `generationId`.
5. Rejected, expired, or superseded results remain visible for diagnostics.

RallarAI supplies lifecycle and transition helpers, but it does not force an
approval store because game rules differ by application.

```ts
import {
    createRallarAiAcceptedResultTracker,
    transitionRallarAiResultLifecycle
} from '@shared/rallar-ai/mod.ts';

const tracker = createRallarAiAcceptedResultTracker();
const proposed = transitionRallarAiResultLifecycle(result, 'proposed');
const accepted = transitionRallarAiResultLifecycle(proposed, 'accepted');

await tracker.acceptOnce(accepted, (proposal) => {
    applyGameEvent(proposal.value);
});
```

Calling `acceptOnce` again with the same `dedupeKey` or `generationId` is a
no-op, which protects reconnect, retry, and replay paths.

## Lifecycle Transitions

RallarAI envelopes start as `draft`. Applications can use lifecycle helpers to
make acceptance explicit:

```ts
const proposed = transitionRallarAiResultLifecycle(result, 'proposed');
const accepted = transitionRallarAiResultLifecycle(proposed, 'accepted');
const superseded = transitionRallarAiResultLifecycle(accepted, 'superseded');
```

Invalid transitions throw a typed `RallarAiError`. For example,
`accepted -> rejected` is invalid because accepted output may already have been
applied to domain state.

## Replay And Debug

Persisted envelopes can be summarized without exposing prompt, context, raw
model output, or generated value:

```ts
import { summarizeRallarAiReplayLog } from '@shared/rallar-ai/mod.ts';

const summary = summarizeRallarAiReplayLog(storedEnvelopes);

console.log(summary.duplicateDedupeIds);
console.log(summary.entries.map((entry) => ({
    generationId: entry.generationId,
    lifecycle: entry.lifecycle,
    validationOk: entry.validationOk
})));
```

Use replay summaries for test artifacts, support bundles, and host review UI.
Domain replay should still validate and apply only accepted envelopes once.

## CRDT Proposals

Do not let AI output mutate `rallar.crdt` documents directly in V1. Generate
candidate operations as JSON proposals, validate them against app rules, then
append through the existing CRDT API only after acceptance. This keeps AI output
inside the current CRDT durability, validation, and hardening boundaries.

## Local Live Providers

Normal CI should use the mock provider or fake sidecar provider. Live checks are
local or scheduled:

- Ollama: run a local sidecar on `http://127.0.0.1:11434`, choose a model that
  supports structured JSON well enough for the test schema, and keep the test
  behind `RALLAR_AI_LIVE_OLLAMA=1`.
- WebLLM: import a provider dynamically from a browser-only module and keep the
  test behind `RALLAR_AI_LIVE_WEBLLM=1`.

See [RallarAI Governance And Evaluation](./rallar-ai-governance-and-evaluation.md)
for provider metadata, production review, and live-gated evaluation guidance.
The deployment template in `examples/rallar-ai-server-ollama/` shows Rallar
Server plus a private Ollama sidecar.
