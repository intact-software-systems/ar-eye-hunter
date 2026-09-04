---
name: rallar-testing
description: Use when creating, modifying, reviewing, diagnosing, replacing, or deleting Rallar tests, mocks, fixtures, test support, or validation commands.
---

# Rallar Testing

## Start Here

Read `references/test-commands.md` when choosing commands. Prefer targeted checks first, then broader builds or suites based on blast radius.

`adaptive-plan-execution` owns working-plan and proportional-validation judgment.

## Semantic Test Design Gate

Before writing or retaining a test:

1. Name the independent production break the test must catch.
2. Exercise the lowest stable public or owned boundary that proves that break.
3. Assert return values, errors, public state readback, artifacts, visible state,
   or effects captured at an owned external port.
4. Derive expectations independently of production helpers, builders, and
   catalogs.
5. Require behaviorally equivalent implementations to pass unchanged.
6. Reuse, merge, replace, or delete coverage so each retained test protects a
   distinct behavior or risk. Prefer fewer complete tests over overlapping
   examples.

Call count, absence, or order is evidence only when the interaction itself is
the requirement: retry policy, idempotency, cache suppression, exactly-once
effects, or prescribed protocol order. State the independently observable
failure and assert at the owned port. If the coupling checker reports it, use a
narrow `interaction` boundary whose semantic contract explains why that count,
absence, or order is required. An ordinary outbound payload assertion such as
`toHaveBeenCalledWith` is permitted at an owned port; it does not by itself pin
invocation topology. Permission does not earn the assertion a place: retain it
only when the payload is itself an independent contract that the result or
captured effect does not already prove.

When a test fails after a structure-only production change, classify the
failure before editing production. If public behavior and independent contracts
still hold, delete the obsolete test or replace it with semantic coverage.
Never reshape production code to restore private helper calls, sequence,
timing, asset names, or other incidental topology.

## AppInbox Mutation Gate

Read
`.agents/skills/rallar-code-writing/references/convergent-service-writing.md`
before choosing tests for authoritative database or realtime mutations. Its
verification section defines the required decision, conflict, retry,
idempotency, corruption, and final-convergence behaviors. Focused tests must
exercise the real conditional-write boundary; lock acquisition or waiting is
not an acceptance criterion.

For `strict-domain-write` package or API transaction writes, prove the persistence-ready
value is completed before transaction entry, even when work is cheap or
winner-only. Prove one mutation attempt per delivery, full read/compute/validate
re-entry on outer QueueBox redelivery, and no handler or persistence-helper
inner retry. Inside-transaction refinement must start from actual
database-returned facts; PostgreSQL business semantics remain a human review.

For an affected exact PostgreSQL ResourceInbox, Results, or QueueBox owner,
test bounded reservation, replay, replacement, rollback, and
winner-only invocation directly. Prove that the exact guarded winner
materializer is never invoked for a losing or replay branch, is invoked once for
the winner, and rolls back its placeholder when materialization or replacement
fails. Cover its authorized bounded winner-only clock capture, identifier
generation, serialization, and final-row construction; do not assert that the
strict precomputable-work grammar governs this exact specialized callback.
Reject lease, heartbeat, polling, arbitrary callback, external-effect,
unbounded-work, caller-mutation, and unrelated nested-transaction variants in
semantic tests. Maintain PostgreSQL and PGlite parity, and run the
focused real PostgreSQL integration tests whenever specialized SQL or its
transaction semantics change. Browser IndexedDB readwrite and initial
versionchange schema-creation tests continue to prove strict
persistence-ready-before-entry behavior; incompatible existing schemas fail
closed without a schema rewrite.

When authoritative mutation control flow changes, run
`npm run check:repo-style:navigation-details` for the affected roots and perform
the manual 5/5 cold probe from concrete registration through operation entry,
policy, first write guard, durable result, and after-commit effect. Navigation
details remain observational, but the changed-range gate rejects new or worsened
high-confidence registration-indirection and unnamed-deferred-edge findings.
Legitimate and unknown/manual classifications remain non-blocking. An analyzer
execution failure or a landmark that remains unreachable after consolidation
fails validation.

## Selection Rules

- Use behavior-named test modules. Historical task numbers, correction waves,
  and implementation chronology do not tell a developer which behavior failed.
- Semantic tests are primary. Source inventories, exact-tree checks, string
  assertions, and line/count ratchets are supplementary and temporary, with a
  named owner and removal condition. For a materially changed callback,
  transaction, retry, protocol, or lifecycle family, assert semantic behavior
  at the entry, transaction, commit return, after-commit, failure, cleanup, and
  final result boundaries.
- Production code is the primary design artifact; tests are secondary evidence.
  Tests protect independently stated observable behavior, public contracts,
  safety and correctness invariants, and approved architecture boundaries. They
  do not own incidental file trees, helper names, call order, line counts,
  migration history, or implementation topology. Classify a failure as a
  production regression or obsolete test coupling before changing production;
  never restore inferior production structure merely to make a coupled test
  pass.

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
  independently authenticated clients, five groups, three Postgres-backed API
  processes, 10 client lanes plus 5 control lanes. Never reduce these constants,
  the operation matrix, or its assertions to make a change pass.
- API-v1 black-box topology: memory mode manages one API process. Built-in
  Postgres cluster profiles manage three Deno API processes sharing one Postgres
  database on ports 18080, 18081, and 18082. Their isolated logs are
  `api-v1-server.log`, `api-v1-server-secondary.log`, and
  `api-v1-server-tertiary.log`; recipes-only mode is externally managed.
  Standard/default, CRDT, and medium-scale cluster recipes must make node C
  meaningful. See `references/test-commands.md` for the commands, artifacts,
  and failure-triage expectations.
- RTC topology stream, cursor, replay, reconnect, retention, or cutover work:
  also run the dedicated
  `npm run test:api-v1:black-box:postgres:topology-replay` gate. It keeps A/B
  active, makes C passive, requires poll-only N5/N6 convergence, then proves
  same-session current hydration through a new C' process identity. Never
  replace this semantic proof with log counts.
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
  routing, run `npm run test:repo-governance`.

## UI Behavior Rule

When UI behavior changes, acceptance requires a Playwright test that operates visible controls a human would use and verifies resulting browser/app state. Query-string setup is allowed for deep-link or bootstrap contract tests, but it cannot be the only proof for a human-facing workflow. For popups, auth, storage, realtime, downloads, or navigation, verify the resulting state: URL cleanup, localStorage/sessionStorage, network requests, visible status, session IDs, connected agents, or artifacts.

## Reporting

Always say exactly which commands passed, failed, or were skipped. If a build emits known large-chunk warnings but exits zero, report it as pass with warning.
