# Rallar CRDT Black Box Apps Support Plan

Date: 2026-06-05

Status: Implementation plan for CRDT operator and test support in
`apps/rallar-black-box` and `apps/rallar-black-box-control-server`.

Related plans:

- `plans/rallar-crdt-product-and-implementation-plan.md`
- `plans/rallar-crdt-production-hardening-companion-plan.md`
- `plans/rallar-crdt-black-box-live-validation-plan.md`

## Purpose

Rallar CRDT is a user-visible collaboration feature, but the Black Box apps
should support it as test and operator tooling rather than as a product editor.
`apps/rallar-black-box` should make CRDT health, live validation recipes,
preflight, command authoring, and failure diagnostics easy to inspect.
`apps/rallar-black-box-control-server` should remain provider-neutral: it
queues browser-agent commands, dispatches them, stores results/events, redacts
artifacts, and exports evidence without embedding CRDT semantics.

This plan captures the remaining app-level work after CRDT browser-agent
commands and live runner recipes have been added to the shared-test stack.

## Current Code And Docs Checked

Primary local references:

- `apps/rallar-black-box/src/App.tsx`
- `apps/rallar-black-box/src/app-tabs.ts`
- `apps/rallar-black-box/src/control-client.ts`
- `apps/rallar-black-box/src/control-protocol.ts`
- `apps/rallar-black-box/src/control-run-manager.ts`
- `apps/rallar-black-box/src/distributed-recipes.ts`
- `apps/rallar-black-box/src/schema-authoring.ts`
- `apps/rallar-black-box-control-server/src/control-service.ts`
- `apps/rallar-black-box-control-server/src/control-artifacts.ts`
- `apps/rallar-black-box-control-server/src/main.ts`
- `apps/rallar-black-box-control-server/src/routes/swagger-routes.ts`
- `packages/shared-test/rallar-bb-test/schema.ts`
- `packages/shared-test/rallar-bb-test/types.ts`
- `packages/shared-test/rallar-bb-test/distributed-run.ts`
- `packages/shared-test/black-box-runner/recipe-matrix.json`
- `packages/shared-test/black-box-runner/docs/black-box-runner-recipe-matrix.md`

Repo facts this plan relies on:

- `apps/rallar-black-box` already has a `CRDT Health` tab in direct Rallar mode.
- The CRDT Health tab already calls Rallar API admin routes for list,
  integrity, debug export, backup export, compact, rebuild, archive,
  quarantine, and destroy.
- Browser-agent CRDT commands already include `crdt.open`, `crdt.apply`,
  `crdt.read`, `crdt.sync`, `crdt.health`, `crdt.wait`, `crdt.undo`,
  `crdt.redo`, `crdt.close`, and `crdt.destroy`.
- `packages/shared-test/rallar-bb-test/schema.ts` already exposes capability
  metadata and examples for the `crdt.*` command family.
- The black-box runner recipe matrix already includes deterministic CRDT rows
  and `live-crdt` rows for WS convergence, RTC with WS fallback, durable
  catch-up, local persistence reopen, and admin HTTP integrity.
- `apps/rallar-black-box-control-server` validates queued commands through the
  shared `rallar-bb-test` schema and stores redacted run artifacts.
- Control-agent identity currently reports principal/session/application/
  workspace/group/provider metadata, but not explicit CRDT runtime capability
  or supported CRDT transports.

## Product Boundary

Supported:

- CRDT operator/admin visibility in `apps/rallar-black-box`.
- CRDT recipe discovery, authoring, preflight, and run diagnostics.
- Browser-agent execution of `crdt.*` commands through the existing shared-test
  command contract.
- Control-server queue, dispatch, result storage, redacted artifact export, and
  distributed-run orchestration for CRDT recipes.

Not supported in these apps:

- A product-facing collaborative document editor.
- A CRDT engine inside `apps/rallar-black-box-control-server`.
- Control-server-specific `crdt.admin.*` APIs.
- Server-side interpretation or mutation of CRDT operation payloads by the
  control server.
- Displaying keys, tokens, encryption key material, ciphertext bodies, or
  unredacted debug/export payloads.

## Implementation Plan

### 1. Improve CRDT Health As Operator Tooling

Keep the existing CRDT Health tab under direct Rallar mode and keep the
`provider=browser-rallar` and login guards.

Tasks:

- Preserve the current admin action set: refresh/list, integrity, debug export,
  backup export, compact, rebuild projection, archive, quarantine, and destroy.
- Show clearer selected-document metadata: document key, lifecycle, rollout,
  update count, snapshot count, last append sequence, updated time, and
  quarantine reason when present.
- Show action status and action failure details in a redacted result panel.
- Add copyable HTTP recipe snippets for admin workflows so the same checks can
  be run through `http.request` recipes.
- Keep destructive actions visually distinct and require the existing selected
  document context before they can run.

Acceptance criteria:

- Operators can list CRDT documents, run integrity/export/lifecycle actions,
  and inspect redacted results from the tab.
- Missing provider mode and missing login produce clear guard messages.
- Admin debug/export results are still redacted before display.

### 2. Surface CRDT Recipes And `live-crdt` In The App

Make CRDT validation easy to find from the Black Box runner mode.

Tasks:

- Surface `live-crdt` as a first-class profile filter in recipe catalog and
  run-manager views.
- Highlight recipe matrix entries with category `rallar-crdt`.
- Add copyable or selectable presets for:
  - WS convergence.
  - `rtc-with-ws-fallback`.
  - durable HTTP late-join catch-up.
  - local persistence reopen.
  - admin HTTP integrity.
- Show required gates inline for CRDT live rows:
  `RALLAR_API_BASE_URL`, Alice/Bob credentials, `RALLAR_ADMIN_ACCESS_TOKEN`,
  `RALLAR_CRDT_DOCUMENT_KEY`, Playwright, WS readiness, RTC readiness, and
  durable catch-up route availability.

Acceptance criteria:

- A user can find all CRDT recipes by filtering for `live-crdt` or CRDT
  category text.
- CRDT recipe details show profile, provider mode, live gates, expected
  artifact name, prerequisites, and copyable run commands.
- The UI does not imply deterministic local rows require live transport.

### 3. Improve CRDT Command Authoring And Result Diagnostics

Use the shared command capability catalog as the source of truth.

Tasks:

- Ensure schema authoring displays every `crdt.*` capability, including
  `crdt.wait`, with provider modes, runtime surfaces, live requirements, and
  artifact expectations.
- Add CRDT command presets or examples for `crdt.open`, `crdt.apply`,
  `crdt.wait`, `crdt.read`, `crdt.health`, and `crdt.close`.
- Show CRDT result summaries for handle, document ref, transport strategy,
  health status, pending count, failed count, dependency-blocked count,
  wait attempts, waited time, and last sync result.
- Preserve the existing redaction pipeline for command results, diagnostics,
  exports, encryption configuration, keys, tokens, and ciphertext.

Acceptance criteria:

- Command authoring can validate and explain representative CRDT commands.
- `crdt.wait` timeouts expose the last value/health/sync result in redacted
  diagnostics.
- CRDT command output remains safe to paste into issue reports.

### 4. Add CRDT Capability-Aware Distributed Targeting

Prevent distributed CRDT runs from targeting browser agents that cannot run
CRDT commands.

Tasks:

- Extend control-agent identity or heartbeat metadata with optional runtime
  capabilities:
  - whether a CRDT runtime is installed.
  - supported CRDT transports such as `local-only`, `ws`, `rtc`,
    `ws-then-rtc`, and `rtc-with-ws-fallback`.
  - provider mode and API base readiness.
- Add this metadata to the SPA control client from the browser runtime state.
- Include the metadata in control-server snapshots and OpenAPI schemas.
- Use the metadata in distributed recipe preflight and target rows to warn or
  block CRDT recipes when an agent lacks CRDT support.
- Keep capability metadata advisory for orchestration only; actual CRDT command
  execution remains browser-agent owned.

Acceptance criteria:

- Connected agents can report CRDT runtime capability without breaking older
  agents that omit the field.
- Distributed CRDT recipes clearly identify missing CRDT runtime, missing
  transport, stale heartbeat, or group mismatch before staging/running.
- Non-CRDT recipes continue to use the existing identity matching behavior.

### 5. Keep The Control Server Provider-Neutral

Harden evidence handling without adding CRDT semantics to the control server.

Tasks:

- Continue validating queued commands through
  `validateRallarBlackBoxTestCommand(...)`.
- Do not parse, merge, compact, or apply CRDT operation payloads in the control
  server.
- Improve artifact event labeling so CRDT diagnostics/results are labeled as
  CRDT evidence rather than generic RTC diagnostics.
- Ensure run artifacts preserve useful CRDT fields after redaction: command
  kind, handle, transport, health summary, wait attempts, wait duration,
  pending counts, failed counts, dependency counts, and last sync status.
- Keep CRDT admin validation as normal `http.request` recipes against the
  Rallar API.

Acceptance criteria:

- The control server can enqueue, dispatch, store, and export `crdt.*` command
  results without special CRDT engine code.
- CRDT artifacts are redacted, labeled as CRDT, and useful for debugging live
  convergence failures.
- Existing HTTP/WS destination restrictions still apply only to commands that
  open external HTTP or WS destinations.

## Test Plan

- UI tests cover CRDT Health provider/login guards, selected-document display,
  admin action status, redacted results, and copyable admin recipe snippets.
- Recipe catalog and run-manager tests cover `live-crdt` filtering, CRDT
  category highlighting, live gate display, and local-only recipe messaging.
- Schema-authoring tests cover representative `crdt.*` commands and validate
  capability summaries for `crdt.wait`.
- Control-agent tests cover capability metadata emission on register and
  heartbeat, including backward compatibility when metadata is absent.
- Distributed recipe tests cover CRDT-capable agents, agents without CRDT
  runtime, missing transport capability, stale agents, and non-CRDT recipes.
- Control-server tests cover enqueue, dispatch, result storage, artifact export,
  and redaction for `crdt.wait` and another representative `crdt.*` command.
- Artifact tests verify CRDT events are labeled as CRDT evidence and include
  useful redacted health/wait diagnostics.
- Existing shared-test CRDT live recipes remain the source of live end-to-end
  validation for WS convergence, RTC fallback, durable catch-up, local
  persistence, and admin HTTP integrity.

## Assumptions

- The shared `rallar-bb-test` command contract remains the source of truth for
  CRDT browser-agent commands.
- `apps/rallar-black-box` is an operator/testing app, not the product CRDT UI.
- `apps/rallar-black-box-control-server` remains provider-neutral and
  orchestration-only.
- Capability metadata is optional and backward compatible for older browser
  agents.
- V1 focuses on health, recipes, preflight, command authoring, and diagnostics;
  a graphical CRDT operation builder is deferred.
- CRDT admin workflows continue to use Rallar API HTTP routes rather than new
  control-server-specific APIs.
