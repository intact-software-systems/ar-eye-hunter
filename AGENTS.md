# Rallar Agent Guide

Use this file as the lightweight repo orientation. Detailed workflows live in
the repo-local Codex plugin under `.agents/skills/**`.

## Start Here

- Inspect the existing code and relevant `examples/**` before editing; Rallar
  package docs can lag behind active package work.
- For package/app changes, read the relevant repo skill in `.agents/skills/**`:
  - `building-rallar-apps` first for greenfield apps and React/3D architecture;
    then use the authority, realtime, and testing specialists for the selected
    surfaces.
  - `rallar-platform` for package boundaries and public surfaces.
  - `rallar-realtime` for rooms, presence, WS/RTC, scoped identity, and routing.
  - `rallar-games` for AR Eye Hunter, Relic Hunters, Rallar Game, and Motion.
  - `rallar-ai` for RallarAI providers, schemas, and deterministic helpers.
  - `rallar-code-writing` for package code style and testability.
  - `rallar-testing` for validation commands.
- Keep `.codex-plugin/plugin.json` as the source that exposes these skills to
  Codex. Do not add a separate `SKILLS.md` unless the plugin format changes.

## Product Truths

- Treat `packages/**` as the reusable product surface and `apps/**` as
  consumers.
- Keep Rallar black-box control protocol, distributed-run artifact contracts,
  reusable recipe fixtures, and artifact analysis in `packages/shared-test`;
  `apps/rallar-black-box` should consume those contracts for UI/operator flows.
- Preserve existing public exports and app import paths unless a task explicitly
  asks for a breaking change.
- Prefer `GroupRef`/`roomRef` when application/workspace scope matters.
- For room-scoped app/game traffic, prefer `rallar.realtime.room<T>(...)` and
  `rallar.messages.room<T>(...)` before hand-wiring RTC readiness and sends.
- Use Rallar Data for browser-local latest-value state, not live match truth.
- Use Rallar CRDT for collaborative authored documents, not competitive live
  match authority.
- Use Rallar Motion for presentation smoothing, not simulation authority.
- RallarAI output is proposal data until validated and accepted by domain code.
- Optimistic compare-and-set writes with bounded retries are the default for
  authoritative shared database state. Conditional insert owns creation;
  expected-revision compare-and-set owns updates; expected-revision conditional
  delete owns deletion and expiry.
- Every optimistic retry must re-read and rerun authorization, policy, capacity,
  lifecycle, and invariant checks. Never retry only a stale final write.
- Authoritative user-write authentication dependencies are mandatory and fail
  closed; do not add optional authority repositories, missing-authority
  fallbacks, or production overloads shaped only for tests.
- Keep internal cleanup/expiry behind a separately wired narrow maintenance
  capability. Never expose it through public group service or app-inbox types,
  and never accept caller-provided actor, reason, or bypass fields.
- Database row, table, and advisory locks are exceptional. Do not copy an
  existing lock as architecture precedent. Any exception needs explicit human
  approval, a documented invariant and measured need, a bounded critical
  section, and a review or removal condition.
- Authoritative persisted, replicated, queued, event, snapshot, and response
  contracts use mandatory fields by default. Optional fields require meaningful
  domain absence and consumer tests; sparse request, query, patch, builder, and
  migration inputs use separate types.
- Validate canonical storage key, stored value identity, and trusted
  command-slot relationships before every authoritative compare-and-set.
  Never derive the expected actor, target, principal, session, or request
  identity from the candidate row being validated.

## Validation

- Run focused tests for the touched package or app before broader suites.
- When adding or changing REST API behavior, add or adjust Rallar black-box
  recipes/tests in `packages/shared-test/black-box-runner` as part of the same
  change, and run the focused black-box command when the required services are
  available.
- For shared-web public surface work, include public API snapshots and browser
  bundle-boundary checks when exports or entry points change.
- For game/realtime changes, include the relevant app tests/builds and shared
  package tests.
- Report commands that passed, failed, or were skipped.

## AI Handoff Contract (applies to all agents)

- End each AI task with a concise completion handoff:
  - What changed (files + behavior).
  - Why those changes were chosen (risk/compatibility rationale).
  - Validation evidence (exact command outputs and results).
  - Any follow-up needed.
- Keep the handoff structured, not just an action list. If tradeoffs were made,
  call them out explicitly.

## Performance analysis repo guidance

When using the `performance-analysis` skill:

- Start static audits from `packages/**`, `apps/api-v1`,
  `apps/rallar-black-box-control-server`, and
  `apps/rallar-black-box-headless`.
- Read `scripts/perf/README.md` and the relevant existing harness under
  `scripts/perf/**` before adding a benchmark.
- Run focused correctness tests from the `rallar-testing` skill before
  accepting an optimization.
- Put generated profiles under `tmp/perf/` and do not commit them unless
  explicitly requested.
- Treat `packages/shared/webrtc`, `packages/shared/multicast`,
  `packages/shared-web/browser`, and shared-server queue/state paths as
  performance-sensitive when they are on the measured workload.
- Treat historical plans and generated black-box artifacts as context, not a
  runtime baseline unless the environment and workload match.
