# Rallar Group-State Server Traceability QA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the authoritative group-state path published by PR #59 easier for
a human to locate and trace by strengthening the repository review contract in
one guidance PR, then applying behavior-neutral, test-first traceability fixes
in one server QA PR.

**Architecture:** PR A updates only repository skills, human-review guidance,
test discoverability, and independent lineage-governance evidence. PR B keeps
every runtime and public contract fixed while exposing the construction and
AppInbox-to-result timelines through descriptive symbols, complete dependency
registration, a focused inbox translation owner, an immutable transaction
result, narrow handler capabilities, and an explicit timing adapter instead of
dynamic service dispatch. The two PRs publish independently; the server
child's later evidence ledger waits for both.

**Tech Stack:** Markdown repo skills and plans, TypeScript 7.0.2, Vitest,
`@babel/parser`, Deno, AppInbox, Git, and GitHub Actions.

## Global Constraints

- This plan is a follow-up child of the
  [Repository Human Traceability Refactoring Program](repo-human-traceability-refactoring-program-plan.md)
  and a quality-assurance successor to
  [the authoritative group-state server structure child](rallar-group-state-server-structure-plan.md).
- The human must approve this exact plan Git blob before either implementation
  PR begins. Plan approval authorizes implementation scope, not either merge.
- PR A is skills, review guidance, test ownership, and an independent audit of
  PR #59's structural-lineage declarations only. It changes no production code,
  checker implementation, checker output, rule, count, severity, or strictness.
- PR B is behavior-neutral group-state traceability work only. It changes no
  HTTP, queue, public TypeScript, persisted, storage-key, receipt, event, outbox,
  timing-event, retry, transaction, or concurrency contract.
- Preserve TypeScript `7.0.2`, every dependency and lockfile, workflow
  definition, and warning-only full-repository checker behavior.
- Preserve AppInbox as the sole transaction and retry owner. Keep the visible
  order `read -> compute -> validate -> write(transaction, computed)`, with the
  operation-specific conditional guard first and receipt/event/final outbox
  writes in the same transaction.
- Preserve every existing public import path, direct one-hop compatibility
  export, AppInbox type, operation mapping, error string, default, omission,
  cloning rule, volatile-value invocation point, canonical ordering rule, cache
  observation, and wake timing.
- Do not reorganize API-v1 routes, OpenAPI, browser code, topology ownership,
  RTC RTT ownership, or another mutation domain in this child.
- Preserve
  `plans/rallar-rest-snapshot-read-convergence-implementation-plan.md`
  unchanged.
- Keep every human-authored module at or below 400 physical lines and every new
  or materially changed general function at or below 60 physical lines. Size
  never authorizes a pass-through helper or another compatibility hop.
- Use two non-default implementation branches and two pull requests in order.
  PR B starts only after PR A's exact resulting `main` SHA passes **Run Hetzner
  Supported Distributed Manifests**.
- No implementation PR may merge without a separate exact human decision.
- Construction-detail findings in changed production code require an explicit
  human disposition. PR A does not make every optional construction warning
  globally blocking; checker calibration or schema enforcement requires a
  separately approved governance child.
- The later server evidence ledger remains separately authorized after PR B.
  The API-v1 child remains blocked until that ledger is `ledger-published`.

---

Date: 2026-08-01

Status: Review-driven revision drafted and unapproved. Planning publication
does not authorize PR A or PR B.

## 1. Prerequisite And Scope Boundary

PR #59 is the immutable implementation prerequisite for this QA child:

- approved-base SHA: `52d973bb71dda2100455e8585a0a8f98d177bd13`;
- final feature head: `bec8bea4eb095de9ad3a6b47c18e6799ab811239`;
- frozen feature tree: `c1ac6a57dad974d04264cbe1fa92313697256712`;
- Branch Release Gate run `30694693554`, attempt 1, success for that exact head;
- PR #59, “refactor: separate authoritative group state server owners”;
- squash result on `main`: `06e0c5ab138c2ab55ac519b2244f727acd42d560`;
- resulting `main` tree: `c1ac6a57dad974d04264cbe1fa92313697256712`;
- **Run Hetzner Supported Distributed Manifests** run `30697799787`, attempt 1,
  success for that exact `main` SHA.

These facts prove that PR #59 was safely published. They do not relabel its
separate Task 10 ledger as published. The server child remains
implementation-published with later-ledger publication pending.

The QA child addresses only review findings about human navigation. Re-review
against final feature head `bec8bea4eb095de9ad3a6b47c18e6799ab811239`
and resulting `main` `06e0c5ab138c2ab55ac519b2244f727acd42d560`
distinguishes the final state from the earlier reviewed head
`57e7d57f51c0a88a854919dcafeb0ba06125c1a5`:

1. **Still present:** the standards do not require one code-derived trace for
   each materially different callback, transaction, retry, protocol, or
   lifecycle family, nor do they require the complete registration/runtime,
   failure, cleanup, and caller-visible-result evidence in Section 2.
2. **Still present:** required topology and RTC RTT processing dependencies are
   assigned after the constructor has registered their callbacks. The final
   handlers are stateless and accept mandatory dependencies explicitly, which
   fixed the earlier handler-owned late binding, but the public facade still
   exposes a use-before-configuration interval.
3. **Still present:** `GroupStateInboxHandler.commitMutation` mutates
   `committedSnapshot` inside the AppInbox transaction callback and consumes it
   after callback return. The transaction writer persists the callback's return
   value, so replacing it with a compound result without an explicit durable
   projection would corrupt the persisted AppInbox result contract.
4. **Still present:** `group-state-inbox-handler.ts` combines the direct
   mutation phase sequence with AppInbox-payload-to-descriptor routing, and its
   broad `GroupStateService` input hides the smaller capability set used by the
   handler.
5. **Still present:** `group-state-service.ts` uses `Proxy`, `Reflect.get`,
   variadic arguments, and `Function.apply` for timing, so symbol navigation
   cannot show which timed method calls which operation.
6. **Still present:** internal names disagree with behavior or filenames:
   `resolve-group-mutation-target.ts` exports unprefixed resolver names,
   `writeResult` is pure computation, and `write-group-state-mutation.ts`
   disagrees with `writeGroupMutation`. Nineteen historical
   `task10-route-closure-correction*` test modules and
   `read-compute-write-contract.test.ts` remain hard to discover.
7. **Still present:** the structural-lineage mechanism validates merge base,
   source blob, target existence, uniqueness, and required compatibility paths,
   but it does not prove symbol- or span-level derivation. The benefiting PR
   supplied its own manifest, so its 17 remaining lineages require independent
   human provenance review before their historical style-debt capacity is
   treated as trustworthy precedent.
8. **Fixed after the earlier head:** presence lifecycle ownership is now direct
   named functions in `group-state/presence/group-presence-service.ts`, and
   `services/app-group-ws-session-lifecycle.ts` is a direct re-export-only
   compatibility path. PR B records and protects that result; it does not
   recreate a static `GroupPresenceService` class.
9. PR #59's feature ownership, mutation phase separation, persistence owners,
   AppInbox authority, topology and RTC RTT algorithms, mirrored test placement,
   final PGlite semantics, and explicit stateless handler operations remain
   accepted and are not reopened.

## 2. Human Traceability Acceptance Contract

After PR B, a reviewer who starts with `AppInboxType.GROUP_CREATE` must be able
to follow two separate timelines from production symbols without consulting
this plan. Registration is not presented as runtime processing.

```text
construction:
  AppGroupInboxService.constructor
    -> registerGroupStateMessageHandlers
       -> AppInboxService.onStateMessage               # group callbacks live

configuration before queue processing is enabled:
  create-rallar-server.ts
    -> AppGroupInboxService.setTopologyManagementService
       -> registerTopologyStateMessageHandlers         # captures complete service
    -> AppGroupInboxService.setRtcRttAppInboxDependencies
       -> registerRtcRttStateMessageHandler            # captures complete dependencies

request and enqueue preparation:
  AppGroupInboxService.processAuthenticatedEntryUntilCompletionResult
    -> prepareAuthenticatedGroupMutation
       -> toGroupMutationDescriptor
       -> GroupStateService.prepareMutation
    -> AppInboxService.processEntryUntilCompletionResult
       -> processEntryUntilCompletionInternal
          -> enqueueIfAbsent
          -> waitForCompletion

reserved queue attempt through the registered handler:
  AppInboxService.onStateMessage handler
    -> AppInboxTransactionWriter.begin
    -> GroupStateInboxHandler.processGroupStateMutation
       -> GroupStateInboxMutationOperations.read
       -> GroupStateInboxMutationOperations.compute
       -> GroupStateInboxMutationOperations.validate
       -> GroupStateInboxHandler.commitMutation
          -> AppInboxTransactionWriter.writeMutationWithAfterCommitResult
             -> runInTransaction
                -> GroupStateInboxMutationOperations.write
                   -> writeGroupMutation
                      -> conditional guard
                      -> authoritative effects
                      -> event
                      -> receipt/idempotency record
                      -> final APP_OUTBOX rows
                -> readGroupStateInboxResult
                -> project exact predecessor durable result
                -> ResourceInboxResultsRepository.replace
                -> ResourceInboxRepository.finishReserved
             -> transaction commits; immutable private after-commit result returns
          -> GroupStateInboxMutationOperations.observeSnapshot after commit
          -> wakeQueue after commit

waiting caller:
  AppInboxService.waitForCompletion
    -> findByKeyAndReturnEither
    -> durable AppInbox result returned to the caller
```

PR A requires one such code-derived trace for every materially different
callback, transaction, retry, protocol, or lifecycle family. Message variants
that share the same control-flow family use one trace plus an explicit variant
inventory; they do not require redundant diagrams. Each trace names:

- the external or protocol entry;
- callback registration owner and registration time;
- runtime invoker and callback invocation count or retry rule;
- representation translation and read, compute, validate, and write owners;
- transaction and retry owner and the first conditional guard;
- receipt, event, exact durable result, and final outbox writes;
- commit-return point and private after-commit data;
- after-commit effects, early exits, failures, and cleanup; and
- final caller-visible result and canonical versus compatibility paths.

The transaction-callback review rule is fail-closed: mutable values do not
escape a transaction callback unless the transaction contract explicitly proves
invocation count, retry behavior, commit semantics, failure behavior, and why
mutation is safe. The preferred shape is an immutable result whose durable
projection is visibly distinct from private after-commit data.

Passing tests or checker output does not answer these questions. PR A makes this
an explicit human-review deliverable; PR B makes the representative path visible
in the code.

## 3. Exact Current And Target Trees

### 3.1 PR A guidance and traceability-analysis tree

Current owners:

```text
.agents/skills/publishing-plan-progress/SKILL.md
.agents/skills/rallar-code-writing/
  SKILL.md
  references/
    convergent-service-writing.md
    repo-code-style.md
.agents/skills/rallar-realtime/SKILL.md
.agents/skills/rallar-testing/SKILL.md
.agents/skills/rallar-testing/references/test-commands.md
docs/repo-human-style-guide.md
plans/repo-style-lineages/
  rallar-group-state-server-structure.json
packages/tests/repo/
  rallar-skill-integrity.test.ts
  repo-code-style-integrity.test.ts
packages/tests/rallar-black-box/rallar-testing-skill.test.ts
packages/tests/shared-server/
  task10-route-closure-correction.test.ts
  task10-route-closure-correction-2.test.ts
  task10-route-closure-correction-4.test.ts
  task10-route-closure-correction-5.test.ts
  task10-route-closure-correction-6.test.ts
  task10-route-closure-correction-7.test.ts
  task10-route-closure-correction-8.test.ts
  task10-route-closure-correction-9.test.ts
  task10-route-closure-correction-10.test.ts
  task10-route-closure-correction-11.test.ts
  task10-route-closure-correction-12.test.ts
  task10-route-closure-correction-13.test.ts
  task10-route-closure-correction-14.test.ts
  task10-route-closure-correction-15-executor.test.ts
  task10-route-closure-correction-15.test.ts
  task10-route-closure-correction-16.test.ts
  task10-route-closure-correction-17.test.ts
  task10-route-closure-correction-18.test.ts
  task10-route-closure-correction-19.test.ts
```

Target owners:

```text
.agents/skills/publishing-plan-progress/SKILL.md
.agents/skills/rallar-code-writing/
  SKILL.md
  references/
    convergent-service-writing.md
    repo-code-style.md
.agents/skills/rallar-realtime/SKILL.md
.agents/skills/rallar-testing/SKILL.md
.agents/skills/rallar-testing/references/test-commands.md
docs/repo-human-style-guide.md
plans/repo-style-lineages/
  rallar-group-state-server-structure.json
  rallar-group-state-server-structure-provenance.md
packages/tests/repo/
  rallar-authoritative-mutation-guidance-integrity.test.ts
  rallar-group-state-owner-integrity.test.ts
  rallar-skill-app-examples-integrity.test.ts
  rallar-skill-plugin-publication-integrity.test.ts
  repo-code-style-authority-integrity.test.ts
  repo-code-style-checker-integrity.test.ts
  repo-code-style-review-evidence-integrity.test.ts
  repo-style-structural-lineage-provenance.test.ts
packages/tests/rallar-black-box/rallar-testing-skill.test.ts
packages/tests/shared-server/
  mutation-route-owner-analysis.test.ts
  mutation-route-owner-boundary-traversal.test.ts
  mutation-route-owner-provenance.test.ts
  mutation-route-owner-registration-collections.test.ts
  mutation-route-owner-registration-predicates.test.ts
  mutation-route-owner-logical-predicates.test.ts
  mutation-route-owner-call-effects.test.ts
  mutation-route-owner-object-projections.test.ts
  mutation-route-owner-map-projections.test.ts
  mutation-route-owner-lexical-resolution.test.ts
  mutation-route-owner-call-aliases.test.ts
  mutation-route-owner-control-flow-alternatives.test.ts
  mutation-route-owner-loop-and-switch-flow.test.ts
  mutation-route-owner-execution-state.test.ts
  mutation-route-owner-abrupt-completion.test.ts
  mutation-route-owner-loop-completion.test.ts
  mutation-route-owner-loop-divergence.test.ts
  mutation-route-owner-loop-fixed-point.test.ts
  mutation-route-owner-state-coalescing.test.ts
```

The provenance document is independent evidence, not a checker input. For each
of the 17 remaining PR #59 manifest rows it records the exact approved-base
source path/blob, source symbol or line span, target symbol or line span,
mechanical-move classification, semantic additions excluded from inherited
capacity, and human disposition. Its focused integrity test proves complete
manifest/target coverage and active paths, while human review proves actual
derivation. Neither file changes lineage loading or style-debt accounting.

The nineteen test moves preserve every test body, fixture, literal, mutation,
and assertion site. Their `describe` titles change from historical task numbers
to the same descriptive responsibility as the filename. No analyzer or
production checker behavior changes in PR A.

### 3.2 PR B group-state production and test tree

Current directly affected production tree:

```text
packages/shared-server/rallar-system/
  services/
    AppGroupInboxService.ts
    AppInboxService.ts
    app-group-ws-session-lifecycle.ts
    app-inbox-transaction-writer.ts
  group-state/
    group-state-service-contracts.ts
    group-state-service.ts
    inbox/
      group-state-inbox-contracts.ts
      group-state-inbox-handler.ts
      group-state-inbox-result.ts
    mutation/
      group-mutation-result.ts
      aggregate/
        compute-group-aggregate-mutation.ts
      membership/
        compute-group-membership-mutation.ts
      orchestration/
        resolve-group-mutation-target.ts
      presence/
        compute-group-presence-mutation.ts
      read/
        resolve-group-mutation-read-identities.ts
      result-validation/
        validate-computed-group-mutation-write.ts
      write/
        compute-group-membership-write.ts
        write-group-state-mutation.ts
    presence/
      group-presence-service.ts
```

Target directly affected production tree:

```text
packages/shared-server/rallar-system/
  services/
    AppGroupInboxService.ts
    AppInboxService.ts
    app-group-ws-session-lifecycle.ts
    app-inbox-transaction-writer.ts
  group-state/
    group-state-service-contracts.ts
    group-state-service.ts
    group-state-service-timing.ts
    inbox/
      group-state-inbox-contracts.ts
      group-state-inbox-handler.ts
      group-state-inbox-mutation-descriptor.ts
      group-state-inbox-result.ts
    mutation/
      group-mutation-result.ts
      aggregate/
        compute-group-aggregate-mutation.ts
      membership/
        compute-group-membership-mutation.ts
      orchestration/
        resolve-group-mutation-target-identity.ts
      presence/
        compute-group-presence-mutation.ts
      read/
        resolve-group-mutation-read-identities.ts
      result-validation/
        validate-computed-group-mutation-write.ts
      write/
        compute-group-membership-write.ts
        write-group-mutation.ts
    presence/
      group-presence-service.ts
```

Current directly affected test/support tree:

```text
apps/api-v1/test/
  rallar-server.test.ts
packages/tests/repo/
  group-state-server-source-ratchet-inventory.ts
  group-state-server-source-ratchet.test.ts
packages/tests/shared-server/
  app-inbox-test-database.ts
  app-inbox-transaction.test.ts
  rallar-middleware.test.ts
  topology-app-inbox-ownership.test.ts
  mutation-routing-owner-inventory.ts
  read-compute-write-contract.test.ts
  read-compute-write-source-analysis.ts
  group-state/
    group-state-service-idempotency.test.ts
    group-state-test-mutation-executor.ts
    inbox/
      group-state-inbox-authority.test.ts
      group-state-inbox-construction.test.ts
      group-state-inbox-operation-matrix.test.ts
      group-state-inbox-retry.test.ts
      group-state-inbox-test-runtime.ts
    mutation/
      write-group-state-mutation-behavior.test.ts
```

Target directly affected test/support tree:

```text
apps/api-v1/test/
  rallar-server.test.ts
packages/tests/repo/
  group-state-server-source-ratchet-inventory.ts
  group-state-server-source-ratchet.test.ts
  group-state-source-ratchet-function-sizes.ts
  group-state-traceability-active-paths.test.ts
packages/tests/shared-server/
  app-inbox-test-database-contracts.ts
  app-inbox-test-database-sql.ts
  app-inbox-test-database-transaction.ts
  app-inbox-test-database.ts
  app-inbox-transaction.test.ts
  rallar-middleware.test.ts
  topology-app-inbox-ownership.test.ts
  authoritative-mutation-read-compute-validate-write.test.ts
  authoritative-mutation-source-analysis.ts
  mutation-routing-owner-inventory.ts
  group-state/
    group-state-service-idempotency.test.ts
    group-state-service-timing-fixture.ts
    group-state-service-timing.test.ts
    group-state-test-mutation-executor.ts
    inbox/
      app-group-inbox-registration-lifecycle.test.ts
      group-state-inbox-authority.test.ts
      group-state-inbox-construction.test.ts
      group-state-inbox-descriptor-contract.test.ts
      group-state-inbox-operation-matrix.test.ts
      group-state-inbox-resource-fixtures.ts
      group-state-inbox-retry.test.ts
      group-state-inbox-test-runtime.ts
      group-state-inbox-transaction-failures.test.ts
      group-state-inbox-transaction-result.test.ts
      group-state-transaction-boundary-fixture.ts
    mutation/
      write-group-mutation-behavior.test.ts
```

The production target remains limited to the approved explicit timing and
descriptor owners plus the transaction/handler refinements and descriptive
internal moves. Task 5 adds only cohesive timing and transaction test owners.
The in-memory database test support separates its public factory, contracts,
SQL-family dispatch and stage hooks, and transaction publication/commit owners;
its existing defaults and every consumer remain unchanged:

- `group-state-inbox-mutation-descriptor.ts` owns the exact AppInbox payload to
  `GroupMutationDescriptor` translation now embedded below the direct phase
  sequence in `group-state-inbox-handler.ts`.
- `group-state-service-timing.ts` owns the real timing/instrumentation boundary
  through explicit `GroupStateService` operations.
- `app-inbox-transaction-writer.ts` owns the immutable split between the exact
  persisted durable value and private data returned only after commit; no
  compound internal result is serialized.
- `group-state-inbox-contracts.ts` owns one cohesive, named handler-facing
  capability contract rather than exposing the entire service surface.
- the registration-lifecycle and transaction-result suites own the temporal
  and serialization/commit-return behavior introduced by this revision.
- target-identity and mutation-write filenames align with their primary
  symbols without adding aliases or compatibility hops.

It does not add a facade, barrel, callback chain, dependency bag, state owner,
or compatibility path.

### 3.3 Traced unchanged construction and compatibility consumers

Task 5 re-runs this inventory before editing. These known paths remain consumers
or compatibility evidence, not move targets:

```text
packages/shared-server/mod.ts
packages/shared-server/rallar-system/middleware/RallarMiddleware.ts
apps/api-v1/src/
  create-rallar-server.ts
  middleware.ts
  services/create-api-admin-mutation-gateway.ts
apps/api-v1/test/
  rallar-server.test.ts
  db/
    pglite-app-inbox-ws-close-test-harness.ts
    pglite-sql-adapter.test.ts
examples/server-middleware/README.md
packages/tests/shared-server/
  app-inbox-expired-row-replacement.test.ts
  app-inbox-ws-close-test-harness.ts
  group-state/inbox/
    group-state-inbox-authority.test.ts
    group-state-inbox-retry.test.ts
    group-state-inbox-test-runtime.ts
  fixtures/postgres-app-inbox-worker-services.ts
```

The package export makes the class and setters a compatibility surface even if
the repository has no additional setter call. Every newly discovered consumer
must be classified as unchanged, direct-test-only, or an exact in-scope import/
registration edit. A production consumer outside the listed server composition
path, a preconfiguration processing dependency, or a need for a new shim stops
execution for human review.

## 4. Exact Move And Symbol Map

### 4.1 PR A guidance and independent-governance map

| Owner                                                   | Exact addition                                                                                                                                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rallar-code-writing/SKILL.md` and `repo-code-style.md` | Require family-level code-derived traces, the complete fields in Section 2, immutable transaction callback outputs, temporary-ratchet ownership/removal, and human disposition of changed production construction warnings. |
| `convergent-service-writing.md`                         | Require visible AppInbox registration/runtime timelines, transaction callback semantics, durable/private result separation, retry re-entry, first guard, atomic writes, commit return, and after-commit effects.            |
| `rallar-realtime/SKILL.md`                              | Name `group-state/**`, `topology/inbox/**`, and `rtc-topology/inbox/**` as canonical; identify applicable old `services/**` paths as compatibility-only.                                                                    |
| `rallar-testing/SKILL.md` and `test-commands.md`        | Require behavior-named test modules and semantic entry/transaction/exit assertions; register the nineteen renamed suites and PR B focused suites.                                                                           |
| `publishing-plan-progress/SKILL.md`                     | Require a written stacked-versus-single decision at review pressure, a one-screen read-first map for an accepted large PR, and exact current head/tree/workflow evidence with stale evidence corrected before completion.   |
| `docs/repo-human-style-guide.md`                        | Add the code-only trace exercise, construction-warning disposition, temporary-ratchet review, and large-review evidence checklist.                                                                                          |
| `rallar-group-state-server-structure-provenance.md`     | Record the independent, target-by-target symbol/span derivation audit and exclude semantically new code from inherited style-debt capacity.                                                                                 |
| focused integrity tests                                 | Prove concepts, active paths, all manifest/target rows, and renamed test discoverability without implementing a checker rule.                                                                                               |

Review pressure is present when **any** of these is true: more than 100 changed
files, more than 10,000 changed lines (`additions + deletions`), more than 20
changed production modules, or more than three materially different control-flow
families. The numbers require a written decision; they do not mechanically
require a split. Cohesion, dependency order, compatibility risk, and ability to
review one invariant at a time remain the human decision. If one PR is accepted,
its body must contain a one-screen ordered map of entry owners, transaction/exit
owners, compatibility surfaces, review slices, and exact evidence.

Literal, named-case, `expect(...)`, and exact-tree inventories are temporary
migration ratchets. Every such ratchet records its owner and removal condition:
remove or replace it after the move's resulting-main workflow and later ledger
are published, when semantic runtime/architecture assertions directly cover the
same loss risk. A ratchet never substitutes for runtime behavior.

For changed production files, the PR review map lists every construction-detail
warning by path, rule, and symbol and records one human disposition: fixed,
demonstrated false positive, or accepted existing debt with no new/worsened
magnitude and an owner. Silence or a warning-only exit code is not a disposition.
This evidence remains in the PR/handoff; it does not change global checker
strictness.

### 4.2 PR A historical test ownership moves

| Current path                                          | Target path                                              | Target suite responsibility                    |
| ----------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| `task10-route-closure-correction.test.ts`             | `mutation-route-owner-analysis.test.ts`                  | public analyzer and complete route inventory   |
| `task10-route-closure-correction-2.test.ts`           | `mutation-route-owner-boundary-traversal.test.ts`        | recursive import traversal and exact handoffs  |
| `task10-route-closure-correction-4.test.ts`           | `mutation-route-owner-provenance.test.ts`                | mutable capability and receiver provenance     |
| `task10-route-closure-correction-5.test.ts`           | `mutation-route-owner-registration-collections.test.ts`  | imported registration collections              |
| `task10-route-closure-correction-6.test.ts`           | `mutation-route-owner-registration-predicates.test.ts`   | exact registration predicates                  |
| `task10-route-closure-correction-7.test.ts`           | `mutation-route-owner-logical-predicates.test.ts`        | logical predicate evaluation                   |
| `task10-route-closure-correction-8.test.ts`           | `mutation-route-owner-call-effects.test.ts`              | executed and non-executed calls                |
| `task10-route-closure-correction-9.test.ts`           | `mutation-route-owner-object-projections.test.ts`        | `Object` projections                           |
| `task10-route-closure-correction-10.test.ts`          | `mutation-route-owner-map-projections.test.ts`           | `Map` projections                              |
| `task10-route-closure-correction-11.test.ts`          | `mutation-route-owner-lexical-resolution.test.ts`        | lexical shadowing and assignment order         |
| `task10-route-closure-correction-12.test.ts`          | `mutation-route-owner-call-aliases.test.ts`              | bind, call, apply, factory, and global aliases |
| `task10-route-closure-correction-13.test.ts`          | `mutation-route-owner-control-flow-alternatives.test.ts` | conditional alternatives                       |
| `task10-route-closure-correction-14.test.ts`          | `mutation-route-owner-loop-and-switch-flow.test.ts`      | loop joins and switch fallthrough              |
| `task10-route-closure-correction-15-executor.test.ts` | `mutation-route-owner-execution-state.test.ts`           | execution-state coalescing                     |
| `task10-route-closure-correction-15.test.ts`          | `mutation-route-owner-abrupt-completion.test.ts`         | abrupt completion and `finally`                |
| `task10-route-closure-correction-16.test.ts`          | `mutation-route-owner-loop-completion.test.ts`           | loop update/test completion                    |
| `task10-route-closure-correction-17.test.ts`          | `mutation-route-owner-loop-divergence.test.ts`           | divergent loop flow                            |
| `task10-route-closure-correction-18.test.ts`          | `mutation-route-owner-loop-fixed-point.test.ts`          | per-path loop fixed points                     |
| `task10-route-closure-correction-19.test.ts`          | `mutation-route-owner-state-coalescing.test.ts`          | bounded route-state coalescing                 |

### 4.3 PR B production and test moves

| Current owner                                                                                 | Target owner                                                                                                                                                                                             | Locked responsibility                                                                                                                                             |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| descriptor switches and `to*MutationDescriptor` helpers inside `group-state-inbox-handler.ts` | exported `toGroupMutationDescriptor` and private family helpers in `group-state-inbox-mutation-descriptor.ts`                                                                                            | exact payload-to-domain translation, switch order, errors, and field projection                                                                                   |
| `GroupStateInboxHandler.processMutation`                                                      | `GroupStateInboxHandler.processGroupStateMutation`                                                                                                                                                       | direct protocol entry with visible read/compute/validate/commit sequence                                                                                          |
| dynamic `withGroupStateServiceTiming` and proxy-specific helpers in `group-state-service.ts`  | exported `createTimedGroupStateService` and private detail helpers in `group-state-service-timing.ts`                                                                                                    | identical timing names/details with one explicit wrapper per operation                                                                                            |
| constructor-time topology/RTC registration over optional facade fields                        | group callbacks register in construction; topology/RTC callbacks register exactly once when each existing setter receives its complete mandatory dependency, before queue processing is enabled          | no live callback resolves an optional processing dependency; existing public setters remain one-hop lifecycle compatibility surfaces                              |
| mutable `committedSnapshot` escaping the group transaction callback                           | immutable `AppInboxMutationTransactionResult<Durable, AfterCommit>` returned through a transaction-writer operation that persists only `durableResult` and returns `afterCommitResult` only after commit | exact predecessor durable JSON/property order and private committed-snapshot identity                                                                             |
| broad handler dependency on `GroupStateService`                                               | `GroupStateInboxMutationOperations` in `group-state-inbox-contracts.ts`                                                                                                                                  | one cohesive internal port containing exactly the mutation phases, lifecycle guard operations, and snapshot observation; broad exported service remains unchanged |
| `resolve-group-mutation-target.ts` / `mutationTargetPrincipalId` / `mutationTargetSessionId`  | `resolve-group-mutation-target-identity.ts` / `resolveGroupMutationTargetPrincipalId` / `resolveGroupMutationTargetSessionId`                                                                            | exact pure target identity rules                                                                                                                                  |
| pure `writeResult` in `group-mutation-result.ts`                                              | `computeGroupMutationWrite`                                                                                                                                                                              | exact pure computed-result construction; no write occurs                                                                                                          |
| `write-group-state-mutation.ts` exporting `writeGroupMutation`                                | `write-group-mutation.ts` exporting unchanged internal `writeGroupMutation`                                                                                                                              | filename and primary symbol agree; write order and persistence behavior unchanged                                                                                 |
| `write-group-state-mutation-behavior.test.ts`                                                 | `write-group-mutation-behavior.test.ts`                                                                                                                                                                  | exact behavior cases and assertions follow the canonical write owner                                                                                              |
| `read-compute-write-contract.test.ts`                                                         | `authoritative-mutation-read-compute-validate-write.test.ts`                                                                                                                                             | authoritative phases, transaction, outbox, and ownership                                                                                                          |
| `read-compute-write-source-analysis.ts`                                                       | `authoritative-mutation-source-analysis.ts`                                                                                                                                                              | source extraction owned by that suite                                                                                                                             |

`AppGroupInboxService.ts`, its public class, constructor, setter names, and every
package/app import path remain in place. The setter inventory includes API-v1
bootstrap, PGlite/PostgreSQL workers and tests, topology ownership tests, and
the package-exported class itself. Each setter becomes an explicit one-time
registration/configuration compatibility surface: same object is idempotent,
different object preserves the predecessor error, and its registered callback
captures the supplied mandatory value immutably. Removal requires a separately
approved public-consumer inventory and migration. Existing one-hop exports
remain unchanged unless an import-only correction is required by an exact move.

## 5. PR A: Skills And Review Guidance Contract

PR A adds one consistent requirement, not competing rule sets:

1. `rallar-code-writing/SKILL.md`, `repo-code-style.md`, and
   `convergent-service-writing.md` require the Section 2 family-level trace and
   immutable transaction-callback rule. The review starts at code symbols,
   separates registration from invocation, and cannot be satisfied by a plan,
   inventory count, or source-text assertion.
2. `rallar-realtime/SKILL.md` names the final canonical `group-state/**`,
   `topology/inbox/**`, and `rtc-topology/inbox/**` owners. The applicable old
   `services/**` paths are documented as direct compatibility surfaces rather
   than canonical implementation locations.
3. `rallar-testing/SKILL.md` requires behavior-named test modules and semantic
   assertions at entry, transaction, commit return, after-commit, failure,
   cleanup, and final result. `test-commands.md` names the focused route-owner,
   registration-lifecycle, transaction-result, and authoritative mutation
   suites.
4. `publishing-plan-progress/SKILL.md` defines the Section 4.1 review-pressure
   triggers, requires the written stacked-versus-single decision and read-first
   map, and makes stale head/tree/workflow evidence a publication blocker.
5. `docs/repo-human-style-guide.md` adds the code-only review exercise,
   changed-production construction-warning disposition, temporary-ratchet
   ownership/removal review, and large-PR evidence checklist.
6. The independent provenance document audits every remaining PR #59 lineage
   target at symbol/span level, distinguishes moved debt from semantic additions,
   and records a human disposition. Its test proves complete deterministic
   coverage of the immutable manifest; it does not infer derivation.
7. Integrity tests assert the shared concepts and active paths without copying
   complete prose into brittle string snapshots. The nineteen route-owner
   suites receive descriptive filenames and `describe` titles with unchanged
   behavior, fixtures, literals, mutations, and assertion sites.

PR A adds no checker rule, parser behavior, lineage consumer, schema enforcement,
method scanner, test-name checker, severity, or strict mode. Semantic clarity
and provenance remain explicit human judgments. If review concludes that
automation is necessary, PR A records a proposed, separately approved
governance child and stops; it does not silently implement the rule.

## 6. PR B: Behavior-Neutral Code Contract

### 6.1 Inbound translation owner

`group-state-inbox-mutation-descriptor.ts` exposes exactly:

```ts
export function toGroupMutationDescriptor<V>(
  enqueue: AppInboxEnqueueInput<V>,
): GroupMutationDescriptor;
```

It preserves all existing operation groups, payload casts, field selections,
`mutationDescriptor` calls, switch order, and unsupported-type errors.
`AppGroupInboxService.prepareAuthenticatedGroupMutation` calls it directly
before `GroupStateService.prepareMutation`. The handler no longer owns or
exposes a pass-through `toMutationDescriptor` method.

`GroupStateInboxHandler.processGroupStateMutation` retains preparation-envelope
validation, attempt-count insertion, the presence-connect path, direct phases,
the AppInbox transaction callback, result assembly, after-commit observation,
and after-commit wake in their existing order.

### 6.2 Explicit timing boundary

`group-state-service-timing.ts` exposes exactly:

```ts
export interface CreateTimedGroupStateServiceInput {
  readonly service: GroupStateService;
  readonly timing: RallarTimingSink | undefined;
  readonly serviceId: string;
}

export function createTimedGroupStateService(
  input: CreateTimedGroupStateServiceInput,
): GroupStateService;
```

When `timing` is absent, the exact service object is returned. When present, the
returned object explicitly retains `sessionGenerationLifecycle`, `compute`, and
`validate` and explicitly wraps every currently timed async operation. Each
wrapper calls the same method exactly once and emits the same component,
operation, service ID, request, scope, group, principal, and session details.

The target contains no `Proxy`, `Reflect.get`, `Function.apply`, variadic
`GroupStateServiceArgument[]`, property-name dispatch, or runtime method
discovery. Timing is a real instrumentation boundary, so the explicit adapter is
not a pass-through exception.

### 6.3 Complete dependency registration

`AppGroupInboxService` preserves its exported class, positional constructor,
setter names/signatures, public methods, and one-hop package path. The target
changes only callback lifetime:

- construction registers the group mutation and cleanup families, whose
  complete dependencies are constructor-valid;
- the first `setTopologyManagementService(service)` stores `service` only as an
  identity/idempotence guard and registers the topology family exactly once;
  each callback captures that exact mandatory `service` value;
- the first `setRtcRttAppInboxDependencies(dependencies)` does the same for the
  RTC RTT callback and captures the complete mandatory dependency value;
- a repeated setter with the same object is a no-op and a different object
  throws the exact predecessor error;
- no registered callback reads an optional facade field, supplier, registry,
  service locator, or mutable closure at invocation time; and
- API-v1 construction tests prove both configuration calls finish before the
  inbox worker/server can process those message families.

Task 5 inventories every constructor and setter use, the exported package path,
API-v1 composition/mocks, PGlite tests, PostgreSQL worker fixtures, and topology
ownership tests before RED. It characterizes the supported bootstrap lifetime
and exact invalid configuration errors. If a real consumer requires topology or
RTC processing before configuration, or the correction requires changing a
public signature or supported observable behavior, execution stops for a new
human plan decision.

### 6.4 Immutable transaction result

`app-inbox-transaction-writer.ts` owns this internal contract:

```ts
export interface AppInboxMutationTransactionResult<DurableResult, AfterCommitResult> {
  readonly durableResult: DurableResult;
  readonly afterCommitResult: AfterCommitResult;
}
```

A descriptively named `writeMutationWithAfterCommitResult` operation accepts a
callback that returns that value. Inside the existing transaction it persists
only `durableResult`, with the exact predecessor JSON value and property order,
finishes the reservation, and records the exact durable finalization result.
Only after `runInTransaction` has returned successfully does it expose the
immutable compound value to its private caller. The existing `writeMutation`
surface and all non-group callers preserve their signature and behavior; both
operations share one cohesive private transaction/finalization owner rather
than duplicating the write sequence or adding a callback-based dependency bag.
The handler keeps the existing durable-only `writeMutation` dependency for the
inactive-presence result and adds the compound operation only for the path that
needs a committed snapshot. This prevents private after-commit machinery from
spreading to callers that do not need it.

`GroupStateInboxHandler.commitMutation` returns
`{ durableResult, afterCommitResult: { committedSnapshot } }` from the callback,
destructures it only after commit, observes the exact snapshot object, wakes in
the predecessor order, and returns only `durableResult`. A failed callback,
durable-result write, reservation finish, or commit exposes no private result,
performs no observation/wake, and remains under the existing AppInbox retry
classification. Tests compare independently written raw JSON, key order,
snapshot identity, invocation count, retry re-entry, failure behavior, receipts,
events, final outbox, observation, wake, and every public return.

### 6.5 Narrow handler-facing capability

`GroupStateInboxMutationOperations` is one internal cohesive interface, not a
new public service or interface-per-method family. It contains exactly
`read`, `compute`, `validate`, `write`, `sessionGenerationLifecycle`, and
`observeSnapshot`. `GroupStateInboxHandler` and the presence-connect operation
consume it; `AppGroupInboxService` supplies the existing broad
`GroupStateService` structurally. Preparation, listing, paging, event, cache,
and unrelated lifecycle operations do not appear in the handler port. The
exported `GroupStateService`, factory return, compatibility paths, and all
external consumers remain unchanged.

### 6.6 Naming and already-complete presence ownership

The Section 4.3 target-identity, compute-result, and mutation-write renames are
internal direct moves. Update only exact imports, direct tests, source
inventories. Final-main inventory proves no public or one-hop compatibility file
exports these three internal families, so remove the internal predecessor paths
and add no alias or re-export.

Final PR #59 already replaced the static/pass-through presence class with
direct functions in `group-state/presence/group-presence-service.ts`; the old
lifecycle module is re-export-only. PR B adds a ratchet and consumer assertion
for that final state and makes no presence lifecycle implementation change
except the type-only narrowing needed for the handler capability.

### 6.7 Traceability tests

Tests prove behavior, not prose:

- each `GROUP_*` AppInbox type produces the equivalent descriptor or exact
  predecessor error;
- create-group reaches `processGroupStateMutation`, direct phases, AppInbox
  `writeMutationWithAfterCommitResult`, service write, durable/private result
  assembly, observation, and wake in the locked order;
- timing absent returns the same object identity;
- timing present calls every async operation once and preserves event details;
  every async operation independently preserves its exact rejection identity,
  single underlying call, one error event, and operation-specific details;
- `compute` and `validate` remain synchronous and untimed;
- topology and RTC callbacks do not exist before complete configuration, capture
  the exact mandatory value once, and preserve setter idempotence/errors and
  runtime order;
- the immutable transaction result persists byte-for-byte equivalent durable
  JSON, never persists private snapshot data, exposes the same snapshot identity
  only after commit, and preserves every failure/retry/observation/wake path;
- the handler can be constructed from only its named capability and cannot
  reach unrelated broad service operations;
- final direct presence functions and their re-export-only compatibility file
  remain the single executable ownership path;
- route-owner and source-ratchet inventories use the exact new symbols/paths;
- public exports and every `AppGroupInboxService` consumer remain unchanged.

Source ratchets may prove ownership, absence of dynamic proxy constructs, and
active paths. They do not replace runtime order, timing, error, receipt, outbox,
retry, or convergence assertions.

## 7. Compatibility And Invariants

The following are locked and require a new human plan revision if threatened:

- `AppGroupInboxService` name, constructor, setter names/signatures, public
  methods, and path; only the Section 6.3 registration lifetime is approved;
- `GroupStateService`, mutation, request, response, receipt, event, snapshot,
  persisted, queue, and outbox shapes;
- all one-hop compatibility exports and existing package/app/test consumers;
- authentication, preparation authority, command hashing, facts, volatile IDs,
  queue resource IDs, and replay identity;
- AppInbox reservation, transaction, total attempts, backoff, fairness,
  classification, and complete fresh-attempt behavior;
- exact phase order, first conditional guard, optimistic compare-and-set,
  atomic state/event/receipt/outbox writes, collision rollback, and ordering;
- result assembly, snapshot observation, wake timing, and `Either` behavior;
- the exact persisted durable JSON value/property order and AppInbox
  finalization result; private after-commit data never becomes durable output;
- presence, topology, RTC RTT, admin, browser, and API-v1 behavior, including
  the already-complete direct-function presence owner;
- TypeScript 7.0.2, dependencies, workflows, warning-only checkers, and every
  approved performance threshold.

PR B crosses the authoritative mutation path, transaction-return boundary, and
registration lifecycle structurally even though it must remain behavior-neutral.
It does not move retry or transaction ownership or create a new concurrency
domain. It therefore requires the complete mutation, registration, transaction,
concurrency, and comparative-performance verification in Section 9. No result
may be waived or rerolled inside this plan.

## 8. Implementation Tasks

### Task 0: Publish And Approve This Planning Revision

**Files:**

- Modify: `plans/rallar-group-state-server-traceability-qa-plan.md`
- Modify: `plans/repo-human-traceability-refactoring-program-plan.md`
- Modify: `plans/repo-human-traceability-program-execution-plan.md`
- Modify: `plans/rallar-group-state-server-structure-plan.md`

- [ ] Verify the planning branch starts from exact `main`
      `06e0c5ab138c2ab55ac519b2244f727acd42d560` and tree
      `c1ac6a57dad974d04264cbe1fa92313697256712`.
- [ ] Resume draft PR #60 from exact predecessor planning head
      `3b427a29692316d11b32ceac0e2a4ce482803b88`, tree
      `e45a87769a4f84bd869f3e09a6905cd3fed9ce35`, and unapproved plan blob
      `aad13aecdd916b201b1511d9e76707a1caddc650`; create no replacement branch,
      goal, or PR.
- [ ] Record only already-existing PR #59 evidence; leave future planning, PR A,
      PR B, ledger, and API-v1 publication facts outside their producing trees.
- [ ] Run Section 9.1.
- [ ] Publish one non-default draft planning PR and require Branch Release Gate
      for its exact commit.
- [ ] Stop for human approval of the exact plan Git blob and later human merge
      of the planning PR. Do not begin PR A from an unmerged plan branch.

### Task 1: Start PR A And Capture Guidance, Lineage, And Test Inventories

**Files:**

- Delete: `packages/tests/repo/rallar-skill-integrity.test.ts`
- Delete: `packages/tests/repo/repo-code-style-integrity.test.ts`
- Create: `packages/tests/repo/rallar-skill-plugin-publication-integrity.test.ts`
- Create: `packages/tests/repo/rallar-skill-app-examples-integrity.test.ts`
- Create: `packages/tests/repo/rallar-authoritative-mutation-guidance-integrity.test.ts`
- Create: `packages/tests/repo/rallar-group-state-owner-integrity.test.ts`
- Create: `packages/tests/repo/repo-code-style-authority-integrity.test.ts`
- Create: `packages/tests/repo/repo-code-style-review-evidence-integrity.test.ts`
- Create: `packages/tests/repo/repo-code-style-checker-integrity.test.ts`
- Modify: `packages/tests/rallar-black-box/rallar-testing-skill.test.ts`
- Create: `packages/tests/repo/repo-style-structural-lineage-provenance.test.ts`
- Modify: `package.json` (`test:repo-governance` registration only)

- [ ] Start `codex/rallar-group-state-traceability-guidance` from the exact
      resulting `main` SHA of the planning PR after its default workflow.
- [ ] Inventory the exact 17 manifest rows, 48 unique targets, source blobs,
      compatibility paths, current source/target symbols, and changed regions.
- [ ] Record all nineteen route-owner filenames, `describe` titles, named cases,
      independently written literals, and `expect(...)` sites.
- [ ] Add focused assertions for Section 2 trace fields, canonical realtime
      paths, behavior-named tests, large-PR evidence, ratchet removal, human
      warning disposition, and complete provenance rows. Capture RED.
- [ ] Split the two superseded mixed integrity owners into the seven descriptive
      Task 1 owners, preserving every original case, fixture, literal,
      expectation, and assertion site; keep each module at or below 400 lines.

### Task 2: Implement The PR A Guidance Contract

**Files:**

- Modify: `.agents/skills/rallar-code-writing/SKILL.md`
- Modify: `.agents/skills/rallar-code-writing/references/repo-code-style.md`
- Modify:
  `.agents/skills/rallar-code-writing/references/convergent-service-writing.md`
- Modify: `.agents/skills/rallar-realtime/SKILL.md`
- Modify: `.agents/skills/rallar-testing/SKILL.md`
- Modify: `.agents/skills/rallar-testing/references/test-commands.md`
- Modify: `.agents/skills/publishing-plan-progress/SKILL.md`
- Modify: `docs/repo-human-style-guide.md`
- Test: the Task 1 integrity suites and the behavior-named testing guidance suite

- [ ] Use `superpowers:writing-skills` for the skill changes and verify their
      pressure scenarios before treating prose-integrity tests as sufficient.
- [ ] Add the single traceability/review contract in Sections 2, 4.1, and 5.
- [ ] Add pressure-scenario tests proving thresholds require a decision rather
      than an automatic split and stale evidence blocks completion.
- [ ] Keep semantic clarity and construction-warning disposition in human
      review; add no checker behavior, lineage consumer, rule, or strict mode.
- [ ] Run the Task 1 tests and capture GREEN evidence.
- [ ] Run `npm run test:repo-governance`.

### Task 3: Publish The Independent PR #59 Lineage Audit

**Files:**

- Create:
  `plans/repo-style-lineages/rallar-group-state-server-structure-provenance.md`
- Test:
  `packages/tests/repo/repo-style-structural-lineage-provenance.test.ts`

- [ ] For every manifest source/target, record exact source blob and symbol/span,
      target symbol/span, moved-versus-new classification, compatibility path,
      and capacity disposition. Semantically new target regions receive no
      inherited capacity.
- [ ] Have a reviewer independent of PR #59 implementation verify derivation
      from Git objects and record Critical/Important findings target by target.
- [ ] Fail if any target lacks defensible provenance. Do not edit the manifest,
      checker, loader, schema, or debt calculation in PR A.
- [ ] If automated enforcement is warranted, record a separate future
      governance proposal and keep it unapproved/unimplemented.

### Task 4: Rename Historical Tests, Review, And Publish PR A

**Files:**

- Move: the nineteen exact paths in Section 4.2
- Modify: direct imports, active commands, and coverage registries only where an
  exact old path exists

- [ ] Record the pre-move test names, fixtures, literals, mutations, and
      `expect(...)` site counts.
- [ ] Move each suite and update only its `describe` title and direct imports.
- [ ] Prove post-move test names, fixtures, literals, mutations, and assertion
      counts are identical except the approved descriptive `describe` titles.
- [ ] Run all nineteen renamed suites plus route-owner inventory/routing tests.
- [ ] Independently review guidance consistency, pressure scenarios, lineage
      provenance, unchanged checker behavior, test ownership, and exact scope;
      Critical 0 / Important 0 is required.
- [ ] Run Section 9.2 on the unchanged tree, publish draft PR A, require Branch
      Release Gate, and mark ready only when green.
- [ ] Stop for exact human merge approval; require the exact resulting `main`
      default workflow before Task 5.

### Task 5: Start PR B And Characterize Every Affected Control-Flow Family

**Files:**

- Modify:
  `packages/tests/shared-server/group-state/inbox/group-state-inbox-operation-matrix.test.ts`
- Create:
  `packages/tests/shared-server/group-state/group-state-service-timing.test.ts`
- Create:
  `packages/tests/shared-server/group-state/inbox/app-group-inbox-registration-lifecycle.test.ts`
- Create:
  `packages/tests/shared-server/group-state/inbox/group-state-inbox-transaction-result.test.ts`
- Create:
  `packages/tests/shared-server/group-state/inbox/group-state-inbox-transaction-failures.test.ts`
- Create:
  `packages/tests/shared-server/group-state/inbox/group-state-transaction-boundary-fixture.ts`
- Create:
  `packages/tests/shared-server/group-state/group-state-service-timing-fixture.ts`
- Modify: `packages/tests/shared-server/app-inbox-test-database.ts`
- Create: `packages/tests/shared-server/app-inbox-test-database-contracts.ts`
- Create: `packages/tests/shared-server/app-inbox-test-database-sql.ts`
- Create: `packages/tests/shared-server/app-inbox-test-database-transaction.ts`
- Modify: `packages/tests/shared-server/app-inbox-transaction.test.ts`
- Modify: `packages/tests/shared-server/rallar-middleware.test.ts`
- Modify: `packages/tests/shared-server/topology-app-inbox-ownership.test.ts`
- Modify: `apps/api-v1/test/rallar-server.test.ts`
- Create:
  `packages/tests/shared-server/group-state/inbox/group-state-inbox-descriptor-contract.test.ts`
- Create:
  `packages/tests/shared-server/group-state/inbox/group-state-inbox-resource-fixtures.ts`
- Modify:
  `packages/tests/shared-server/group-state/inbox/group-state-inbox-test-runtime.ts`
- Rename: the two source-contract files in Section 4.3
- Modify: direct imports and source-ratchet inventories
- Create: `packages/tests/repo/group-state-source-ratchet-function-sizes.ts`
- Create: `packages/tests/repo/group-state-traceability-active-paths.test.ts`
- Modify: `.agents/skills/rallar-testing/references/test-commands.md`
- Modify: `packages/shared-server/architecture.md`
- Modify: `docs/rallar-convergent-state-and-rtc-topology.md`

- [ ] Start `codex/rallar-group-state-traceability-runtime` from PR A's exact
      resulting `main` SHA after its default workflow.
- [ ] Re-inventory every `AppGroupInboxService` constructor/setter/public
      consumer and prove the supported configuration-to-worker-start lifetime.
- [ ] Characterize each materially different group, presence, topology, RTC,
      transaction/retry, and lifecycle family using the Section 2 fields.
- [ ] Lock every descriptor mapping/error, phase, callback invocation, retry,
      durable raw JSON/property order, private snapshot identity, commit failure,
      observation/wake, timing event, setter identity/error, and public result.
- [ ] Rename the source contract suite/helper without changing assertions.
- [ ] Record GREEN predecessor characterization.
- [ ] Add target source ratchets and capture RED only for not-yet-created owners
      and still-present dynamic proxy, mutable callback escape, optional live
      dependency, broad handler-port, and inconsistent-name constructs.
- [ ] Derive the complete Task 5 changed TypeScript owner set from PR A's exact
      resulting-main base and fail closed on an omitted path; allow only the
      exact unchanged reviewed predecessor `runOperationMatrix` at 64 lines.

### Task 6: Extract Descriptor Translation And Rename The Protocol Entry

**Files:**

- Create:
  `packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-mutation-descriptor.ts`
- Modify:
  `packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts`
- Modify: `packages/shared-server/rallar-system/services/AppGroupInboxService.ts`
- Modify: directly affected Task 5 tests/inventories

- [ ] Move descriptor code without rewriting branches, casts, values, or errors.
- [ ] Rename only the internal handler method to
      `processGroupStateMutation` and update exact internal callers.
- [ ] Remove the handler's pass-through descriptor method.
- [ ] Run descriptor, authority, operation, routing, retry, and ratchet tests.
- [ ] Obtain scoped review with Critical 0 / Important 0.

### Task 7: Replace Dynamic Timing Dispatch With Explicit Operations

**Files:**

- Create:
  `packages/shared-server/rallar-system/group-state/group-state-service-timing.ts`
- Modify: `packages/shared-server/rallar-system/group-state/group-state-service.ts`
- Test:
  `packages/tests/shared-server/group-state/group-state-service-timing.test.ts`
- Modify: directly affected source ratchets

- [ ] Implement the exact Section 6.2 interface and factory.
- [ ] Preserve no-timing identity and untimed synchronous `compute`/`validate`.
- [ ] Preserve every timed name, detail, call, return, rejection, and order.
- [ ] Delete only superseded proxy-specific types/helpers.
- [ ] Run timing, idempotency, handler, AppInbox, and ratchet tests.
- [ ] Obtain scoped review with Critical 0 / Important 0.

### Task 8: Make Topology And RTC Registration Construction-Valid

**Files:**

- Modify: `packages/shared-server/rallar-system/services/AppGroupInboxService.ts`
- Test: the registration, middleware, topology ownership, operation, and RTC
  suites named in Tasks 5 and Section 9.3

- [ ] Preserve the exact public constructor/setter surface and implement the
      Section 6.3 one-time registration lifecycle test-first.
- [ ] Prove no topology/RTC callback is live with an incomplete processing
      dependency and no callback reads mutable optional state at invocation.
- [ ] Prove normal composition, message registration order within each family,
      setter idempotence/error, queue processing, receipt/outbox, and result are
      unchanged. Stop if a real consumer needs preconfiguration processing.
- [ ] Obtain scoped review with Critical 0 / Important 0.

### Task 9: Return Immutable Transaction Data Through The AppInbox Owner

**Files:**

- Modify:
  `packages/shared-server/rallar-system/services/app-inbox-transaction-writer.ts`
- Modify: `packages/shared-server/rallar-system/services/AppInboxService.ts`
- Modify:
  `packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts`
- Modify:
  `packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts`
- Modify only as required for the narrow input type:
  `packages/shared-server/rallar-system/group-state/presence/group-presence-service.ts`
- Test: the transaction-result, AppInbox transaction, operation, retry,
  idempotency, presence, and source-ratchet suites

- [ ] Add the Section 6.4 immutable result RED/GREEN fixtures before removing
      mutable callback escape. Independently compare raw durable JSON and key
      order rather than serializing an expected compound result.
- [ ] Introduce the one Section 6.5 handler-facing capability and prove the
      exported broad service, factory result, and public compatibility paths are
      unchanged.
- [ ] Preserve callback invocation/retry, commit/failure, finalization, exact
      snapshot identity, observation/wake order, receipt/event/final-outbox, and
      caller return behavior.
- [ ] Obtain scoped review with Critical 0 / Important 0.

### Task 10: Reconcile Remaining Internal Names And Protect Presence Ownership

**Files:**

- Move:
  `packages/shared-server/rallar-system/group-state/mutation/orchestration/resolve-group-mutation-target.ts`
  to
  `packages/shared-server/rallar-system/group-state/mutation/orchestration/resolve-group-mutation-target-identity.ts`
- Move:
  `packages/shared-server/rallar-system/group-state/mutation/write/write-group-state-mutation.ts`
  to
  `packages/shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts`
- Modify:
  `packages/shared-server/rallar-system/group-state/mutation/group-mutation-result.ts`
- Modify:
  `packages/shared-server/rallar-system/group-state/mutation/aggregate/compute-group-aggregate-mutation.ts`
- Modify:
  `packages/shared-server/rallar-system/group-state/mutation/membership/compute-group-membership-mutation.ts`
- Modify:
  `packages/shared-server/rallar-system/group-state/mutation/presence/compute-group-presence-mutation.ts`
- Modify:
  `packages/shared-server/rallar-system/group-state/mutation/read/resolve-group-mutation-read-identities.ts`
- Modify:
  `packages/shared-server/rallar-system/group-state/mutation/result-validation/validate-computed-group-mutation-write.ts`
- Modify:
  `packages/shared-server/rallar-system/group-state/mutation/write/compute-group-membership-write.ts`
- Modify:
  `packages/shared-server/rallar-system/group-state/group-state-service.ts`
- Move:
  `packages/tests/shared-server/group-state/mutation/write-group-state-mutation-behavior.test.ts`
  to
  `packages/tests/shared-server/group-state/mutation/write-group-mutation-behavior.test.ts`
- Modify:
  `packages/tests/shared-server/group-state/group-state-test-mutation-executor.ts`
- Modify: exact source inventories; no compatibility export changes

- [ ] Rename the two resolver functions and pure result constructor exactly as
      Section 4.3 defines; preserve parameters, returns, errors, and call order.
- [ ] Prove the final direct presence owner and re-export-only old path were
      already present at the PR #59 prerequisite and remain unchanged.
- [ ] Run focused compute/read/write, public export, compatibility, source
      inventory, file/function, and cycle tests.
- [ ] Obtain scoped review with Critical 0 / Important 0.

### Task 11: Prove Behavior, Compatibility, Concurrency, And Performance

**Files:**

- Modify: this plan only for factual task evidence before the final freeze

- [ ] Run Section 9.3 on one unchanged tree.
- [ ] Perform whole-PR review from PR A's resulting `main` through the exact
      candidate; Critical 0 / Important 0 required. Resolve every in-scope
      finding and rerun invalidated gates before the freeze.
- [ ] Confirm TypeScript, checkers, public exports, compatibility paths,
      AppInbox durable serialization/finalization, registration behavior,
      transaction/retry semantics, and unrelated plans remain unchanged.
- [ ] Before measurement, finish every implementation, plan-evidence, review,
      and local-gate edit, then create one exact local candidate commit. That
      same commit must be the final PR B head if measurement succeeds.
- [ ] Run one fixed, non-rerolled A-B-B-A comparison using PR A's exact
      resulting `main` SHA as both A positions and the exact PR B candidate
      commit as both B positions. Use the approved server-child PostgreSQL 16
      protocol, pooling writer, unchanged global comparator, and existing 1.5%
      child-policy evaluator without changing any threshold.
- [ ] Stop if the comparator or a correctness invariant fails. No optimization,
      threshold change, tolerance, or replacement run is authorized.

### Task 12: Publish PR B And Return To Human Merge Review

**Files:**

- Publish the exact already-measured PR B candidate commit

- [ ] Reconfirm the unchanged exact tree and commit; create no post-measurement
      evidence or formatting commit.
- [ ] Push non-forced, update draft PR B with before/after trace and exact
      validation/performance evidence, and require Branch Release Gate.
- [ ] Mark ready only when all gates and review are green.
- [ ] Stop for exact human merge. Do not publish the ledger or begin API-v1.

### Task 13: Publish The Server Ledger Later

After PR B merges and its exact resulting `main` SHA passes **Run Hetzner
Supported Distributed Manifests**, separate human authorization starts an
evidence-only branch. It may update only:

- `plans/rallar-group-state-server-structure-plan.md`;
- `plans/rallar-group-state-server-traceability-qa-plan.md`;
- `plans/repo-human-traceability-refactoring-program-plan.md`;
- `plans/repo-human-traceability-program-execution-plan.md`.

The ledger records already-existing PR #59, PR A, and PR B trees, commits, PRs,
Branch Release Gates, resulting `main` SHAs, and default workflows. It marks the
server implementation and QA complete while leaving the ledger's own future
facts external. Only after that envelope succeeds may the server child be
`ledger-published` and the API-v1 child be drafted.

## 9. Validation Matrix

### 9.1 Planning PR

```bash
npx prettier --write \
  plans/rallar-group-state-server-traceability-qa-plan.md \
  plans/repo-human-traceability-refactoring-program-plan.md \
  plans/repo-human-traceability-program-execution-plan.md \
  plans/rallar-group-state-server-structure-plan.md
git diff --check
npm run test:repo-governance
npm run test:unit
npm run test:ci
npm run build
```

### 9.2 PR A guidance and route-owner suites

```bash
npx vitest run \
  packages/tests/repo/rallar-skill-plugin-publication-integrity.test.ts \
  packages/tests/repo/rallar-skill-app-examples-integrity.test.ts \
  packages/tests/repo/rallar-authoritative-mutation-guidance-integrity.test.ts \
  packages/tests/repo/rallar-group-state-owner-integrity.test.ts \
  packages/tests/repo/repo-code-style-authority-integrity.test.ts \
  packages/tests/repo/repo-code-style-review-evidence-integrity.test.ts \
  packages/tests/repo/repo-code-style-checker-integrity.test.ts \
  packages/tests/repo/repo-style-structural-lineage-provenance.test.ts \
  packages/tests/rallar-black-box/rallar-testing-skill.test.ts
npx vitest run packages/tests/shared-server/mutation-route-owner-*.test.ts
npx vitest run \
  packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts
npm run test:repo-governance
npm run check:repo-style
npm run check:repo-style:layout
npm run check:repo-style:layout-details
npm run check:repo-style:construction-details
npm run check:repo-style:output-contracts
npm run check:repo-style:object-interfaces
npm run check:repo-style:changed -- origin/main
npm run test:unit
npm run test:ci
npm run build
```

### 9.3 PR B behavior-neutral runtime suites

```bash
npx vitest run \
  packages/tests/shared-server/group-state/inbox/group-state-inbox-authority.test.ts \
  packages/tests/shared-server/group-state/inbox/app-group-inbox-registration-lifecycle.test.ts \
  packages/tests/shared-server/group-state/inbox/group-state-inbox-construction.test.ts \
  packages/tests/shared-server/group-state/inbox/group-state-inbox-descriptor-contract.test.ts \
  packages/tests/shared-server/group-state/inbox/group-state-inbox-operation-matrix.test.ts \
  packages/tests/shared-server/group-state/inbox/group-state-inbox-retry.test.ts \
  packages/tests/shared-server/group-state/inbox/group-state-inbox-transaction-result.test.ts \
  packages/tests/shared-server/group-state/group-state-service-idempotency.test.ts \
  packages/tests/shared-server/group-state/group-state-service-timing.test.ts \
  packages/tests/shared-server/group-state/mutation/write-group-mutation-behavior.test.ts \
  packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts \
  packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts \
  packages/tests/shared-server/app-inbox-transaction.test.ts \
  packages/tests/shared-server/rallar-middleware.test.ts \
  packages/tests/shared-server/topology-app-inbox-contract.test.ts \
  packages/tests/shared-server/topology-app-inbox-ownership.test.ts \
  packages/tests/shared-server/rallar-rtc-topology-service.test.ts
(cd apps/api-v1 && deno task test test/rallar-server.test.ts)
npx vitest run packages/tests/shared-server/group-state
npx vitest run packages/tests/shared-server
npx vitest run \
  packages/tests/repo/group-state-server-source-ratchet.test.ts \
  packages/tests/repo/group-state-test-structure.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
(cd apps/api-v1 && deno task check)
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres:medium-scale
npm run check:repo-style
npm run check:repo-style:layout
npm run check:repo-style:layout-details
npm run check:repo-style:construction-details
npm run check:repo-style:output-contracts
npm run check:repo-style:object-interfaces
npm run check:repo-style:changed -- origin/main
npm run test:unit
npm run test:ci
npm run build
git diff --check
```

After these gates and the whole-PR review pass, the executor freezes one local
candidate commit and runs the fixed A-B-B-A sequence defined by the server
child's **Corrected-runtime order-balanced comparison**, with these deliberate
substitutions only:

- the exact approved base for both A positions is PR A's resulting `main` SHA;
- both B positions use the same exact frozen PR B candidate commit;
- every artifact, environment, pooled-output, and manifest path uses a new
  `group-state-traceability-qa` basename;
- every position uses a fresh non-overlapping PostgreSQL 16 container with the
  same pinned image, CPU, memory, shared memory, database, migration,
  empty-table, autovacuum/analyze, warmup `1`, runs `9`, and concurrency `10`
  requirements;
- the pooling writer receives the exact A and B commits, all four source and
  environment paths, and writes 18-sample-per-side pooled artifacts plus a
  binding manifest;
- the unchanged global comparator runs first; then
  `compare-group-state-server-structure-performance.mjs` evaluates the same
  immutable pooled artifacts and exact manifest under the existing 1.5% policy.

Each A and B position runs exactly once in A-B-B-A order. A failed or
uncontrolled position is a blocker; it is not rerun. Historical PR #59
measurements are not reused as a baseline. Generated artifacts stay under
`tmp/perf/`, their hashes and environment evidence are recorded externally,
and they are not committed. No content may change after the candidate commit is
measured. If evidence wording or code must change, the measurement no longer
binds the final head and execution stops for a new human decision.

## 10. Publication And Human Review Gates

1. **Planning review:** human approves or revises this exact plan Git blob.
2. **Planning merge:** human separately merges the planning PR; PR A waits for
   its exact default workflow.
3. **PR A review:** verify one guidance contract, the written large-review
   decision model, temporary-ratchet lifecycle, preserved test assertions,
   independent target-by-target lineage provenance, and unchanged checker
   behavior. Human separately approves its exact merge.
4. **PR B review:** verify registration has complete dependencies, the
   transaction result preserves exact durable serialization and private
   after-commit timing, the handler port is cohesive, names and timing are
   direct, and no behavior, compatibility, state, lifecycle, transaction,
   retry, or performance contract changed. Human separately approves its exact
   merge.
5. **Ledger authorization:** after PR B's default workflow, the human separately
   authorizes and later merges the ledger.
6. **API-v1 drafting:** only `ledger-published` unlocks a planning-only API-v1
   child prompt.

## 11. Non-Circular Completion Evidence

Each frozen tree contains only facts that existed before it:

- this planning tree may record PR #59 evidence, but not its own future
  publication facts;
- PR A and PR B keep their final PR, merge, and default-workflow facts external;
- the later ledger records completed PR #59, PR A, and PR B envelopes, but not
  its own future publication facts;
- the ledger PR and Mandatory Completion Handoff carry its tree, commit, PR,
  gate, merge, and default workflow. Only then is the server child
  `ledger-published`.

Any change after a freeze invalidates affected review/gates. A later ledger
never relabels or invalidates a frozen implementation tree.

## 12. Acceptance Checklist

- [ ] Human approved this exact plan blob.
- [ ] Planning PR merged and its exact default workflow succeeded.
- [ ] PR A integrity tests failed before guidance and passed after.
- [ ] PR A defines the two timelines and every family-level trace field in
      Section 2, including invocation count, failures, cleanup, and final result.
- [ ] Transaction callbacks prefer immutable durable/private results; every
      mutable escape requires the explicit fail-closed review disposition.
- [ ] Realtime skills name canonical final owners and compatibility-only paths.
- [ ] Testing guidance requires behavior names and semantic entry/transaction/
      exit evidence.
- [ ] Publishing guidance defines review-pressure triggers, a written
      stacked-versus-single decision, read-first map, and stale-evidence block.
- [ ] Every mechanical ratchet names an owner and removal condition and remains
      supplemental to semantic assertions.
- [ ] All changed production construction warnings received a human disposition.
- [ ] Every remaining PR #59 lineage target has independently reviewed
      symbol/span provenance; semantic additions consume no inherited capacity.
- [ ] PR A added no semantic checker rule or strict mode.
- [ ] All nineteen historical tests have descriptive names with all assertions.
- [ ] PR A review has Critical 0 / Important 0.
- [ ] PR A local/remote gates and resulting-main workflow passed.
- [ ] PR B characterization proves every predecessor mapping and runtime order.
- [ ] `processGroupStateMutation` exposes the direct phase path.
- [ ] `toGroupMutationDescriptor` owns only representation translation.
- [ ] Timing is explicit and contains no dynamic method dispatch.
- [ ] Topology/RTC callbacks become live only with complete mandatory
      dependencies; public setter signatures and supported behavior remain fixed.
- [ ] AppInbox persists only the exact predecessor durable result; immutable
      private after-commit data becomes visible only after confirmed commit.
- [ ] The handler depends on one cohesive narrow mutation capability while the
      exported broad `GroupStateService` contract remains unchanged.
- [ ] Target identity, computed-write, and mutation-write filenames/symbols use
      the exact Section 4.3 names.
- [ ] Direct-function presence ownership remains verified, not reimplemented.
- [ ] Public exports, compatibility, contracts, AppInbox, and API-v1 are unchanged.
- [ ] Medium-scale convergence and governed performance comparison passed.
- [ ] PR B review has Critical 0 / Important 0.
- [ ] PR B local/remote gates and resulting-main workflow passed.
- [ ] Later server ledger reached `ledger-published`.
- [ ] API-v1 remained unstarted throughout this QA child.

## 13. Risks And Stop Conditions

| Risk                                                                                               | Required response                                                       |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Explicit timing changes an event/error                                                             | Restore exact behavior test-first; stop if contract change is required. |
| Descriptor extraction changes order/default/error                                                  | Restore literal predecessor behavior; no cleanup is authorized.         |
| Deferred registration changes a supported preconfiguration call                                    | Stop for a new human behavior/public-contract decision.                 |
| A callback still reads an optional/mutable topology or RTC dependency                              | Do not publish; capture the mandatory value at registration.            |
| The internal transaction compound value reaches durable JSON/finalization                          | Stop, restore exact durable projection and raw property order.          |
| Private after-commit data becomes visible before commit or after failure                           | Stop, restore transaction-owner release and retry behavior.             |
| Narrow ports multiply into tiny interfaces/factories                                               | Consolidate at the cohesive handler boundary; add no dependency bag.    |
| A naming move requires a new compatibility hop                                                     | Keep the internal old name or stop for an exact compatibility decision. |
| Lineage provenance cannot distinguish moved debt from semantic additions                           | Fail that target; do not change checker capacity in PR A.               |
| Automated lineage/method/test enforcement appears necessary                                        | Record a separately approved governance follow-up; do not implement it. |
| A compatibility consumer imports an internal handler                                               | Preserve only if already real; stop before adding a new shim.           |
| Test moves lose coverage or active paths                                                           | Restore exact test/assertion inventory before publication.              |
| A helper only forwards control                                                                     | Keep the direct call or combine ownership.                              |
| Convergence/performance fails                                                                      | Stop with artifacts; no reroll, threshold, or tolerance change.         |
| API-v1 production change appears necessary                                                         | Stop; it belongs to the later API-v1 child.                             |
| Public, persisted, AppInbox, dependency, workflow, TypeScript, or checker change appears necessary | Stop and return the exact plan decision to the human.                   |

## 14. Progress Record

| Milestone              | State                    | Evidence                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PR #59 prerequisite    | complete                 | Feature `bec8bea4eb095de9ad3a6b47c18e6799ab811239`, tree `c1ac6a57dad974d04264cbe1fa92313697256712`, Branch Release Gate `30694693554` attempt 1 success, resulting `main` `06e0c5ab138c2ab55ac519b2244f727acd42d560`, default workflow `30697799787` attempt 1 success. |
| Planning revision base | superseded; unapproved   | Draft PR #60 predecessor head `3b427a29692316d11b32ceac0e2a4ce482803b88`, tree `e45a87769a4f84bd869f3e09a6905cd3fed9ce35`, and plan blob `aad13aecdd916b201b1511d9e76707a1caddc650`; no approval attached.                                                               |
| QA findings inventory  | revised draft            | Final PR #59 re-review distinguishes completed direct presence/stateless-handler fixes from remaining registration lifetime, transaction result, broad handler port, dynamic timing, naming, test-discoverability, review-guidance, and lineage-provenance findings.     |
| QA child plan          | human-review pending     | No exact Git blob has been approved.                                                                                                                                                                                                                                     |
| PR A                   | blocked by plan approval | No implementation branch, commit, or PR exists.                                                                                                                                                                                                                          |
| PR B                   | blocked by PR A          | No implementation branch, commit, or PR exists.                                                                                                                                                                                                                          |
| Server later ledger    | pending                  | Waits for both QA implementation envelopes and separate authorization.                                                                                                                                                                                                   |
| API-v1 child           | blocked                  | Waits for the server ledger to be `ledger-published`.                                                                                                                                                                                                                    |

## 15. Planning Self-Review Record

The drafting pass checks:

- every finding has an exact task and validation owner;
- PR A and PR B have disjoint production scope and sequential publication;
- final-main facts are not inherited from the earlier `57e7d57` review head;
- current/target paths and symbols are consistent;
- every historical test move has one destination;
- representative entry, transaction, exit, and after-commit owners are named;
- registration and runtime invocation are separate timelines;
- each materially different control-flow family has one non-redundant trace;
- mutable transaction escape is removed without serializing private data;
- public setter compatibility is explicit and no callback observes optional
  processing dependencies;
- dynamic timing removal preserves instrumentation rather than deleting it;
- the broad public service remains while the handler gets one cohesive port;
- direct-function presence ownership is recorded as complete, not reimplemented;
- lineage governance stays in PR A and checker implementation stays out;
- no public, persisted, behavior, AppInbox, dependency, workflow, checker, or
  API-v1 change is hidden;
- completion/performance gates and human decisions are explicit;
- later evidence is non-circular;
- no `TBD`, `TODO`, placeholder, or “similar to” step remains.

Any failed item is corrected before human review.
