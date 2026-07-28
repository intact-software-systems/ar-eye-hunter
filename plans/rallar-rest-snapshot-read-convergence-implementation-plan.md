# Rallar REST Snapshot Read Convergence Implementation Plan

> **Status:** Revalidated against current `main`; review-ready, not approved and not
> implementation-complete.
>
> **Implementation workflow:** Use `superpowers:executing-plans` or
> `superpowers:subagent-driven-development` only after the human architecture
> decisions in Task 0 are recorded. Use the repo-local `rallar-code-writing`,
> `rallar-platform`, `rallar-realtime`, `rallar-testing`, and
> `publishing-plan-progress` skills throughout implementation.

**Goal:** Give REST point-snapshot reads an explicit convergence contract that
matches the current revision domains:

- client point reads use the scalar, entity-local `stateRevision`;
- group point reads use the authoritative
  `GroupStateCausalRevision { groupRevision, presenceRevision }`;
- an omitted minimum reads a durable snapshot;
- a supplied minimum may use a presence-fresh process cache only when it equals
  or dominates the caller's floor;
- strict authorization always uses current durable authority;
- browser refresh and collection reconciliation converge without claiming that
  a physical delete is a causal tombstone.

## Revalidation Against Main

### Reviewed baseline

| Item | Exact value |
|---|---|
| Review date | 2026-07-27 |
| Current branch | `main` |
| Reviewed `HEAD` | `6d87fcbe9b7812b366d0c91f45b27a1179c878e4` |
| Local `origin/main` after `git fetch origin main` | `6d87fcbe9b7812b366d0c91f45b27a1179c878e4` |
| `FETCH_HEAD` after fetch | `6d87fcbe9b7812b366d0c91f45b27a1179c878e4` |
| Status | `## main...origin/main`; clean index and working tree; no untracked files |
| User changes present before review | No |
| Original plan commit | `f38cf81627f3e91a5f5c09460fa69ce4718d4bec`, 2026-07-20 |

The fetched remote-tracking ref, `FETCH_HEAD`, and checked-out `HEAD` agree.
This checkout therefore represented current remote `main` at the review
boundary. Any implementation session must repeat this baseline check because
the conclusion is SHA-specific.

### Important architectural changes and corrections

| Change or corrected assumption | Classification | Current evidence and plan consequence |
|---|---|---|
| Group authority is a two-component causal revision; scalar `stateRevision` is only a compatibility projection. | Contradicted by the old plan; already implemented before the old plan | `packages/shared/api/group-types.ts:166-169,203-213`; `packages/shared/api/group-client-views.ts:68-109`; `packages/shared/repository/group-state-snapshots-repository.ts:224-269`. Replace every group scalar floor with a complete causal floor and define incomparable behavior. |
| Group presence uses per-session guards and no longer advances the group row for every presence write. | Old runtime map obsolete; already implemented | `packages/shared-server/rallar-system/services/group-state-guarded-batch.ts:118-136`; `packages/shared-server/rallar-system/repositories/GroupStateRepository.ts:620-660`. Remove the old contention premise. |
| Presence summaries are hints; durable assembly revalidates group lifecycle, active membership, session identity/generation, connectivity, expiry, and one captured observation time. | Already implemented | `packages/shared-server/rallar-system/repositories/group-state-snapshot-assembly.ts:13-100`; `packages/shared-server/rallar-system/repositories/GroupStateRepository.ts:331-421,810-871`. Keep this as a non-regression invariant, not new work. |
| AppInbox owns incoming mutation transactions and retry attempts. Services perform named `read`, `compute`, `validate`, and `write(transaction, computed)` phases. | Old companion-plan dependency obsolete; already implemented | `packages/shared-server/rallar-system/services/app-inbox-transaction-writer.ts:47-82,126-152`; `packages/shared-server/rallar-system/services/AppClientInboxService.ts:424-446`; `packages/shared-server/rallar-system/services/AppGroupInboxService.ts:957-1076`. This read plan must not create a mutation bypass or a second transaction/retry boundary. |
| The intermediate mutation outbox was removed. Final resource outbox rows are written in the received transaction. | Old follow-up obsolete; already implemented | Commit `f5e10b2bbf23092c2c98c501fb20ee17fb8583d8`; `packages/shared-server/rallar-system/services/client-state-service.ts:238-282`; `packages/shared-server/rallar-system/services/group-state-guarded-batch.ts:118-179`; `packages/shared-server/rallar-system/services/GroupPresenceSummaryWork.ts:178-222`. Remove every proposed intermediate-outbox dependency. |
| Group point REST reads already call a full durable snapshot read. | Old READ-02 obsolete; already implemented | `apps/api-v1/src/routes/group-state-routes.ts:151-169`; `packages/shared-server/rallar-system/services/cached-group-state-service.ts:56-59`. Do not reimplement this behavior. |
| Client point REST reads and strict self-collection reads still call cached `readSnapshot`. | Missing required work | `apps/api-v1/src/routes/client-state-routes.ts:72-110`; production injection in `apps/api-v1/src/create-rallar-server.ts:337-349` and cached-service requirement in `apps/api-v1/src/middleware-contract.ts:20-33`. Add an explicit durable current-client method and use it for tokenless reads. |
| Group point and event authorization are durable, but graph/topology policy can use cached `readSnapshot`. | Partially implemented; missing security work | `apps/api-v1/src/routes/group-state-routes.ts:151-169,941-985`; `apps/api-v1/src/routes/graph-topology-routes.ts:350-377`; cached production injection at `apps/api-v1/src/create-rallar-server.ts:350-363`. Require a durable current read in graph/topology policy paths. |
| Group cache services and browser repositories already compare causal tuples and reject incomparable observations. | Already implemented | `packages/shared-server/rallar-system/services/group-state-snapshot-read-through-cache.ts:33-39,150-170`; `packages/shared/repository/group-state-snapshots-repository.ts:251-269`; `packages/shared-web/browser/data-caches.ts:258-297`. Reuse these semantics. |
| OpenAPI already requires client `stateRevision` and group `stateRevision` plus `causalRevision`. | Old READ-10 obsolete in part; already implemented | `apps/api-v1/resources/api-v1-openapi.yaml:3898-3930,4322-4367`; `apps/api-v1/test/swagger-routes.test.ts:107-132`. Add transport parameters, headers, and errors only; preserve required arrays. |
| The browser already has a 20-second state heartbeat with a 5-second retry, authoritative collection refresh, group-404 removal during heartbeat, and an incomparable-group forced reread. | Old anti-entropy inventory incomplete | `packages/shared-web/browser/heartbeat.ts:15-16,60-90,98-137`; `packages/shared-web/browser/api-workflows.ts:128-155`; `packages/shared-web/browser/data-caches.ts:258-297`. Do not add a second random 5–10 request cadence. |
| Room-session refresh still delegates to the full collection refresh; people refresh also reads both collections. | Partially correct; room work remains | `packages/shared-web/browser/rallar-runtime/rooms.ts:194-217,416-435`; `packages/shared-web/browser/rallar-runtime/people.ts:41-67`. Make room-session refresh a targeted durable point read; retain top-level durable collection refresh. |
| Browser collection hydration is merge-only, so an entity omitted after deletion or authorization filtering may remain locally visible. | Missing required work | `packages/shared-web/browser/data-caches.ts:240-256`; `packages/shared-web/browser/rallar-runtime/state-store.ts:290-299`. Add scoped, race-fenced reconciliation after a complete successful collection response. |
| Current storage/cache key projections are not uniformly injective over presence and value. | Missing required work | `packages/shared-server/rallar-system/client-state-storage-keys.ts:7-30` aliases absent workspace with explicit `_`; `packages/shared/repository/client-state-snapshots-repository.ts:203-210` and `packages/shared/repository/group-state-snapshots-repository.ts:402-407` alias absent workspace with explicit empty string. Key hardening and bounded migration are prerequisites for exact scoped eviction. |
| Mutation-result cache hydration exists but is not a correctness boundary. | Still correct with updated context | `packages/shared-server/rallar-system/state-sync-cache-hydration.ts:22-57`; `apps/api-v1/src/routes/client-state-routes.ts:461-506`; `packages/shared-server/rallar-system/services/AppClientInboxService.ts:424-446`; `packages/shared-server/rallar-system/services/AppGroupInboxService.ts:987-1076`. Retain it as a latency optimization; convergence must rely on revision checks and durable fallback. |
| The API-v1 black-box runner supports a primary and optional secondary server, not a tertiary server. | Old Task 7 unsupported and unnecessary | `packages/shared-test/black-box-runner/api-v1-black-box-run.mts:7-16,93-126,195-216`; `packages/shared-test/package.json` scripts `bb:api-v1:postgres` and `bb:api-v1:postgres:medium-scale`. Use deterministic three-logical-cache unit tests plus the existing two-process Postgres gate. |
| The black-box execution report does not currently retain response headers needed for source/revision assertions. | Missing required work | `packages/shared-test/black-box-runner/execute-black-box.ts:1142`. Extend the report contract before recipes assert convergence headers. |
| The old plan names a publish-failure characterization test. | Obsolete | That test was deleted with commit `f5e10b2bbf23092c2c98c501fb20ee17fb8583d8`. Use current cache, route, and `state-sync-event-replay-characterization` tests instead. |
| The authoritative TypeScript standard is `repo-code-style.md`. | Old style reference obsolete | `.agents/skills/rallar-code-writing/references/repo-code-style.md`; `docs/repo-human-style-guide.md`. New plain object contracts use `interface`; modules should remain under the 400-line target or receive an explicit human exception. |

### Current-main inconsistency outside this read implementation

The replacement `AGENTS.md` requires final `APP_OUTBOX`/`WS_OUTBOX` insertion to
be insert-only and says a collision rolls back without loading a winner.
Current writers call `ResourceInboxRepository.writeIfAbsentOrMatch`
(`packages/shared-server/rallar-system/services/client-state-service.ts:277-281`,
`packages/shared-server/rallar-system/services/group-state-guarded-batch.ts:174-179`,
and
`packages/shared-server/rallar-system/services/GroupPresenceSummaryWork.ts:193-196`).
The implementation of that helper can accept an exact existing row
(`packages/shared-server/postgres/resource-inbox/ResourceInboxRepository.ts:105-218`).

This plan must not copy, expand, or bless that behavior. Resolving the
source-versus-`AGENTS.md` collision policy is a separate mutation remediation
decision because this plan adds no database mutation. It remains an explicit
repository issue and prevents describing the mutation architecture as wholly
closed.

## Audit Of The Original Plan

### Original findings

| Original item | Classification | Revised disposition |
|---|---|---|
| READ-01: internal caches accept `minStateRevision` | Partially correct | Client scalar semantics remain. Group scalar semantics are compatibility-only; use `minCausalRevision`. REST still exposes neither floor. |
| READ-02: group current read probes a durable head then cache | Obsolete | It already performs one full durable `readSnapshot`; remove the proposed rewrite. |
| READ-03: client lacks current-read parity | Still correct | Add `readCurrentSnapshot`/REST read parity to the process-owned cached client service. |
| READ-04: cache presence freshness cannot prove completeness | Still correct for caches; durable side already implemented | Retain the limitation and do not call a presence-fresh cache globally current. |
| READ-05: acknowledged revision followed by stale GET | Historical claim unverifiable from source alone | Preserve only as incident motivation. The new contract makes returning below a supplied floor an explicit failure. |
| READ-06: receiving-node hydration does not prove Node C | Still correct | Test three logical caches deterministically; do not require a third API process. |
| READ-07: aggregate/children stable assembly | Partially correct | Update for batched authority reads, one captured time, presence summary validation, and group causal tuples. |
| READ-08: browser monotonic cache but no anti-entropy | Partially obsolete | Browser group caches are causal and heartbeat/collection repair already exists. Replace random request cadence with targeted room refresh and scoped collection reconciliation. |
| READ-09: wakeups are not durable replay | Still correct | Keep durable invalidation/replay as a deferred alternative. |
| READ-10: OpenAPI omits required revision fields | Already implemented | Preserve current required arrays; add query/header/error contracts and client minimum validation. |
| READ-11: group point response snapshot might authorize stale data | Already implemented for group point/events; missing for graph/topology | Keep the durable authority rule and harden the graph/topology dependency. |
| READ-12: room-session refresh reads the full collection | Still correct | Replace only the room-session path with targeted durable point refresh. |

### Original tasks, files, commands, and criteria

| Original area | Classification | Action in this revision |
|---|---|---|
| Task 0 human review | Still required | Expanded to include the group query shape, conditional absence handling, key migration, and feature-branch publication boundary. |
| Task 1 shared scalar selector | Partially correct for clients; contradicted for groups | Replace with separate client-scalar and group-causal interfaces and explicit incomparable handling. |
| Task 2 symmetric cached services | Partially implemented | Group current and causal-at-least methods already exist. Add client current parity, REST selection, production composition, and race-fenced eviction. |
| Task 3 routes | Partially implemented | Preserve group durable point behavior, add separate query parsers, fix strict client collection and graph/topology authority, and expose headers. |
| Task 4 random browser cadence | Replaced | Use targeted tokenless room-session refresh plus existing heartbeat; add scoped collection reconciliation and conditional absence removal. |
| Task 5 required OpenAPI fields | Already implemented in part | Do not rewrite required fields; add transport details and parity tests. |
| Task 6 deleted publish-failure test | Obsolete | Replace with current cache/service/route characterization tests. |
| Task 7 three-process runner/workflow expansion | Rejected | Current runner is two-process. A third process does not deterministically prove a missed wakeup without fault suppression and is unnecessary for the selected contract. |
| Task 8 old runtime/outbox docs | Partially obsolete | Document current AppInbox, causal tuple, liveness, and selected REST contract. |
| Task 9 skill changes | Partially redundant | Skills already contain AppInbox/causal rules; add only the new read contract and real commands, then run skill integrity tests. |
| Task 10 validation | Incomplete in old plan | Add repo style, unit, CI, build, medium-scale, draft PR, Branch Release Gate, and Hetzner default-branch evidence. |
| `state-sync-publish-failure-characterization.test.ts` | Obsolete path | Removed from all tasks and commands. |
| Three-process Postgres command/workflow | Unverifiable/nonexistent | Removed. Existing two-process scripts remain authoritative. |
| Per-task `git commit` commands | Unsafe on the reviewed `main` checkout | Replace with feature-branch-only checkpoints. Plan review never authorizes any commit. |
| Scalar group acceptance criteria | Contradicted | Replace with causal equality/dominance and incomparable handling. |
| Fifth-through-tenth browser probe criterion | Obsolete design | Replace with explicit targeted refresh plus the existing 20-second heartbeat. |
| “Caches never regress” plus unconditional 404 delete | Internally contradicted | Require compare-and-remove fences; state that physical deletion is not resurrection-safe without tombstones. |

All previously proposed `Create` artifacts were absent as expected. Every
existing path retained below was checked at the reviewed SHA. Every new path is
explicitly labelled **Create**.

## Current Contract And Invariants

### Revision domains

1. `ClientSnapshot.stateRevision` is a non-negative, entity-local scalar.
   It is not a workspace revision. A client cache is eligible when its scalar
   revision is greater than or equal to the caller's scalar floor.
2. `GroupSnapshot.causalRevision` is authoritative. A group cache is eligible
   only when both components equal or exceed the requested components.
   `incomparable` is not an eligible result.
3. `GroupSnapshot.stateRevision` remains a compatibility/diagnostic projection
   and must not be accepted as an external group freshness floor.
4. Client and group collection reads contain independently revisioned entities.
   There is no collection-wide revision domain, so collection routes accept no
   minimum token.

### Proposed REST surface

| Route | No minimum | Minimum | Cache eligibility | Strict authorization |
|---|---|---|---|---|
| `GET /api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId` | Full durable client snapshot read | `minStateRevision=<safe non-negative integer>` | Presence-fresh client snapshot with scalar revision at least the floor | Existing durable auth-session identity; response selection may use cache after authorization |
| `GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId` | Full durable group snapshot read | Both `minGroupRevision=<safe non-negative integer>` and `minPresenceRevision=<safe non-negative integer>` | Presence-fresh group snapshot whose causal tuple equals or dominates the floor | When strict read auth is enabled, perform one durable current group read, authorize and respond from it, and validate the floor against it; never authorize from the response cache |

Supplying only one group component is `400 invalid-group-causal-revision`.
Repeated, blank, signed, decimal, exponential, non-finite, negative, or unsafe
integer values are `400`. A durable observation dominated by the requested
floor, or incomparable with it, is retryable `503` with `Retry-After: 1`.

Successful point responses set:

- `Rallar-State-Source: cache|durable`;
- client: `Rallar-State-Revision`;
- group: `Rallar-Group-Revision` and `Rallar-Presence-Revision`;
- `Cache-Control: no-store`.

The group response may retain `Rallar-State-Revision` only as a labelled
compatibility projection. It must not be used to satisfy the causal floor.
All new headers must be exposed by CORS.

### Selection results

**Create** `packages/shared/api/state-snapshot-read.ts` with interfaces for
plain object contracts:

```ts
export interface ClientStateSnapshotReadOptions {
    readonly minStateRevision?: number;
}

export interface GroupStateSnapshotReadOptions {
    readonly minCausalRevision?: GroupStateCausalRevision;
}

export type StateSnapshotReadSource = 'cache' | 'durable';

export interface StateSnapshotReadFound<T> {
    readonly status: 'found';
    readonly source: StateSnapshotReadSource;
    readonly snapshot: T;
}

export interface StateSnapshotReadNotFound {
    readonly status: 'not-found';
    readonly source: 'durable';
}

export type StateSnapshotReadResult<T> =
    | StateSnapshotReadFound<T>
    | StateSnapshotReadNotFound;
```

Use separate client and group selectors. Do not build a generic numeric
`revisionOf` abstraction that erases the group partial order.

### Absence, eviction, and tombstones

An authoritative tokenless `404` proves absence at that durable observation.
It does not supply a causal deletion revision. Unconditional deletion is
race-unsafe:

1. a durable not-found read begins;
2. a newer positive snapshot is observed;
3. the older not-found result deletes the newer entry.

The selected near-term behavior is compare-and-remove:

- capture the exact scoped cache observation before the durable read;
- after durable not-found, remove only if the current entry is still identical
  to the captured revision and content;
- if the entry advanced, changed, or appeared after the read began, keep it;
- return the authoritative `404` to the caller regardless of whether cleanup
  won the race.

This improves presentation convergence but does **not** prevent a delayed stale
publication from recreating a positive entry. A causal tombstone is required
for resurrection safety and for durable/distributed negative-cache convergence.
The plan therefore rejects claims that simple deletion is equivalent to a
tombstone.

### AppInbox, CAS, and liveness boundaries

- This plan adds no database mutation and no new transaction, retry loop,
  mutation outbox, or final-outbox writer.
- Incoming mutations continue through AppInbox. Every conflict returns to a
  fresh `read`, `compute`, `validate`, and AppInbox-owned transaction.
- Snapshot reads keep existing key/value/scope validation and stable assembly.
- Group presence summaries remain hints. Durable snapshots keep one captured
  observation time and revalidate current group, membership, and session
  authority before reporting live presence.
- Strict authorization, policy, capacity, lifecycle, and governance never use
  a caller's stale-tolerant preference.
- Mutation-result hydration remains a best-effort latency optimization. It is
  not required for tokenless or at-least correctness.

## Architecture Proposal Review

| Proposal | Problem solved | Guarantee provided | Guarantee not provided | Current-architecture interaction | Security, performance, and compatibility | Recommendation |
|---|---|---|---|---|---|---|
| Tokenless durable point reads | Warm process cache can lag durable state | Reads a stable durable snapshot/absence at one observation boundary | No promise that another commit cannot occur after the read | Read-only; uses current repository assembly and does not enter AppInbox/CAS | More database work; strongest simple policy/auth basis; backward-compatible for existing group point behavior and a client behavior change | **Selected** |
| Tokened at-least cache reads | Caller knows a committed revision but wants a cheap eligible read | Never returns below a client scalar floor or outside group causal equality/dominance | Does not promise newest durable state or presence completeness | Reuses process caches and current group tuple comparison; durable fallback remains read-only | Strict group auth bypasses cache; query additions are compatible; cache hits reduce read load | **Selected**, client scalar and group causal pair |
| Periodic browser authoritative probes | Normal use can otherwise keep reusing eligible old cache data | Would bound convergence by calls if every scoped entity keeps being read | Does not cover idle entities and duplicates existing timer repair | Existing browser heartbeat already runs every 20 seconds and top-level refresh is durable | Random cadence adds hidden state, off-by-one risk, and inconsistent facade semantics | **Replaced** by explicit targeted room refresh, existing heartbeat, and scoped collection reconciliation |
| Durable revision-head reads | Avoids assembling a full snapshot when checking a cache | Can reject a cache known below a canonical head | A head and later snapshot are not one atomic observation; still needs full read on miss | Group has two heads and liveness-filtered projections; adds another read before common paths | Extra database round trip; can encourage stale auth if misused | **Rejected** as default |
| Latest-snapshot projection tables | Reduce multi-row assembly cost | Can provide one-row reads if projection is transactionally authoritative | Does not solve lag when populated asynchronously; does not remove tombstone needs | Would be an additional AppInbox/CAS write target and must use current causal tuple | Migration, write amplification, hot-presence contention, and compatibility cost require measurement | **Deferred** |
| Durable invalidation/replay | Repair missed wakeups across API processes | Cursor replay plus anti-entropy can converge process caches after missed notifications | Does not by itself make browser caches current or authorize stale data | Must use final resource outbox truth or a separately approved durable source; no intermediate mutation outbox | Requires cursor ownership, retention, compaction, poison handling, and metrics | **Deferred** |
| Tombstones | Prevent stale positives from resurrecting after deletion | Causal negative state can dominate earlier positives | Does not make authorization optional or remove retention policy | Requires authoritative deletion revision and transactionally consistent publication | Contract/storage migration and retention cost; necessary before claiming negative-cache convergence | **Deferred**, while compare-and-remove is selected as bounded cleanup |
| Structured causal group revisions | Correctly represents independent group and presence progress | Equality/dominance/incomparability without scalar aliasing | Does not provide a workspace-wide collection revision | Already the authoritative model in source and caches | Two query/header fields add transport surface but preserve response compatibility | **Selected and already implemented internally** |
| Convergence metrics and service-level targets | Make cache effectiveness and fallback behavior observable | Counters/histograms show source, fallback, shortfall, incomparable, and cleanup races | Metrics alone provide no consistency guarantee; percentile targets need a measured baseline | Add read-path instrumentation only; no mutation changes | Low compatibility risk; avoid high-cardinality IDs | **Selected metrics; latency SLOs deferred until baseline measurement** |

Required metrics:

- point reads by entity kind, source, strict-auth mode, and result;
- cache floor hit, cache floor miss, durable fallback, durable shortfall, and
  group incomparable counts;
- durable snapshot latency by client/group and list-versus-point;
- conditional absence cleanup applied/skipped because the cache advanced;
- browser targeted refresh result and scoped collection reconciliation counts.

Do not label a value `latest` unless it means latest observed at a named
boundary. Do not define p95/p99 service-level targets until representative
baseline results are recorded.

## Implementation Tasks

Every task below is future implementation work. This plan review authorizes
none of it.

### Task 0: Record architecture and feature-branch gates

**Evidence:** This plan and `AGENTS.md`.

- [ ] Recheck branch, full `HEAD`, full `origin/main`, `git status`, and user
  changes.
- [ ] Record the human choice of client scalar plus group causal pair:
  `minStateRevision` for clients and the all-or-none
  `minGroupRevision`/`minPresenceRevision` pair for groups.
- [ ] Record acceptance of compare-and-remove as bounded cleanup without
  resurrection safety, or split tombstone design into an approved prerequisite.
- [ ] Record the bounded migration approach for non-injective client and shared
  snapshot keys.
- [ ] Confirm no scalar collection floor, no policy decision from stale cache,
  and no new mutation path.
- [ ] Before implementation edits, create or switch to
  `codex/rallar-rest-snapshot-read-convergence`. Never implement task commits
  on `main`, `master`, or another default branch.
- [ ] Plan review or Task 0 approval is not commit, push, merge, rebase, or PR
  permission. The future publication workflow applies only on the feature
  branch; default-branch operations require the separate just-in-time
  disclosures and permissions in `AGENTS.md`.

No feature-branch checkpoint is created for the review gate alone.

### Task 1: Make scoped keys and absence cleanup race-safe

**Modify:**

- `packages/shared-server/rallar-system/client-state-storage-keys.ts`
- `packages/shared-server/rallar-system/repositories/ClientStateRepository.ts`
- `packages/shared/repository/client-state-snapshots-repository.ts`
- `packages/shared/repository/group-state-snapshots-repository.ts`
- `packages/shared/cache/ObservableLatestRepository.ts`
- `packages/shared/cache/ObservableLoanedRepository.ts`
- `packages/shared-server/rallar-system/services/client-state-snapshot-read-through-cache.ts`
- `packages/shared-server/rallar-system/services/group-state-snapshot-read-through-cache.ts`
- `packages/tests/shared/observable-latest-repository.test.ts`
- `packages/tests/shared/observable-loaned-repository.test.ts`

**Create:**

- `packages/tests/shared-server/client-state-storage-keys.test.ts`

**Verify:**

- `packages/tests/shared-server/client-state-snapshot-read-through-cache.test.ts`
- `packages/tests/shared-server/group-state-snapshot-read-through-cache.test.ts`
- `packages/tests/shared-web/data-caches.test.ts`

Steps:

- [ ] Add failing key tests covering field name, string value, type/presence,
  absent workspace, explicit `_`, explicit empty string, delimiters, percent
  sequences, child keys, prefix/list boundaries, and repository round trips.
- [ ] Replace sentinel/empty-string aliases with a canonical typed projection.
  Do not treat URI escaping alone as absence encoding.
- [ ] For persisted client state, migrate a legacy row only after validating its
  stored identity proves the intended scope and conditionally claiming the new
  key. Do not fan one row into two scopes or add an unbounded dual-read.
- [ ] Add conditional repository deletion that succeeds only when the current
  value is the expected exact observation. Preserve observer and session-index
  behavior.
- [ ] Add `evictIfUnchanged` to both snapshot read-through caches and cover the
  not-found/newer-positive race.
- [ ] Keep new modules/interfaces within repo style limits; split implementation
  helpers instead of growing an already oversized module without approval.
- [ ] Run:
  `npx vitest run packages/tests/shared/observable-latest-repository.test.ts packages/tests/shared/observable-loaned-repository.test.ts packages/tests/shared-server/client-state-storage-keys.test.ts packages/tests/shared-server/client-state-snapshot-read-through-cache.test.ts packages/tests/shared-server/group-state-snapshot-read-through-cache.test.ts packages/tests/shared-web/data-caches.test.ts`.

**Feature-branch checkpoint only:** `fix: make snapshot cache identity and absence cleanup causal-safe`.

### Task 2: Add separate client and group REST read selectors

**Create:**

- `packages/shared/api/state-snapshot-read.ts`
- `packages/shared-server/rallar-system/services/rest-state-snapshot-reader.ts`
- `packages/tests/shared-server/rest-state-snapshot-reader.test.ts`

**Modify:**

- `packages/shared-server/rallar-system/services/cached-client-state-service.ts`
- `packages/shared-server/rallar-system/services/cached-group-state-service.ts`
- `packages/shared-server/rallar-system/services/client-state-snapshot-read-through-cache.ts`
- `packages/shared-server/rallar-system/services/group-state-snapshot-read-through-cache.ts`
- `packages/shared-server/mod.ts`
- `apps/api-v1/src/middleware-contract.ts`
- `apps/api-v1/src/middleware.ts`

**Verify:**

- `packages/tests/shared-server/cached-state-services.test.ts`
- `packages/tests/shared-server/client-state-snapshot-read-through-cache.test.ts`
- `packages/tests/shared-server/group-state-snapshot-read-through-cache.test.ts`
- `packages/tests/shared-server/state-sync-cache-hydration.test.ts`

Steps:

- [ ] Write failing client tests: tokenless performs one full durable read;
  an eligible scalar cache answers tokened reads; an ineligible cache falls back
  to durable; durable below the floor yields a typed retryable shortfall.
- [ ] Write failing group tests with equality, dominance, domination, and
  incomparability. Never project the tuple to a scalar for eligibility.
- [ ] Add a typed found/not-found result with explicit `cache|durable` source.
- [ ] Add client `readCurrentSnapshot` parity and separate REST selector
  methods to the process-owned services wired through middleware.
- [ ] Preserve current group `readCurrentSnapshot` as a direct durable read.
  Do not add a revision-head probe.
- [ ] On durable not-found, invoke `evictIfUnchanged` with the observation
  captured before the read. Return not-found even when cleanup loses a race.
- [ ] Do not turn a liveness-filtered group projection into stronger canonical
  authority than its preserved causal tuple. Continue to reject incomparable
  cache observation.
- [ ] Add a deterministic three-logical-cache test over one durable fake:
  warm A/B/C, commit through B, hydrate A/B only, prove C's client scalar and
  group causal floor miss falls back to durable, and prove C tokenless always
  reads durable.
- [ ] Keep current mutation-result hydration tests as optimization tests.
- [ ] Run:
  `npx vitest run packages/tests/shared-server/rest-state-snapshot-reader.test.ts packages/tests/shared-server/cached-state-services.test.ts packages/tests/shared-server/client-state-snapshot-read-through-cache.test.ts packages/tests/shared-server/group-state-snapshot-read-through-cache.test.ts packages/tests/shared-server/state-sync-cache-hydration.test.ts`.

**Feature-branch checkpoint only:** `feat: add scalar client and causal group REST snapshot readers`.

### Task 3: Expose the contract without weakening authorization

**Create:**

- `apps/api-v1/src/routes/state-snapshot-read.ts`
- `apps/api-v1/test/routes/state-snapshot-read.test.ts`

**Modify:**

- `apps/api-v1/src/routes/client-state-routes.ts`
- `apps/api-v1/src/routes/group-state-routes.ts`
- `apps/api-v1/src/routes/graph-topology-routes.ts`
- `apps/api-v1/src/create-rallar-server.ts`
- `apps/api-v1/src/main.ts`
- `apps/api-v1/test/routes/state-api-routes-hardening.test.ts`
- `apps/api-v1/test/routes/graph-topology-routes.test.ts`

Steps:

- [ ] Add table-driven parser tests for blank, whitespace, signed, negative,
  decimal, exponential, `NaN`, `Infinity`, unsafe, and repeated values.
- [ ] Require both group causal query components or neither.
- [ ] Route client tokenless point and strict self-collection reads through the
  durable current-client method.
- [ ] Route non-policy-sensitive client tokened reads through the scalar
  selector.
- [ ] Preserve group tokenless direct durable behavior.
- [ ] In non-strict mode, allow a group causal cache hit. In strict mode,
  perform one durable current group read, check the requested causal floor,
  authorize, and return that same snapshot.
- [ ] Replace graph/topology's cache-permitting `readSnapshot` authority
  dependency with `readCurrentSnapshot`; avoid duplicate durable reads within
  one request by passing the obtained snapshot through existence and policy
  checks.
- [ ] Keep mutation route prechecks advisory only; AppInbox must still rerun
  complete durable authorization and validation on every attempt.
- [ ] Emit source/revision/no-store headers on `200`; emit `Retry-After: 1` on
  shortfall/incomparable `503`; expose all headers in CORS.
- [ ] Add assertions that serializers return all required authoritative fields.
- [ ] Run:
  `cd apps/api-v1 && deno test --allow-env --allow-read test/routes/state-snapshot-read.test.ts test/routes/state-api-routes-hardening.test.ts test/routes/graph-topology-routes.test.ts`.
- [ ] Run: `cd apps/api-v1 && deno task check`.

**Feature-branch checkpoint only:** `feat: expose causal snapshot floors in API v1`.

### Task 4: Make browser refresh authoritative and scope-reconciling

**Create:**

- `packages/tests/shared-web/api-integration-state-snapshot-read.test.ts`
- `packages/tests/shared-web/state-snapshot-read-reconciliation.test.ts`

**Modify:**

- `packages/shared-web/browser/api-integration.ts`
- `packages/shared-web/browser/api-workflows.ts`
- `packages/shared-web/browser/data-caches.ts`
- `packages/shared-web/browser/rallar-runtime/contracts.ts`
- `packages/shared-web/browser/rallar-runtime/state-store.ts`
- `packages/shared-web/browser/rallar-runtime/rooms.ts`
- `packages/shared-web/browser/rallar-runtime/people.ts`
- `packages/shared-web/browser/rallar-runtime/composition.ts`
- `packages/shared-web/mod.ts`
- `packages/tests/shared-web/rallar-rooms-facade.test.ts`
- `packages/tests/shared-web/rallar-people-facade.test.ts`
- `packages/tests/shared-web/rallar-rooms-people-state.test.ts`
- `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
- `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`

Steps:

- [ ] Add a client point function with scalar options and group point options
  using the causal pair. Successful HTTP metadata must expose the response
  source/revisions without weakening authoritative body validation.
- [ ] Change `rallar.rooms.room(ref).refresh()` to one targeted tokenless group
  point read. Keep `rallar.rooms.refresh()` and `rallar.people.refresh()` on
  complete durable collection reads.
- [ ] Do not add random 5–10-call state. The existing heartbeat remains the
  background repair mechanism for the current client and joined groups.
- [ ] On targeted `404`, compare-and-remove only the exact unchanged scoped
  browser observation and rethrow the original `ApiHttpError`.
- [ ] After a successful complete collection read, reconcile that scope:
  remove a previously visible entity omitted from the result only when the
  cached observation has not advanced since the request began.
- [ ] Preserve group causal monotonicity and the current incomparable recovery
  path. Never accept the compatibility scalar as group authority.
- [ ] State in tests and public docs that physical removal can be followed by
  stale-publication reinsertion until a future tombstone design lands.
- [ ] Keep low-level point functions stateless. Callers explicitly choose
  tokenless or tokened reads.
- [ ] Update public API snapshots and browser bundle-boundary checks for every
  new export.
- [ ] Run:
  `npx vitest run packages/tests/shared-web/api-integration-state-snapshot-read.test.ts packages/tests/shared-web/state-snapshot-read-reconciliation.test.ts packages/tests/shared-web/rallar-rooms-facade.test.ts packages/tests/shared-web/rallar-people-facade.test.ts packages/tests/shared-web/rallar-rooms-people-state.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`.
- [ ] Run: `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`.

**Feature-branch checkpoint only:** `feat: converge browser snapshot refresh and scoped absence`.

### Task 5: Align OpenAPI, Swagger, and successful contracts

**Modify:**

- `apps/api-v1/resources/api-v1-openapi.yaml`
- `apps/api-v1/test/swagger-routes.test.ts`
- `packages/shared-test/black-box-runner/tests/api-v1/api-v1-openapi-topology-auth.json`

Steps:

- [ ] Add client `minStateRevision` and the all-or-none group causal query pair
  to point operations only.
- [ ] Add `400`, `404`, and retryable `503` response schemas and the source,
  revision, `Retry-After`, and no-store header contracts.
- [ ] Preserve required `ClientSnapshot.stateRevision`,
  `GroupSnapshot.stateRevision`, and `GroupSnapshot.causalRevision`.
- [ ] Add `minimum: 0` consistently to client revision fields and confirm all
  successful required arrays, serializers, TypeScript contracts, and tests
  agree.
- [ ] Add Swagger and recipe assertions that collection/event/presence routes
  do not advertise one entity floor.
- [ ] Run:
  `cd apps/api-v1 && deno test --allow-env --allow-read test/swagger-routes.test.ts`.
- [ ] Run:
  `npm run test:api-v1:black-box:memory`.

**Feature-branch checkpoint only:** `docs: specify scalar client and causal group snapshot reads`.

### Task 6: Prove logical and real multi-process convergence

**Create:**

- `packages/shared-test/black-box-runner/tests/api-v1/api-v1-state-read-convergence.json`

**Modify:**

- `packages/shared-test/black-box-runner/execute-black-box.ts`
- `packages/shared-test/black-box-runner/recipe-matrix.json`
- `packages/tests/shared-test/rallar-bb-test.test.ts`
- `packages/tests/shared-test/api-v1-black-box-run.test.ts`
- `packages/tests/shared-server/state-sync-event-replay-characterization.test.ts`
- `apps/api-v1/test/routes/state-api-routes-hardening.test.ts`

Steps:

- [ ] Extend black-box HTTP result/report data to retain a normalized,
  allow-listed response-header map; cover redaction and serialization before
  recipes assert headers.
- [ ] Add a two-process Postgres recipe that warms one process, mutates through
  the other, captures the committed client scalar/group causal revision, and
  proves:
  - tokenless reads are durable;
  - eligible floors may use cache;
  - stale floors fall back to durable;
  - no response is below a client scalar floor;
  - group equality/dominance succeeds and incomparable/dominated durable
    observations fail with the typed `503`;
  - source and revision headers match the response body;
  - strict group and graph/topology policy use durable current authority.
- [ ] Keep the deterministic three-logical-cache unit test from Task 2 as the
  proof that a cache missing all hydration/wakeup observations converges.
- [ ] Do not add a tertiary API process. Current two-process integration plus
  deterministic logical isolation proves the selected contract without
  nondeterministic queue claimant or PostgreSQL wakeup behavior.
- [ ] Run:
  `npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/api-v1-black-box-run.test.ts packages/tests/shared-server/state-sync-event-replay-characterization.test.ts`.
- [ ] Run:
  `npm run test:api-v1:black-box:postgres`.
- [ ] Run the mandatory unweakened gate:
  `npm run test:api-v1:black-box:postgres:medium-scale`.
- [ ] If local PostgreSQL is unavailable, report each command as skipped and
  require exact CI evidence on the same feature commit; a skip does not satisfy
  completion.

**Feature-branch checkpoint only:** `test: prove two-process causal snapshot convergence`.

### Task 7: Publish the current mental model in docs and skills

**Create:**

- `docs/rallar-state-snapshot-consistency.md`

**Modify:**

- `docs/README.md`
- `docs/rallar-api-reference.md`
- `docs/rallar-convergent-state-and-rtc-topology.md`
- `docs/rallar-groups-report.md`
- `docs/rallar-troubleshooting-checklist.md`
- `packages/shared-server/rallar-server-repositories.md`
- `.agents/skills/rallar-realtime/SKILL.md`
- `.agents/skills/rallar-platform/SKILL.md`
- `.agents/skills/rallar-testing/SKILL.md`
- `.agents/skills/rallar-testing/references/test-commands.md`

Steps:

- [ ] Define internal consistency, client scalar monotonicity, group causal
  partial order, presence completeness limits, durable authority, and
  post-read commit races.
- [ ] Describe current AppInbox transaction/retry ownership, direct final
  resource outbox rows, per-session presence guards, summary revalidation, and
  captured observation time. Do not describe them as future work.
- [ ] Document the two point-route query shapes, headers, validation, typed
  errors, and strict-auth exception.
- [ ] Document targeted room refresh, existing 20-second heartbeat, scoped
  collection reconciliation, compare-and-remove races, and why a physical
  delete is not a tombstone.
- [ ] Remove stale durable-head-probe, shared group-row presence contention,
  future causal-split, intermediate mutation-outbox, package-code-style, random
  cadence, and three-process claims.
- [ ] Add only real focused commands to the testing skill.
- [ ] Run:
  `npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts packages/tests/repo/repo-code-style-integrity.test.ts packages/tests/repo/repo-style-check.test.ts`.
- [ ] Run: `npm run check:repo-style`.

**Feature-branch checkpoint only:** `docs: publish causal REST snapshot consistency`.

### Task 8: Final verification, publication, and review handoff

**Verify the exact final feature-branch tree after all edits:**

- [ ] Run focused commands from Tasks 1–7 and record exact results.
- [ ] Run `npm run check:repo-style`.
- [ ] Run `npm run test:unit`.
- [ ] Run `npm run test:ci`.
- [ ] Run `npm run build`.
- [ ] Run `npm run test:api-v1:black-box:postgres:medium-scale`.
- [ ] Run `git diff --check`.
- [ ] Confirm every authoritative TypeScript/OpenAPI/serializer/test contract
  remains aligned.
- [ ] Confirm no incoming mutation bypasses AppInbox, no service owns a new
  transaction/retry loop, and no intermediate mutation outbox was introduced.
- [ ] Confirm no generated artifacts under `.artifacts/` or `tmp/` are staged.
- [ ] Confirm the current branch is the feature branch before every checkpoint.

Any change after a successful final `test:unit`, `test:ci`, or `build` result
invalidates that result and requires rerunning the command.

**Publication requirements:**

- [ ] On the non-default feature branch, commit only reviewed in-scope files,
  push the branch, and keep a draft PR current with the plan link, milestones,
  exact passed/failed/skipped validation, and incomplete decisions.
- [ ] Record the final feature-branch commit SHA.
- [ ] Require **Branch Release Gate** to pass for that exact final
  feature-branch SHA. The workflow is defined in
  `.github/workflows/branch-release-gate.yml:1-14`.
- [ ] After a separately authorized integration to the default branch, record
  the resulting default-branch SHA.
- [ ] Require **Run Hetzner Supported Distributed Manifests** to pass for that
  exact default-branch SHA. The workflow is defined in
  `.github/workflows/hetzner-supported-distributed-manifests.yml:1-50`.
- [ ] Do not infer either result from a workflow attached to older code.
- [ ] Do not mark the plan approved or implementation-complete while a command,
  draft PR update, workflow, or exact-SHA evidence is pending, skipped, failed,
  or prohibited.

**Final feature-branch checkpoint only:** `feat: complete REST snapshot read convergence`.

## Acceptance Criteria

- Client point GET without a minimum performs a full durable read.
- Group point GET without a minimum preserves the already-durable current read.
- Client tokened reads never return below `minStateRevision`.
- Group tokened reads return cache only when the causal tuple equals or
  dominates the complete requested pair; incomparable is never accepted.
- A cache miss/ineligible value falls back to durable. A durable value below or
  incomparable with the requested floor returns typed retryable `503`.
- Collections accept no entity minimum. Strict self-client collection is
  durable; group collections remain durable and policy-filter current
  snapshots.
- Strict group point/event/graph/topology authorization uses durable current
  authority and never a stale-tolerant response candidate.
- Presence summaries remain hints; durable assembly revalidates lifecycle,
  membership, session identity/generation, connectivity, and expiry at one
  captured time while preserving `GroupStateCausalRevision`.
- Mutation-result hydration remains operational but is not required for
  correctness.
- A logical Node C that missed hydration and wakeups still converges through
  tokenless or at-least durable fallback.
- Room-session refresh is a targeted tokenless durable point read. Top-level
  rooms/people refresh remains a durable collection read.
- Successful collection refresh reconciles unchanged omitted entries in the
  requested scope; it never deletes an entry that advanced during the request.
- Authoritative not-found cleanup is compare-and-remove. Documentation and
  tests do not claim resurrection safety without a causal tombstone.
- Client and group storage/cache keys are injective over field, value,
  type/presence, delimiters, percent sequences, and child/prefix boundaries.
- TypeScript authoritative fields, serializers, OpenAPI `required` arrays,
  Swagger, browser validation, and tests remain aligned.
- Response source/revision headers, CORS exposure, no-store policy, and
  retryable errors match the selected contract.
- Focused tests, repo style, `test:unit`, `test:ci`, `build`, ordinary Postgres
  black-box, and the unweakened two-process medium-scale gate have exact
  recorded results.
- The draft PR is current; Branch Release Gate is green on the final feature
  SHA; Hetzner supported manifests are green on the resulting default-branch
  SHA.

## Explicit Non-Goals

- Claiming globally latest state at response receipt.
- Inventing a scalar group causal floor or a workspace collection revision.
- Replacing runtime-state snapshot assembly with projection tables in this
  implementation.
- Adding durable cache-invalidation replay in this implementation.
- Claiming physical cache deletion is a tombstone.
- Adding a third API-v1 process to the black-box runner.
- Adding a second random browser probe cadence beside the existing heartbeat.
- Changing AppInbox mutation ownership, CAS retry boundaries, or final resource
  outbox behavior.
- Resolving the current final-outbox collision-policy mismatch noted in the
  revalidation ledger.
- Weakening authorization, policy, lifecycle, capacity, or governance for cache
  hit rate.

## Human Decisions Still Required

1. Approve or revise the external group query shape:
   `minGroupRevision` plus `minPresenceRevision`, both required together.
2. Accept compare-and-remove as bounded near-term absence cleanup, with causal
   tombstones deferred and resurrection safety explicitly unclaimed.
3. Approve the bounded migration for the current non-injective client and shared
   snapshot key projections, or split it into a prerequisite plan before exact
   scoped eviction ships.
4. Decide whether to retain a group `Rallar-State-Revision` header as a clearly
   labelled compatibility projection; it cannot satisfy the causal contract.
5. Assign separate ownership for the current source-versus-`AGENTS.md`
   final-outbox collision-policy mismatch.
6. Approve implementation only on a feature branch. This plan review never
   grants permission for a default-branch commit or push.

After production measurement, separately review projection tables, durable
replay, causal tombstone retention, and numeric latency service-level targets.
