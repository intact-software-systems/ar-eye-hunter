# Rallar CRDT Black-Box Live Validation Plan

Date: 2026-06-05

Status: Implementation plan and runbook for live-gated CRDT validation in the
black-box stack.

Related plans:

- `plans/rallar-crdt-product-and-implementation-plan.md`
- `plans/rallar-crdt-production-hardening-companion-plan.md`

## Purpose

Rallar CRDT is a user-visible collaboration feature. The black-box stack should
prove the high-risk behaviors that unit tests cannot fully cover: browser-agent
command dispatch, WS convergence, RTC with WS fallback, durable HTTP late-join
catch-up, local persistence reopen, health diagnostics, and admin integrity
routes.

This plan keeps `black-box-runner` provider-neutral. CRDT behavior lives in
`rallar-bb-test` browser-agent commands and the browser Rallar runtime; the
runner only expands recipes, forwards `crdt.*` steps, extracts outputs, runs
assertions, and stores artifacts.

## Current Code And Docs Checked

Primary local references:

- `packages/shared-test/rallar-bb-test/types.ts`
- `packages/shared-test/rallar-bb-test/schema.ts`
- `packages/shared-test/rallar-bb-test/browser-adapter.ts`
- `packages/shared-test/black-box-runner/browser/rallar-browser-runtime.ts`
- `packages/shared-test/black-box-runner/rallar-browser-rtc-provider.ts`
- `packages/shared-test/black-box-runner/rallar-remote-browser-provider.ts`
- `packages/shared-test/black-box-runner/recipe-matrix.json`
- `packages/shared-test/black-box-runner/examples`
- `packages/shared-test/black-box-runner/docs/black-box-runner-recipe-guide.md`
- `docs/rallar-crdt-guide.md`

Repo facts this plan relies on:

- Browser-agent CRDT commands include `crdt.open`, `crdt.apply`, `crdt.read`,
  `crdt.sync`, `crdt.health`, `crdt.wait`, `crdt.undo`, `crdt.redo`,
  `crdt.close`, and `crdt.destroy`.
- `crdt.wait` polls an opened browser CRDT handle until value or health
  conditions match; it may call `document.sync(...)` between attempts.
- Runner scenario steps classify `crdt.*` as CRDT interactions and forward them
  through provider `command(...)`.
- Existing runner output extraction and `assert` steps are sufficient for
  convergence assertions.
- CRDT admin coverage remains ordinary `http.request` in V1.

## Validation Strategy

- Use a dedicated `live-crdt` matrix profile for CRDT live rows, in addition to
  existing `live` and `browser-live` profiles.
- Run deterministic CRDT diagnostics first, then live browser recipes:
  WS convergence, RTC with WS fallback, durable late-join catch-up, local
  persistence reopen, and admin HTTP integrity.
- Each live recipe must contain state assertions, not only command completion:
  `crdt.wait` for eventual value and health, `crdt.read` output extraction, and
  runner `assert` comparisons.
- Keep remote-browser parity as a provider concern. Remote providers should
  forward `crdt.wait` using the same command contract as local browser
  providers.

## Live Preflight Requirements

Required environment for browser CRDT rows:

- `RALLAR_API_BASE_URL`
- `RALLAR_ALICE_USERNAME`
- `RALLAR_ALICE_PASSWORD`
- `RALLAR_BOB_USERNAME`
- `RALLAR_BOB_PASSWORD`

Required environment for admin integrity rows:

- `RALLAR_API_BASE_URL`
- `RALLAR_ADMIN_ACCESS_TOKEN`
- `RALLAR_CRDT_DOCUMENT_KEY`

Preflight should verify:

- API reachability through `RALLAR_API_BASE_URL`.
- Playwright/browser availability for browser-backed rows.
- Alice and Bob authentication can succeed.
- Room create/join or configured room access is available.
- WS readiness for `ws` CRDT transport.
- RTC readiness or a clear fallback path for `rtc-with-ws-fallback`.
- Durable catch-up route availability for recipes using `durableCatchUp: "http"`.
- Admin route authorization for integrity/debug/export rows.

## Expected Artifacts

Each live run should produce:

- Redacted `report.json` with CRDT step results, extracted outputs, assertions,
  and summary counts.
- CRDT diagnostics for open, apply, sync, wait, health, close, and failures.
- Preflight summary showing required env/service/browser gates.
- Failure bundle with last CRDT value, health, pending counts, dependency
  counts, failed counts, transport strategy, and last sync result when
  `crdt.wait` times out.

## Acceptance Criteria

- `live-crdt` expands only CRDT live/admin validation rows.
- WS convergence proves Alice and Bob materialize the same title/count values
  with zero pending and dependency-blocked updates.
- RTC fallback proves the selected `rtc-with-ws-fallback` strategy is usable
  and reaches clean health after convergence.
- Durable late-join proves Bob sees Alice's pre-join update through HTTP-backed
  catch-up.
- Local persistence proves a browser-local CRDT document can close, reopen, and
  read the persisted value without live transport.
- Admin integrity checks pass when admin credentials are present and fail with
  clear authorization/preflight diagnostics when they are absent.
