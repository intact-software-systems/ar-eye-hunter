# Rallar Agent Guide

Use this file as the lightweight repo orientation. Detailed workflows live in
the repo-local Codex plugin under `skills/**`.

## Start Here

- Inspect the existing code before editing; Rallar package docs can lag behind
  active package work.
- For package/app changes, read the relevant repo skill in `skills/**`:
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

## Validation

- Run focused tests for the touched package or app before broader suites.
- For shared-web public surface work, include public API snapshots and browser
  bundle-boundary checks when exports or entry points change.
- For game/realtime changes, include the relevant app tests/builds and shared
  package tests.
- Report commands that passed, failed, or were skipped.

## Performance analysis repo guidance

When using the performance-analysis skill:

- Start static performance audits from these entry points:
  - `packages/**`
  - `apps/api-v1`
  - `apps/rallar-black-box-control-server`
  - `apps/rallar-black-box-headless`
  
- Use these benchmark commands:
  - `...`

- Use these test commands before accepting optimization changes:
  - `...`

- Put temporary profiling artifacts under:
  - `tmp/perf/`

- Do not commit generated profile files unless explicitly requested.

- Treat these as performance-sensitive paths:
  - `packages/...`

- Treat these as not representative for performance:
  - `...`