# Rallar Group-State Server Traceability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task by task. Use
> `superpowers:test-driven-development` for every behavior or contract-facing
> correction. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the authoritative group-state server easier for a human to enter,
trace, and review by publishing durable navigation and stronger authoring
guidance first, then applying behavior-neutral type, transaction-owner, timing,
and naming corrections.

**Architecture:** This child succeeds the PR #59 server structure work and the
PR #61/#62 traceability QA work. PR A changes guidance and durable navigation
only. PR B preserves every observable and persisted contract while replacing
repeated protocol assertions with a discriminated relationship, exposing the
canonical transaction writer at the handler boundary, keeping presence commit
selection in the handler, closing the timed-operation inventory, and aligning
one internal computed-result name. Both implementation PRs are complete; the
separate server evidence-ledger publication is pending.

**Tech Stack:** Markdown, TypeScript 7.0.2, Vitest, Deno, AppInbox,
PostgreSQL 16, the warning-only repository style checker, Git, and GitHub
Actions.

## Global Constraints

- This is a linked successor to the
  [server structure child](rallar-group-state-server-structure-plan.md) and the
  [server traceability QA child](rallar-group-state-server-traceability-qa-plan.md)
  under the
  [Repository Human Traceability Refactoring Program](repo-human-traceability-refactoring-program-plan.md).
- The human must approve the exact Git blob of this plan before PR A begins.
  Planning approval authorizes only this plan's two implementation PRs; each
  merge remains a separate exact human decision.
- Use one child-specific goal after approval and reuse it across PR A and PR B.
- PR A is guidance, durable navigation, and directly owned governance tests
  only. PR B is behavior-neutral runtime traceability inside authoritative
  group-state and its directly owned tests only.
- PR B starts only after PR A's exact resulting `main` SHA passes **Run Hetzner
  Supported Distributed Manifests**.
- Preserve every public or package export, import path, HTTP and AppInbox
  contract, persisted format, storage key, property order, omission/default/
  cloning rule, volatile-value point, canonical ordering rule, and public
  return.
- Preserve AppInbox reservation, transaction ownership, callback and retry
  behavior, total attempts, backoff, fairness, optimistic concurrency,
  idempotency, receipt/event/audience production, required outbox intents,
  final outbox writes, atomic rollback, observation, wake, and caller-result
  semantics.
- Preserve all timing-event fields, field presence and order, operation names,
  calls, results, errors, and counts exactly. Principal/session enrichment is
  outside this child.
- Preserve TypeScript `7.0.2`, dependencies, lockfiles, workflows, checker
  implementation and warning-only behavior, global performance policy, and the
  existing child-specific 1.5% performance evaluator.
- Keep every human-authored module at or below 400 physical lines and every new
  or materially changed general function at or below 60 physical lines. These
  limits never authorize pass-through helpers, generic dependency bags,
  compatibility hops, hidden defaults, or duplicated state.
- Preserve
  `plans/rallar-rest-snapshot-read-convergence-implementation-plan.md`
  unchanged.
- Do not reorganize API-v1, browser code, topology ownership, RTC RTT ownership,
  another mutation domain, or the server evidence ledger in this child.
- Keep all future implementation, pull-request, merge, workflow, and ledger
  facts outside the Git trees that would create them. Completed planning facts
  and completed local PR A task facts are recorded only after they already
  exist.

---

Date: 2026-08-02

Status: Complete implementation record. Guidance/navigation PR #64 and
behavior-neutral runtime PR #65 passed their exact publication, merge, and
resulting-main workflow envelopes. The separately authorized five-plan server
evidence-ledger publication is pending. The API-v1 child remains blocked and
unstarted until that ledger reaches `ledger-published`.

## 1. Prerequisite And Scope Boundary

The exact PR #62 publication envelope is the prerequisite for this plan:

- PR #62 feature head: `b579aa56bc656b12f3717f2b02c0e24de9244357`;
- frozen feature tree: `3a7d80a3a9c522ba4954168be5f380aee04f871b`;
- Branch Release Gate run `30739771277`, attempt 1, success for that exact head;
- PR #62, the behavior-neutral runtime PR from the server traceability QA
  child;
- resulting `main` SHA: `f124f8c3ac57e5f3a92c47f767f8b7e2b19e6af5`;
- resulting `main` tree: `3a7d80a3a9c522ba4954168be5f380aee04f871b`;
- **Run Hetzner Supported Distributed Manifests** run `30741608017`, attempt 1,
  success for that exact resulting-main SHA.

These facts prove that PR #62 is published. They do not make the existing server
evidence ledger publishable yet: this child deliberately inserts PR A and PR B
before that ledger.

The planning envelope is also complete:

- planning feature head: `477cf23c9e252f37b0a4f2cc9e1dc5943396eb3f`;
- frozen planning tree: `c74ea92a13f38f49521a285d97e5a3eea4b99001`;
- PR #63 approved the plan blob
  `4ee1aca23ab50f94838cb3648432754b520a39f2`;
- Branch Release Gate run `30742629944`, attempt 1, succeeded for that exact
  planning feature head;
- resulting `main` SHA: `61356b7c72310864917005053d5a4c9f431ee91e`; and
- resulting `main` tree: `c74ea92a13f38f49521a285d97e5a3eea4b99001`, the same
  tree as the planning feature; and
- **Run Hetzner Supported Distributed Manifests** run `30744279428`, attempt 1,
  succeeded for that exact resulting-main SHA.

At planning-publication time, these facts authorized PR A Task 1 and Task 2
only. They did not record a PR A final head, tree, PR number, Branch Release
Gate, merge, default workflow, ledger publication, or API-v1 start. The later
completed PR A and PR B envelopes are now recorded in Section 12; the pending
ledger's own future publication evidence remains external.

This child addresses the remaining human-traceability findings after PR #62:

1. protocol dispatch still repeats case-local payload assertions instead of
   carrying the existing type-to-payload relationship in the discriminant;
2. transaction/retry semantics are duplicated at the handler boundary instead
   of being directly navigable through a named port beside the writer;
3. presence connect chooses active versus inactive commit behavior through
   callbacks owned by a helper instead of returning a typed decision to the
   canonical handler;
4. timing operation names are runtime strings rather than a closed inventory;
5. one computed-result symbol still reads as an imperative write;
6. temporary source-text assertions remain after semantic type/runtime owners
   now exist; and
7. the feature lacks a durable, colocated navigation map despite its module and
   control-flow-family size.

The work is a traceability correction, not a semantic redesign. If any item
requires observable behavior, a public or persisted contract, a compatibility
structure, an AppInbox invariant, a dependency, a workflow, checker behavior,
or a performance threshold to change, execution stops for a new human decision.

## 2. Human Traceability Acceptance Contract

### 2.1 Guidance acceptance

PR A must make these requirements explicit in the authoritative guidance:

- A protocol dispatcher uses a discriminated type-to-payload relationship when
  that relationship already exists. Repeated case-local assertions are not an
  acceptable substitute.
- One boundary narrowing may establish an existing typed protocol relationship.
  It must not claim to validate fields it did not inspect, silently add payload
  validation, or alter runtime error timing.
- Transaction, retry, lifecycle, and after-commit dependencies use a named port
  declared beside the canonical owner. From a consumer, **Go to Definition**
  must reveal invocation, retry, commit, and failure semantics instead of an
  anonymously duplicated signature.
- Capability cohesion is judged by responsibility, not method count. Several
  methods that own one transaction phase may form one narrow capability; several
  unrelated methods do not become cohesive merely because the count is small.
- An explicit timing/decorator owner uses a closed operation-name type and an
  exhaustive operation inventory.
- Timing identity fields are deliberately populated, deliberately retained for
  compatibility, or removed only through separately approved observable-
  behavior work.
- A feature with more than 20 production modules or more than three materially
  different control-flow families retains a durable repository navigation map.
  A historical PR body is not a durable substitute.
- Semantic tests are primary. Source inventories, exact-tree checks, string
  assertions, and line/count ratchets are supplementary and temporary, with a
  named owner and removal condition.

No checker rule, parser, schema, severity, output, count, debt calculation, or
strictness changes in PR A.

### 2.2 Durable navigation acceptance

`packages/shared-server/rallar-system/group-state/README.md` becomes the
colocated navigation owner. It links to source rather than duplicating runtime
truth and includes:

- a construction and callback-registration timeline;
- a request/enqueue timeline separated from later queue delivery and runtime
  invocation;
- the canonical descriptor, handler, transaction, read, compute, validate,
  write, durable-result, after-commit observation, wake, and caller-result
  owners;
- separate ordinary mutation, presence-connect, presence-maintenance,
  snapshot/query, and event families;
- normal exits, inactive/no-op exits, retry re-entry, terminal failures,
  cleanup, and compatibility-only paths; and
- a short ordered **Read these files first** list using current repository links.

`packages/shared-server/architecture.md` links to the colocated README without
copying its timelines. A repository-governance test fails closed when a linked
path disappears or a named primary symbol is no longer present. The test does
not treat README prose as runtime truth.

### 2.3 Runtime acceptance

PR B must leave these paths direct for a human:

```text
authenticated enqueue
    -> isAuthenticatedGroupMutationEnqueue
    -> toGroupMutationDescriptor
    -> AppGroupInboxService registration
    -> GroupStateInboxHandler.processGroupStateMutation
    -> read -> compute -> validate
    -> AppInboxMutationTransactionWriter
    -> durable result + private after-commit result
    -> observe committed snapshot
    -> wake queue
    -> caller-visible durable result
```

Presence connect may return an inactive decision or an active computed decision,
but `GroupStateInboxHandler` remains the visible owner that chooses and performs
the corresponding transaction. Timing decoration remains explicit and
exhaustive, and no new hop is introduced solely to satisfy a type or size rule.

## 3. Exact Pull-Request Scope And File Ownership

### 3.1 PR A: guidance and durable navigation

Create branch `codex/rallar-group-state-traceability-hardening-guidance` from
the planning PR's exact resulting-main SHA after its default workflow succeeds.

Approved guidance and navigation paths:

```text
.agents/skills/rallar-code-writing/references/repo-code-style.md
.agents/skills/rallar-code-writing/references/convergent-service-writing.md
.agents/skills/rallar-realtime/SKILL.md
.agents/skills/rallar-testing/SKILL.md
.agents/skills/publishing-plan-progress/SKILL.md
docs/repo-human-style-guide.md
packages/shared-server/architecture.md
packages/shared-server/rallar-system/group-state/README.md
packages/tests/repo/rallar-authoritative-mutation-guidance-integrity.test.ts
packages/tests/repo/rallar-group-state-owner-integrity.test.ts
packages/tests/repo/repo-code-style-review-evidence-integrity.test.ts
packages/tests/repo/group-state-navigation-map-integrity.test.ts
packages/tests/repo/group-state-server-source-ratchet.test.ts
packages/tests/repo/group-state-server-source-ratchet-inventory.ts
packages/tests/rallar-black-box/rallar-testing-skill.test.ts
package.json
plans/rallar-group-state-server-traceability-hardening-plan.md
```

`package.json` may change only to register the new navigation-map integrity test
in `test:repo-governance`. The plan may receive only factual Task 1-3 progress
evidence; no future merge or default-workflow fact enters PR A's tree.

If an existing integrity owner is a more cohesive home for a proposed assertion,
use it instead of creating another test module and amend the plan factually. Do
not add multiple overlapping prose-string test owners.

### 3.2 PR B: behavior-neutral runtime traceability

Create branch `codex/rallar-group-state-traceability-hardening-runtime` from PR
A's exact resulting-main SHA after its default workflow succeeds.

Approved production owners:

```text
packages/shared-server/rallar-system/services/app-inbox-transaction-writer.ts
packages/shared-server/rallar-system/services/AppGroupInboxService.ts
packages/shared-server/rallar-system/group-state/README.md
packages/shared-server/rallar-system/group-state/group-state-service-timing.ts
packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts
packages/shared-server/rallar-system/group-state/inbox/to-group-mutation-descriptor.ts
packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts
packages/shared-server/rallar-system/group-state/presence/group-presence-service.ts
packages/shared-server/rallar-system/group-state/mutation/group-mutation-result.ts
packages/shared-server/rallar-system/group-state/mutation/aggregate/compute-group-aggregate-mutation.ts
packages/shared-server/rallar-system/group-state/mutation/presence/compute-group-presence-mutation.ts
packages/shared-server/rallar-system/group-state/mutation/write/compute-group-membership-write.ts
```

Approved directly owned semantic and architecture tests:

```text
packages/tests/shared-server/group-state/inbox/group-state-inbox-descriptor-contract.test.ts
packages/tests/shared-server/group-state/inbox/group-state-inbox-operation-matrix.test.ts
packages/tests/shared-server/group-state/inbox/group-state-inbox-construction.test.ts
packages/tests/shared-server/group-state/inbox/group-state-inbox-payload-contract.test.ts
packages/tests/shared-server/group-state/inbox/group-state-inbox-transaction-result.test.ts
packages/tests/shared-server/group-state/inbox/group-state-inbox-transaction-failures.test.ts
packages/tests/shared-server/group-state/inbox/group-state-transaction-boundary-fixture.ts
packages/tests/shared-server/group-state/inbox/group-state-inbox-test-runtime.ts
packages/tests/shared-server/group-state/group-state-service-timing.test.ts
packages/tests/shared-server/group-state/group-state-service-timing-contract.test.ts
packages/tests/shared-server/group-state/group-state-service-timing-fixture.ts
packages/tests/shared-server/group-state/mutation/group-mutation-result.test.ts
packages/tests/shared-server/group-state/mutation/group-mutation-result-adaptation.test.ts
packages/tests/shared-server/group-state/mutation/group-mutation-result-persistence.test.ts
packages/tests/shared-server/group-state/mutation/group-aggregate-mutation.test.ts
packages/tests/shared-server/group-state/mutation/group-membership-mutation.test.ts
packages/tests/shared-server/group-state/mutation/group-presence-mutation.test.ts
packages/tests/shared-server/group-state/presence/group-presence-connect-decision.test.ts
packages/tests/repo/group-state-server-source-ratchet-inventory.ts
packages/tests/repo/group-state-server-source-ratchet.test.ts
packages/tests/repo/group-state-traceability-active-paths.test.ts
packages/tests/repo/group-state-navigation-map-integrity.test.ts
packages/tests/repo/rallar-group-state-owner-integrity.test.ts
plans/rallar-group-state-server-traceability-hardening-plan.md
```

A directly affected existing semantic test may change when exact RED/GREEN
evidence requires it. A new test module is allowed only when it owns one cohesive
responsibility and is needed to keep every module within 400 lines. Production
work outside the listed authoritative group-state and transaction-writer owners
is a stop condition.

## 4. Locked Internal Contracts

No type in this section becomes a package-entrypoint export or changes a public
method signature. A type may be exported from its internal source module only
when another approved internal owner must import it.

### 4.1 Authenticated descriptor relationship

Declare the existing 17-way relationship beside the AppInbox payload contracts:

```ts
export interface AuthenticatedGroupMutationPayloadByType {
    [AppInboxType.GROUP_CREATE]: GroupCreateAppInboxPayload;
    [AppInboxType.GROUP_UPDATE]: GroupUpdateAppInboxPayload;
    [AppInboxType.GROUP_DIRECTOR_APPOINT]: GroupDirectorAppointAppInboxPayload;
    [AppInboxType.GROUP_JOIN]: GroupJoinAppInboxPayload;
    [AppInboxType.GROUP_INVITE_CREATE]: GroupInviteCreateAppInboxPayload;
    [AppInboxType.GROUP_INVITE_REVOKE]: GroupInviteRevokeAppInboxPayload;
    [AppInboxType.GROUP_INVITE_ACCEPT]: GroupInviteAcceptAppInboxPayload;
    [AppInboxType.GROUP_JOIN_CODE_ROTATE]: GroupJoinCodeRotateAppInboxPayload;
    [AppInboxType.GROUP_MEMBER_REMOVE]: GroupMemberRemoveAppInboxPayload;
    [AppInboxType.GROUP_MEMBER_BAN]: GroupMemberBanAppInboxPayload;
    [AppInboxType.GROUP_MEMBER_UNBAN]: GroupMemberUnbanAppInboxPayload;
    [AppInboxType.GROUP_MEMBER_ROLE_SET]: GroupMemberRoleSetAppInboxPayload;
    [AppInboxType.GROUP_OWNERSHIP_TRANSFER]: GroupOwnershipTransferAppInboxPayload;
    [AppInboxType.GROUP_MEMBER_UPSERT]: GroupMemberUpsertAppInboxPayload;
    [AppInboxType.GROUP_PRESENCE_CONNECT]: GroupPresenceConnectAppInboxPayload;
    [AppInboxType.GROUP_PRESENCE_HEARTBEAT]: GroupPresenceHeartbeatAppInboxPayload;
    [AppInboxType.GROUP_PRESENCE_DISCONNECT]: GroupPresenceDisconnectAppInboxPayload;
}

export type AuthenticatedGroupMutationInboxType = keyof AuthenticatedGroupMutationPayloadByType;

export type AuthenticatedGroupMutationEnqueue = Readonly<
    {
        [Type in AuthenticatedGroupMutationInboxType]:
            & Omit<AppInboxEnqueueInput<AuthenticatedGroupMutationPayloadByType[Type]>, 'type'>
            & Readonly<{ type: Type; }>;
    }
>[AuthenticatedGroupMutationInboxType];

interface AuthenticatedGroupMutationEnqueueCandidate {
    readonly type: AppInboxType;
}

export function isAuthenticatedGroupMutationEnqueue(
    enqueue: AuthenticatedGroupMutationEnqueueCandidate
): enqueue is AuthenticatedGroupMutationEnqueue;

export function toGroupMutationDescriptor(
    enqueue: AuthenticatedGroupMutationEnqueue
): GroupMutationDescriptor;
```

The predicate preserves the current `AUTHENTICATED_GROUP_INBOX_TYPES`
membership decision. It does not inspect payload fields, validate the payload,
alter unsupported-type error timing, or replace downstream command validation.
Remove, ban, and unban retain their exact distinct payload types. Export these
types only from their internal source module; do not add a package entrypoint
export. Replace the internal `isAuthenticatedGroupMutationInboxType` consumer
with the enqueue predicate and remove the superseded predicate without a
compatibility alias. Each family helper accepts its exact `Extract<...>` subset
of `AuthenticatedGroupMutationEnqueue`, and every switch is exhaustive through
a `never` assertion. The assertion preserves the exact existing
`GroupMutationAuthorizationError` text when an untyped runtime caller supplies
an unsupported type.

### 4.2 Named transaction writer port

Declare beside `AppInboxTransactionWriter`:

```ts
export interface AppInboxMutationTransactionWriter {
    writeMutation<Result>(
        context: AppInboxMessageContext,
        write: (transaction: PSqlTransactionSql) => Promise<Result>
    ): Promise<Result>;

    writeMutationWithAfterCommitResult<DurableResult, AfterCommitResult>(
        context: AppInboxMessageContext,
        write: (
            transaction: PSqlTransactionSql
        ) => Promise<AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>>
    ): Promise<AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>>;
}
```

`AppInboxTransactionWriter` implements this internal port. Export the port only
from that internal source module so the handler can import it; add no package
entrypoint export. Go to Definition must reach the current canonical writer and
its transaction/finalization logic. No second adapter or compatibility export
is created.

The handler contract becomes:

```ts
export interface GroupStateInboxHandlerDependencies {
    readonly mutationService: GroupStateMutationService;
    readonly sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
    readonly snapshotObserver: Pick<GroupStateService, 'observeSnapshot'>;
    readonly transactionWriter: AppInboxMutationTransactionWriter;
    readonly wakeQueue?: () => void;
}
```

Delete `GroupStateInboxMutationOperations`. The broad exported
`GroupStateService` and all of its consumers remain unchanged. The handler gets
separate named responsibilities without multiplying them into one-method ports.

### 4.3 Presence-connect decision

Replace callback-based presence-connect commit ownership with:

```ts
export type GroupPresenceConnectOutcome =
    | InactiveGroupPresenceResult
    | Readonly<{
        status: 'ready-to-commit';
        computed: GroupMutationComputed;
        lifecycleGuard: WsSessionGenerationLifecycleComputed;
    }>;

interface ProcessGroupPresenceConnectInput {
    readonly command: GroupStateMutationCommand;
    readonly mutationService: GroupStateMutationService;
    readonly sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
}
```

`processGroupPresenceConnect` reads, computes, validates, and returns the exact
decision from `ProcessGroupPresenceConnectInput`. It does not receive a
transaction callback. The handler performs the inactive durable transaction or
the active mutation transaction visibly inside `processGroupStateMutation`.
The inactive result shape, active durable bytes, callback invocation count,
lifecycle guard, observation, wake, and failures are unchanged.

### 4.4 Closed timing operation inventory

Declare:

```ts
type GroupStateTimedOperation = Exclude<
    keyof GroupStateService,
    'compute' | 'validate' | 'sessionGenerationLifecycle'
>;
```

Every timing wrapper and `timeGroupStateOperation` input uses that type. Tests
prove the runtime operation inventory and the Promise-returning service-key
inventory agree exactly, including optional `listRecentEvents` presence and
absence. Timing identity data remains exactly as published by PR #62.

### 4.5 Internal result name

Rename `computeGroupMutationWrite` to `computeGroupMutationWriteResult` in its
existing owner and direct internal consumers. Add no alias, compatibility hop,
or new file solely for this rename.

## 5. Implementation Tasks

### Task 0: Publish And Approve This Child Plan

**Files:**

- Create: `plans/rallar-group-state-server-traceability-hardening-plan.md`
- Modify: `plans/repo-human-traceability-refactoring-program-plan.md`
- Modify: `plans/repo-human-traceability-program-execution-plan.md`
- Modify: `plans/rallar-group-state-server-structure-plan.md`
- Modify: `plans/rallar-group-state-server-traceability-qa-plan.md`

- [x] Verify PR #62's exact feature head, tree, Branch Release Gate, resulting
      `main`, resulting tree, and successful default-branch workflow from Git
      and GitHub.
- [x] Start the planning branch from exact `main`
      `f124f8c3ac57e5f3a92c47f767f8b7e2b19e6af5` and tree
      `3a7d80a3a9c522ba4954168be5f380aee04f871b`.
- [x] Add this child and reciprocal links without rewriting historical evidence.
- [x] Mark it drafted/unapproved, keep the server ledger pending, and keep the
      API-v1 child blocked.
- [x] Run Section 7.1 on one unchanged planning tree.
- [x] Publish the non-default planning PR #63, require Branch Release Gate
      `30742629944` attempt 1 success for feature
      `477cf23c9e252f37b0a4f2cc9e1dc5943396eb3f`, and obtain human approval of
      exact plan blob `4ee1aca23ab50f94838cb3648432754b520a39f2`.
- [x] Wait for planning-PR merge `61356b7c72310864917005053d5a4c9f431ee91e`
      and default workflow `30744279428` attempt 1 success before creating the
      implementation branch and child-specific goal.

### Task 1: Strengthen Human-Traceability Guidance Test-First

**Files:** the PR A guidance and directly owned integrity files in Section 3.1.

- [x] Start PR A from planning `main`
      `61356b7c72310864917005053d5a4c9f431ee91e` after its default workflow
      succeeds and create one child-specific goal.
- [x] Add baseline pressure scenarios for every Section 2.1 rule before changing
      guidance. The authorization-focused controls produced RED for Rules 1-7;
      Rule 8 was already baseline compliant, so its clearer semantic-primary
      vocabulary is plan-driven clarification rather than failure-derived work.
- [x] Update the code standard, convergent-service guidance, realtime skill,
      testing skill, publishing skill, and human review guide as one consistent
      contract.
- [x] Require human disposition of changed production construction warnings;
      do not make every optional warning globally blocking.
- [x] Keep mechanical ratchets supplementary with an owner and removal
      condition.
- [x] Run the focused skill/review suites and `npm run test:repo-governance` to
      GREEN; Task 1 was accepted at
      `afe4760aaea04b29d8b9063f421903ec9c7f5f6f`. The ignored final repeated
      campaign retained five independent baseline-control and five independent
      updated-guidance samples covering all eight rules: baseline had three
      choice vectors and no all-rule target sample, while updated guidance
      converged on `BBBBBBBB` in all five samples. Rule 8 stayed baseline
      compliant.

### Task 2: Add The Durable Group-State Navigation Map

**Files:**

- Create: `packages/shared-server/rallar-system/group-state/README.md`
- Modify: `packages/shared-server/architecture.md`
- Create: `packages/tests/repo/group-state-navigation-map-integrity.test.ts`
- Modify: `packages/tests/repo/rallar-group-state-owner-integrity.test.ts` only
  for non-overlapping owner assertions
- Modify: `packages/tests/repo/group-state-server-source-ratchet.test.ts` and
  `group-state-server-source-ratchet-inventory.ts` only to retain the exact-tree
  ratchet for the new navigation map and the cumulative changed-TypeScript
  owner inventory without parsing Markdown as TypeScript
- Modify: `package.json` (`test:repo-governance` registration only)

- [x] Derive every timeline and family trace from current source before writing
      the README.
- [x] Record construction/registration separately from request/runtime
      invocation and name every entry, retry, transaction, normal/early/failure
      exit, cleanup, observation, wake, and caller-result owner.
- [x] Add an ordered read-first list with repository-relative links.
- [x] Add test-first path and primary-symbol integrity. Fail when links or named
      owners are stale, but do not make prose the runtime oracle.
- [x] Link the README once from package architecture without duplicating its
      map. Task 2 was accepted through
      `c80d1e0ac519e46d9b4f3cfe35854b6960761340`.

### Task 3: Review And Publish PR A

- [x] Independently review guidance pressure, source-derived navigation,
      checker isolation, test ownership, exact scope, and non-circular evidence;
      Critical 0 and Important 0 are required.
- [x] Resolve ordinary in-scope findings autonomously and rerun every invalidated
      gate.
- [x] Run Section 7.2 on the final unchanged tree.
- [x] Freeze the exact tree/head, push non-forced, update the draft PR with
      current evidence, and require Branch Release Gate for that exact head.
- [x] Mark PR A ready and stop for the exact human merge decision.
- [x] After merge, verify the exact resulting `main` SHA and its successful
      default workflow before Task 4.

### Task 4: Lock Protocol Translation Test-First

**Files:**

- Modify: `packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts`
- Modify: `packages/shared-server/rallar-system/group-state/inbox/to-group-mutation-descriptor.ts`
- Modify: `packages/shared-server/rallar-system/services/AppGroupInboxService.ts`
- Test: descriptor, operation-matrix, construction, and routing owners in
  Section 3.2

- [x] Start PR B from PR A's exact resulting-main SHA after its default workflow
      succeeds.
- [x] Capture all 17 existing descriptor mappings, property orders, defaults,
      omissions, identity fields, volatile-value calls, and unsupported-type
      errors as predecessor GREEN.
- [x] Add compile-time RED cases proving one AppInbox type cannot receive another
      type's payload, including distinct remove, ban, and unban payloads.
- [x] Implement `AuthenticatedGroupMutationPayloadByType`, its union, the
      membership-only predicate, the narrowed translator input, and exhaustive
      switches.
- [x] Keep every public `AppGroupInboxService` method signature unchanged and
      preserve exact runtime error behavior.
- [x] Obtain a scoped independent review with Critical 0 / Important 0.

### Task 5: Make Transaction And Handler Ownership Directly Navigable

**Files:**

- Modify: `packages/shared-server/rallar-system/services/app-inbox-transaction-writer.ts`
- Modify: `packages/shared-server/rallar-system/services/AppGroupInboxService.ts`
- Modify: `packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts`
- Modify: `packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts`
- Modify: `packages/shared-server/rallar-system/group-state/presence/group-presence-service.ts`
- Test: handler construction, transaction-result/failure, presence, retry, and
  operation owners in Section 3.2

- [x] Characterize active and inactive presence connect, ordinary mutation,
      retry, terminal failure, observation, wake, and caller-visible result.
- [x] Add the named transaction port beside the writer and make the writer its
      canonical implementation.
- [x] Pass the writer, mutation service, lifecycle service, and snapshot observer
      as separately named handler responsibilities; remove
      `GroupStateInboxMutationOperations` and duplicated transaction signatures.
- [x] Make presence connect return `GroupPresenceConnectOutcome` without
      transaction callbacks.
- [x] Keep inactive-versus-active transaction choice visibly in
      `processGroupStateMutation`.
- [x] Prove durable JSON bytes/property order, committed-snapshot identity,
      after-commit-only observation, wake timing, retry/callback counts,
      receipts/events/outbox, and rollback are unchanged.
- [x] Obtain a scoped independent review with Critical 0 / Important 0.

### Task 6: Close Timing And Naming Seams

**Files:** timing, computed-result, direct consumers, README, and directly owned
tests in Section 3.2.

- [x] Derive the exact current timing event matrix before editing.
- [x] Apply `GroupStateTimedOperation` to every timing operation field and prove
      exhaustive compile-time/runtime inventory.
- [x] Inspect the optional `listRecentEvents` wrapper and preserve it unchanged:
      no simplification was necessary, and its method presence, receiver,
      arguments, return/rejection identity, and timing event remain exact.
- [x] Preserve all timing identity fields; do not enrich them in this child.
- [x] Rename `computeGroupMutationWrite` to
      `computeGroupMutationWriteResult` and update direct consumers/tests without
      an alias or extra module.
- [x] Update the durable README to the exact final symbols.
- [x] Obtain a scoped independent review with Critical 0 / Important 0.

### Task 7: Replace Superseded Syntax Assertions With Semantic Evidence

**Files:** directly affected PR #62 semantic/ratchet tests in Section 3.2.

- [x] Inventory raw JSON, property-order, identity, error, retry, observation,
      wake, operation-matrix, and source-string assertions before editing.
- [x] Retain every behavior assertion and independently written literal.
- [x] Replace only source-string checks for handler capability, transaction
      result structure, protocol routing, and the computed-write symbol with
      compile-time assignability or runtime architecture assertions.
- [x] Retain exact-tree ratchets until the later ledger satisfies their existing
      removal condition.
- [x] Prove no behavior case or assertion site is weakened or silently removed.
- [x] Obtain a scoped independent review with Critical 0 / Important 0.

### Task 8: Review, Validate, Measure, And Publish PR B

- [x] Run a fresh whole-PR review across Tasks 4-7 for human call-path clarity,
      public/persisted compatibility, AppInbox semantics, runtime cycles,
      module/function limits, source-test balance, and exact scope; require
      Critical 0 / Important 0.
- [x] Resolve ordinary in-scope findings test-first and rerun every invalidated
      gate.
- [x] Keep the PR B ratchet inventory synchronized with the exact changed and
      mirrored test owners, keep navigation links aligned to current primary
      symbols, and resolve only behavior-neutral type-expression, function-size,
      and formatting findings found by the final review.
- [x] Run Section 7.3 on the final unchanged content tree.
- [x] Finish every content, review, evidence, and formatting edit before
      creating the performance candidate.
- [x] Create one immutable local candidate commit and run the exact non-rerolled
      A-B-B-A comparison in Section 7.4. The measured candidate must remain the
      final PR head.
- [x] Preserve the non-reroll policy: no environment, correctness invariant,
      unchanged global-comparator, or child-evaluator failure authorized a
      reroll, scope expansion, or threshold change.
- [x] Push the accepted exact measured candidate non-forced; update the PR
      with before/after timelines, internal contracts, compatibility evidence,
      warning dispositions, validation, artifacts, final SHA, and tree.
- [x] Require Branch Release Gate success for the exact head, mark PR B ready,
      and stop for the exact human merge decision.

## 6. Compatibility And Invariant Matrix

| Surface             | Required proof                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Public/package API  | Export snapshots and direct import consumers are unchanged.                                                                                     |
| Descriptor protocol | All 17 type/payload pairs retain exact descriptor values, order, errors, and volatile points.                                                   |
| AppInbox            | Reservation, retry, transaction, idempotency, receipt, event, audience, outbox, rollback, and finalization tests remain exact.                  |
| Presence connect    | Inactive and ready-to-commit decisions yield predecessor durable result, lifecycle guard, transaction, observation, wake, and failure behavior. |
| Transaction result  | Only durable JSON is persisted; private committed snapshot is released only after confirmed commit with exact identity.                         |
| Timing              | Operation inventory, optional method presence, receiver, arguments, result/rejection identity, event content/order, and counts are exact.       |
| Naming              | Only the private computed-write symbol changes; no alias or compatibility hop appears.                                                          |
| Navigation          | Every linked source path and named primary symbol exists; README prose is not executable authority.                                             |
| Checker             | All modes remain warning-only with unchanged implementation and output contracts.                                                               |
| Performance         | Existing global comparator, 1.5% child evaluator, isolation protocol, and all correctness thresholds remain unchanged.                          |

## 7. Validation Matrix

### 7.1 Planning PR

```bash
npx prettier --write \
  plans/rallar-group-state-server-traceability-hardening-plan.md \
  plans/repo-human-traceability-refactoring-program-plan.md \
  plans/repo-human-traceability-program-execution-plan.md \
  plans/rallar-group-state-server-structure-plan.md \
  plans/rallar-group-state-server-traceability-qa-plan.md
git diff --check
npm run test:repo-governance
npm run test:unit
npm run test:ci
npm run build
```

### 7.2 PR A

```bash
npx vitest run \
  packages/tests/repo/rallar-authoritative-mutation-guidance-integrity.test.ts \
  packages/tests/repo/rallar-group-state-owner-integrity.test.ts \
  packages/tests/repo/repo-code-style-review-evidence-integrity.test.ts \
  packages/tests/repo/group-state-navigation-map-integrity.test.ts \
  packages/tests/rallar-black-box/rallar-testing-skill.test.ts
npm run test:repo-governance
npm run check:repo-style
npm run check:repo-style:layout
npm run check:repo-style:layout-details
npm run check:repo-style:construction-details
npm run check:repo-style:output-contracts
npm run check:repo-style:object-interfaces
npm run check:repo-style:changed -- origin/main
npx prettier --check \
  .agents/skills/rallar-code-writing/references/repo-code-style.md \
  .agents/skills/rallar-code-writing/references/convergent-service-writing.md \
  .agents/skills/rallar-realtime/SKILL.md \
  .agents/skills/rallar-testing/SKILL.md \
  .agents/skills/publishing-plan-progress/SKILL.md \
  docs/repo-human-style-guide.md \
  packages/shared-server/architecture.md \
  packages/shared-server/rallar-system/group-state/README.md \
  plans/rallar-group-state-server-traceability-hardening-plan.md
git diff --check
npm run test:unit
npm run test:ci
npm run build
```

### 7.3 PR B focused and completion gates

```bash
npx vitest run \
  packages/tests/shared-server/group-state/inbox/group-state-inbox-descriptor-contract.test.ts \
  packages/tests/shared-server/group-state/inbox/group-state-inbox-operation-matrix.test.ts \
  packages/tests/shared-server/group-state/inbox/group-state-inbox-construction.test.ts \
  packages/tests/shared-server/group-state/inbox/group-state-inbox-transaction-result.test.ts \
  packages/tests/shared-server/group-state/inbox/group-state-inbox-transaction-failures.test.ts \
  packages/tests/shared-server/group-state/inbox/group-state-inbox-retry.test.ts \
  packages/tests/shared-server/group-state/group-state-service-timing.test.ts \
  packages/tests/shared-server/group-state/group-state-service-timing-contract.test.ts \
  packages/tests/shared-server/group-state/mutation/group-aggregate-mutation.test.ts \
  packages/tests/shared-server/group-state/mutation/group-membership-mutation.test.ts \
  packages/tests/shared-server/group-state/mutation/group-presence-mutation.test.ts \
  packages/tests/shared-server/group-state/mutation/group-mutation-result.test.ts \
  packages/tests/shared-server/group-state/mutation/group-mutation-result-adaptation.test.ts \
  packages/tests/shared-server/group-state/mutation/group-mutation-result-persistence.test.ts \
  packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts \
  packages/tests/shared-server/app-inbox-transaction.test.ts \
  packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts
npx vitest run packages/tests/shared-server/group-state
npx vitest run packages/tests/shared-server
npx vitest run \
  packages/tests/repo/group-state-server-source-ratchet.test.ts \
  packages/tests/repo/group-state-test-structure.test.ts \
  packages/tests/repo/group-state-traceability-active-paths.test.ts \
  packages/tests/repo/group-state-navigation-map-integrity.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
(cd apps/api-v1 && deno task check)
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres:medium-scale
npm run test:repo-governance
npm run check:repo-style
npm run check:repo-style:layout
npm run check:repo-style:layout-details
npm run check:repo-style:construction-details
npm run check:repo-style:output-contracts
npm run check:repo-style:object-interfaces
npm run check:repo-style:changed -- <exact-pr-a-resulting-main-sha>
npx prettier --check \
  packages/shared-server/rallar-system/group-state \
  packages/shared-server/rallar-system/services/app-inbox-transaction-writer.ts \
  packages/shared-server/rallar-system/services/AppGroupInboxService.ts \
  packages/tests/shared-server/group-state \
  packages/tests/repo/group-state-server-source-ratchet.test.ts \
  packages/tests/repo/group-state-traceability-active-paths.test.ts \
  packages/tests/repo/group-state-navigation-map-integrity.test.ts \
  plans/rallar-group-state-server-traceability-hardening-plan.md
git diff --check
npm run test:unit
npm run test:ci
npm run build
```

The executor replaces only the explicit placeholder with the verified PR A
resulting-main SHA before execution. That value is external evidence until it
exists; it is not guessed in this plan.

### 7.4 Governed PR B performance comparison

After all PR B content, review, and local gates are final, create one immutable
candidate commit and run exactly once in this order:

1. PR A's exact resulting-main SHA;
2. exact PR B candidate;
3. the same exact PR B candidate;
4. the same exact PR A resulting-main SHA.

Use the established isolated PostgreSQL 16 protocol from
`scripts/perf/README.md`: four fresh non-overlapping environments, the pinned
image/configuration/resource limits, autovacuum/analyze disabled, zero preflight
rows, no automatic maintenance, warmup `1`, runs `9`, and concurrency `10`.
Pool exactly 18 measured samples per workload per side. Preserve every raw
artifact, environment record, hash, pooled artifact, and manifest. Run the
unchanged global comparator first, then the unchanged server-child 1.5%
evaluator. Do not rerun a position or change candidate content, tooling, a
threshold, comparator, evaluator, or harness after measurement.

## 8. Publication And Exact Human Review Points

1. **Plan approval:** approve only the exact plan Git blob from the planning PR.
   Revisions require another exact-blob approval.
2. **Planning merge:** the human merges the exact planning head/tree. PR A waits
   for its resulting-main default workflow.
3. **PR A merge:** the human reviews and merges the exact guidance/navigation
   head/tree. PR B waits for its resulting-main default workflow.
4. **PR B merge:** the human reviews and merges the exact measured runtime
   head/tree. No ledger publication is implicit.
5. **Ledger authorization:** after PR B's exact resulting-main workflow
   succeeds, a separate human prompt may start the evidence-only server ledger.

Every implementation PR requires independent review with Critical 0 and
Important 0, exact local validation, current PR evidence, and Branch Release
Gate success for its exact final head before it may be marked ready.

## 9. Non-Circular Completion Evidence

The planning tree recorded only PR #62 and earlier evidence. The now-complete
planning envelope above records its existing feature/tree, approved plan blob,
PR #63, Branch Release Gate, merge, and default-workflow facts.

The reciprocal hardening-child rows in the
[master program](repo-human-traceability-refactoring-program-plan.md),
[execution plan](repo-human-traceability-program-execution-plan.md),
[server structure child](rallar-group-state-server-structure-plan.md), and
[server traceability QA child](rallar-group-state-server-traceability-qa-plan.md)
were frozen historical planning-publication records before this separately
authorized ledger. This ledger reconciles their current-state rows without
rewriting their labeled historical checkpoints. Their earlier
drafted/unapproved/no-implementation language is not current execution truth
and must not be relied on for PR A status.

PR A's frozen tree and PR B's frozen tree did not record their future final
heads, PR numbers, Branch Release Gates, merge SHAs, or default workflows. Their
completed publication envelopes now exist outside those frozen trees. PR B's
performance artifacts remain external and uncommitted under `tmp/perf/`.

After PR B merged and its exact resulting-main workflow succeeded, the
separately authorized evidence-only branch updates the server structure plan,
server QA plan, this plan, master program, and execution plan. That ledger
records the already-existing PR #59, PR #60, PR #61, PR #62, PR #63, PR #64,
and PR #65 envelopes. Its frozen tree may not record its own future tree,
commit, PR, Branch Release Gate, merge SHA, or default workflow. Only after the
ledger PR merges and the exact resulting-main workflow succeeds may the external
handoff call the server work `ledger-published` and unblock the API-v1 child.

## 10. Acceptance Checklist

- [x] Human approved plan blob `4ee1aca23ab50f94838cb3648432754b520a39f2`.
- [x] Planning PR #63 merged as
      `61356b7c72310864917005053d5a4c9f431ee91e` and its exact
      resulting-main workflow `30744279428` attempt 1 passed.
- [x] PR A guidance pressure tests failed before implementation and passed after.
- [x] PR A published the durable group-state navigation map with verified paths
      and primary symbols.
- [x] PR A changed no checker behavior or production code.
- [x] PR A review has Critical 0 / Important 0 and all local/remote gates passed.
- [x] PR A merged and its exact resulting-main workflow passed.
- [x] All 17 authenticated type/payload relationships are discriminated and
      descriptor behavior remains exact.
- [x] The named transaction writer port leads directly to the canonical owner.
- [x] Handler dependencies are cohesive named responsibilities; the broad
      public service remains unchanged.
- [x] Presence connect returns a typed decision and the handler visibly owns
      inactive and active transaction selection.
- [x] Durable bytes, private snapshot identity, observation, wake, retry,
      receipt, event, audience, outbox, and rollback behavior are unchanged.
- [x] The timed-operation type and runtime inventory are exhaustive with exact
      timing-event behavior.
- [x] `computeGroupMutationWriteResult` is the only internal computed-write
      symbol and no alias/hop exists.
- [x] Superseded source-string assertions were replaced only where semantic
      evidence is stronger; all behavior assertions remain.
- [x] PR B review has Critical 0 / Important 0 and every focused/completion gate
      passed on the exact unchanged candidate.
- [x] The one A-B-B-A comparison passed both unchanged evaluators without a
      reroll or post-measurement content change.
- [x] PR B Branch Release Gate passed for its exact measured head.
- [x] PR B merged and its exact resulting-main workflow passed.
- [ ] Server later ledger reached `ledger-published` through separate
      authorization and publication.
- [ ] API-v1 remained blocked until ledger publication.

## 11. Risks And Stop Conditions

| Risk                                                                                    | Required response                                                                               |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Boundary predicate begins validating payload fields                                     | Restore enum-membership-only narrowing; stop if runtime validation must change.                 |
| Type mapping changes a descriptor, error, order, default, or volatile point             | Restore predecessor behavior test-first; no semantic cleanup is authorized.                     |
| Named ports multiply into tiny abstractions                                             | Keep one cohesive responsibility at the canonical owner; add no dependency bag or pass-through. |
| Presence decision changes transaction selection or callback count                       | Restore exact active/inactive behavior; stop if a semantic change is required.                  |
| Private after-commit data reaches durable JSON or escapes before commit                 | Stop and restore exact durable projection and commit-confirmed release.                         |
| Timing typing changes any event or optional method behavior                             | Restore byte-for-byte timing behavior; enrichment requires a separate plan.                     |
| README becomes a second runtime specification                                           | Keep it a link-based navigation map and verify source owners instead.                           |
| Semantic tests are replaced by syntax checks                                            | Restore semantic behavior assertions; ratchets remain supplementary only.                       |
| New public export, compatibility hop, runtime cycle, or API-v1 change appears necessary | Stop for an explicit human plan decision.                                                       |
| Performance or convergence fails                                                        | Stop with immutable evidence; do not reroll, optimize outside scope, or change a threshold.     |
| Default workflow or infrastructure persistently fails                                   | Stop with the exact failed run/job/step; do not diagnose unrelated providers.                   |

## 12. Progress Record

| Milestone                 | State                  | Evidence                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR #62 prerequisite       | published              | Feature `b579aa56bc656b12f3717f2b02c0e24de9244357`, tree `3a7d80a3a9c522ba4954168be5f380aee04f871b`, Branch Release Gate `30739771277` attempt 1 success, resulting `main` `f124f8c3ac57e5f3a92c47f767f8b7e2b19e6af5`, default workflow `30741608017` attempt 1 success.                                                                                                    |
| Hardening child plan      | approved and published | Planning feature `477cf23c9e252f37b0a4f2cc9e1dc5943396eb3f`, tree `c74ea92a13f38f49521a285d97e5a3eea4b99001`, PR #63, approved plan blob `4ee1aca23ab50f94838cb3648432754b520a39f2`, Branch Release Gate `30742629944` attempt 1 success, resulting `main` `61356b7c72310864917005053d5a4c9f431ee91e` with the same tree, default workflow `30744279428` attempt 1 success. |
| PR A guidance/navigation  | complete               | PR #64 feature `6ce2bcce85f3a03446c847f4b07689c1c0b1e70e`, tree `00d475e7d40bed7060567ee391ffe1041fba443a`, Branch Release Gate `30748239173` attempt 1 success, resulting `main` `49237d8bb75d2239569aa4e3d43f8b88db799602` with the same tree, default workflow `30749273740` attempt 1 success.                                                                          |
| PR B runtime traceability | complete               | PR #65 feature `a7e429274a8776b8e1cc842da9c472a12feee224`, tree `c1cd8fd529efec6486acb34f0d79e084e33141d0`, Branch Release Gate `30755181882` attempt 1 success, resulting `main` `5a6ffd385655af75b28aa22feb5a7103f87862a0` with the same tree, default workflow `30774354577` attempt 1 success.                                                                          |
| Server later ledger       | pending publication    | Separately authorized five-plan ledger records completed implementation envelopes only; its own future publication evidence remains external.                                                                                                                                                                                                                               |
| API-v1 child              | blocked and unstarted  | Waits for the server ledger to reach `ledger-published`.                                                                                                                                                                                                                                                                                                                    |

## 13. Planning Self-Review Record

Before publication, review this complete plan for:

- missing findings, placeholders other than the deliberately external PR A base
  in an execution command, or conditional implementation choices;
- inconsistent filename, interface, type, method, and primary-symbol names;
- hidden public, persisted, AppInbox, timing, checker, dependency, workflow,
  TypeScript, performance, API-v1, or compatibility changes;
- a boundary narrowing that claims validation it does not perform;
- a named port that duplicates rather than reveals the canonical owner;
- callback-based transaction ownership or private data escaping before commit;
- timing inventory gaps or accidental identity enrichment;
- navigation prose that duplicates runtime truth;
- mechanical tests displacing semantic evidence;
- runtime cycles, generic owners, dependency bags, pass-through helpers, hidden
  defaults, duplicated state, or extra compatibility hops;
- tasks too broad for independent review;
- incomplete mutation-path, concurrency-domain, performance, publication, or
  human-review gates; and
- circular future evidence or an API-v1/ledger start hidden inside this child.

Any unresolved Critical or Important finding returns the exact plan blob to
revision before approval.
