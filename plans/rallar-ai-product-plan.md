# RallarAI Implementation Plan

Date: 2026-06-03

Last updated: 2026-06-06

Status: Plan and implementation tracking document for an opt-in RallarAI product layer.

Implementation progress is tracked in `docs/rallar-ai-implementation-progress.md`.

## Purpose

RallarAI should add schema-guided JSON generation to Rallar without making AI part of the Rallar core runtime. The feature should let an application generate validated JSON from a model, broadcast or persist the result through normal Rallar channels, and keep the generated data in a clear envelope that can be inspected, replayed, rejected, or accepted by the application.

The key product idea is that RallarAI is not an authority over application state. It is an optional generation layer that produces structured candidate data. The application still owns domain validation, game rules, permissions, and final state application.

## Product Boundary

RallarAI has two deployable parts:

- RallarAI Browser: optional browser-side JSON generation and broadcast/persist helpers.
- RallarAI Server: optional server-side JSON generation through provider adapters and sidecar engines.

RallarAI also needs shared contracts used by both parts. These contracts should live under `packages/shared/rallar-ai/**`, not in a standalone shared package that implies a separate product surface.

Rallar core must not import RallarAI by default. The integration should be opt-in through explicit imports from the RallarAI modules.

## Companion Plan

This document is the main implementation plan for the opt-in RallarAI product layer. The companion follow-up plan is `plans/rallar-ai-companion-follow-up-plan.md`.

The companion plan covers concerns that should shape RallarAI before public adoption, but should not obscure the main V1 package and provider work:

- Authorization and room permissions.
- Transport semantics, idempotency, and result lifecycle.
- Host approval workflows.
- Security hardening.
- Model and provider governance.
- Quality evaluation.
- Developer experience and packaging.
- Future integrations such as CRDT operations and replay/debug tooling.

## V1 Decisions

V1 should include:

- Shared RallarAI contracts under `packages/shared/rallar-ai/**`.
- Deterministic mock provider for CI and product examples.
- Fake HTTP sidecar provider for server adapter tests.
- Provider capability declarations.
- Schema registry and schema version compatibility helpers.
- Generation policy for browser/server/fallback selection.
- Timeout, cancellation, and stale-result handling.
- Basic server quotas and concurrency limits.
- Privacy/redaction hooks for request context.
- Structured diagnostics for generation, validation, broadcast, and persistence.
- Browser facade for generate, validate, broadcast, and persist workflows.
- Server facade for REST route, WebSocket topic, validate, publish, and persist workflows.
- Optional gated live tests for Ollama server-side.
- Optional gated live tests for WebLLM browser-side.

Initial V1 implementation now exists for shared contracts, the browser facade,
the server facade, browser WebLLM provider packaging, recipes, live-gated
evaluation helpers, and app-level generated-event approval/dedupe coverage.
Real WebLLM live evaluation remains blocked until an application supplies a
browser model runtime.

V1 should exclude:

- A mandatory real AI provider.
- Agent frameworks, memory systems, or tool-calling orchestration.
- Embedding a model runtime inside Rallar Server.
- Making browser or server AI part of the default Rallar bundle.
- A full prompt-management product.
- A moderation or safety product.
- Multi-model arbitration beyond simple fallback policy.

## Current Rallar Fit

The existing Rallar shape fits this as a thin opt-in layer:

- Browser Rallar already exposes data, CRDT documents, WebSocket, WebRTC, RTC, and realtime-oriented surfaces that RallarAI can use after generation.
- Rallar Server already has route mounting, WebSocket topics, publishing, and data access patterns that can host the server-side facade.
- Rallar Black Box already uses deterministic testing with live-gated optional checks. RallarAI should mirror that model instead of requiring live AI in normal CI.

The product fit is strongest if RallarAI is presented as "structured generation over Rallar transports", not as a general AI platform.

## Current Repo Alignment

This plan is anchored to the current repo structure and docs:

- Browser facade source: `packages/shared-web/browser/rallar.ts`.
- Browser data source: `packages/shared-web/browser/rallar-data.ts`.
- Browser CRDT source: `packages/shared-web/browser/rallar-crdt.ts`.
- Server application facade: `packages/shared-server/rallar-facade/RallarServerApplication.ts`.
- Server core facade: `packages/shared-server/rallar-facade/RallarServer.ts`.
- Server topic router: `packages/shared-server/rallar-facade/ws-topic-router.ts`.
- Server middleware source: `packages/shared-server/rallar-system/middleware/RallarMiddleware.ts`.
- Server CRDT source: `packages/shared-server/crdt/RallarCrdtServer.ts`.
- Public docs: `docs/rallar-api-reference.md`, `docs/rallar-quickstart-and-recipes.md`, `docs/rallar-ai-skill.md`, and `docs/rallar-crdt-guide.md`.
- Path aliases: `@shared/`, `@shared-web/`, and `@shared-server/` are already configured in `deno.json` and `tsconfig.json`.

RallarAI should therefore extend the existing package homes instead of introducing separate package roots:

- Shared contracts: `packages/shared/rallar-ai/**`.
- Browser facade and browser providers: `packages/shared-web/browser/**`.
- Server facade and server providers: `packages/shared-server/rallar-ai/**`.

RallarAI V1 should not directly mutate CRDT documents as a default behavior. When AI-generated CRDT operations are added later, they should be generated as proposals that use the current `rallar.crdt` API and respect the durable append, validation, hardening, and transport guidance in the CRDT docs.

## Package Layout

Suggested V1 layout:

```text
packages/shared/rallar-ai/rallar-ai-types.ts
packages/shared/rallar-ai/rallar-ai-validation.ts
packages/shared/rallar-ai/rallar-ai-hashing.ts
packages/shared/rallar-ai/rallar-ai-envelope.ts
packages/shared/rallar-ai/rallar-ai-mock-provider.ts
packages/shared/rallar-ai/rallar-ai-provider-capabilities.ts
packages/shared/rallar-ai/rallar-ai-schema-registry.ts
packages/shared/rallar-ai/rallar-ai-generation-policy.ts
packages/shared/rallar-ai/rallar-ai-diagnostics.ts
packages/shared/rallar-ai/rallar-ai-authorization.ts
packages/shared/rallar-ai/rallar-ai-transport-policy.ts
packages/shared/rallar-ai/rallar-ai-result-lifecycle.ts
packages/shared/rallar-ai/rallar-ai-provider-governance.ts
packages/shared/rallar-ai/rallar-ai-evaluation.ts
packages/shared/rallar-ai/mod.ts

packages/shared-web/browser/rallar-ai.ts
packages/shared-web/browser/rallar-ai-providers/webllm.ts

packages/shared-server/rallar-ai/RallarAiServer.ts
packages/shared-server/rallar-ai/providers/ollama.ts
packages/shared-server/rallar-ai/providers/fake-sidecar-http.ts
```

The browser and server RallarAI modules should import the shared contracts through the existing repo aliases:

- `@shared/rallar-ai/...`
- `@shared-web/browser/rallar-ai.ts`
- `@shared-server/rallar-ai/RallarAiServer.ts`

Rallar core should not import any of these files. The current repo already uses `packages/shared`, `packages/shared-web`, and `packages/shared-server` as the package homes, so RallarAI should extend those homes instead of creating unrelated top-level package families.

## Shared Contract

The shared contract should describe generated JSON as an envelope, not just a raw value.

```ts
export type RallarAiJsonSource = "browser" | "server" | "mock";

export interface RallarAiJsonRequest<TContext = unknown> {
  requestId?: string;
  schemaId: string;
  schemaVersion: string;
  schema: unknown;
  prompt: string;
  context?: TContext;
  baseStateRevision?: string;
  dedupeKey?: string;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RallarAiJsonResult<TValue = unknown> {
  protocolVersion: 1;
  requestId?: string;
  generationId: string;
  dedupeKey?: string;
  supersedesGenerationId?: string;
  source: RallarAiJsonSource;
  providerId: string;
  modelId?: string;
  schemaId: string;
  schemaVersion: string;
  schemaHash: string;
  promptHash: string;
  baseStateRevision?: string;
  createdAtEpochMs: number;
  value: TValue;
  rawText?: string;
  validation: {
    ok: boolean;
    errors: string[];
  };
  timing?: {
    startedAtEpochMs: number;
    completedAtEpochMs: number;
  };
}

export interface RallarAiJsonProvider {
  providerId: string;
  source: RallarAiJsonSource;
  capabilities: RallarAiProviderCapabilities;
  generateJson<TValue = unknown, TContext = unknown>(
    request: RallarAiJsonRequest<TContext>,
  ): Promise<RallarAiJsonResult<TValue>>;
}

export interface RallarAiProviderCapabilities {
  supportsJsonSchema: boolean;
  supportsStreaming: boolean;
  supportsCancellation: boolean;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  typicalColdStartMs?: number;
  target: "browser" | "server" | "shared";
}
```

The envelope gives Rallar applications enough metadata to deduplicate, replay, audit, persist, and reject generated output.

## Provider Capabilities

Every provider should declare what it can safely support before the app attempts generation. This avoids brittle feature detection and gives RallarAI a clear way to choose between browser and server providers.

Minimum capability fields:

- JSON schema support.
- Streaming support.
- Cancellation support.
- Target runtime: browser, server, or shared test provider.
- Maximum context/output limits when known.
- Typical cold-start cost when known.

V1 should use capabilities for routing and diagnostics, not as a promise of output quality. Schema validation remains mandatory even when a provider reports structured-output support.

## Schema Registry And Versioning

RallarAI should support raw schemas, but the preferred path should be a small schema registry:

```ts
const registry = createRallarAiSchemaRegistry()
  .register({
    schemaId: "game-event",
    schemaVersion: "1",
    schema,
  });
```

The registry should provide:

- Stable schema hashing.
- Lookup by `schemaId` and `schemaVersion`.
- Compatibility checks when peers or clients use different app versions.
- A place to attach migration notes later.

The registry does not need to become a persistence layer in V1. It should be an in-process helper that keeps generated envelopes tied to known schema versions.

## Generation Policy

Applications should be able to decide where generation is allowed and how fallback works.

Suggested policy modes:

| Mode | Behavior |
| --- | --- |
| `disabled` | RallarAI is unavailable even if packages are installed. |
| `browser-only` | Generate only in the browser. |
| `server-only` | Generate only through RallarAI Server. |
| `browser-first` | Try browser provider, fall back to server when unavailable or timed out. |
| `server-first` | Try server provider, fall back to browser when configured. |

The default should be explicit, not magical. An app should opt into a policy when creating the browser or server facade.

## Timeouts, Cancellation, And Stale Results

AI generation can be slow enough that the game or app state changes while a request is running. RallarAI should support:

- `AbortSignal` on generation requests.
- Request-level `timeoutMs`.
- Provider-level default timeout.
- Stale-result rejection when `baseStateRevision` no longer matches the current app state.
- Error envelopes or typed errors for timeout, cancellation, provider failure, invalid JSON, and schema validation failure.

This matters in both browser and server deployments. In games, it prevents old generated events from landing after the room has already moved on.

## Quotas And Resource Limits

Server-side RallarAI needs simple resource controls from V1:

- Maximum concurrent generations globally.
- Maximum concurrent generations per user/session.
- Maximum prompt/context byte size.
- Maximum output tokens where provider support exists.
- Optional per-room rate limits.
- Timeout and cancellation cleanup.

Browser-side RallarAI should expose capability and loading state so the app can avoid starting work the device cannot realistically finish.

## Privacy And Redaction

RallarAI should make it easy for applications to control what state is sent to a model. V1 should include hooks for:

- Redacting sensitive context fields before generation.
- Deciding whether prompts and raw model text are persisted.
- Disabling `rawText` capture when an app wants only validated JSON.
- Tagging generated envelopes with enough metadata to audit the provider and model used.

RallarAI should not assume that all game or app state is safe to send to a local or server-side model.

## Observability

RallarAI should emit structured diagnostics that can be consumed by tests, logs, or app-level tooling.

Recommended diagnostic events:

- Generation requested.
- Provider selected.
- Provider started.
- Provider completed.
- Provider timed out.
- Provider cancelled.
- JSON parse failed.
- Schema validation failed.
- Envelope broadcast started/completed/failed.
- Envelope persistence started/completed/failed.

Diagnostics should include provider ID, model ID when known, schema ID/version/hash, source, elapsed time, validation status, and generation ID. They should not include prompt or context by default.

## Browser Deployment

Browser-side RallarAI should be imported explicitly by the application:

```ts
import { rallar } from "@shared-web/browser/rallar.ts";
import { createRallarBrowserAi } from "@shared-web/browser/rallar-ai.ts";

const ai = createRallarBrowserAi({ rallar, provider });

const result = await ai.generateJson<GameEvent>({
  schemaId: "game-event",
  schemaVersion: "1",
  schema,
  prompt,
  context,
});

await ai.broadcastJson({
  result,
  roomRef,
  laneId: "game-events",
  transport: "realtime",
});

await ai.persistJson({
  result,
  storeName: "ai-results",
  key: result.generationId,
  scope: "session",
});
```

In practice:

1. The web app starts normal Rallar.
2. The app checks whether browser AI is enabled and supported.
3. The app loads the provider and model only when needed.
4. The provider generates JSON from a prompt, schema, and context.
5. RallarAI parses and validates the result.
6. The app broadcasts the envelope through Rallar realtime, WebRTC, or messages.
7. The app may persist the envelope through Rallar data APIs.
8. The game or app applies the value only after its own domain validation.

Browser deployment has no Rallar Server dependency. This is useful for local-first, peer-to-peer, and offline-capable use cases. It also means browser capability detection, model loading UX, and device performance variance must be handled by the application.

## Server Deployment

Server-side RallarAI should also be imported explicitly:

```ts
import { createRallarServerApplication } from "@shared-server/rallar-facade/RallarServerApplication.ts";
import { createRallarServerAi } from "@shared-server/rallar-ai/RallarAiServer.ts";

const rallar = createRallarServerApplication({
  runtime,
  routes: {
    ws: installWsRoutes,
    rest: [installAuthRoutes, installStateRoutes],
  },
});

const ai = createRallarServerAi({ rallar, provider });

ai.installRestRoutes(app, {
  path: "/api/ai/generate-json",
});

ai.installGenerationTopic({
  requestTopicId: "room.ai",
  requestTypeId: "generate",
  resultTopicId: "room.ai",
  resultTypeId: "generated",
  scope: "room",
  fanout: "live-only",
});
```

The exact RallarAI helper names can change during implementation, but the integration point should match the current server facade: route installers, `server.ws.defineTopic`, `server.ws.publish`, `server.data.open`, and the existing `createRallarServerApplication` flow.

In practice:

1. Rallar Server starts normally.
2. A separate AI engine sidecar starts outside Rallar Server.
3. The RallarAI server provider calls the sidecar over a local or private HTTP boundary.
4. The server facade parses and validates the model output.
5. The server persists the envelope when configured.
6. The server publishes the envelope over Rallar WebSocket topics or returns it from REST.
7. Clients consume the same envelope shape as browser-generated results.

For local development, Ollama can run as a sidecar on `127.0.0.1:11434`. In production, the sidecar should stay private to the server network. The public deployment should expose the Rallar API, not the raw AI sidecar.

## Provider Test Matrix

RallarAI should separate deterministic test providers from optional live providers.

| Provider | Target | Required in CI | Purpose |
| --- | --- | --- | --- |
| `mock` | shared/browser/server | yes | Deterministic contract, validation, and workflow tests. |
| `fake-sidecar-http` | server | yes | Tests HTTP provider behavior, timeout handling, malformed output, and error mapping without a real model. |
| `ollama` | server | no | Optional local live test for server-side structured JSON generation. |
| `webllm` | browser | no | Optional local live test for in-browser generation. |
| `vllm` | server | no | Future high-throughput deployment option, not a V1 gate. |
| `llama.cpp` | server/browser-adjacent | no | Future lightweight local runtime option, not a V1 gate. |

Recommended live-test gates:

```text
RALLAR_AI_LIVE_OLLAMA=1
RALLAR_AI_OLLAMA_BASE_URL=http://127.0.0.1:11434
RALLAR_AI_OLLAMA_MODEL=<local-model>

RALLAR_AI_LIVE_WEBLLM=1
RALLAR_AI_WEBLLM_MODEL=<browser-model>
```

Normal CI should pass without an installed model, GPU, browser model cache, or network access.

## Testing Plan

Shared package tests:

- Envelope creation is stable and deterministic where expected.
- Schema hashing and prompt hashing are stable.
- Schema registry lookup and compatibility checks are deterministic.
- Provider capability declarations are validated.
- Generation policy selects the expected provider or fallback route.
- Mock provider returns valid generated JSON.
- Validation rejects malformed JSON and schema-invalid values.
- Validation error output is useful enough for product debugging.
- Timeout, cancellation, and stale-result errors are typed and testable.

Browser package tests:

- `generateJson` delegates to a provider and returns the shared envelope.
- Broadcast helper sends the envelope through the selected Rallar transport.
- Persist helper stores the envelope through Rallar data APIs.
- Browser policy rejects generation when browser AI is disabled.
- Browser policy falls back to server only when explicitly configured.
- Browser diagnostics omit prompt/context by default.
- Browser package does not force server imports.
- Core Rallar does not import RallarAI.
- Optional WebLLM test only runs when `RALLAR_AI_LIVE_WEBLLM=1`.

Server package tests:

- REST route accepts a schema request and returns a validated envelope.
- WebSocket topic accepts generation requests and publishes generated envelopes.
- Fake sidecar tests success, invalid JSON, schema-invalid JSON, timeout, and provider error cases.
- Server quotas reject excessive concurrent requests.
- Server request size limits reject oversized prompt/context payloads.
- Server redaction hook removes configured context fields before provider calls.
- Server diagnostics omit prompt/context by default.
- Server package does not force browser imports.
- Core Rallar Server does not import RallarAI.
- Optional Ollama test only runs when `RALLAR_AI_LIVE_OLLAMA=1`.

Black-box follow-up tests:

- A mock generated game event can be broadcast to a common group.
- A client can receive, validate, and apply the event.
- Live provider tests can be enabled locally without changing normal CI.

## Example Game Event Flow

A game can use a JSON schema as the model contract and distribute the generated result over a shared Rallar channel:

```text
player action/context
  -> RallarAI generateJson(schema, prompt, context)
  -> validated RallarAiJsonResult<GameEvent>
  -> Rallar realtime/WebRTC broadcast
  -> peers receive same envelope
  -> game validates domain rules
  -> game applies event to local state
```

This is especially attractive when cheating is not the main concern and the goal is collaborative, creative, or emergent gameplay. It keeps server costs low for browser-first games while still allowing a server-authoritative option later.

## Main Pros

- Opt-in packaging keeps Rallar small and avoids forcing AI dependencies on normal users.
- Browser generation supports local-first and peer-to-peer game patterns.
- Server generation supports centralized validation, easier provider control, and more consistent performance.
- Shared envelopes make browser and server outputs interoperable.
- JSON schema generation gives developers a concrete contract instead of free-form text.
- Deterministic mock and fake providers make the feature testable without live AI.
- Sidecar deployment keeps open source engines outside Rallar Server and makes provider swaps easier.

## Main Cons And Risks

- Browser AI support varies by device, browser, GPU, memory, and model cache state.
- Browser generation can increase bundle complexity and user-visible loading time.
- Server-side AI adds operational work: model hosting, resource limits, timeout handling, and observability.
- JSON schema validation does not replace domain validation.
- Different providers may produce subtly different valid outputs.
- Model licenses and deployment requirements must be checked per model and provider.
- Generated output can still be low quality even when schema-valid.

## Selling Points

- "Bring your own AI engine" without locking Rallar to a vendor.
- "Generate structured game events in-browser or server-side."
- "Same envelope, same validation, same Rallar transports."
- "Works in CI without a model."
- "Local-first AI when the browser can handle it; server-side AI when the product needs control."
- "AI as an optional Rallar layer, not a dependency tax."

## Rollout Plan

Phase 1: Shared contracts and deterministic providers.

- [x] Create `packages/shared/rallar-ai/**`.
- [x] Add shared types, envelope builder, validation helpers, hashing helpers, and mock provider.
- [x] Add fake sidecar HTTP provider test support.
- [x] Add provider capability types.
- [x] Add schema registry helper.
- [x] Add generation policy helper.
- [x] Add diagnostic event types.
- [x] Add authorization, transport policy, lifecycle, and provider governance helpers.
- [x] Add CI tests for contracts and validation.

Phase 2: Browser facade.

- [x] Create `packages/shared-web/browser/rallar-ai.ts`.
- [x] Add `createRallarBrowserAi`.
- [x] Add generate, broadcast, and persist helpers.
- [x] Add browser policy handling.
- [x] Add timeout, cancellation, and stale-result handling.
- [x] Add browser diagnostics.
- [x] Add browser tests with mock provider.
- [x] Document capability detection and unsupported-browser fallback.

Phase 3: Server facade.

- [x] Create `packages/shared-server/rallar-ai/RallarAiServer.ts`.
- [x] Add `createRallarServerAi`.
- [x] Add REST route mounting.
- [x] Add WebSocket topic helper.
- [x] Add quotas, request size limits, and concurrency limits.
- [x] Add redaction hooks.
- [x] Add server diagnostics.
- [x] Add mocked provider tests for success, malformed request handling, quotas, REST, WS, persistence, and Ollama adapter behavior.

Phase 4: Optional live providers.

- [x] Add Ollama server provider behind explicit import and base URL allowlist configuration.
- [x] Add optional live Ollama smoke test behind `RALLAR_AI_LIVE_OLLAMA=1`.
- [x] Add WebLLM browser provider behind explicit import.
- [x] Document blocker for real live WebLLM smoke tests behind `RALLAR_AI_LIVE_WEBLLM=1`; they require an application-supplied browser model runtime.
- [x] Keep live tests out of normal CI.
- [x] Document local setup for both providers in developer-facing docs.

Phase 5: Recipes and product examples.

- [x] Add a game event generation recipe.
- [x] Add browser-only and server-side example flows.
- [x] Add browser-first and server-first fallback examples.
- [x] Add app-level/browser-facade tests around generated event broadcast, approval, dedupe, and consumption.
- [x] Document when to choose browser AI, server AI, or both.

Phase 6: V1.5 and V2 expansion.

- [x] Document deferral for streaming/progress events where provider support exists.
- [x] Document deferral for model lifecycle helpers for browser cache/loading/unload state and server sidecar health.
- [x] Document deferral for versioned prompt template helpers.
- [x] Document deferral for optional result signing or provenance verification for server-generated envelopes.
- [x] Add replay/debug tooling for stored generation requests and envelopes.
- [x] Document deferral for pluggable content/safety hooks.
- [x] Document deferral for multi-peer or host/server arbitration patterns for generated game events.

## Acceptance Criteria

Implemented and verified:

- Rallar core imports no RallarAI code by default.
- Rallar Server imports no RallarAI code by default.
- Shared contracts live under `packages/shared/rallar-ai/**`.
- Browser and server results use the same envelope shape.
- Providers declare capabilities before generation.
- Applications can configure browser-only, server-only, disabled, browser-first, or server-first generation policy.
- Schema registry can resolve and hash known schema versions.
- Generated output is parsed and schema-validated before broadcast or persistence helpers send it onward.
- Timeout, cancellation, and stale-result behavior is covered by deterministic tests.
- Server-side quotas and request size limits exist.
- Diagnostics exist and omit prompt/context by default.
- Normal CI passes with only mock and fake providers.
- The plan supports browser-only, server-only, and hybrid deployments.

Blocked or deferred acceptance work:

- Real live WebLLM tests require an application-supplied browser model runtime.
- Framework-specific REST examples require an adopter-selected server framework.
- Browser cache UI, result signing, provenance verification, prompt-template
  product work, and richer arbitration remain deferred product extensions.

## Open Implementation Questions

- Should the lightweight shared schema validator remain the V1 default, or should a full JSON Schema implementation be introduced later?
- Should prompt hashing continue to include normalized context, prompt string, and schema metadata, or should privacy-sensitive applications be able to disable context hashing?
- Should result persistence remain part of RallarAI V1 helpers, or should production apps be encouraged to wrap it in domain-specific stores?
- Should WebRTC broadcast keep the highest-level `realtime` abstraction as the default, with direct `messages.rtc` as an advanced option?
- What model IDs should be documented for local Ollama and WebLLM smoke tests once the project chooses a minimum hardware target?
- Should stale-result checks be implemented as a shared helper only, or should browser/server facades enforce them by default?
- Should server quotas be configured through Rallar Server defaults, RallarAI defaults, or both?
- Should provider diagnostics flow through an existing Rallar diagnostics surface if one exists, or stay local to RallarAI V1?

## V1.5 And V2 Backlog

These are valuable product directions, but they should not block V1:

- Streaming/progress events for model loading and long generations.
- Browser model lifecycle helpers for download progress, cache state, warmup, memory pressure, and unload.
- Server sidecar health checks and readiness endpoints.
- Versioned prompt templates with template ID, version, variables, and hash.
- Optional result signing for server-generated envelopes.
- Replay/debug tooling that can reproduce a generation from stored request metadata.
- Pluggable content and safety hooks before and after generation.
- Hybrid arbitration for multi-peer generation, such as first-valid-wins, host-decides, server-decides, or room-consensus patterns.

## References

- Ollama structured outputs: https://docs.ollama.com/capabilities/structured-outputs
- WebLLM documentation: https://www.webllm.org/docs
- vLLM structured outputs: https://docs.vllm.ai/en/latest/features/structured_outputs.html

## Recommendation

Start with the shared contracts, deterministic mock provider, fake sidecar provider, and the two opt-in facades. This gives RallarAI a stable product shape before committing to any one AI runtime.

Use Ollama as the first optional live server provider because it is simple to run locally as a sidecar. Use WebLLM as the first optional live browser provider because it directly exercises the browser-only value proposition. Treat vLLM and llama.cpp as later deployment adapters, not V1 blockers.
