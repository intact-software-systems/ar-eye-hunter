---
name: rallar-testing
description: Use when deciding which Vitest, Deno, Vite, Playwright, package build, or black-box validation commands to run for Rallar package/app changes.
---

# Rallar Testing

## Start Here

Read `references/test-commands.md` when choosing commands. Prefer targeted checks first, then broader builds or suites based on blast radius.

## AppInbox Mutation Gate

- **AppInbox is mandatory for incoming database mutations.** This includes all
  HTTP and WebSocket client/group/topology, authentication/session/ticket, CRDT
  append/admin, and mutating admin paths.
- AppInbox owns the transaction and retry boundary. The service
  `write(transaction, computed)` only applies pure computed persistence data:
  service write receives the transaction and never opens or retries one.
- The received transaction writes state, event, receipt, result, and final
  `APP_OUTBOX`/`WS_OUTBOX` rows directly through `ResourceInboxRepository`.
  There is no intermediate mutation outbox. Authoritative contracts use
  mandatory fields by default.
- Resource-inbox verification preserves 20 total processing attempts: 1, 2, 4,
  8, and 16 ms for attempts one through five, increasing seconds capped at 30
  seconds with jitter, plus a distinct best-effort fairness lane for retries
  more than 30 seconds overdue.
- Queue locks are coordination-only. Tests must reject domain row, table,
  advisory, and CRDT document locks as substitutes for conditional writes.
  Deadline, sunk-cost, or authority pressure never justifies weakening or
  skipping a required verification gate.

## Selection Rules

- Shared contracts: run the relevant `packages/tests/shared*` Vitest files and the package `tsc`.
- When shared state contracts, mandatory fields, repository interfaces, or
  service composition/signatures change, native-check every affected reusable
  `scripts/perf/**` consumer and smoke the relevant executable harness.
  An unchanged historical artifact hash proves preservation, not that current
  HEAD can reproduce it.
- Scoped storage-key changes: prove exact canonical keys and pairwise
  non-collision for absence, valid sentinels, delimiters, percent/lookalikes,
  every derived child key, prefix/list behavior, and repository isolation;
  include live Postgres when the keys guard authoritative shared state.
- Authoritative scoped-read changes: seed wrong-scope or wrong-slot values
  directly and prove direct, prefix-list, page, event, and compact-receipt reads
  fail as typed invariant corruption rather than returning misses, filtering,
  rewriting, or guessing. Cover every decoded application/workspace/group and
  principal/session/request slot at memory and live database boundaries.
- Authoritative transaction changes: force an outbox-key collision and prove a
  typed failure rolls back state, receipt, event, and outbox without a winner
  read. For group/summary phase changes, assert explicit read, compute,
  validate, write, transaction, conflict, and backoff timing as applicable,
  including replay paths that skip write and transaction.
- API-v1 client, group, topology, runtime-state, or database-concurrency work:
  run focused tests first, then the unweakened
  `npm run test:api-v1:black-box:postgres:medium-scale` gate. It means 100
  independently authenticated clients, five groups, two Postgres-backed API
  processes, 10 client lanes plus 5 control lanes. Never reduce these constants,
  the operation matrix, or its assertions to make a change pass.
- A mutation-path or concurrency-domain change also requires
  `npm run perf:api-v1:state-write` and the comparative result gate implemented
  by `node scripts/perf/compare-api-v1-state-write-results.mjs`.
- Browser facade changes: include `packages/tests/shared-web` and app builds if game apps consume the surface.
- Server/middleware changes: include `packages/tests/shared-server`, Deno checks for API apps, and focused restart/routing tests when relevant.
- REST API additions or behavior changes: add or update Rallar black-box recipes/tests in `packages/shared-test/black-box-runner` alongside the API change, then run the focused black-box command when its required services are available.
- Game changes: include the game app test/build and package tests for shared game/motion/rules code.
- Black-box runner changes: include `packages/tests/shared-test` and the relevant rallar-black-box Playwright config only when needed.
- Repo skills and active routing: after changes to `.agents/skills/**`,
  `.codex-plugin/plugin.json`, active Rallar docs/examples, or root skill/config
  routing, run
  `npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts packages/tests/repo/repo-code-style-integrity.test.ts packages/tests/repo/repo-style-check.test.ts packages/tests/repo/repo-style-layout-rules.test.ts`.

## UI Behavior Rule

When UI behavior changes, acceptance requires a Playwright test that operates visible controls a human would use and verifies resulting browser/app state. Query-string setup is allowed for deep-link or bootstrap contract tests, but it cannot be the only proof for a human-facing workflow. For popups, auth, storage, realtime, downloads, or navigation, verify the resulting state: URL cleanup, localStorage/sessionStorage, network requests, visible status, session IDs, connected agents, or artifacts.

## Plan Completion Gate

Focused tests are feedback, not a substitute for completion gates. Before a
written implementation plan can be approved or marked complete, apply this
rule: Run the commands from the final uncommitted working tree before
publication:

```bash
npm run test:unit
npm run test:ci
npm run build
```

Any change after a successful gate invalidates that gate. Keep the draft pull
request current, then require **Branch Release Gate** to pass for the final
feature-branch commit and **Run Hetzner Supported Distributed Manifests** to
pass for the resulting default-branch commit. Record the exact commit SHA for
each result. Do not approve completion: the plan is not complete while any
required command or workflow is pending, skipped, failed, or attached to an
older commit. An instruction not to commit or push postpones publication but
does not waive these completion gates.

## Reporting

Always say exactly which commands passed, failed, or were skipped. If a build emits known large-chunk warnings but exits zero, report it as pass with warning.
