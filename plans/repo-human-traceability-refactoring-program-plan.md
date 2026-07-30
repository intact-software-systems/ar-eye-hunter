# Repository Human Traceability Refactoring Program Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement an approved child plan task by
> task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the repository navigable by a human who follows filenames,
folders, dataflow, callers, and callees, while incrementally bringing existing
TypeScript into compliance with the repository coding standard.

**Architecture:** Organize production and test code by owned feature first and
by responsibility second. Preserve the existing package boundaries, establish
one explicit browser `room` to authoritative server `group-state` translation
boundary, and migrate one complete vertical feature slice at a time. Separate
behavior-preserving file moves from semantic code-standard changes so reviewers
can distinguish relocation from behavior changes.

**Tech Stack:** TypeScript, Deno, Node.js/npm workspaces, Hono, Vitest,
Playwright, PostgreSQL/PGlite, Markdown, the warning-only repository style
checker, and Git rename detection.

## Global Constraints

- The authoritative TypeScript standard remains
  `.agents/skills/rallar-code-writing/references/repo-code-style.md`.
- The standard applies repo-wide to `apps/**`, `packages/**`, `scripts/**`,
  examples, tests, and support tooling.
- New and changed code follows the standard. Existing violations are debt, not
  precedent.
- Keep `packages/shared`, `packages/shared-web`, `packages/shared-server`,
  `packages/shared-graph`, `packages/shared-test`, and `packages/tests` in their
  current runtime and ownership roles.
- Organize by feature or owned capability before technical role. Do not replace
  broad `services`, `types`, or `repositories` folders with broad
  `translators`, `factories`, or `interfaces` folders.
- `room` is the product and browser term. `group-state` is the authoritative API
  and server term. Translation between them occurs at one explicitly named
  browser boundary.
- Established protocol identity names such as `GroupRef` and `roomRef` remain
  unchanged unless a separately approved public-contract plan changes them.
- Preserve public exports, import paths, OpenAPI contracts, persisted formats,
  and behavior unless a child plan explicitly identifies and receives approval
  for a compatibility or breaking change.
- Incoming HTTP and WebSocket database mutations continue through AppInbox.
  AppInbox owns transaction and retry behavior, with visible `read`, `compute`,
  `validate`, and `write(transaction, computed)` phases.
- Authoritative persisted, replicated, queued, event, snapshot, receipt,
  result, and response fields remain mandatory by default.
- Checker additions remain warning-only. This program does not introduce
  strict mode or a CI-blocking style gate.
- Do not run a repository-wide formatter, filename rewrite, optional-field
  rewrite, `type`-to-`interface` rewrite, or automated semantic codemod.
- Preserve unrelated working-tree changes and stage only files belonging to the
  active child plan.
- A plan or milestone is not complete until its required focused checks and the
  repository completion and publication gates have passed on the exact final
  code.

---

Date: 2026-07-28

Status: Reviewed and approved for child-plan drafting. The program documents are
published on `main`. The governance and checker child was approved at blob
`8ee56ac27189f9bed751fb6a95992830bda6be60` and is `ledger-published`. The
[browser room/group-state translation-boundary child](rallar-room-group-state-translation-boundary-plan.md)
was approved at Git blob
`37861202ce25c3cd5832663a5a3f6d7e2e4a0e4e` subject only to its explicitly
recorded narrow amendments. Structure/boundary Tasks 0 through 5 are
implemented in draft PR #53; Task 6 final review, immutable-tree verification,
publication gate, and human merge decision remain pending. The alignment pass
has not started.

Program drafting, approval, execution, publication, and human handoffs follow
the [Repository Human Traceability Program Execution Plan](repo-human-traceability-program-execution-plan.md).
That execution protocol does not itself approve any child plan.

Approved execution decision on 2026-07-28:

- A public structural move may use one temporary compatibility re-export hop.
  Every concrete shim still requires explicit human approval in its child plan,
  must name the supported consumers, and must include a removal condition.
- The first browser room migration preserves the existing
  `RallarRoomsFacade` public return-type compatibility. Product-named public room
  contracts require a separate breaking-release plan and approval.
- A migration that crosses a public boundary, spans multiple packages, or
  touches more than approximately 20 files normally uses two pull requests:
  structure first, then code-standard alignment. A smaller private migration
  may use one pull request with clearly separated commit series for those two
  passes.

Publication and progress reconciliation on 2026-07-28:

- The initial direct program-document publication resolved to
  `4ec117db1e09e00f86ed8f66cbf8adab1cdeb4a9`
  (`docs: add human traceability execution plans`).
- That commit has tree `ea05be8881303557ec9ec8f7951bbef76a4922fc`,
  parent `95065d769f585464b15059423057e151877fdb1a`, and adds only this
  master plan, the execution plan, and the governance/checker child plan:
  2,787 inserted lines across three new Markdown files. It has no associated
  pull request.
- Parent `95065d769f585464b15059423057e151877fdb1a` is the merge commit
  for GitHub PR #45. It published the primary human-understandability principle
  in `AGENTS.md`, the code-writing skill, the canonical code standard, the
  human review guide, and their integrity test. It did not add the Wave 0
  organization/naming sections or checker behavior.
- For `4ec117db1e09e00f86ed8f66cbf8adab1cdeb4a9`, GitHub Actions run
  `30328273160` (**Push on main**) and run `30328273405`
  (**Deploy Web + API**) passed. Run `30328273358`
  (**Run Hetzner Supported Distributed Manifests**) failed. Direct publication
  is therefore verified, but the required default-branch completion workflow
  is not green for that commit.
- GitHub's combined commit status also reports failures for
  `deploy/intact-software-systems/rallar-bb-server`,
  `deploy/intact-software-systems/relic-hunters`, and
  `deploy/intact-software-systems/rallar-server`. This documentation-only
  reconciliation records but does not diagnose those deployment failures.
- Wave 0 Tasks 1 through 5 were implemented and published through
  `55469829af67eabdc692ab4e9823c0e26fabb40b`. Final integration produced
  immutable feature tree `47a885540b60765a1a0c95089902a0371e0a7f2b` and
  feature SHA `a986931c250c2f1fa12daa3e8d44a74669b178ed`. Branch Release
  Gate run `30362667041` attempt 2 passed for that exact feature SHA. Human-
  approved PR #47 merged as
  `4f98f241aefe62c89288e29403ba7f1f23897625`, and **Run Hetzner
  Supported Distributed Manifests** run `30367222275` attempt 1 passed for
  that exact resulting `main` SHA. The governance/checker implementation
  therefore reached `complete`.
- The separate governance evidence ledger has tree
  `94270ad17f7f68eaa9b95529764c23a844514ae9`, feature SHA
  `c4743acd9fc685292f9fa6a7508d0a08afe05fd6`, successful Branch Release
  Gate run `30371906927` attempt 1, and PR #51. It merged as exact `main` SHA
  `7a6c8e0c2cfb3413b4c0fbaaf0af31af2571c015`; **Run Hetzner Supported
  Distributed Manifests** run `30407710853` attempt 1 passed for that exact
  SHA. The governance/checker child is therefore `ledger-published`, and the
  browser child may be reviewed for separate approval.

## 1. Why This Is A Program Instead Of One Refactor

The repository contains several different kinds of debt:

1. mechanical naming and formatting debt;
2. physical structure and co-location debt;
3. responsibility and call-stack indirection debt;
4. contract and optionality debt;
5. failure-flow, side-effect, and functional-dataflow debt;
6. public API, OpenAPI, persistence, and compatibility debt.

Those categories do not have the same risk. Renaming a private file and updating
its imports is different from making an optional authoritative field mandatory
or replacing exception flow with `Either`. Combining them in one repository-wide
change would make review unreliable and regressions difficult to diagnose.

The unit of migration is therefore one owned feature flow, not one file and not
the whole repository. A feature flow includes its boundary, contracts,
orchestration, pure decisions, persistence or transport adapters, public exports,
and matching tests.

Each feature migration receives a focused child implementation plan. The child
plan records exact current and target files, public compatibility decisions,
behavior characterization, focused commands, and completion evidence. This
master plan governs the order and rules shared by those child plans.

## 2. Current Navigation Baseline

The planning audit found these high-signal examples:

| Area                                                |               Current shape | Navigation consequence                                                                                   |
| --------------------------------------------------- | --------------------------: | -------------------------------------------------------------------------------------------------------- |
| `packages/shared-server/rallar-system/services`     | 102 direct TypeScript files | Auth, group-state, CRDT, AppInbox, topology, RTC, and WebSocket responsibilities are siblings.           |
| `packages/shared-server/rallar-system/repositories` |  27 direct TypeScript files | Repository contracts, implementations, storage keys, assembly, and exact reads are mixed.                |
| `packages/shared-web/browser`                       |  43 direct TypeScript files | Facades, browser stores, middleware, transport, and feature behavior are mixed.                          |
| `packages/shared-web/browser/rallar-runtime`        |  23 direct TypeScript files | The same capability nouns appear both at browser root and under runtime.                                 |
| `apps/api-v1/src/routes`                            |              13 route files | Large feature routes mix decoding, defaults, authorization, commands, reads, result mapping, and errors. |
| `apps/api-v1/src/services`                          |  17 direct TypeScript files | Factories, auth, middleware, configuration, startup, and services share one layer folder.                |
| `packages/tests/shared-server`                      | 196 direct TypeScript files | Production features and their tests do not have matching navigable paths.                                |
| `packages/shared-test/rallar-bb-test`               |  67 direct TypeScript files | Distributed run, fleet, artifact, browser, and control concerns are mixed.                               |

Using the warning checker's filtered production source set, 215 TypeScript files
are over 400 physical lines, 162 are over 500, and 97 are over 800 in the
2026-07-28 planning baseline. These counts are review inventories, not commands
to split files mechanically or to register every legacy hard-tier file.

Important current hotspots include:

- `packages/shared-server/rallar-system/services/group-state-mutations.ts` at
  more than 4,200 lines;
- `packages/shared-server/rallar-system/services/AppGroupInboxService.ts` at
  more than 1,700 lines while also owning topology and RTC RTT behavior;
- `packages/shared-server/rallar-system/services/group-state-service.ts` at
  more than 1,200 lines;
- `apps/api-v1/src/routes/group-state-routes.ts` at more than 1,200 lines;
- `packages/shared-web/browser/rallar-runtime/rooms.ts` at more than 1,000
  lines;
- `packages/shared-web/browser/api-workflows.ts` at more than 1,000 lines.

The repository already contains useful internal phase boundaries. For example,
group-state mutation processing has a direct `read`, `compute`, `validate`, and
`write` sequence. The first objective is to expose those existing boundaries in
the filesystem before redesigning behavior.

`packages/shared-graph` is a useful relative example: it already uses feature
folders such as `graph`, `mesh`, `tree`, `crdt`, and `repository`, and has far
fewer oversized files. The program should reuse that feature-first principle,
not mechanically copy every folder name.

## 3. Canonical Vocabulary Boundary

### 3.1 Product and browser language

Browser product APIs use these nouns:

- room;
- room member;
- room presence;
- room state;
- room event;
- current room.

New browser-facing filenames, symbols, and documentation use `room`, not
`group`, when describing the product capability.

### 3.2 Authoritative API and server language

Authoritative HTTP, AppInbox, domain service, persistence, event, and snapshot
code uses these nouns:

- group-state;
- group member;
- group presence;
- group-state mutation;
- group-state event;
- group-state snapshot.

Avoid the mixed term `state group` in new code. Use `group-state` for the
authoritative capability and `GroupStateXxx` for its symbols.

### 3.3 The single translation boundary

The target browser boundary is:

```text
packages/shared-web/browser/rooms/room-group-state-translation.ts
```

This module owns pure translations between browser room inputs/views and
authoritative group-state request/response contracts. Its primary exports use
the canonical `toXxx` vocabulary, for example:

```ts
interface ToCreateGroupStateRequestInput {
  readonly roomInput: RallarCreateRoomInput;
  readonly principalId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly requestId: string;
}

function toCreateGroupStateRequest(input: ToCreateGroupStateRequestInput): CreateGroupRequest;

function toRallarRoomSummary(snapshot: GroupSnapshot): RallarRoomSummary;
```

The boundary is one conceptual module. If it exceeds the 400-line review
threshold, it may become a `room-group-state-translation/` folder with one
same-named entry file and responsibility-specific `to-*` modules. Callers still
enter through that single named boundary.

During migration, existing direct `GroupSnapshot` use in the browser is recorded
as compatibility debt. The first room migration preserves the current
`RallarRoomsFacade` return-type compatibility. A child plan that wants to retain
a compatibility alias or re-export must request human approval and state its
removal condition. Product-named public room contracts and changes to the facade
return types require a separate breaking-release plan.

## 4. Target Repository Shape

The package boundaries remain stable. Their internal first-level organization
becomes feature-oriented.

```text
packages/shared/api/
  auth/
  client-state/
  group-state/
  topology/
  admin/

packages/shared-server/rallar-system/
  app-inbox/
  auth/
  client-state/
  crdt/
  group-state/
  rtc-topology/
  topology/
  websocket/
  admin/

packages/shared-web/browser/
  composition/
  auth/
  calls/
  crdt/
  data/
  director/
  media/
  messages/
  people/
  realtime/
  rooms/
  rtc/
  websocket/

packages/shared-test/
  black-box-runner/
    api-v1-state-write/
    artifacts/
    browser/
    providers/
    scenarios/
  rallar-bb-test/
    artifacts/
    browser/
    control/
    distributed-run/
    fleet/
    recipes/

apps/api-v1/src/
  composition/
  auth/
  client-state/
  crdt/
  group-state/
  rtc-topology/
  topology/
  admin/
  database/
  websocket/

packages/tests/
  shared/
    <matching shared feature>/
  shared-web/
    <matching browser feature>/
  shared-server/
    <matching server feature>/
  shared-test/
    <matching test-tool feature>/
```

This is a target vocabulary map, not an instruction to create every directory
up front. A directory is created when its first migrated feature needs it.
Empty architecture scaffolding is not added.

### 4.1 Target group-state server shape

```text
packages/shared-server/rallar-system/group-state/
  group-state-service.ts
  group-state-service-contracts.ts

  inbox/
    group-state-inbox-handler.ts
    group-state-inbox-contracts.ts

  mutation/
    group-state-mutation-contracts.ts
    read-group-state-mutation.ts
    compute-group-state-mutation.ts
    validate-group-state-mutation.ts
    write-group-state-mutation.ts

  persistence/
    group-state-repository.ts
    group-state-storage-keys.ts
    group-state-runtime-namespaces.ts
    read-exact-group-state-mutation.ts
    read-group-state-authority.ts
    assemble-group-state-snapshot.ts
    group-state-write-descriptors.ts

  presence/
    group-presence-service.ts
    group-presence-summary-work.ts
    reconcile-expired-group-presence.ts

  snapshot/
    group-state-snapshot-cache.ts
    validate-group-state-snapshot.ts
```

`AppGroupInboxService` must not remain the owner of topology configuration and
RTC RTT mutation behavior merely because those messages currently arrive
through the same queue infrastructure. AppInbox supplies infrastructure;
group-state, topology, and RTC topology own their respective decisions.

### 4.2 Target API-v1 group-state shape

```text
apps/api-v1/src/group-state/
  register-group-state-routes.ts
  group-state-read-routes.ts
  group-state-mutation-routes.ts
  group-membership-routes.ts
  group-presence-routes.ts
  to-group-state-command.ts
  to-group-state-response.ts
  group-state-route-errors.ts
```

`registerGroupStateRoutes` is the obvious entry point. It contains route
registration, not domain behavior. Route modules expose the boundary sequence
directly: decode and default, authenticate, translate, submit or read, and map
the response.

### 4.3 Target browser room shape

```text
packages/shared-web/browser/rooms/
  rallar-rooms-facade.ts
  browser-rallar-rooms.ts
  room-group-state-translation.ts
  room-state-store.ts
  room-events.ts
  room-presence.ts
  create-and-join-room.ts
  update-room.ts
```

The current facade/controller/operations forwarding chain is reviewed during
this migration. A public facade is allowed as a real package boundary, but a
wrapper that only forwards every call to another object should be collapsed or
made the actual owner of a boundary decision.

### 4.4 Target API-v1 composition shape

```text
apps/api-v1/src/composition/
  create-rallar-server.ts
  create-default-rallar-server.ts
  create-api-v1-runtime.ts
  create-group-state-runtime.ts
  create-realtime-runtime.ts
  create-admin-runtime.ts
  register-api-v1-routes.ts
  start-api-v1-background-work.ts
```

`createRallarServer(input)` receives required dependencies.
`createDefaultRallarServer()` reads validated application configuration,
constructs the default dependencies, and calls `createRallarServer(input)`.
Defaults, environment reads, and service selection stay visible in this
composition folder.

## 5. Co-location And Ownership Rules

| Artifact                                                              | Owning location                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| OpenAPI request/response schema                                       | `apps/api-v1/resources/api-v1-openapi.yaml`                              |
| Cross-runtime HTTP DTO                                                | `packages/shared/api/<authoritative-feature>/`                           |
| Browser product input/view                                            | `packages/shared-web/browser/<product-feature>/`                         |
| Browser-to-authoritative translation                                  | The named product/authoritative translation boundary                     |
| Command, `Read`, `Computed`, validation issue, and `Written` contract | Beside the use case or service that owns the phase sequence              |
| Persistence record, storage key, exact read, and snapshot assembly    | `<feature>/persistence/`                                                 |
| Explicit-dependency service factory                                   | Beside the concrete service                                              |
| Production-default factory                                            | Application `composition/`                                               |
| Route request-to-command translation                                  | API feature folder beside its routes                                     |
| Route error-to-response translation                                   | API feature `*-route-errors.ts`                                          |
| Private one-use interface                                             | Same file as its behavior                                                |
| Intentionally shared exported contract                                | Named feature contract file, exported through the package boundary       |
| Tests and test support                                                | Mirrored feature path under `packages/tests` or the owning app test tree |

Do not create global `interfaces`, `types`, `translators`, `factories`,
`helpers`, or `utils` directories. Those names identify an implementation
artifact, not an owner.

## 6. File And Symbol Naming Rules

The program adds these rules to the canonical standard before production moves
begin:

- TypeScript filenames use kebab-case, including files whose primary export is
  a class.
- A file's basename matches its primary exported class, function, interface, or
  capability after mechanical Pascal/camel-to-kebab conversion.
- Action modules are verb-first and match the canonical function vocabulary:
  `read-group-state-mutation.ts`, `compute-group-state-mutation.ts`,
  `validate-group-state-mutation.ts`, and `write-group-state-mutation.ts`.
- Route registration functions are descriptive, such as
  `registerGroupStateRoutes`, rather than generic exports named `init`.
- Lifecycle functions may use `init`, `start`, and `stop` only with the owned
  capability in the full name.
- Generic filenames such as `utils.ts`, `types.ts`, `helpers.ts`,
  `contracts.ts`, `runtime.ts`, and `middleware.ts` require a feature noun and
  role, for example `group-state-service-contracts.ts` or
  `api-v1-http-middleware.ts`.
- Historical implementation names such as `task10-*` and `*-correction-17`
  are replaced with the behavior or invariant the test proves when that test
  feature is migrated.
- Established abbreviations such as API, CRDT, HTTP, RTC, SQL, URL, WebSocket,
  and WS are allowed. Local abbreviations such as `svc`, `mgr`, `cfg`, `ctx`,
  `req`, `res`, `grp`, and `proc` are not introduced in public or domain names.
- `mod.ts` remains a package compatibility boundary. Do not add nested barrels
  merely to shorten imports.
- Internal code imports the owning file directly. Public package consumers use
  the intentional package entry point.

Directory review heuristics:

- More than 20 direct production TypeScript files prompts a folder ownership
  review.
- Four or more sibling files with the same meaningful feature prefix prompts a
  feature-folder review.
- A new one-file folder requires a real public or runtime boundary; do not add
  folders for visual symmetry.
- Prefer `feature/subfeature/file.ts` and avoid deeper nesting unless the
  additional level removes a genuine mixed responsibility.
- Every feature folder has one obvious starting file named for the feature's
  public service, facade, or route-registration function.

These are review signals, not reasons for mechanical pass-through modules.

## 7. How Existing Standard Violations Are Migrated

### 7.1 Classify before changing

Every finding in an active feature receives one of these classes:

| Class       | Examples                                                                          | Required treatment                                                    |
| ----------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Mechanical  | formatting, import groups, kebab-case filename, generic local variable            | Change only in the active feature; format touched files.              |
| Structural  | feature folder, file split, co-location, primary-symbol filename                  | Characterize behavior first; move without semantic changes.           |
| Semantic    | required fields, defaults, function vocabulary, `Either`, purity, state ownership | Separate test-driven change after structural moves are stable.        |
| Contractual | public API, OpenAPI, persisted value, event, queue, snapshot, response            | Separate approved child plan with producer and consumer migration.    |
| Operational | transaction, retry, concurrency, environment/configuration, background lifecycle  | Separate high-risk child plan with integration and performance gates. |

Automated tools may perform mechanical formatting and import updates after a
human has selected the exact feature scope. Automated tools must not decide
whether optionality is meaningful, where a responsibility belongs, whether a
failure is expected, or whether an abstraction should exist.

### 7.2 Use a two-pass feature migration

Large, public, or cross-package features use two independently reviewable pull
requests. Features touching more than approximately 20 files are considered
large unless the child plan explains why the files form one smaller review
unit. Smaller private features may use two clearly separated commit series on
one feature branch and pull request:

1. **Structure pass**
   - add characterization and public-surface tests;
   - move files into the target feature tree;
   - rename files and primary symbols;
   - split oversized files only along existing behavior boundaries;
   - update direct imports and mirrored test locations;
   - preserve behavior and contracts;
   - inspect the diff with rename detection.
2. **Code-standard pass**
   - make defaults visible at boundaries and composition roots;
   - replace optional internal contracts with complete stage contracts;
   - apply `interface` versus `type` rules;
   - make `read`, `compute`, `validate`, and `write` phases explicit;
   - replace expected exceptions with `Either` or validation issues;
   - normalize runtime exceptions at side-effect boundaries;
   - remove pass-through helpers and wrapper-only modules;
   - apply the canonical 40/50/60 general-function review and the file-size
     tiers before extracting code;
   - reduce files, functions, and handlers over their review thresholds only at
     coherent responsibility boundaries;
   - rerun behavior, contract, and integration tests.

Do not hide semantic rewrites inside a rename-only change. Do not postpone all
semantic cleanup indefinitely either: a feature is not marked standard-compliant
until its second pass is complete.

### 7.3 Ratchet new work

While legacy migration proceeds:

- all new files follow the target feature tree and naming rules;
- a touched over-400-line file may not grow without explicit human approval;
- a materially touched over-800-line file or over-60-line function is refactored
  at a coherent boundary or recorded in the repo code-style exception registry;
- a change that materially touches two responsibilities splits them;
- new public optional fields require documented domain absence;
- new production defaults are placed in OpenAPI or typed application
  composition, never in a deep helper;
- an active feature may not add new warnings to its recorded structural and
  code-style baseline;
- unrelated files are not cleaned merely because they are nearby.

This prevents the migration target from moving away while avoiding a giant
repository rewrite.

## 8. Warning-Only Tooling Additions

Extend `scripts/repo-style-check.mjs` through a focused
`scripts/repo-style-check/layout-rules.mjs` module. The checker remains
non-blocking and reports:

- production directories with more than 20 direct TypeScript files;
- flat directories containing at least four files with the same meaningful
  feature prefix;
- mixed PascalCase/camelCase/kebab-case TypeScript filenames;
- generic production filenames lacking a feature noun;
- generic route registration exports named only `init`;
- `mod.ts` files outside approved package boundaries;
- likely mismatch between a filename and its primary exported symbol;
- browser room modules that directly construct authoritative group-state
  requests outside `room-group-state-translation.ts`;
- server group-state modules that introduce the product noun `room` outside an
  established protocol identity or explicit boundary adapter.

The primary-symbol mismatch and room/group-state vocabulary checks start
opt-in because syntax and protocol exceptions can make them noisy. Tests,
fixtures, and mocks remain excluded from the default checker; task-history test
filenames are handled by human review during the mirrored-test migration.
Checker output must explain that folder-size and prefix-cluster findings are
ownership review prompts, not automatic instructions to create folders.

Strict mode remains unavailable until the human separately approves it after:

- a sample of 100 warnings, or every warning when fewer exist, has at most a
  five-percent false-positive rate for the candidate blocking rule;
- all actively migrated features have stable focused checks;
- the repository has no unexplained new-warning growth for three consecutive
  completed feature migrations;
- the human decides which subset, if any, should become blocking.

## 9. Compatibility And Import Migration

File moves must distinguish internal and public paths:

- update private/internal direct imports in the same structure pass;
- preserve package `mod.ts` as the public compatibility surface;
- do not create nested re-export chains for internal convenience;
- allow at most one temporary compatibility re-export hop under the approved
  program policy, with each concrete shim explicitly approved in its child
  plan;
- record the old path, consumers, approval, and removal condition in the child
  plan;
- remove an approved shim after all supported consumers use the intended public
  entry point and the removal has separate compatibility approval;
- if compatibility is not approved, leave the public file in place and migrate
  only its private implementation until a breaking plan is approved.

The completed `plans/rallar-shared-web-modularization-iterations-plan.md`
already established browser public-surface snapshots, bundle checks, and narrow
entry points. This program preserves those results and reorganizes the current
domain implementations; it does not reopen the completed bundle-modularization
work without evidence.

## 10. Program Order

### Wave 0: Governance and measurable baseline

Goal: make the target rules reviewable and the debt visible before moving code.

PR #45 supplies the already-published primary-principle prerequisite. It does
not satisfy any checkbox in this Wave 0 implementation list.

- [x] Add repository-organization and filename sections to the canonical code
      standard.
- [x] Extend the human review guide with feature ownership, matching filename,
      and co-location checks.
- [x] Add warning-only layout checks and fixture tests.
- [x] Record baseline counts for directory density, filename style, generic
      filenames, and files over 400 lines.
- [x] Confirm the checker remains non-blocking and strict mode remains rejected.

The executable baseline measured at
`1b8a3bf18fc67f7a893a6c7d9566497bedda99dc` and published through
`55469829af67eabdc692ab4e9823c0e26fabb40b` records 16 dense directories,
22 conservative prefix clusters across 8 directories, 422 filename-style files
across 90 directories, 15 generic filenames, 11 generic route registrations,
zero unapproved `mod.ts` files, and 215 files over 400 physical lines. The
detailed opt-in inventory is 344 primary-export mismatches, 2 browser-room
boundary findings, and zero server group-state vocabulary findings. The
complete checker exited `0` with known warnings, while strict mode remained
unavailable and exited `1`.

An active feature records its focused layout counts before its structure pass.
The pass may reduce them or leave explained legacy debt unchanged; it may not
add an unexplained warning. Repository totals are context, not a reason to
expand the active feature scope.

### Wave 1: Pilot the complete room/group-state flow

Goal: prove the migration method on the highest-value end-to-end navigation
path.

This wave is split into three child plans so each remains reviewable:

1. browser rooms and the explicit room/group-state translation boundary;
2. authoritative shared-server group-state service, mutation, persistence,
   presence, and AppInbox ownership;
3. API-v1 group-state routes, composition, and mirrored tests.

Acceptance requires that a human can start at `RallarRoomsFacade.create`, find
the one room/group-state translation, continue to the API route and AppInbox,
then follow `read`, `compute`, `validate`, and `write` by matching filenames.

### Wave 2: Remaining authoritative mutation domains

Migrate in this order because they already expose strong filename clusters and
share the AppInbox architecture:

1. client-state;
2. auth;
3. group topology configuration;
4. RTC topology and RTT;
5. CRDT mutation and administration;
6. mutating admin operations.

Each child plan must preserve the existing AppInbox, transaction, retry,
idempotency, outbox, and optimistic-concurrency invariants.

### Wave 3: API-v1 composition and configuration

Separate the current broad `middleware.ts` and `create-rallar-server.ts`
responsibilities into explicit composition units. Introduce required
`createRallarServer(input)` and visible `createDefaultRallarServer()` assembly.
Move operational defaults into validated JSON configuration and retain only the
approved environment-variable allowlist. OpenAPI remains the source of HTTP
request defaults.

This wave must not change API behavior merely to make composition cleaner.
Configuration-source changes receive their own rollout and deployment review.

### Wave 4: Remaining shared-web browser features

Migrate auth, messages, realtime, RTC, calls, media, people, director, data,
CRDT, WebSocket, and browser composition. Preserve the existing public API and
bundle-boundary tests unless a separately approved child plan changes them.

Review every facade/controller pair. Keep a facade when it is a real product or
package boundary; collapse wrappers that only forward calls without owning a
decision, lifecycle, state, translation, or compatibility boundary.

### Wave 5: Test and black-box tooling structure

Mirror production feature folders under `packages/tests`. Move mutation-boundary
analysis implementation into its own folder. Rename task-history tests by the
behavior or invariant they prove.

Split `packages/shared-test/rallar-bb-test` into distributed-run, fleet,
control, artifact, recipe, and browser features. Split
`packages/shared-test/black-box-runner` into scenario, provider, browser,
artifact, and API-v1 state-write evidence features.

Test moves must preserve test discovery and package commands. Avoid changing
test behavior in the same commit as a path-only move.

### Wave 6: Remaining package hotspots

Apply the same method to `packages/shared/cache`, `packages/shared/crdt`,
`packages/shared/services`, AL/ALM, queuebox, persistence, WebRTC, multicast,
RallarAI, Rallar Game, Rallar Match, Rallar Motion, and remaining apps.

The work is prioritized by active change frequency, navigation pain, file size,
and boundary risk rather than alphabetically.

### Wave 7: Enforcement decision

Review the final warning inventory, false-positive samples, and remaining
approved exceptions. The human then decides whether selected mechanical checks
may become blocking. Semantic checks such as responsibility, purity, meaningful
absence, and decision depth remain human review concerns even if mechanical
checks become strict.

## 11. Child Plan Entry And Exit Contract

Every feature child plan begins with:

- current files and direct-file counts;
- current public exports and import consumers;
- one representative top-to-bottom call trace;
- existing behavior and characterization tests;
- exact current-to-target file map;
- file-size tier and 40/50/60 function review for the touched surface, including
  any existing hard-tier exceptions that the change must remove or renew;
- classification of mechanical, structural, semantic, contractual, and
  operational changes;
- explicit compatibility decisions and retirement conditions;
- focused validation commands selected from the Rallar testing guide.

Every child plan ends with:

- an obvious feature entry file;
- no new unapproved public export or import-path break;
- matching primary symbols and filenames;
- tests mirrored to the feature path;
- no unexplained new checker warnings;
- final file-size tier and 40/50/60 function review for the touched surface;
- every materially touched over-800-line file and over-60-line function either
  refactored at a coherent boundary or recorded with human approval in the repo
  code-style exception registry;
- documented remaining debt for the feature;
- exact passed, failed, unavailable, and skipped validation results;
- updated program progress in this plan or its approved successor ledger.

Feature status values are:

| Status             | Meaning                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `unmapped`         | No current-to-target ownership map exists.                                                      |
| `characterized`    | Public surface and representative behavior are protected by tests.                              |
| `structured`       | Files and tests follow the feature tree without intended behavior changes.                      |
| `standard-aligned` | The feature's touched production code follows the code standard or records approved exceptions. |
| `verified`         | Focused and required broad checks passed on the final feature code.                             |
| `published`        | Draft PR and required remote gates passed for the exact commits.                                |

Do not report a feature complete at `structured`; its known semantic
code-standard debt remains visible until `standard-aligned` and `verified`.

## 12. Progress Measures

Use measures that correspond to human navigation rather than changed-line
volume:

- number of feature folders with an obvious entry file;
- maximum direct TypeScript files in active production folders;
- count of production files over 400 lines;
- count of production files over 500 lines;
- count of production files over 800 lines;
- count of generic production filenames;
- count of mixed-case filename violations;
- count of wrapper-only call-stack hops found and removed through manual review;
- count of direct room/group-state crossings outside the named boundary;
- count of feature trees whose tests mirror production ownership;
- feature status from `unmapped` through `published`;
- sampled time for a human to trace one representative input-to-write flow.

Do not use total lines changed, files moved, or warning count alone as success.
A mechanical split that creates pass-through files can improve those numbers
while making navigation worse.

## 13. Validation Matrix

### Governance and checker changes

```bash
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts \
  packages/tests/repo/repo-code-style-integrity.test.ts \
  packages/tests/repo/repo-style-check.test.ts
npm run check:repo-style
```

### Shared contract or package-boundary changes

```bash
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts \
  packages/tests/shared-web/shared-web-browser-entrypoints.test.ts \
  packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
```

### Browser room changes

```bash
npx vitest run packages/tests/shared-web/rallar-rooms-facade.test.ts \
  packages/tests/shared-web/rallar-room-realtime-channel.test.ts \
  packages/tests/shared-web/rallar-message-channel-compat.test.ts \
  packages/tests/shared-web/rallar-readiness.test.ts
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npm --workspace ar-eye-hunter-v1 run build
npm --workspace relic-hunters-v1 run build
```

### Shared-server and API-v1 group-state changes

The child plan selects the exact focused group-state tests. At minimum it
includes group-state service, mutation read, guarded batch, AppInbox authority,
route, public contract, and repository tests, followed by:

```bash
npx tsc -p packages/shared-server/tsconfig.json --noEmit
cd apps/api-v1 && deno task check
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres:medium-scale
```

A mutation-path or concurrency-domain change also requires:

```bash
npm run perf:api-v1:state-write -- \
  --backend=postgres \
  --warmup=1 \
  --runs=3 \
  --concurrency=10 \
  --out=tmp/perf/api-v1-state-write-candidate.json

node scripts/perf/compare-api-v1-state-write-results.mjs \
  tmp/perf/api-v1-state-write-baseline.json \
  tmp/perf/api-v1-state-write-candidate.json
```

Pure file moves that demonstrably do not alter mutation paths do not need the
performance command, but they still need focused behavior, type, import, public
surface, and API checks selected by their child plan.

### Program completion gate

After all approved child plans have reached their final uncommitted state:

```bash
npm run test:unit
npm run test:ci
npm run build
```

Any change after a successful gate invalidates it. Completion also requires a
current draft pull request, a successful **Branch Release Gate** for the exact
final feature-branch commit, and a successful **Run Hetzner Supported
Distributed Manifests** workflow for the resulting exact default-branch commit.

## 14. First Executable Child Plans

After this master plan is approved, use the
[program execution protocol](repo-human-traceability-program-execution-plan.md)
to write, review, approve, execute, and hand off these child plans in order:

- [x] [Repository human traceability governance and checker](repo-human-traceability-governance-and-checker-plan.md)
  - state: approved at blob
    `8ee56ac27189f9bed751fb6a95992830bda6be60`; implementation `complete` at
    feature SHA `a986931c250c2f1fa12daa3e8d44a74669b178ed`, merged `main`
    SHA `4f98f241aefe62c89288e29403ba7f1f23897625`; separate ledger PR #51
    merged as `7a6c8e0c2cfb3413b4c0fbaaf0af31af2571c015` and reached
    `ledger-published` after workflow run `30407710853` passed;
  - exact code-style wording;
  - warning-only layout rule implementation and fixtures;
  - initial measured baseline.
- [ ] [Rallar room/group-state translation boundary](rallar-room-group-state-translation-boundary-plan.md)
  - state: exact Git blob
    `37861202ce25c3cd5832663a5a3f6d7e2e4a0e4e` approved with only recorded
    narrow amendments; structure/boundary Tasks 0 through 5 implemented in
    draft PR #53; Task 6 verification/publication and human merge pending;
    alignment not started;
  - browser room target tree;
  - explicit translation functions;
  - facade compatibility decision;
  - shared-web and app consumer validation.
- [ ] `plans/rallar-group-state-server-structure-plan.md`
  - exact move map for group-state service, mutation, persistence, presence,
    snapshot, and AppInbox files;
  - split of topology and RTC RTT ownership from `AppGroupInboxService`;
  - mirrored shared-server tests;
  - mutation-path verification decision.
- [ ] `plans/api-v1-group-state-route-structure-plan.md`
  - route split and descriptive registration symbols;
  - request defaults and request-to-command translation;
  - API-v1 composition changes needed by group-state only;
  - OpenAPI, route, and black-box compatibility checks.

Only after the pilot is `verified` should the program copy its migration method
to client-state, auth, topology, RTC, and CRDT. Adjust the method when the pilot
shows that a rule creates extra indirection or harms traceability.

The governance child does not unlock the browser boundary child until its
implementation is `complete` and its separate evidence-ledger publication is
`ledger-published` under the execution protocol's non-circular evidence
contract.

## 15. Explicit Non-Goals

- Do not move every file before the pilot proves the target structure.
- Do not redesign domain behavior merely because a file is moved.
- Do not preserve every old private import path through re-export shims.
- Do not break public browser facades, package exports, wire contracts, or
  persisted contracts without a separate approved migration.
- Do not create one file per interface, type, helper, or operation when
  co-location remains clearer and the file stays cohesive.
- Do not treat a 400-line threshold as a command to create pass-through files.
- Do not require all legacy debt to be fixed before ordinary product work can
  continue.
- Do not enable strict style enforcement as part of this program without a
  later explicit human decision.

## 16. Approved Execution Decisions

Human review has approved all master-plan execution choices:

1. A public structural move may use one temporary compatibility re-export hop;
   every concrete shim still requires explicit approval, named consumers, and
   a removal condition.
2. The first browser room migration preserves the current
   `RallarRoomsFacade` return-type compatibility. Product-named public room
   contracts require a separate breaking-release plan.
3. Public, cross-package, or approximately greater-than-20-file migrations use
   two pull requests by default. Smaller private migrations may use one pull
   request with clearly separated structure and code-standard commit series.

The next authorized program step is Task 6 review, verification, and
publication of the browser structure/boundary PR. Only after human merge and a
successful default-branch workflow may the already-approved alignment pass
start from the exact resulting `main` SHA. The shared-server and API-v1
children remain unstarted.
