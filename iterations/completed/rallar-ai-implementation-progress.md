# RallarAI Implementation Progress

Date: 2026-06-05

Last verified: 2026-06-06

Source plans:

- `plans/rallar-ai-product-plan.md`
- `plans/rallar-ai-companion-follow-up-plan.md`

## Goal

Implement RallarAI as an opt-in product layer for schema-guided JSON generation
in browser and server contexts. RallarAI must preserve the current Rallar core
boundary: no default imports from `packages/shared-web/browser/rallar.ts` or
`packages/shared-server/rallar-facade/RallarServer.ts`.

## Audit Checklist

- [x] Read the RallarAI product and companion follow-up plans.
- [x] Read relevant root docs in `docs/*.md`, including API reference,
      quickstart, AI skill/prompting guidance, troubleshooting, environment
      variables, product evaluation, CRDT guide/runbook, and implementation
      progress notes.
- [x] Inspected repository structure and confirmed RallarAI should extend
      existing package homes:
      `packages/shared/rallar-ai/**`,
      `packages/shared-web/browser/**`, and
      `packages/shared-server/rallar-ai/**`.
- [x] Inspected root and package scripts. Shared contracts are verified with
      `npx tsc -p packages/shared/tsconfig.json --noEmit`; browser/server
      modules are verified with their workspace builds.
- [x] Inspected current browser facade, Rallar Data, Rallar CRDT, server
      application facade, server topic router, and server app-data patterns.
- [x] Inspected representative Vitest coverage for browser data/messages and
      server WS/app-data facades.
- [x] Confirmed existing unrelated dirty worktree entry
      `packages/tests/shared-server/group-state-app-inbox.test.ts` should not
      be modified for RallarAI unless it becomes a blocker.

## Milestones

### 1. Shared Contracts And Deterministic Providers

- [x] Add `packages/shared/rallar-ai/**`.
- [x] Add shared types for requests, results, providers, capabilities,
      validation, diagnostics, generation policy, lifecycle, transport policy,
      authorization, governance metadata, and typed errors.
- [x] Add stable JSON canonicalization and hash helpers.
- [x] Add schema registry and schema version lookup helpers.
- [x] Add JSON parse and lightweight JSON-schema validation helpers.
- [x] Add envelope builder and validation-result normalization.
- [x] Add deterministic mock provider.
- [x] Add fake sidecar HTTP provider support for deterministic server tests.
- [x] Add deterministic evaluation harness for mock-provider quality checks.
- [x] Export shared RallarAI contracts from `packages/shared/mod.ts`.
- [x] Add focused shared tests.
- [x] Verify shared typecheck and tests.

### 2. Browser RallarAI Facade

- [x] Add `packages/shared-web/browser/rallar-ai.ts`.
- [x] Add `createRallarBrowserAi(...)`.
- [x] Add `generateJson(...)` delegation through shared providers.
- [x] Add browser generation policy handling.
- [x] Enforce browser provider target capabilities.
- [x] Add timeout, cancellation, and stale-result helpers.
- [x] Add broadcast helpers for `realtime`, `messages.rtc`, and `messages.ws`
      where appropriate.
- [x] Add persist helper over `rallar.data`.
- [x] Add diagnostics, including failure diagnostics, that omit prompt/context
      by default.
- [x] Keep WebLLM behind an explicit provider entry point; do not import it by
      default.
- [x] Add focused browser tests.
- [x] Verify shared-web build and relevant tests.

### 3. Server RallarAI Facade

- [x] Add `packages/shared-server/rallar-ai/RallarAiServer.ts`.
- [x] Add `createRallarServerAi(...)`.
- [x] Add route-installer style REST generation helper aligned with
      `createRallarServerApplication(...)`.
- [x] Add WebSocket topic helper aligned with `server.ws.defineTopic(...)`,
      `authorize`, `maxPayloadBytes`, scoped topics, fanout, and publish
      statuses.
- [x] Add server persistence helper over `server.data.open(...)`.
- [x] Add quotas, concurrency limits, request size limits, redaction hooks, and
      provider base URL allowlist support.
- [x] Add typed provider error mapping and diagnostics, including failure
      diagnostics, that omit prompt/context by default.
- [x] Add Ollama provider behind explicit localhost/allowlist configuration.
- [x] Add focused server tests for generation, REST, WS, persistence, quotas,
      malformed requests, and the Ollama adapter with mocked fetch.
- [x] Verify shared-server build and relevant tests.

### 4. Companion Guardrails

- [x] Add authorization hook types and server helper integration.
- [x] Add transport policy types and documented helper behavior.
- [x] Add idempotency fields and helpers.
- [x] Add result lifecycle states and transition helpers.
- [x] Add provider governance metadata helpers.
- [x] Add security hardening tests for malformed and oversized inputs.
- [x] Add deterministic evaluation harness for mock provider output.
- [x] Add live evaluation gate helper so live provider suites are skipped unless
      an explicit environment variable is enabled.
- [x] Add accepted-result tracking helpers for host approval and dedupe
      recipes.
- [x] Add replay/debug summary helpers for stored envelopes.
- [x] Document optional host/human approval recipes.
- [x] Document CRDT operation proposal boundaries using current `rallar.crdt`
      in the main and companion plans.

### 5. Recipes, Docs, And Black-Box Follow-Up

- [x] Add RallarAI examples or recipes for game-event generation.
- [x] Add browser-only and server-side example flows.
- [x] Add browser-first and server-first fallback examples.
- [x] Add host approval and dedupe examples.
- [x] Add lifecycle transition examples.
- [x] Add replay/debug examples for stored envelopes.
- [x] Add model/provider governance and evaluation documentation.
- [x] Add RallarAI live evaluation environment variables to the environment
      variable inventory.
- [x] Add explicit WebLLM browser provider entry point and dynamic-import test.
- [x] Add Docker Compose template for Rallar Server plus a private Ollama
      sidecar.
- [x] Add black-box follow-up coverage for mock generated event broadcast and
      consumption, or explicitly document why it is deferred.
- [x] Document local live-provider setup expectation for Ollama and WebLLM in
      the plans; live provider tests remain opt-in.
- [x] Add app-level browser facade test proving proposed AI output can be
      broadcast, accepted, deduplicated, and applied once.

### 6. Deferred Or Blocked Items

- [x] Real WebLLM live browser tests are blocked in repository CI because they
      require an application-supplied browser model runtime. The structural
      adapter, dynamic import path, and `RALLAR_AI_LIVE_WEBLLM` gate are
      implemented/documented.
- [x] vLLM provider is deferred until the server provider API is stable.
- [x] llama.cpp provider is deferred until the server provider API is stable.
- [x] Streaming/progress events are deferred because V1 uses non-streaming JSON
      envelope generation.
- [x] Browser model lifecycle/cache management UI is deferred because RallarAI
      V1 is a package/API layer, not a UI product.
- [x] Server sidecar health/readiness endpoints are deferred until a concrete
      app server framework is selected by an adopter.
- [x] Framework-specific REST mounting examples are blocked until a real
      adopter selects Express, Hono, Fastify, Deno HTTP, or another target.
- [x] Versioned prompt-template product is deferred; V1 supports request
      prompts and hashes, not prompt management.
- [x] Server result signing/provenance verification is deferred until a
      production trust model is chosen.
- [x] Replay/debug viewer UI is deferred; replay summary helpers and docs now
      provide the metadata needed for future UI work.
- [x] Pluggable content/safety product is deferred; V1 exposes validation,
      authorization, and provider hooks.
- [x] Multi-peer or host/server arbitration beyond helper types and recipes is
      deferred because applications own final state acceptance.

## Verified

- [x] Shared typecheck.
- [x] Shared RallarAI unit tests.
- [x] Shared-web build.
- [x] Browser RallarAI unit tests.
- [x] Shared-server build.
- [x] Server RallarAI unit tests.
- [x] Relevant broader test suite passes.
- [x] App/workspace build.

## Current Status

The companion follow-up plan is implemented as a package/API and documentation
slice. Shared contracts, deterministic providers, browser facade, server
facade/provider slices, proposal/dedupe helpers, replay summaries, live
evaluation gates, governance documentation, WebLLM adapter packaging, and
deployment examples are implemented or explicitly documented as blocked/deferred.

## Remaining Limitations

- Live AI providers are intentionally not required for normal CI.
- The Ollama adapter is covered with mocked fetch; local live Ollama verification
  remains opt-in because it depends on a running local model at the configured
  endpoint.
- Real WebLLM live verification remains blocked by the absence of an
  application-supplied browser model runtime in repository CI.
- vLLM, llama.cpp, streaming, approval UI, replay/debug UI, browser model cache
  UI, and production signing/provenance workflows remain documented deferred
  product work.
- Framework-specific REST examples remain blocked until an adopter chooses a
  concrete server framework.
- Full `npm test` requires local `127.0.0.1` listener permission for a small
  set of shared-test HTTP tests; it passes when run outside the sandbox.

## Verification Log

- `npx vitest run packages/tests/shared/rallar-ai-contracts.test.ts`
  - Passed: 1 file, 10 tests.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
  - Passed.
- `npx vitest run packages/tests/shared/rallar-ai-contracts.test.ts packages/tests/shared-web/rallar-ai.test.ts`
  - Passed: 2 files, 14 tests.
- `npm --workspace @ar-eye-hunter/shared-web run build`
  - Passed.
- `npx vitest run packages/tests/shared-server/rallar-ai-server.test.ts`
  - Passed: 1 file, 10 tests.
- `npm --workspace @ar-eye-hunter/shared-server run build`
  - Passed after REST installer generic typing fix.
- `npx vitest run packages/tests/shared/rallar-ai-contracts.test.ts packages/tests/shared-web/rallar-ai.test.ts packages/tests/shared-server/rallar-ai-server.test.ts`
  - Passed: 3 files, 26 tests.
- `npm run build`
  - Passed for all workspaces. Vite reported existing chunk-size warnings.
- `npm test -- --run packages/tests/shared/rallar-ai-contracts.test.ts packages/tests/shared-web/rallar-ai.test.ts packages/tests/shared-server/rallar-ai-server.test.ts`
  - Passed through the root test script: 3 files, 26 tests.
- `npx vitest run packages/tests/rallar-black-box/rallar-mode-boundary.test.ts packages/tests/shared-test/rallar-companion-coverage.test.ts`
  - Passed: 2 files, 11 tests, after updating stale boundary expectations for
    direct panel slices and CRDT recipe command kinds.
- `npm test`
  - Sandboxed run failed because local HTTP test servers could not bind to
    `127.0.0.1` (`listen EPERM`).
  - Rerun outside the sandbox passed: 172 files, 1231 tests.
- `npx vitest run packages/tests/shared/rallar-ai-contracts.test.ts packages/tests/shared-web/rallar-ai.test.ts packages/tests/shared-server/rallar-ai-server.test.ts`
  - Passed: 3 files, 26 tests, after adding browser provider-target enforcement,
    browser failure diagnostics, server provider-failure diagnostic taxonomy,
    and evaluation metadata assertions.
- `npx vitest run packages/tests/shared/rallar-ai-contracts.test.ts packages/tests/shared-web/rallar-ai.test.ts packages/tests/shared-server/rallar-ai-server.test.ts packages/tests/shared-server/rallar-ai-live-ollama.test.ts`
  - Passed: 4 files, 30 tests, after adding accepted-result tracking, replay
    summaries, live evaluation gates, WebLLM dynamic-import provider coverage,
    and the live Ollama skip/run harness.
- `npx vitest run packages/tests/shared/rallar-ai-contracts.test.ts packages/tests/shared-web/rallar-ai.test.ts packages/tests/shared-server/rallar-ai-server.test.ts packages/tests/shared-server/rallar-ai-live-ollama.test.ts`
  - Passed: 4 files, 31 tests, after adding browser app-level proposal
    broadcast, host approval, dedupe, and apply-once coverage.
- `npm test -- --run packages/tests/shared/rallar-ai-contracts.test.ts packages/tests/shared-web/rallar-ai.test.ts packages/tests/shared-server/rallar-ai-server.test.ts packages/tests/shared-server/rallar-ai-live-ollama.test.ts`
  - Passed through the root test script: 4 files, 31 tests.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
  - Passed.
- `npm --workspace @ar-eye-hunter/shared-web run build`
  - Passed.
- `npm --workspace @ar-eye-hunter/shared-server run build`
  - Passed.
- `npm run build`
  - Passed for all workspaces. Vite reported existing chunk-size warnings.
- `npx vitest run packages/tests/rallar-black-box/rallar-mode-boundary.test.ts packages/tests/shared-test/rallar-companion-coverage.test.ts packages/tests/shared-test/rallar-bb-test.test.ts`
  - Passed: 3 files, 59 tests.
