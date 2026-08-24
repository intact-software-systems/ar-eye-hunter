# Shared Human Traceability Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task by task. Use
> `superpowers:test-driven-development` for behavior changes,
> `rallar-repo:adaptive-plan-execution` for horizon decisions,
> `rallar-repo:rallar-code-writing` for every changed human-authored file,
> `rallar-repo:organizing-repository-structure` for moves and splits,
> `rallar-repo:rallar-platform`, `rallar-repo:rallar-realtime`,
> `rallar-repo:rallar-ai`, and `rallar-repo:rallar-games` for their owned
> boundaries, `rallar-repo:rallar-testing` for validation, and
> `rallar-repo:publishing-plan-progress` for delivery. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Make `packages/shared/**` directly navigable by domain owner, so a
developer can follow each public contract or runtime-neutral capability through
validation, policy, state transition, persistence or transport port, failure,
and caller-visible result without first understanding generic implementation
buckets.

**Architecture:** Preserve `packages/shared` as the runtime-agnostic contract
and reusable-behavior package. Recover ownership incrementally: first establish
the public and dependency baselines, then move QueueBox read/dequeue behavior
out of generic services, then split the mixed API contract junction by
authoritative feature. Only after those foundations are stable should child
slices consolidate AL, dissolve the remaining `services/` and `repository/`
buckets, or split CRDT and other high-density feature internals. Move each
control-flow family with its tests, canonical imports, public disposition, and
navigation evidence.

**Tech Stack:** TypeScript with `erasableSyntaxOnly`, runtime-neutral WebSocket
and WebRTC ports, QueueBox/AL, IndexedDB adapters, CRDT, Vitest, Deno API checks,
dprint, and repository style/structure/legacy checks.

**Spec:**
[`plans/repo-human-traceability-refactoring-program-plan.md`](../../../plans/repo-human-traceability-refactoring-program-plan.md),
especially the child-plan entry/exit contract and remaining shared-package
work. [`packages/shared/architecture.md`](../../../packages/shared/architecture.md)
records current package truths and is updated with implementation slices when
the package navigation changes.

**Planning base:** `4d46d428d` (`main` and `origin/main` when this audit began).
Before implementation, fetch current `origin/main`, authenticate live paths and
consumers again, and amend this plan only if ownership, compatibility, or
acceptance materially changed.

## Global Constraints

- Implement each approved slice on a fresh `codex/` branch based on current
  `origin/main`; this plan's presence on `main` does not authorize production
  changes or a default-branch commit.
- Preserve `packages/shared` as runtime-agnostic. Browser storage selection and
  browser composition belong in `packages/shared-web`; server adapters and
  persistence belong in `packages/shared-server`; shared keeps contracts,
  deterministic policy, protocol logic, and injected ports.
- Preserve scoped `GroupRef` identity, AL and QueueBox contracts, authoritative
  state and topology schemas, retry/fairness/lease semantics, CRDT wire and
  persisted formats, AI proposal lifecycle, and game/motion authority behavior.
- Treat `packages/shared/mod.ts`, feature `mod.ts` entrypoints, and verified deep
  imports as compatibility evidence, not permission to preserve or remove them
  automatically. Export removal, rename, persisted-format change, and protocol
  change require explicit compatibility or migration approval.
- Do not create a second generic bucket while removing `services/` or
  `repository/`. Every moved module must have a named domain, lifecycle,
  protocol, compatibility, or side-effect owner.
- Every changed human-authored file is reviewed and remediated in full. Every
  support file modified by that remediation enters closure recursively until
  closure. Independent untouched code remains outside closure.
- Remove affected legacy when no independent requirement or verified consumer
  needs it. Any retained production legacy must be a thin named boundary with
  explicit maintainer approval and the required registry entry.
- Semantic behavior tests are primary. Public-surface snapshots, dependency
  direction tests, source inventories, and navigation checks supplement rather
  than replace behavior tests.
- Structure and code-standard alignment are separate review stages for a
  public/cross-package or greater-than-20-file family. Split again before broad
  remediation when either review cannot be completed confidently.
- Keep only the next two implementation slices concrete. Re-authenticate and
  refine later outcomes after each merged slice rather than treating this plan
  as a frozen move manifest.

## Current Evidence and Traceability Diagnosis

The planning-base audit found 213 production TypeScript modules and about
54,980 lines. The 107 shared test/support modules are all direct children of
`packages/tests/shared`, so production ownership and verification ownership do
not mirror each other.

Current top-level direct-file counts are: `al-contracts/` 7, `alm/` 10,
`api/` 33 total with 21 direct children, `cache/` 28, `crdt/` 11,
`multicast/` 3, `ontology/` 10, `persistence/` 3, `queuebox/` 12,
`rallar-ai/` 20, `rallar-game/` 5, `rallar-match/` 8, `rallar-motion/` 12,
`repository/` 12, `resilience/` 6, `rtc/` 4, `services/` 18, `webrtc/` 8,
`websocket/` 2, plus root `mod.ts`.

The densest production areas are `cache/` (28 modules), `api/` (21 direct
modules), `rallar-ai/` (20), `services/` (18), `repository/` and `queuebox/`
(12 each), `rallar-motion/` (12), and `crdt/` (11). Density is a navigation
signal, not an instruction to add folders mechanically.

The full-detail repository checker produced 690 review prompts in this package,
led by 424 unresolved boundary types, 64 object-shaped interfaces, 56 input
contract findings, 31 cognitive-load findings, 28 pass-through wrappers, 24
primary-export findings, and 13 responsibility findings. The layout scan found
density in `api/` and `cache/`, five filename-prefix clusters, 83 filename-style
prompts, and generic files in the product features. These are audit evidence,
not mechanical acceptance criteria.

The largest mixed-control-flow files reinforce the ownership problem:

- `alm/ALInboundAdmissionStore.ts`: 2,319 lines;
- `crdt/crdt-operations.ts`: 1,751 lines;
- `al-contracts/al-policy.ts`: 1,589 lines;
- `crdt/crdt-codec.ts`: 1,579 lines;
- `alm/ALOutboundMessageRuntime.ts`: 1,532 lines;
- `alm/ALOutboundAdmissionStore.ts`: 1,524 lines;
- `services/WebRtcConnectionService.ts`: 1,490 lines;
- `queuebox/IndexedDbQueueBox.ts`: 1,182 lines;
- `api/authoritative-state-validation.ts`: 1,092 lines.

The concrete navigation defects are:

1. `api/api-config.ts` is a semantic junction for API configuration, auth,
   QueueBox message shapes, application topics, identity, ICE, topology, and
   RTT data. `authoritative-state-validation.ts` and `state-types.ts` likewise
   mix client, group, and topology owners.
2. `services/` owns QueueBox readers and engine code, WebSocket QueueBox
   adapters, WebRTC connection/group/heartbeat/receiver behavior, and RTC group
   snapshot synchronization. The folder name contributes no domain meaning.
3. The AL path crosses `al-contracts/`, `alm/`, `queuebox/`, `persistence/`, and
   `services/`. Admission-store modules mix ports, pure decisions, in-memory
   stores, persistence stores, IndexedDB stores, key encoding, and transaction
   behavior.
4. `repository/` groups client state, group state, topology, RTT, and process
   composition by storage mechanism. `cache/defaultRepositoryManager.ts` is a
   process-global service locator used across browser, server, graph, AL, and
   repository consumers.
5. `api/auth.ts` chooses module-global browser `localStorage` and
   `sessionStorage` inside a runtime-agnostic package.
6. Production and test files cannot be followed as a mirrored owner because
   all shared tests currently occupy one flat directory.

Current reciprocal top-folder imports show that the generic buckets also hide
dependency direction:

- `alm` and `services` import each other;
- `multicast`, `rtc`, and `webrtc` each import `services`, while `services`
  imports each of them;
- `api` and `crdt` import each other;
- `api` and `queuebox` import each other.

The broad `mod.ts` exports AL/ALM, QueueBox, persistence, resilience, WebSocket,
WebRTC, multicast, cache, and generic services. Feature barrels already exist
for CRDT, ontology, RallarAI, Rallar Game, Rallar Match, and Rallar Motion.
Repository-local code also uses many deep imports, especially from `api`,
`queuebox`, `services`, `repository`, and `al-contracts`. Therefore file moves
are possible, but an exported symbol or established import path is not removed
without an explicit consumer and compatibility disposition.

The audit counted approximately 1,520 repository import occurrences into
`api`, 377 into `queuebox`, 234 into `services`, 195 into `repository`, 142 into
`al-contracts`, 138 into `cache`, 106 into `crdt`, 102 into `resilience`, 47
into `webrtc`, 40 into `websocket`, 38 into `persistence`, and 33 into `alm`.
The largest consumer groups are shared tests, `packages/shared-server`,
`apps/api-v1`, `packages/shared-web`, and `apps/rallar-black-box`. These counts
are repository evidence rather than a claim about unknown external consumers;
implementation re-runs exact symbol/path searches before any compatibility
decision.

### Existing behavior and characterization evidence

- QueueBox behavior is covered by the existing inbox/outbox reader,
  in-memory/IndexedDB QueueBox, resource inbox fairness/retry/start-processing,
  resource entry, telemetry, WebSocket outbox retry, `queue.test.ts`, and
  `queuedeno.test.ts` suites named in Slice 1.
- Auth, authoritative state, group lifecycle/policy/director, mutation,
  topology, statistics, and validation suites under `packages/tests/shared`
  cover the broad contract families selected for Slice 2. They are moved with
  their owners and supplemented only where exact boundary rejection or alias
  behavior is currently unproved.
- `npx tsc -p packages/shared/tsconfig.json --noEmit` passed on the planning
  base. The audit command
  `npx vitest run packages/tests/shared --reporter=dot` also passed, but the
  repository configuration expanded it to 596 executed files (4 skipped) and
  4,858 passed tests (9 skipped). Concrete slices therefore use exact file
  lists for focused RED/GREEN evidence rather than treating a directory
  argument as focused execution.

### Representative top-to-bottom QueueBox trace

```text
browser/server queue owner
  -> InboxQueueReader / OutboxQueueReader
  -> createQueueMessageReader
  -> QueueBoxUtilities.defaultDequeue
  -> DequeueResourceEntryController.toDequeuer
  -> post-construction callback registration
  -> DequeueController.dequeueForCompute
  -> repository candidate read and reservation/lease
  -> callback processing
  -> completed, retry, or failed repository transition
  -> resilience/telemetry update
  -> caller-visible completion or failure
```

The business phases are legitimate, but the trace crosses `services/`, a
static utility wrapper, two controllers, and temporal callback installation
before reaching the repository transition. Slice 1 keeps the behavior while
making `read -> claim/lease -> process -> release/finalize` visible inside one
QueueBox owner.

### Concrete-slice size and 40/50/60 function baseline

The 11 named current production modules in Slices 1 and 2 contain three files
over 400 physical lines, three over 500, one over 800, and none over the current
1,200-line physical backstop:

| File                                         | Physical lines | Concrete-slice disposition                                                        |
| -------------------------------------------- | -------------: | --------------------------------------------------------------------------------- |
| `api/authoritative-state-validation.ts`      |          1,093 | Split by client, group, and topology trust boundary in Slice 2.                   |
| `queuebox/DequeueResourceEntryController.ts` |            712 | Split configuration, orchestration, and resource transition ownership in Slice 1. |
| `queuebox/DequeueController.ts`              |            528 | Replace temporal callback construction and expose dequeue phases in Slice 1.      |

AST source-span review of those modules found eight functions over 40 lines,
all eight over 50, and seven over 60:

| Function                                          | Current lines | Owner decision                                                                     |
| ------------------------------------------------- | ------------: | ---------------------------------------------------------------------------------- |
| `DequeueResourceEntryController.toDequeuer`       |           317 | Replace the temporal builder with required configuration and named dequeue phases. |
| `validateAuthoritativeGroupSnapshot`              |           182 | Move/split under group-state validation.                                           |
| `validateAuthoritativeClientSnapshot`             |           152 | Move/split under client-state validation.                                          |
| `dequeueWithTypesAlgorithm`                       |           151 | Separate candidate selection, reservation, processing, and finalization decisions. |
| `dequeueForCompute`                               |           118 | Retain as the visible orchestration entry after extracting named phases.           |
| anonymous resource-entry callback in `toDequeuer` |           104 | Replace callback installation with an explicit configured operation.               |
| `validateAuthoritativeOverlayTopologySnapshot`    |            97 | Move/split under topology validation.                                              |

`createQueueMessageReader` is 51 lines and remains in the 50–60 review tier.
No matching hard-tier entry exists in `docs/repo-code-style-exceptions.md`;
implementation must remove the hard-tier condition or obtain explicit human
approval and add the required registry entry.

### Concrete-slice change classification

| Slice   | Mechanical                                                 | Structural                                                                                                                                             | Semantic                                                                                                                           | Contractual                                                                                                                         | Operational                                                                                                                                          |
| ------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slice 1 | Kebab-case moves, mirrored test moves, and import updates. | QueueBox owns readers, dequeue phases, resilience, and entry translation instead of generic `services/`.                                               | Preserve queue selection, fairness, retry, callback dispatch, entry conversion, and error propagation; first add characterization. | Preserve root-exported symbol names. Deep-path retention requires an explicit supported-consumer decision and retirement condition. | Reservation/lease, retry, telemetry, finalization, clocks, identifiers, and randomness are operationally sensitive and become explicit dependencies. |
| Slice 2 | Contract/test moves and canonical import updates.          | API contracts and validators are owned by auth, client state, group state, topology, mutation, identity, configuration, QueueBox, and realtime topics. | Preserve exact-shape validation and request/response meaning.                                                                      | Public aliases, root exports, protocol fields, and default constants require individual compatibility dispositions.                 | Browser storage selection moves to shared-web; consumer configuration supplies defaults without changing authentication persistence behavior.        |

### Exact current-to-target map for the concrete slices

| Current source/symbol                                           | Canonical target                                                                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `queuebox/DequeueController.ts`                                 | `queuebox/dequeue/dequeue-controller.ts`                                                                                         |
| `queuebox/DequeueResourceEntryController.ts`                    | `queuebox/dequeue/dequeue-resource-entry-controller.ts`                                                                          |
| `services/QueueMessageReader.ts`                                | `queuebox/queue-message-reader.ts`                                                                                               |
| `services/InboxQueueReader.ts`                                  | `queuebox/inbox/inbox-queue-reader.ts`                                                                                           |
| `services/OutboxQueueReader.ts`                                 | `queuebox/outbox/outbox-queue-reader.ts`                                                                                         |
| `QueueBoxUtilities.defaultDequeue` and `withRetryDisposition`   | `queuebox/dequeue/run-resilient-dequeue.ts`                                                                                      |
| `QueueBoxUtilities.toResourceEntry`                             | `queuebox/resource-entry-factory.ts`, with clock, identifier, creator, and context supplied explicitly                           |
| `QueueBoxUtilities.toResourceEntryFromMsg`                      | `queuebox/al-message-resource-entry.ts`, the one named AL-to-QueueBox translation boundary                                       |
| `api-config.ts#ApiConfig`                                       | `api/configuration/api-client-config.ts`                                                                                         |
| auth/session/ticket contracts in `api-config.ts`                | `api/auth/auth-contracts.ts`                                                                                                     |
| `api/auth.ts` browser storage selection and session persistence | `packages/shared-web/browser/session/browser-auth-session-store.ts`                                                              |
| `api-config.ts#EnqueuedType`                                    | `queuebox/queue-entry-type.ts`                                                                                                   |
| `api-config.ts#AppTopics`                                       | `api/realtime/application-topic.ts`                                                                                              |
| peer/client identity in `api-config.ts`                         | `api/identity/client-identity.ts`                                                                                                |
| ICE configuration in `api-config.ts`                            | `api/topology/ice-config.ts`                                                                                                     |
| group identity in `api-config.ts`                               | existing `api/group-types.ts`, with alias removal only by approved compatibility decision                                        |
| overlay and RTT contracts in `api-config.ts`                    | `api/topology/overlay-types.ts` and `rtc/rtt-measurement-info.ts`                                                                |
| client validators in `authoritative-state-validation.ts`        | `api/client-state/client-state-validation.ts`                                                                                    |
| group validators in `authoritative-state-validation.ts`         | `api/group-state/group-state-validation.ts`                                                                                      |
| overlay validators in `authoritative-state-validation.ts`       | `api/topology/topology-validation.ts`                                                                                            |
| `state-types.ts#StateScope`                                     | `api/identity/state-scope.ts`                                                                                                    |
| default state-scope constants in `state-types.ts`               | authenticated browser/server/app composition; any retained public constants require explicit approval and a retirement condition |
| `state-types.ts#MutationActorInput`                             | `api/mutation/mutation-actor-input.ts`                                                                                           |
| client mutation requests in `state-types.ts`                    | `api/client-state/client-state-mutation-contracts.ts`                                                                            |
| group mutation/presence requests in `state-types.ts`            | `api/group-state/group-state-mutation-contracts.ts`                                                                              |
| `state-types.ts#StateErrorResponse`                             | `api/mutation/state-mutation-error.ts`                                                                                           |

Existing repository callers move directly to these owners. Root `mod.ts`
symbols keep exact exported names during the concrete slices. An old deep path
is not retained unless the implementation-time inventory proves a supported
external consumer and the maintainer explicitly approves one direct
compatibility hop; retirement requires zero supported consumers plus separate
removal approval.

## Target Ownership and Navigation

The target is a feature-owned package rather than a shallower package:

```text
packages/shared/
  api/
    auth/
    client-state/
    group-state/
      group-lifecycle/
    topology/
    administration/
    statistics/
    identity/
  al/
    contracts/
    policy/
    inbound/
    outbound/
    stores/
  queuebox/
    dequeue/
    inbox/
    outbox/
    persistence/
  websocket/
    queuebox/
  webrtc/
    connection/
    group/
    heartbeat/
    receive/
  rtc/
    group-state/
  cache/
    latest/
    loaned/
    observable/
    composition/
  crdt/
    policy/
    codec/
    document/
    model/
    administration/
  rallar-ai/
  ontology/
  rallar-game/
  rallar-match/
  rallar-motion/
```

This tree is a target ownership map, not an instruction to create every folder
up front. A folder appears only when an implementation slice moves a coherent
control-flow family into it. Feature-local imports should point inward toward
contracts and pure policy, with injected persistence/transport ports at the
edge. Reciprocal top-level dependencies are either removed or documented as a
real protocol boundary with one visible translation owner.

Specific ownership decisions:

| Current area                                    | Target owner                                         |
| ----------------------------------------------- | ---------------------------------------------------- |
| Pure auth DTOs and parsing                      | `api/auth/`                                          |
| Browser auth storage selection                  | shared-web browser session/auth owner                |
| Client state types and validation               | `api/client-state/`                                  |
| Group state, policy, and lifecycle              | `api/group-state/`                                   |
| Overlay/graph contracts and validation          | `api/topology/`                                      |
| Queue readers, dequeue, and inbox/outbox engine | `queuebox/` subfamilies                              |
| WebSocket QueueBox adapters                     | `websocket/queuebox/`                                |
| WebRTC connection/group/heartbeat/receive       | `webrtc/` subfamilies                                |
| RTC snapshot synchronization                    | `rtc/group-state/`                                   |
| `al-contracts/` plus `alm/`                     | one canonical `al/` feature                          |
| Generic state repositories                      | explicit client/group/topology/RTT cache owners      |
| CRDT internals                                  | retained `crdt/`, split by policy/protocol/lifecycle |
| AI, ontology, game, match, motion               | retained coherent feature owners                     |

## Slice 1: Recover QueueBox Read and Dequeue Ownership

This slice is first because AL, browser, server, and WebSocket code depend on
QueueBox. It removes one generic-service dependency without rewriting AL.

### Task 1: Freeze the public, dependency, and behavior baseline

**Files:**

- Create: `packages/tests/shared/shared-public-api-snapshots.test.ts`
- Create: `packages/tests/shared/shared-dependency-directions.test.ts`
- Modify: `packages/shared/architecture.md`
- Modify: the exact existing QueueBox tests named below only when the baseline
  exposes missing behavior

- [ ] Add a public API snapshot that records the symbol names exposed by
      `packages/shared/mod.ts` and the existing feature barrels without asserting
      private file placement.
- [ ] Add a dependency-direction test for the slice's target: QueueBox
      production modules must not import from generic `services/` after the move,
      and canonical callers must not use a compatibility-only path.
- [ ] Record a durable package navigation table in `architecture.md` for API,
      QueueBox, AL, cache/repository, CRDT, transports, and product features.
- [ ] Add semantic characterization only where current coverage does not prove
      dequeue fairness, empty reads, retry, lease/release, finalization, resource
      precedence, AL conversion, and error propagation.
- [ ] Run the exact QueueBox test list before changing production code and
      record baseline results. Do not use a directory argument: repository Vitest
      configuration expanded the audit's nominal shared-directory run to 600 test
      files.

**Baseline command:**

```bash
npx vitest run \
  packages/tests/shared/inbox-queue-reader.test.ts \
  packages/tests/shared/outbox-queue-reader.test.ts \
  packages/tests/shared/queuebox-utilities.test.ts \
  packages/tests/shared/in-memory-queuebox.test.ts \
  packages/tests/shared/indexeddb-queuebox.test.ts \
  packages/tests/shared/queue.test.ts \
  packages/tests/shared/queuedeno.test.ts \
  packages/tests/shared/resource-inbox-attempt-telemetry.test.ts \
  packages/tests/shared/resource-inbox-fairness-precedence.test.ts \
  packages/tests/shared/resource-inbox-retry-policy.test.ts \
  packages/tests/shared/resource-inbox-start-processing.test.ts \
  packages/tests/shared/resource-entry.test.ts \
  packages/tests/shared/ws-outbox-owner-miss-retry.test.ts
```

**Commit:** `test(shared): freeze queuebox ownership behavior`

### Task 2: Make dequeue construction valid at creation

**Files:**

- Move/rename: `packages/shared/queuebox/DequeueController.ts` to
  `packages/shared/queuebox/dequeue/dequeue-controller.ts`
- Move/rename: `packages/shared/queuebox/DequeueResourceEntryController.ts` to
  `packages/shared/queuebox/dequeue/dequeue-resource-entry-controller.ts`
- Modify: callers discovered by
  `rg -n "DequeueController|DequeueResourceEntryController" packages apps examples`
- Modify: QueueBox tests from Task 1 that exercise construction and dequeue

- [ ] Write a failing construction test showing that the controller receives
      all required read, process, release, clock, retry, and failure dependencies at
      creation instead of through later callback installation.
- [ ] Introduce one named construction input owned beside the controller. Do
      not create rename-only aliases, generic options bags, setters, or an
      interface-per-function.
- [ ] Separate the visible phases `read candidate -> claim/lease -> process ->
  release/finalize` inside the owner while preserving ordering, fairness,
      retry, and telemetry behavior.
- [ ] Update repository-local callers directly. Do not retain an old internal
      construction route merely because a coupled test used it.
- [ ] Re-run the exact QueueBox test list and package typecheck.

**Commit:** `refactor(shared): make dequeue dependencies explicit`

### Task 3: Move QueueBox readers and utilities to their domain owner

**Files:**

- Move/rename: `packages/shared/services/QueueMessageReader.ts` to
  `packages/shared/queuebox/queue-message-reader.ts`
- Move: `packages/shared/services/InboxQueueReader.ts` to
  `packages/shared/queuebox/inbox/inbox-queue-reader.ts`
- Move: `packages/shared/services/OutboxQueueReader.ts` to
  `packages/shared/queuebox/outbox/outbox-queue-reader.ts`
- Split/move: `packages/shared/services/QueueBoxUtilities.ts` to
  `packages/shared/queuebox/dequeue/run-resilient-dequeue.ts`,
  `packages/shared/queuebox/resource-entry-factory.ts`, and
  `packages/shared/queuebox/al-message-resource-entry.ts`
- Modify: `packages/shared/mod.ts`
- Modify: all repository-local consumers found by exact import search
- Move: `packages/tests/shared/inbox-queue-reader.test.ts` to
  `packages/tests/shared/queuebox/inbox/inbox-queue-reader.test.ts`
- Move: `packages/tests/shared/outbox-queue-reader.test.ts` to
  `packages/tests/shared/queuebox/outbox/outbox-queue-reader.test.ts`
- Move/rename: `packages/tests/shared/queuebox-utilities.test.ts` beside the
  named behavior it verifies

- [ ] Inventory every production and test importer before moving files,
      grouped by `shared-web`, `shared-server`, API-v1, shared-test, apps, and
      examples.
- [ ] Move reader behavior without forwarding modules. If a deep path has a
      verified external consumer, stop and request a compatibility decision for
      that path instead of guessing.
- [ ] Replace the static `QueueBoxUtilities` vocabulary with the three named
      owners in the exact map. Expose clocks, identifiers, audit creator/context,
      queue conversions, and side effects at the call site; remove hard-coded
      test identity/defaults from production entry creation while preserving
      current values through explicit caller composition where required.
- [ ] Update canonical imports and `mod.ts` exports. A root public symbol keeps
      its exported name unless separately approved.
- [ ] Move tests with the production family and rename them around observable
      behavior, not the old file layout.
- [ ] Prove with `rg` and the dependency-direction test that QueueBox canonical
      code no longer traverses `services/`.

**Commit:** `refactor(shared): colocate queuebox readers`

### Task 4: Close Slice 1 across consumers

**Files:**

- Modify: `packages/shared/architecture.md`
- Modify: public/dependency tests from Task 1
- Modify: affected shared-web, shared-server, API-v1, shared-test, app, and
  example imports only when discovered by the authenticated inventory

- [ ] Run focused QueueBox tests from their new paths.
- [ ] Run shared, shared-web, and shared-server typechecks.
- [ ] Run the API-v1 Deno check because QueueBox contracts are a material API
      consumer.
- [ ] Run public snapshot and dependency-direction tests.
- [ ] Run changed-file style, changed-range regression, structure, legacy, and
      formatting gates from `rallar-testing`.
- [ ] Perform a code-only navigation probe: start from enqueue/dequeue public
      usage and locate read, claim, process, retry, release/finalize, telemetry, and
      result without entering `services/` or relying on tests.
- [ ] Report app builds or black-box validation as passed, failed, unavailable,
      or skipped according to authenticated affected consumers.
- [ ] Run `npm run pr:delivery -- status`; repair real conflicts, but do not
      merge/rebase merely because the branch is `BEHIND` while GitHub says the pull
      request is mergeable.

**Slice 1 exit:** QueueBox read/dequeue has one feature owner, required
dependencies are valid at creation, tests mirror the owner, public names remain
compatible, and a developer can follow the lifecycle without the generic
`services/` directory.

## Slice 2: Recover API Contract Ownership

Start only after Slice 1 has merged and the planning base has been refreshed.
This slice changes contract organization, not authoritative server behavior.

### Task 5: Characterize the mixed contract junction

**Files:**

- Create: `packages/tests/shared/api/api-contract-ownership.test.ts`
- Move: relevant existing API tests into `packages/tests/shared/api/**` as each
  production owner moves
- Modify: `packages/shared/api/README.md`
- Modify: `packages/tests/shared/shared-public-api-snapshots.test.ts`

- [ ] Inventory every export and importer of `api-config.ts`, `auth.ts`,
      `authoritative-state-validation.ts`, and `state-types.ts` by semantic owner.
- [ ] Record each rename-only or compatibility alias separately, including
      `ConsumeAgentSessionTicketResponse`, request aliases to
      `MutationActorInput`, and `AnyGroupPresence`. Classify each as verified
      consumer compatibility, protocol/persistence contract, or removable only
      with explicit approval.
- [ ] Add behavior tests for pure auth parsing, client-state validation,
      group-state validation, topology validation, and invalid boundary rejection.
      Do not snapshot private filenames.
- [ ] Update `api/README.md` with current and target paths, dependency
      directions, and the deliberate status of `group-lifecycle/`.

**Commit:** `test(shared): characterize api contract ownership`

### Task 6: Split API contracts by authoritative feature

**Files:**

- Split: `packages/shared/api/api-config.ts`
- Split: `packages/shared/api/authoritative-state-validation.ts`
- Split: `packages/shared/api/state-types.ts`
- Move/split: `packages/shared/api/auth.ts`
- Preserve/refine: `packages/shared/api/group-lifecycle/**`
- Modify: `packages/shared/mod.ts`
- Modify: every authenticated repository-local consumer
- Modify/move: API tests to mirrored owners under `packages/tests/shared/api/**`

- [ ] Execute the exact symbol-to-file map above one feature family at a time.
      If refreshed consumers or protocol evidence contradicts a target, stop that
      family and amend the approved plan instead of improvising a generic owner.
- [ ] Move pure auth DTOs, validation, and parsing to `api/auth/`. Move browser
      storage selection and mutable browser persistence to the shared-web
      session/auth owner in a coordinated shared-web slice; do not add a DOM shim
      inside shared.
- [ ] Move client identity, snapshot, mutation, and validation contracts to
      `api/client-state/`.
- [ ] Move group snapshot, presence, policy, mutation, and validation contracts
      to `api/group-state/`. Keep `group-lifecycle/` as an explicit subdomain unless
      a code-only navigation probe demonstrates a more direct owner.
- [ ] Move overlay/graph, topology configuration, ICE/RTC-neutral topology, and
      RTT contracts to `api/topology/` or the existing `rtc/` owner according to
      who validates and changes the concept.
- [ ] Move QueueBox message shapes and application topics out of
      `api-config.ts` to their protocol owners rather than leaving a smaller
      dumping ground.
- [ ] Keep administration and statistics contracts in named feature folders
      when they are not owned by client, group, or topology state.
- [ ] Update canonical imports directly and preserve public symbol names at the
      root barrel. Do not create nested barrels except where an existing public
      feature boundary needs one stable entrypoint.
- [ ] For each touched source and test, close type organization, boundary
      typing, function size, responsibility, naming, and affected legacy across the
      full file and recursively touched support files.

**Commit:** `refactor(shared): organize api contracts by owner`

### Task 7: Close Slice 2 across package boundaries

**Files:**

- Modify: `packages/shared/architecture.md`
- Modify: `packages/shared/api/README.md`
- Modify: public/dependency tests
- Modify: authenticated consumers only

- [ ] Prove no runtime behavior moved into the contract package and no browser
      global remains in shared auth ownership.
- [ ] Run exact auth, client-state, group-state, group-lifecycle, topology,
      authoritative-validation, mutation, and statistics tests from their new
      mirrored paths.
- [ ] Run shared, shared-web, and shared-server typechecks; API-v1 Deno checks
      and affected tests; public API snapshots; and browser bundle-boundary checks
      when browser import shape changes.
- [ ] Search production imports and prove canonical code uses the new feature
      owners rather than the old `api-config.ts` or mixed validation paths.
- [ ] Perform code-only probes from an auth contract, client mutation, group
      mutation, topology contract, and QueueBox topic to validation and consumer.
- [ ] Run changed-file style, changed-range regression, structure, legacy,
      formatting, and publication gates.

**Slice 2 exit:** API contracts are discoverable by authoritative feature,
browser persistence is outside shared, public symbols and protocol shapes are
preserved or explicitly approved, tests mirror owners, and the `api` directory
no longer acts as a cross-domain type junction.

## Concrete-Slice Focused Validation Commands

Run the exact Slice 1 QueueBox command from Task 1 before movement and update
only its file paths after test co-location. Then run:

```bash
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
cd apps/api-v1 && deno task check
npx vitest run \
  packages/tests/shared/shared-public-api-snapshots.test.ts \
  packages/tests/shared/shared-dependency-directions.test.ts
```

For Slice 2, run the moved equivalents of these exact current behavior files
plus the new ownership test:

```bash
npx vitest run \
  packages/tests/shared/auth.test.ts \
  packages/tests/shared/authoritative-state-contracts.test.ts \
  packages/tests/shared/authoritative-state-validation.test.ts \
  packages/tests/shared/group-client-views.test.ts \
  packages/tests/shared/group-director.test.ts \
  packages/tests/shared/group-policy-types.test.ts \
  packages/tests/shared/group-lifecycle-policy.test.ts \
  packages/tests/shared/group-lifecycle-transitions.test.ts \
  packages/tests/shared/group-lifecycle-managers.test.ts \
  packages/tests/shared/api-mutation-failure.test.ts \
  packages/tests/shared/api-mutation-request.test.ts \
  packages/tests/shared/rallar-validation.test.ts \
  packages/tests/shared/spa-statistics-types.test.ts \
  packages/tests/shared/api/api-contract-ownership.test.ts
```

After either slice, run the current commands selected by `rallar-testing` for
formatting, changed-range style, full touched-file review, structure, legacy,
public/bundle boundaries, and publication. Run affected application tests or
builds when the refreshed consumer inventory crosses an app boundary, and
report every unavailable or skipped check rather than silently omitting it.

## Later Independently Testable Outcomes

These are ordered outcomes, not authorized move manifests. Re-authenticate
paths, consumers, behavior, and compatibility before making each one the next
concrete slice.

### Outcome 3: QueueBox engine and WebSocket adapter ownership

- Move `InboxOutboxContracts.ts` and `InboxOutboxEngine.ts` from `services/` to
  QueueBox lifecycle ownership.
- Keep the engine as one stateful owner while making clocks, identifiers,
  randomness, persistence, and diagnostics explicit composition dependencies.
- Move `WsQueueBoxClientService.ts`, `WsQueueBoxServerService.ts`, and their
  contracts to `websocket/queuebox/`.
- Preserve queue formats, QoS, retry, server/client behavior, and Deno/browser
  consumers; mirror semantic tests with each owner.

### Outcome 4: Consolidate AL contracts and policy

- Establish one canonical `al/` feature and durable `al/README.md` navigation
  map.
- Move contracts/control, validation, runtime shapes, QoS/admission policy, and
  pure dispatch/admission decisions first.
- Preserve AL wire shapes, priorities, deduplication, ordering, retry timing,
  multicast targets, and scoped identity.
- Inventory public deep imports before changing `al-contracts/` or `alm/`
  paths; do not keep old internal paths without an approved compatibility need.

### Outcome 5: Consolidate AL inbound runtime and stores

- Split inbound orchestration, pure admission decisions, store ports,
  in-memory implementations, persistence adapters, IndexedDB adapters, key
  encoding, and transaction behavior at real lifecycle/side-effect boundaries.
- Preserve the visible path `incoming message -> control/admission branch ->
  store read -> decision -> optimistic commit -> durable effects`.
- Keep browser persistence adapters runtime-neutral only if they have verified
  cross-runtime consumers and do not select browser globals; otherwise
  coordinate a shared-web move.

### Outcome 6: Consolidate AL outbound runtime and stores

- Preserve the visible path `enqueue -> ready scheduling -> dispatch plan ->
  admission read -> pure computation -> optimistic commit -> durable effects ->
  prepared send`.
- Separate scheduling, policy, transaction, persistence, and transport effects
  without introducing callback graphs or wrapper layers.
- Validate server, browser, multicast, WebSocket, and WebRTC consumers.

### Outcome 7: Dissolve remaining transport services

- Move WebRTC connection, group, heartbeat, receive, and dial-plan behavior to
  feature-owned `webrtc/` families.
- Move group-snapshot RTC synchronization to `rtc/group-state/` or the verified
  group-state RTC adapter owner.
- Keep shared WebRTC primitives only when they remain free of direct browser
  globals. A cross-package move to shared-web is an explicit architecture and
  public compatibility decision, not an assumption based on the technology.
- Move multicast behavior to its existing owner and remove `services/` once no
  coherent responsibility remains.

### Outcome 8: Recover state cache and repository composition

- Organize the cache matrix by latest, loaned, observable, memento, command,
  token, and composition concepts without flattening real semantic variants.
- Move client, group, topology, overlay, and RTT repositories to explicit state
  owners rather than a generic storage-mechanism directory.
- In a separate behavior slice, pass an explicit `RepositoryManager` from
  composition owners and remove implicit process-global defaults.
- Treat removal of `defaultRepositoryManager` and `LatestRepositoryHelpers`
  defaults as composition and public compatibility changes; preserve no hidden
  console failure path.

### Outcome 9: Split CRDT policy and administration

- Keep `crdt/` and `crdt/mod.ts` as the canonical feature boundary.
- Split rollout policy, metrics/audit sinks, administration, debug bundles,
  backup/restore, retention/erasure, and encryption metadata from
  `crdt-hardening.ts` at policy and side-effect boundaries.
- Preserve document health, quarantine, backup, encryption metadata,
  retention, and erasure semantics and formats.

### Outcome 10: Split CRDT protocol and document lifecycle

- Split operation, batch, update, snapshot, and synchronization-envelope codec
  families from `crdt-codec.ts` while keeping one visible protocol entry.
- Split builders, document lifecycle, model application, materialization, and
  snapshot import/export from `crdt-operations.ts` by decision owner.
- Preserve the public CRDT barrel, wire formats, deterministic application,
  and cross-package consumers.

### Outcome 11: Product feature closure

- Retain `rallar-ai`, ontology, Rallar Game, Rallar Match, and Rallar Motion as
  coherent features.
- Apply focused type-organization, filename, navigation, cognitive-load, and
  affected-legacy closure to one feature at a time.
- Replace generic `types.ts` or `diagnostics.ts` only when the real concept
  owner is clear and public compatibility is resolved.
- Preserve strict RallarAI schemas and proposal lifecycle, game authority and
  replay/idempotency, match state, motion lane freshness, and app builds.

### Outcome 12: Final package closure

- `services/` and generic `repository/` no longer exist unless an explicitly
  approved thin compatibility boundary remains.
- Tests mirror production feature and control-flow ownership, except genuine
  cross-feature public/protocol suites.
- No canonical import traverses a compatibility-only wrapper, process-global
  service locator, or cross-domain API dumping ground.
- Every feature with more than 20 modules or three control-flow families has a
  durable navigation map.
- A human can trace API validation, QueueBox, inbound/outbound AL, WebSocket,
  WebRTC, state cache, CRDT, AI, game, match, and motion paths from public entry
  to result using production code only.

## Acceptance Criteria

- [ ] Every shared capability has one obvious public or feature entry and one
      visible contract/policy/state/effect/result path.
- [ ] `api`, QueueBox, AL, transports, cache/state, CRDT, and product features
      have explicit ownership and inward dependency direction.
- [ ] Browser-only session storage selection is outside shared; remaining code
      is safe for browser, server, tests, and apps under injected runtime ports.
- [ ] Public exports, verified deep imports, protocol and persisted shapes,
      scoped identity, retry/fairness, and product behavior are unchanged unless a
      separately approved migration says otherwise.
- [ ] Tests mirror their production owner and assert observable semantics rather
      than private file placement.
- [ ] Every moved or split module has a matching primary exported symbol and
      filename; no unexplained new repository checker finding remains on the
      changed surface.
- [ ] Canonical internal code bypasses every compatibility-only wrapper and
      implicit global composition route.
- [ ] Re-run the concrete-slice file-size and AST 40/50/60 inventory on final
      code. Every materially touched file over 800 lines and function over 60
      lines is split at a coherent boundary or has explicit human approval and a
      current `docs/repo-code-style-exceptions.md` entry.
- [ ] All changed files satisfy full recursive touched-file standards closure;
      independent untouched code remained outside closure.
- [ ] Focused behavior tests, shared/shared-web/shared-server typechecks,
      affected API/app checks, public API snapshots, style, changed-range,
      structure, legacy, and publication gates are reported as passed, failed,
      unavailable, or skipped.

## Explicit Non-Goals

- Do not move authoritative server state, Hono routes, Postgres adapters,
  browser facade composition, or app-specific runtime wiring into shared.
- Do not redesign protocols, persisted formats, authoritative state behavior,
  CRDT semantics, WebRTC policy, AL QoS, or product authority as part of folder
  ownership recovery.
- Do not remove public exports, deep paths, or apparent aliases without an
  authenticated consumer/contract inventory and explicit approval when
  required.
- Do not split files mechanically by line count or create one helper,
  interface, adapter, controller, or barrel per file.
- Do not replace generic `services/` or `repository/` with generic `runtime/`,
  `core/`, `common/`, `helpers/`, or `types/` buckets.
- Do not move all 107 tests in a test-only churn slice; move each test with the
  production owner whose behavior it verifies.
- Do not execute more than the next two evidence-backed slices at once.

## Completion Handoff

For every slice, report:

- changed files and the owner-to-result behavior made easier to trace;
- why each keep/split/move/consolidate decision was chosen;
- public, deep-import, protocol, persisted, cross-runtime, and app compatibility
  dispositions;
- exact passed, failed, unavailable, and skipped validation;
- affected legacy dispositions and any approved registry entry;
- the code-only navigation probe result;
- the final concrete-slice file-size tiers and 40/50/60 function inventory,
  including the disposition of every touched over-800-line file and over-60-line
  function;
- remaining feature debt and the next one or two evidence-backed outcomes;
- the updated Wave 6 status in
  `plans/repo-human-traceability-refactoring-program-plan.md` or its explicitly
  approved successor ledger;
- confirmation that every changed human-authored file was reviewed in full,
  support-file remediation recursively reached closure, and independent
  untouched files stayed outside closure;
- follow-up issue URLs, or `Follow-up: None`.
