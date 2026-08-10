---
name: rallar-testing
description: Use when deciding which Vitest, Deno, Vite, Playwright, package build, or black-box validation commands to run for Rallar package/app changes.
---

# Rallar Testing

## Start Here

Read `references/test-commands.md` when choosing commands. Prefer targeted checks first, then broader builds or suites based on blast radius.

## AppInbox Mutation Gate

Read
`.agents/skills/rallar-code-writing/references/convergent-service-writing.md`
before choosing tests for authoritative database or realtime mutations. Its
verification section defines the required decision, conflict, retry,
idempotency, corruption, and final-convergence behaviors. Focused tests must
exercise the real conditional-write boundary; lock acquisition or waiting is
not an acceptance criterion.

## Selection Rules

- Use behavior-named test modules. Historical task numbers, correction waves,
  and implementation chronology do not tell a developer which behavior failed.
- Semantic tests are primary. Source inventories, exact-tree checks, string
  assertions, and line/count ratchets are supplementary and temporary, with a
  named owner and removal condition. For a materially changed callback,
  transaction, retry, protocol, or lifecycle family, assert semantic behavior
  at the entry, transaction, commit return, after-commit, failure, cleanup, and
  final result boundaries.

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

## Plan Completion Gate

Plan-only branches do not wait for local or Branch Release Gate builds. This
exception applies only when every changed path is an implementation-plan or
agent-guidance path excluded by `.github/workflows/branch-release-gate.yml`.
Branch Release Gate remains required for branches that change code, workflows,
scripts, tests, or plugin metadata.

Focused tests are feedback, not a substitute for completion gates. Before a
build-affecting written implementation plan can be approved or marked
complete, apply this rule: Run the commands from the final uncommitted working
tree before publication:

```bash
npm run test:unit
npm run test:ci
npm run build
```

Any change after a successful gate invalidates that gate. For build-affecting
implementation plans, keep the draft pull request current, then require
**Branch Release Gate** to pass for the final feature-branch commit and **Run
Hetzner Supported Distributed Manifests** to pass for the resulting
default-branch commit. Record the exact commit SHA for each result. Do not
approve completion: the plan is not complete while any required command or
workflow is pending, skipped, failed, or attached to an older commit. An
instruction not to commit or push postpones publication but does not waive
these completion gates.

## Reporting

Always say exactly which commands passed, failed, or were skipped. If a build emits known large-chunk warnings but exits zero, report it as pass with warning.
