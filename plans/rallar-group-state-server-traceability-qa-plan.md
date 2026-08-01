# Rallar Group-State Server Traceability QA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the authoritative group-state path published by PR #59 easier for
a human to locate and trace by strengthening the repository review contract in
one guidance PR, then applying behavior-neutral, test-first traceability fixes
in one server QA PR.

**Architecture:** PR A updates only repository skills, review guidance, and
their directly owned traceability-analysis tests. PR B keeps every runtime and
public contract fixed while exposing the AppInbox-to-result path through
descriptive symbols, a focused inbox translation owner, and an explicit timing
adapter instead of dynamic service dispatch. The two PRs publish independently;
the server child's later evidence ledger waits for both.

**Tech Stack:** Markdown repo skills and plans, TypeScript 7.0.2, Vitest,
`@babel/parser`, Deno, AppInbox, Git, and GitHub Actions.

## Global Constraints

- This plan is a follow-up child of the
  [Repository Human Traceability Refactoring Program](repo-human-traceability-refactoring-program-plan.md)
  and a quality-assurance successor to
  [the authoritative group-state server structure child](rallar-group-state-server-structure-plan.md).
- The human must approve this exact plan Git blob before either implementation
  PR begins. Plan approval authorizes implementation scope, not either merge.
- PR A is skills, review guidance, and traceability-analysis test ownership only.
  It changes no production code or checker strictness.
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
- The later server evidence ledger remains separately authorized after PR B.
  The API-v1 child remains blocked until that ledger is `ledger-published`.

---

Date: 2026-08-01

Status: Drafted and unapproved. Planning publication does not authorize PR A or
PR B.

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

The QA child addresses only review findings about human navigation:

1. the current standard says to trace a representative input, but does not make
   the reviewer record the exact entry owner, exit owner, direct caller/callee
   chain, or the point at which transaction/retry control returns to AppInbox;
2. the human guide does not require a reviewer to perform the trace using only
   code and symbols rather than relying on an implementation plan;
3. `group-state-inbox-handler.ts` combines the direct mutation phase sequence
   with roughly half a file of AppInbox-payload-to-descriptor routing;
4. `group-state-service.ts` uses `Proxy`, `Reflect.get`, variadic arguments, and
   `Function.apply` to add timing, so symbol navigation cannot show which timed
   method calls which service operation;
5. authoritative mutation source tests are discoverable only through broad or
   historical names, including nineteen `task10-route-closure-correction*`
   modules and `read-compute-write-contract.test.ts`;
6. PR #59's structural direction is otherwise retained: feature ownership,
   mutation phase separation, persistence owners, AppInbox authority, topology
   and RTC RTT owners, and mirrored test placement are not reopened.

## 2. Human Traceability Acceptance Contract

After PR B, a reviewer who starts with `AppInboxType.GROUP_CREATE` must be able
to follow this path from production symbols without consulting this plan:

```text
construction:
  AppGroupInboxService.constructor
    -> registerStateMessageHandlers
       -> AppInboxService.onStateMessage

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
       -> GroupStateService.read
       -> GroupStateService.compute
       -> GroupStateService.validate
       -> GroupStateInboxHandler.commitMutation
          -> AppInboxTransactionWriter.writeMutation
             -> runInTransaction
                -> GroupStateService.write
                   -> writeGroupMutation
                      -> conditional guard
                      -> authoritative effects
                      -> event
                      -> receipt/idempotency record
                      -> final APP_OUTBOX rows
                -> readGroupStateInboxResult
                -> ResourceInboxResultsRepository.replace
                -> ResourceInboxRepository.finishReserved
             -> transaction commits and control returns to commitMutation
          -> GroupStateService.observeSnapshot after commit
          -> wakeQueue after commit

waiting caller:
  AppInboxService.waitForCompletion
    -> findByKeyAndReturnEither
    -> durable AppInbox result returned to the caller
```

The reviewer must be able to answer from the immediate owner and named calls:

- Which public or protocol entry admitted the work?
- Which function translated the representation?
- Who owns each read, compute, validate, and write phase?
- Where does the transaction start and end?
- Who decides whether a conflict retries?
- Which write is the first conditional guard?
- Where are the receipt, event, and final outbox records written?
- What durable result returns to the caller?
- Which effects occur only after commit?
- Which compatibility path is public and which file is canonical?

Passing tests or checker output does not answer these questions. PR A makes this
an explicit human-review deliverable; PR B makes the representative path visible
in the code.

## 3. Exact Current And Target Trees

### 3.1 PR A guidance and traceability-analysis tree

Current owners:

```text
.agents/skills/rallar-code-writing/
  SKILL.md
  references/
    convergent-service-writing.md
    repo-code-style.md
.agents/skills/rallar-testing/references/test-commands.md
docs/repo-human-style-guide.md
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
.agents/skills/rallar-code-writing/
  SKILL.md
  references/
    convergent-service-writing.md
    repo-code-style.md
.agents/skills/rallar-testing/references/test-commands.md
docs/repo-human-style-guide.md
packages/tests/repo/
  rallar-skill-integrity.test.ts
  repo-code-style-integrity.test.ts
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
  group-state/
    group-state-service-contracts.ts
    group-state-service.ts
    inbox/
      group-state-inbox-contracts.ts
      group-state-inbox-handler.ts
      group-state-inbox-result.ts
```

Target directly affected production tree:

```text
packages/shared-server/rallar-system/
  services/
    AppGroupInboxService.ts
  group-state/
    group-state-service-contracts.ts
    group-state-service.ts
    group-state-service-timing.ts
    inbox/
      group-state-inbox-contracts.ts
      group-state-inbox-handler.ts
      group-state-inbox-mutation-descriptor.ts
      group-state-inbox-result.ts
```

Current directly affected test/support tree:

```text
packages/tests/repo/
  group-state-server-source-ratchet-inventory.ts
  group-state-server-source-ratchet.test.ts
packages/tests/shared-server/
  mutation-routing-owner-inventory.ts
  read-compute-write-contract.test.ts
  read-compute-write-source-analysis.ts
  group-state/
    group-state-service-idempotency.test.ts
    inbox/
      group-state-inbox-authority.test.ts
      group-state-inbox-construction.test.ts
      group-state-inbox-operation-matrix.test.ts
      group-state-inbox-retry.test.ts
```

Target directly affected test/support tree:

```text
packages/tests/repo/
  group-state-server-source-ratchet-inventory.ts
  group-state-server-source-ratchet.test.ts
packages/tests/shared-server/
  authoritative-mutation-read-compute-validate-write.test.ts
  authoritative-mutation-source-analysis.ts
  mutation-routing-owner-inventory.ts
  group-state/
    group-state-service-idempotency.test.ts
    group-state-service-timing.test.ts
    inbox/
      group-state-inbox-authority.test.ts
      group-state-inbox-construction.test.ts
      group-state-inbox-operation-matrix.test.ts
      group-state-inbox-retry.test.ts
```

The target adds two real owners only:

- `group-state-inbox-mutation-descriptor.ts` owns the exact AppInbox payload to
  `GroupMutationDescriptor` translation now embedded below the direct phase
  sequence in `group-state-inbox-handler.ts`.
- `group-state-service-timing.ts` owns the real timing/instrumentation boundary
  through explicit `GroupStateService` operations.

It does not add a facade, barrel, callback chain, dependency bag, state owner,
or compatibility path.

## 4. Exact Move And Symbol Map

### 4.1 PR A historical test ownership moves

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

### 4.2 PR B production and test moves

| Current owner                                                                                 | Target owner                                                                                                  | Locked responsibility                                                           |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| descriptor switches and `to*MutationDescriptor` helpers inside `group-state-inbox-handler.ts` | exported `toGroupMutationDescriptor` and private family helpers in `group-state-inbox-mutation-descriptor.ts` | exact payload-to-domain translation, switch order, errors, and field projection |
| `GroupStateInboxHandler.processMutation`                                                      | `GroupStateInboxHandler.processGroupStateMutation`                                                            | direct protocol entry with visible read/compute/validate/commit sequence        |
| dynamic `withGroupStateServiceTiming` and proxy-specific helpers in `group-state-service.ts`  | exported `createTimedGroupStateService` and private detail helpers in `group-state-service-timing.ts`         | identical timing names/details with one explicit wrapper per operation          |
| `read-compute-write-contract.test.ts`                                                         | `authoritative-mutation-read-compute-validate-write.test.ts`                                                  | authoritative phases, transaction, outbox, and ownership                        |
| `read-compute-write-source-analysis.ts`                                                       | `authoritative-mutation-source-analysis.ts`                                                                   | source extraction owned by that suite                                           |

`AppGroupInboxService.ts`, its public class, constructor and setter surfaces, and
every package/app import path remain in place. Existing one-hop compatibility
exports remain byte-for-byte unchanged unless an import-only correction is
required by an exact move above.

## 5. PR A: Skills And Review Guidance Contract

PR A adds one consistent requirement, not competing rule sets:

1. `rallar-code-writing/SKILL.md` requires a before/after representative trace
   for structural work and names entry, translation, decision, side-effect,
   exit, caller, and callee ownership.
2. `repo-code-style.md` adds **Traceable entry and exit paths**. It requires one
   obvious entry owner, one named result/exit owner, direct mainline calls, and
   explicit treatment of dynamic dispatch. A plan-only map or source-text test
   cannot compensate for opaque production code.
3. `convergent-service-writing.md` requires the AppInbox trace to show queue
   admission, reservation, each fresh retry attempt, read/compute/validate,
   transaction-scoped write, receipt/event/final outbox, durable result, and
   after-commit effects.
4. `docs/repo-human-style-guide.md` adds a code-only review exercise starting
   from a public or protocol symbol. The outcome records exact symbols and any
   unavoidable dynamic edge.
5. `test-commands.md` names the focused route-owner and authoritative mutation
   traceability suites.
6. Integrity tests assert the shared concepts and active paths without copying
   complete prose into brittle string snapshots.
7. The nineteen route-owner suites receive descriptive filenames and `describe`
   titles with unchanged logic.

PR A adds no checker rule. Semantic clarity remains human judgment. Automation
verifies only guidance integrity, active paths, and unchanged analyzer behavior.

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

### 6.3 Traceability tests

Tests prove behavior, not prose:

- each `GROUP_*` AppInbox type produces the equivalent descriptor or exact
  predecessor error;
- create-group reaches `processGroupStateMutation`, direct phases, AppInbox
  `writeMutation`, service write, result assembly, observation, and wake in the
  locked order;
- timing absent returns the same object identity;
- timing present calls every async operation once and preserves event details
  and failure propagation;
- `compute` and `validate` remain synchronous and untimed;
- route-owner and source-ratchet inventories use the exact new symbols/paths;
- public exports and every `AppGroupInboxService` consumer remain unchanged.

Source ratchets may prove ownership, absence of dynamic proxy constructs, and
active paths. They do not replace runtime order, timing, error, receipt, outbox,
retry, or convergence assertions.

## 7. Compatibility And Invariants

The following are locked and require a new human plan revision if threatened:

- `AppGroupInboxService` name, constructor, setters, public methods, and path;
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
- presence, topology, RTC RTT, admin, browser, and API-v1 behavior;
- TypeScript 7.0.2, dependencies, workflows, warning-only checkers, and every
  approved performance threshold.

PR B crosses the authoritative mutation call path structurally even though it
must remain behavior-neutral. It therefore requires the complete mutation-path
and concurrency verification in Section 9, including one governed
baseline/candidate performance comparison. No result may be waived or rerolled
inside this plan.

## 8. Implementation Tasks

### Task 0: Publish And Approve This Planning Revision

**Files:**

- Create: `plans/rallar-group-state-server-traceability-qa-plan.md`
- Modify: `plans/repo-human-traceability-refactoring-program-plan.md`
- Modify: `plans/repo-human-traceability-program-execution-plan.md`
- Modify: `plans/rallar-group-state-server-structure-plan.md`

- [ ] Verify the planning branch starts from exact `main`
      `06e0c5ab138c2ab55ac519b2244f727acd42d560` and tree
      `c1ac6a57dad974d04264cbe1fa92313697256712`.
- [ ] Record only already-existing PR #59 evidence; leave future planning, PR A,
      PR B, ledger, and API-v1 publication facts outside their producing trees.
- [ ] Run Section 9.1.
- [ ] Publish one non-default draft planning PR and require Branch Release Gate
      for its exact commit.
- [ ] Stop for human approval of the exact plan Git blob and later human merge
      of the planning PR. Do not begin PR A from an unmerged plan branch.

### Task 1: Start PR A And Add Failing Guidance Integrity Tests

**Files:**

- Modify: `packages/tests/repo/rallar-skill-integrity.test.ts`
- Modify: `packages/tests/repo/repo-code-style-integrity.test.ts`
- Modify: `packages/tests/rallar-black-box/rallar-testing-skill.test.ts`

- [ ] Start `codex/rallar-group-state-traceability-guidance` from the exact
      resulting `main` SHA of the planning PR after its default workflow.
- [ ] Add focused assertions for entry, translation, direct caller/callee,
      exit, AppInbox transaction return, after-commit effects, and active paths.
- [ ] Run the focused files and capture RED evidence.

### Task 2: Implement The PR A Guidance Contract

**Files:**

- Modify: `.agents/skills/rallar-code-writing/SKILL.md`
- Modify: `.agents/skills/rallar-code-writing/references/repo-code-style.md`
- Modify:
  `.agents/skills/rallar-code-writing/references/convergent-service-writing.md`
- Modify: `.agents/skills/rallar-testing/references/test-commands.md`
- Modify: `docs/repo-human-style-guide.md`
- Test: the three Task 1 suites

- [ ] Use `superpowers:writing-skills` for the skill changes and verify their
      pressure scenarios before treating prose-integrity tests as sufficient.
- [ ] Add the one traceability contract defined in Section 5.
- [ ] Keep semantic clarity in human review; add no checker rule or strict mode.
- [ ] Run the Task 1 tests and capture GREEN evidence.
- [ ] Run `npm run test:repo-governance`.

### Task 3: Rename Historical Route-Owner Test Modules

**Files:**

- Move: the nineteen exact paths in Section 4.1
- Modify: direct imports, active commands, and coverage registries only where an
  exact old path exists

- [ ] Record the pre-move test names and `expect(...)` site counts.
- [ ] Move each suite and update only its `describe` title and direct imports.
- [ ] Prove post-move test names and assertion counts are identical.
- [ ] Run all nineteen renamed suites plus route-owner inventory/routing tests.
- [ ] Independently review PR A with Critical 0 / Important 0.
- [ ] Run Section 9.2 on the unchanged tree, publish draft PR A, require Branch
      Release Gate, and mark ready only when green.
- [ ] Stop for exact human merge approval; require the exact resulting-main
      default workflow before Task 4.

### Task 4: Start PR B And Characterize The Runtime Trace

**Files:**

- Modify:
  `packages/tests/shared-server/group-state/inbox/group-state-inbox-operation-matrix.test.ts`
- Create:
  `packages/tests/shared-server/group-state/group-state-service-timing.test.ts`
- Rename: the two source-contract files in Section 4.2
- Modify: direct imports and source-ratchet inventories

- [ ] Start `codex/rallar-group-state-traceability-runtime` from PR A's exact
      resulting `main` SHA after its default workflow.
- [ ] Characterize every descriptor mapping, error, phase, transaction callback,
      result, observation, wake, timing event, identity, call count, and rejection.
- [ ] Rename the source contract suite/helper without changing assertions.
- [ ] Record GREEN predecessor characterization.
- [ ] Add target source ratchets and capture RED only for not-yet-created owners
      and still-present dynamic proxy constructs.

### Task 5: Extract The AppInbox Descriptor Translation

**Files:**

- Create:
  `packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-mutation-descriptor.ts`
- Modify:
  `packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts`
- Modify: `packages/shared-server/rallar-system/services/AppGroupInboxService.ts`
- Modify: directly affected Task 4 tests/inventories

- [ ] Move descriptor code without rewriting branches, casts, values, or errors.
- [ ] Rename only the internal handler method to
      `processGroupStateMutation` and update exact internal callers.
- [ ] Remove the handler's pass-through descriptor method.
- [ ] Run descriptor, authority, operation, routing, retry, and ratchet tests.
- [ ] Obtain scoped review with Critical 0 / Important 0.

### Task 6: Replace Dynamic Timing Dispatch With Explicit Operations

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

### Task 7: Prove Behavior, Compatibility, Concurrency, And Performance

**Files:**

- Modify: this plan only for factual task evidence before the final freeze

- [ ] Run Section 9.3 on one unchanged tree.
- [ ] Perform whole-PR review from PR A's resulting `main` through the exact
      candidate; Critical 0 / Important 0 required. Resolve every in-scope
      finding and rerun invalidated gates before the freeze.
- [ ] Confirm TypeScript, checkers, public exports, compatibility paths,
      AppInbox semantics, and unrelated plans remain unchanged.
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

### Task 8: Publish PR B And Return To Human Merge Review

**Files:**

- Publish the exact already-measured PR B candidate commit

- [ ] Reconfirm the unchanged exact tree and commit; create no post-measurement
      evidence or formatting commit.
- [ ] Push non-forced, update draft PR B with before/after trace and exact
      validation/performance evidence, and require Branch Release Gate.
- [ ] Mark ready only when all gates and review are green.
- [ ] Stop for exact human merge. Do not publish the ledger or begin API-v1.

### Task 9: Publish The Server Ledger Later

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
  packages/tests/repo/rallar-skill-integrity.test.ts \
  packages/tests/repo/repo-code-style-integrity.test.ts \
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
  packages/tests/shared-server/group-state/inbox/group-state-inbox-construction.test.ts \
  packages/tests/shared-server/group-state/inbox/group-state-inbox-operation-matrix.test.ts \
  packages/tests/shared-server/group-state/inbox/group-state-inbox-retry.test.ts \
  packages/tests/shared-server/group-state/group-state-service-idempotency.test.ts \
  packages/tests/shared-server/group-state/group-state-service-timing.test.ts \
  packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts \
  packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts
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
3. **PR A review:** verify one guidance contract, preserved test assertions, and
   unchanged checker behavior. Human separately approves its exact merge.
4. **PR B review:** verify traceability improved without behavior,
   compatibility, state, lifecycle, transaction, or performance changes. Human
   separately approves its exact merge.
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
- [ ] PR A defines entry, translation, caller/callee, side-effect, exit,
      transaction-return, and after-commit evidence.
- [ ] PR A added no semantic checker rule or strict mode.
- [ ] All nineteen historical tests have descriptive names with all assertions.
- [ ] PR A review has Critical 0 / Important 0.
- [ ] PR A local/remote gates and resulting-main workflow passed.
- [ ] PR B characterization proves every predecessor mapping and runtime order.
- [ ] `processGroupStateMutation` exposes the direct phase path.
- [ ] `toGroupMutationDescriptor` owns only representation translation.
- [ ] Timing is explicit and contains no dynamic method dispatch.
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
| A compatibility consumer imports an internal handler                                               | Preserve only if already real; stop before adding a new shim.           |
| Test moves lose coverage or active paths                                                           | Restore exact test/assertion inventory before publication.              |
| A helper only forwards control                                                                     | Keep the direct call or combine ownership.                              |
| Convergence/performance fails                                                                      | Stop with artifacts; no reroll, threshold, or tolerance change.         |
| API-v1 production change appears necessary                                                         | Stop; it belongs to the later API-v1 child.                             |
| Public, persisted, AppInbox, dependency, workflow, TypeScript, or checker change appears necessary | Stop and return the exact plan decision to the human.                   |

## 14. Progress Record

| Milestone             | State                    | Evidence                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PR #59 prerequisite   | complete                 | Feature `bec8bea4eb095de9ad3a6b47c18e6799ab811239`, tree `c1ac6a57dad974d04264cbe1fa92313697256712`, Branch Release Gate `30694693554` attempt 1 success, resulting `main` `06e0c5ab138c2ab55ac519b2244f727acd42d560`, default workflow `30697799787` attempt 1 success. |
| QA findings inventory | drafted                  | Skills, human guide, entry/exit path, dynamic timing, and historical test ownership inspected against PR #59 only.                                                                                                                                                       |
| QA child plan         | human-review pending     | No exact Git blob has been approved.                                                                                                                                                                                                                                     |
| PR A                  | blocked by plan approval | No implementation branch, commit, or PR exists.                                                                                                                                                                                                                          |
| PR B                  | blocked by PR A          | No implementation branch, commit, or PR exists.                                                                                                                                                                                                                          |
| Server later ledger   | pending                  | Waits for both QA implementation envelopes and separate authorization.                                                                                                                                                                                                   |
| API-v1 child          | blocked                  | Waits for the server ledger to be `ledger-published`.                                                                                                                                                                                                                    |

## 15. Planning Self-Review Record

The drafting pass checks:

- every finding has an exact task and validation owner;
- PR A and PR B have disjoint production scope and sequential publication;
- current/target paths and symbols are consistent;
- every historical test move has one destination;
- representative entry, transaction, exit, and after-commit owners are named;
- dynamic timing removal preserves instrumentation rather than deleting it;
- no public, persisted, behavior, AppInbox, dependency, workflow, checker, or
  API-v1 change is hidden;
- completion/performance gates and human decisions are explicit;
- later evidence is non-circular;
- no `TBD`, `TODO`, placeholder, or “similar to” step remains.

Any failed item is corrected before human review.
