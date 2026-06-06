# RallarAI Companion Follow-Up Plan

Date: 2026-06-03

Last updated: 2026-06-06

Status: Post-V1 companion plan and guardrail backlog for the main RallarAI implementation plan.

Related plan: `plans/rallar-ai-product-plan.md`

Implementation progress is tracked in `docs/rallar-ai-implementation-progress.md`.

Current repo anchors:

- Browser Rallar facade: `packages/shared-web/browser/rallar.ts`.
- Browser Rallar Data facade: `packages/shared-web/browser/rallar-data.ts`.
- Browser Rallar CRDT facade: `packages/shared-web/browser/rallar-crdt.ts`.
- Server application facade: `packages/shared-server/rallar-facade/RallarServerApplication.ts`.
- Server core facade: `packages/shared-server/rallar-facade/RallarServer.ts`.
- Server topic router: `packages/shared-server/rallar-facade/ws-topic-router.ts`.
- Server middleware: `packages/shared-server/rallar-system/middleware/RallarMiddleware.ts`.
- Server CRDT facade: `packages/shared-server/crdt/RallarCrdtServer.ts`.
- Rallar guidance docs: `docs/rallar-api-reference.md`, `docs/rallar-quickstart-and-recipes.md`, `docs/rallar-ai-skill.md`, and `docs/rallar-crdt-guide.md`.

## Purpose

This companion plan captures the follow-up product, safety, governance, and developer-experience concerns around RallarAI. The main RallarAI plan defines the opt-in browser/server architecture, shared contracts, provider strategy, deployment model, and V1 implementation phases. This companion plan defines the additional support that will make RallarAI reliable once applications start depending on generated JSON for game and collaboration workflows.

The goal is to avoid retrofitting hard problems later: authorization, transport semantics, idempotency, result lifecycle, security hardening, model governance, quality evaluation, packaging, and debugging.

## Scope

The low-cost V1 hooks in this plan now exist in the shared, browser, and server RallarAI modules. This plan should remain as a follow-up backlog for hardening the feature before public adoption and for adding product polish after the initial package/API surface is stable.

In scope:

- Authorization and room permissions for AI generation.
- Transport semantics for generated AI events.
- Idempotency and duplicate handling.
- Result lifecycle states.
- Optional host/player approval workflows.
- Security hardening around schema, context, prompt, provider, and sidecar boundaries.
- Model and provider governance.
- Quality and evaluation harnesses.
- Developer experience, examples, and scaffolding.
- Packaging and tree-shaking expectations.
- Follow-up product ideas such as CRDT integration and replay/debug tooling.

Out of scope:

- Making RallarAI mandatory for Rallar.
- Building a general agent framework.
- Adding a hosted AI service as part of Rallar.
- Replacing application domain validation.
- Treating AI output as authoritative state by default.

## Current Implementation Review

Review date: 2026-06-06.

This plan is still relevant, but its role has changed. It is no longer a blocker list for creating the initial RallarAI surface. The current code already implements the V1 guardrail hooks that were cheap and important to add early:

- Shared contracts under `packages/shared/rallar-ai/**` for requests, results, providers, diagnostics, transport policy, authorization, lifecycle, governance metadata, schema registry, hashing, validation, and deterministic evaluation.
- Browser facade in `packages/shared-web/browser/rallar-ai.ts` for opt-in generation, stale-result rejection, safe diagnostics, realtime/RTC/WS broadcast, persistence, provider-target enforcement, and failure diagnostics.
- Server facade in `packages/shared-server/rallar-ai/RallarAiServer.ts` for opt-in generation, REST route mounting, WS topic handling, publish/persist helpers, authorization, quotas, size limits, redaction, provider-target enforcement, typed errors, Ollama adapter, fake sidecar adapter, and safe diagnostics.
- Recipes in `docs/rallar-ai-recipes.md` for browser-only generation, server-side Ollama generation, fallback policy, capability detection, host approval, dedupe, CRDT proposal boundaries, and live provider expectations.
- Progress tracking in `docs/rallar-ai-implementation-progress.md` with the latest focused and broader verification history.

Review findings:

- The core product boundary still fits the repo: RallarAI is opt-in, extends the existing `packages/shared`, `packages/shared-web`, and `packages/shared-server` homes, and is not imported by Rallar core by default.
- The browser/server split is now enforced by provider capabilities in both facades, which keeps browser-only and server-only deployment choices honest.
- Adoption evidence now exists for app-level approval and dedupe, governance documentation, live-gated evaluation, and replay/debug examples.
- WebLLM now has an explicit browser provider entry point that type-checks without importing a heavy model runtime by default.
- Docker Compose guidance now exists as a deployment template. Framework-specific REST examples remain deferred until an adopter chooses a concrete framework.

## Priority Backlog

P1 adoption hardening:

- [x] Add an app-level or black-box scenario where generated JSON is broadcast as a proposal, accepted once, deduplicated, and applied to game/domain state.
- [x] Add model/provider governance documentation that explains how applications should record provider metadata, model/license notes, production allow/disallow flags, and deployment review decisions.
- [x] Add a deterministic evaluation report assertion or recipe that shows provider metadata, model metadata, validation status, and domain-quality failures in a form teams can compare.
- [x] Add lifecycle transition examples that show `draft -> proposed -> accepted/rejected/expired/superseded`.

P2 provider and deployment polish:

- [x] Implement the explicit WebLLM provider module and type-check the dynamic import example.
- [x] Add optional live-provider evaluation harnesses behind `RALLAR_AI_LIVE_OLLAMA=1` and `RALLAR_AI_LIVE_WEBLLM=1`.
- [x] Add a Docker Compose example for Rallar Server plus a private Ollama sidecar.
- [x] Documented blocker until adopter choice: add framework-specific REST mounting examples if real adopters use Express, Hono, Fastify, or Deno HTTP directly.

P3 product extensions:

- [x] Add replay/debug tooling for stored AI envelopes and lifecycle transitions.
- [x] Documented deferral until a browser runtime product exists: explore browser model cache lifecycle UI as an application-level helper.
- [x] Documented deferral until a concrete trust model exists: explore signed accepted results or provenance verification.
- [x] Explore AI-generated CRDT operation proposals only as accepted app/domain operations, never as direct model-to-CRDT mutation.

## Product Decisions

- RallarAI should treat generated JSON as proposed data until the application accepts it.
- Server-side generation, broadcast, and persist helpers must expose an authorization hook and invoke it when configured. Production deployments should configure this hook before mounting public REST or WebSocket helpers.
- Browser-side generation can remain peer/local, but helpers should still expose hooks for room policy and host approval.
- Every generated result should be idempotent and deduplicatable.
- RallarAI should define transport semantics explicitly instead of assuming all transports behave the same.
- Provider and model metadata should be visible enough for production governance.
- Browser bundles must not include heavy AI runtimes unless the app imports the matching provider.

## Authorization And Room Permissions

RallarAI should define permission checks for these actions:

- Trigger AI generation.
- Use server-side AI quota.
- Broadcast generated AI output to a room or group.
- Persist generated AI output.
- Approve or reject proposed AI output.
- Configure provider policy for a room.

Suggested V1 hook shape:

```ts
export interface RallarAiAuthorizationContext {
  actorId?: string;
  roomId?: string;
  action:
    | "generate"
    | "broadcast"
    | "persist"
    | "approve"
    | "reject"
    | "configure-provider";
  source: "browser" | "server";
  schemaId: string;
  schemaVersion: string;
}

export type RallarAiAuthorize = (
  context: RallarAiAuthorizationContext,
) => Promise<boolean> | boolean;
```

Server-side authorization should be configured when route or WebSocket helpers are mounted. Browser-side authorization can be advisory, because a local peer can always run local code, but the helper should still make intended policy visible.

This should align with the current server topic router instead of bypassing it. `RallarServerWsTopicDefinition` already supports `authorize`, `maxPayloadBytes`, scoped topics, and fanout. RallarAI server helpers should reuse those hooks where possible and add AI-specific authorization context around them.

## Transport Semantics

Generated AI results may move over Rallar realtime, WebRTC, WebSocket topics, or persistence APIs. The plan should make transport behavior explicit per helper.

Important transport questions:

- Does the generated event require ordering?
- Is acknowledgement required?
- Should retry happen automatically?
- Is the message ephemeral or persisted?
- Does the room use latest-valid-result-wins, first-valid-result-wins, or explicit approval?
- Are peers expected to deduplicate by `generationId`, `requestId`, or `dedupeKey`?

Suggested shared transport metadata:

```ts
export interface RallarAiTransportPolicy {
  delivery: "ephemeral" | "persisted" | "ephemeral-and-persisted";
  ordering: "none" | "per-lane" | "server-ordered";
  acknowledgement: "none" | "sender-only" | "room-quorum";
  conflictPolicy:
    | "first-valid-wins"
    | "latest-valid-wins"
    | "host-decides"
    | "server-decides"
    | "app-defined";
}
```

V1 does not need to implement every transport behavior. It should define the vocabulary so examples and future helpers do not invent incompatible patterns.

The current server topic router already has useful primitives to align with: scoped topics, `fanout` values, `authorize`, `maxPayloadBytes`, `publish`, proxy rules, and publish statuses such as `duplicate`, `superseded`, `expired`, `rate-limited`, and `failed`. RallarAI should build on that vocabulary instead of inventing parallel server transport semantics.

## Idempotency And Duplicate Handling

RallarAI should make repeat application difficult by default.

Recommended fields:

- `requestId`: stable ID for a generation request.
- `generationId`: unique ID for a provider output.
- `dedupeKey`: optional app-level key for "this proposal should only apply once."
- `baseStateRevision`: state revision used to produce the result.
- `supersedesGenerationId`: optional pointer when a newer result replaces an older proposal.

Acceptance rule:

- Applying the same accepted AI result twice should be a no-op in documented recipes.

This matters especially for WebRTC broadcasts, reconnects, retries, and stored replay.

## Result Lifecycle

The main RallarAI envelope says what was generated. The companion lifecycle says how the application treats it.

Suggested lifecycle states:

| State | Meaning |
| --- | --- |
| `draft` | Created locally but not shared. |
| `proposed` | Shared with peers or server, not yet accepted. |
| `accepted` | Approved for application to domain state. |
| `rejected` | Explicitly refused by host, server, or app validation. |
| `expired` | No longer valid because time or base state moved on. |
| `superseded` | Replaced by a newer generation. |

Suggested helper package location:

```text
packages/shared/rallar-ai/rallar-ai-result-lifecycle.ts
```

V1 can expose types and helper functions without forcing a lifecycle store.

## Host Or Human Approval Mode

Some games and collaborative applications will want AI output as a proposal, not an immediate event.

Example flow:

```text
generate result
  -> validate schema
  -> broadcast proposal to host/player
  -> host approves or rejects
  -> approved result is broadcast as accepted
  -> peers apply accepted result once
```

Approval mode should be optional. It is valuable for:

- Turn-based games.
- Creative party games.
- Room-hosted sessions.
- Educational or collaborative tools.
- Any app where surprising AI output should be reviewed before it affects shared state.

## Security Hardening

RallarAI should treat schemas, prompts, context, provider output, and sidecar boundaries as untrusted.

Hardening checklist:

- Limit schema size and nesting depth.
- Limit prompt and context byte size.
- Reject or constrain dangerous schema shapes.
- Avoid logging prompt and context by default.
- Avoid storing raw provider output unless explicitly enabled.
- Validate parsed JSON before broadcast or persistence helpers run.
- Prevent JSON bombs and excessive object depth.
- Keep sidecar endpoints private to server networks.
- Require explicit base URL allowlists for server providers.
- Apply timeout and cancellation cleanup for provider calls.
- Return typed provider errors instead of leaking raw sidecar errors to clients.

Security testing should include malicious schema, oversized context, malformed JSON, slow sidecar, sidecar error, and unexpected content-type cases.

## Model And Provider Governance

RallarAI should record enough provider metadata for production teams to make informed decisions.

Recommended metadata:

- Provider ID.
- Provider adapter version.
- Model ID.
- Model version or digest when available.
- Runtime target: browser, server, mock, or sidecar.
- License notes supplied by the application or provider adapter.
- Production allowed/disallowed flag.
- Structured-output capability.
- Known limits and recommended timeout.

RallarAI should not decide legal model suitability. It should expose the information and hooks that make deployment governance possible.

## Quality And Evaluation Harness

Correct API behavior is not enough. AI providers can return schema-valid output that is still poor for the game or product.

RallarAI should support a small evaluation harness:

- Golden schemas.
- Golden prompts.
- Expected shape and domain constraints.
- Provider comparison snapshots.
- Optional live evaluation runs behind environment gates.
- Human-readable diff output for generated envelopes.

The harness should not run in normal CI with live providers. Deterministic mock evaluation should run in CI; live provider quality checks should be local or scheduled.

## Developer Experience

RallarAI should provide practical examples before advanced abstractions.

Suggested examples:

- Generate a game event from a JSON schema.
- Browser-only AI generation and WebRTC broadcast.
- Server-side Ollama generation and WebSocket publish.
- Browser-first with server fallback.
- Host approval before applying an AI result.
- Persist and replay AI envelopes.
- Redact context before sending to a provider.

Possible scaffold:

```text
examples/rallar-ai-game-event/
```

The examples should show the exact difference between generated proposal, accepted event, and domain state mutation.

## Packaging And Tree-Shaking

Browser packaging must stay sharp:

- `packages/shared-web/browser/rallar-ai.ts` should not import WebLLM by default.
- Provider adapters should be imported explicitly.
- Heavy providers should live behind separate entry points.
- Shared contracts should stay small and dependency-light.
- Server-only dependencies must not enter browser bundles.
- Browser examples should show dynamic provider import when useful.

Suggested provider entry points:

```text
packages/shared-web/browser/rallar-ai-providers/webllm.ts
packages/shared-server/rallar-ai/providers/ollama.ts
packages/shared-server/rallar-ai/providers/fake-sidecar-http.ts
```

## Future Product Integrations

These ideas should not block V1, but they are good product directions:

- AI-generated CRDT operation proposals using the current `rallar.crdt` API.
- AI-assisted conflict resolution.
- AI-generated room setup.
- NPC actions, quests, scenarios, hints, and tutorial prompts.
- Moderation suggestions as application-level proposals.
- Browser model cache management UI.
- Docker Compose examples for Rallar Server plus Ollama.
- Replay/debug viewer for AI envelopes and lifecycle transitions.

## Implementation Plan

Phase 1: Shared follow-up contracts.

- [x] Add result lifecycle types.
- [x] Add transport policy types.
- [x] Add idempotency fields to the shared envelope plan.
- [x] Add provider governance metadata types.
- [x] Add authorization hook types.
- [x] Place shared follow-up contracts under `packages/shared/rallar-ai/**`.

Phase 2: Server guardrails.

- [x] Add authorization hooks to server REST, WebSocket, broadcast, and persist helpers.
- [x] Reuse existing `server.ws.defineTopic` `authorize`, `maxPayloadBytes`, scoped topic, and fanout behavior where possible.
- [x] Add provider base URL allowlist support.
- [x] Add request and schema hardening tests.
- [x] Add typed provider error mapping.
- [x] Add quota and concurrency diagnostics.

Phase 3: Browser and transport recipes.

- [x] Add shared transport policy vocabulary and helper behavior.
- [x] Add documented transport policy recipes.
- [x] Add deduplication helper examples.
- [x] Add host approval example.
- [x] Add browser provider dynamic import example.
- [x] Enforce provider target capabilities in the browser facade.
- [x] Emit safe browser generation failure diagnostics.

Phase 4: Governance and evaluation.

- [x] Add provider metadata helpers.
- [x] Add model/provider governance documentation.
- [x] Add deterministic evaluation harness.
- [x] Include provider metadata and validation status in deterministic evaluation output.
- [x] Add optional live evaluation harness behind environment gates.

Phase 5: Debugging and product polish.

- [x] Add replay/debug recipe for stored envelopes.
- [x] Add lifecycle transition examples.
- [x] Add Docker Compose example for Rallar Server plus Ollama.
- [x] Add guidance for Rallar CRDT integration that respects durable append, validation, hardening policies, and transport boundaries.

## Testing Plan

Shared tests:

- [x] Idempotency helpers produce stable keys.
- [x] Lifecycle transition helpers reject invalid transitions.
- [x] Transport policy objects validate expected values.
- [x] Provider governance metadata validates required fields.

Server tests:

- [x] Unauthorized generation requests are rejected through the shared authorization hook when configured.
- [x] Unauthorized broadcast and persist actions are rejected through the shared authorization hook when configured.
- [x] Oversized schema, prompt, and context payloads are rejected.
- [x] Provider base URL allowlist blocks unexpected sidecar targets.
- [x] Sidecar errors are mapped to typed RallarAI errors in a dedicated fake-sidecar server facade test.

Browser tests:

- [x] Browser package does not import heavy providers by default.
- [x] Browser facade rejects server-only policy and server-target providers.
- [x] Browser generation failure diagnostics omit prompt/context.
- [x] Dynamic provider import examples remain type-checkable after the WebLLM adapter exists.
- [x] App-level host approval recipe applies accepted results once.
- [x] App-level deduplication recipe ignores repeated accepted envelopes.

Evaluation tests:

- [x] Mock provider evaluation runs in normal CI.
- [x] Evaluation output includes provider metadata and validation status.
- [x] Live provider evaluation only runs behind explicit environment gates.

## Acceptance Criteria

- The main RallarAI plan remains the V1 implementation source of truth.
- This companion plan is linked from the main RallarAI plan.
- Authorization hooks are defined before server AI helpers become public.
- Transport semantics are documented for WebRTC, realtime, WebSocket, and persisted flows.
- AI results can be deduplicated before application to domain state.
- Result lifecycle states are documented and have helper types.
- Security hardening has deterministic tests for malformed and oversized inputs.
- Provider governance metadata can describe model, adapter, target, and production suitability.
- Browser provider packaging avoids importing heavy AI runtimes unless explicitly requested.

Blocked or deferred work:

- Framework-specific REST mounting examples are blocked until a real adopter
  selects Express, Hono, Fastify, Deno HTTP, or another target.
- Real WebLLM live evaluation is blocked in normal repository tests because it
  requires a browser model runtime supplied by an application. The provider
  adapter, dynamic import path, and `RALLAR_AI_LIVE_WEBLLM` gate are documented.
- Browser model cache UI, result signing, and provenance verification are
  deferred product extensions that require a concrete application runtime and
  production trust model.

## Open Questions

- Should authorization reuse existing Rallar room/group permission primitives directly, or should RallarAI continue with its minimal hook and let apps bridge to room/group policy?
- Should result lifecycle be purely an app-level helper, or should RallarAI provide a small proposal store?
- Should server-side accepted results be signed in V1.5, or only tagged with provider metadata?
- Should `dedupeKey` be required for broadcast helpers, or optional for app-specific workflows?

## Recommendation

Treat this companion plan as implemented for the current package/API slice. The remaining useful work is product adoption work: choose real app frameworks for REST mounting examples, supply a browser WebLLM runtime for live evaluation, and define a production trust model before adding signing or provenance verification. Heavier product work such as model cache UI and replay viewers should stay deferred until real applications validate the current facades.
