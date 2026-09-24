# PR #521 code assessment

Prepared: 2026-09-08\
Reviewed source: branch `codex/alm-improvements` at `3e69cdd8b`, re-verified against the merged
squash commit `a28e61b61` on `main` (PR head `0d580c3a7`).\
Companion: [ALM roadmap assessment](alm-roadmap-assessment.md).

This document reports the state of the ALM code that [PR #521](https://github.com/intact-software-systems/ar-eye-hunter/pull/521)
landed in `main`, with emphasis on `packages/shared` and `packages/shared-web`. It records what
was measured, what was read, what is strong, what is weak, and what to do first. It is an
assessment, not a plan; the roadmap consequences live in the companion document.

## Verdict

The merged code is a real improvement over the pre-branch ALM: ingress is bounded and decoded
once, the finite original deadline is captured and rechecked at every write boundary, initial
admission conflicts become retained QueueBox work instead of an in-process retry loop, and the
pure `compute`/`validate` owners are genuinely pure and tested. On the merged head every local
gate that this review could run passes.

The weaknesses are structural rather than local. The two admission stores are 1,176 and 1,120
lines, one at cognitive load 124 (review tier) and both pinned by checker dispositions rather
than split; inbound and outbound each re-implement a claim/run/release loop beside QueueBox's own
dequeuer; a control-admission conflict is thrown where a data-admission conflict is a value; the
public typed-send default persists every message to IndexedDB; and `ack: 'receiver'` silently
becomes `hop`. The branch also doubled the reviewed-disposition ledger it is measured against, and
the reviewed head carried sixteen red unit tests that the PR body's "580/580" figure could not
have described. Those were repaired in the final seventeen commits before merge.

Grade by scope (A = exemplary, C = needs a named follow-up, F = unsafe):

| Scope                                       | Grade | One-line reason                                                                                                       |
| ------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/alm/inbound`               | B-    | Doctrine-faithful admission core; work-execution layer owns QueueBox twice and awaits an inline drain on ingress.     |
| `packages/shared/alm/outbound` + `alm` root | C+    | Pure compute/validate owners and canonical storage are good; the 1,120-line store, thrown conflicts, and duplication. |
| `packages/shared/al-contracts` + `api`      | B-    | Bounded limits and control codec are the right boundary; `receiver -> hop` and 846-line normalizer need review.       |
| `packages/shared/queuebox` + `services`     | B     | NotReady readiness landed inside QueueBox; the ALM dequeue path still runs beside the engine-registered handler.      |
| `packages/shared` transport + persistence   | B-    | Truthful RTC settlement vocabulary; data-channel file at cognitive load 118 pinned instead of split.                  |
| `packages/shared-web`                       | B-    | Removal of the per-session queue owner is right; the default send policy forces IndexedDB on the common path.         |
| `packages/shared-server`                    | B     | PostgreSQL work backend checks the deadline before and after mutations; base migration edited in place.               |
| Governance and gates                        | D     | Dispositions 110 -> 386 entries, bundle budget raised at 1.1 KiB headroom, migration convention broken.               |

## What was measured

All commands were run locally on 2026-09-08. "Reviewed head" is `3e69cdd8b`; "merged" is
`a28e61b61`. Nothing in this table is taken from the PR body.

| Check                                                          | Reviewed head                                                                | Merged `main`                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------- |
| `tsc -p packages/shared/tsconfig.json --noEmit`                | pass                                                                         | pass                          |
| `shared-web` and `shared-server` `typecheck`                   | pass                                                                         | pass                          |
| `npx dprint check`                                             | fail (1 file, import order)                                                  | pass                          |
| `cd apps/api-v1 && deno task check`                            | fail (`expiresAtMs` missing in one Deno test)                                | pass                          |
| `check:browser-bundles`                                        | pass, facade 198.9 KiB of 200 KiB                                            | pass                          |
| `check:repo-style:changed` (what CI enforces)                  | fail, 100 findings, 0 in `packages/shared*`                                  | pass (`c5e068516..a28e61b61`) |
| `vitest run` (full `test:unit` suite)                          | 10 files / 16 tests failed of 10,379                                         | pass, 10,539 tests, 0 failed  |
| Focused ALM selection (85 files)                               | 2 failed of 1,017                                                            | those files pass              |
| Same 10 failing files on pre-PR `main` (`c5e068516`)           | 9 of 9 existing files pass                                                   | n/a                           |
| Navigation analyzer, high-confidence findings under `packages` | 2 (same two as `main`)                                                       | unchanged                     |
| `test:postgres:integration`                                    | skipped: branch changes the Prisma schema; shared dev DB not migrated for it | skipped                       |
| `test:api-v1:black-box:postgres:medium-scale`                  | not run                                                                      | not run                       |

Bisect of the sixteen reviewed-head failures (each file bisected separately against the
merge-base):

| First bad commit | Commit subject                                                 | Files broken                                                                                                         |
| ---------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `f352ecd68`      | Bound ALM ingress and authorize paged room message handling    | `ws-server-room-broadcast-delta-audience`, `headless-bundle-boundary`                                                |
| `0bd299d78`      | Unify inbound ALM work under QueueBox                          | `rtc-rtt-traffic-diagnostic`                                                                                         |
| `7aef6696c`      | Capture outbound ALM deadlines and validate work before writes | `ws-queue-box-client-ingress`                                                                                        |
| `6bc53a162`      | Defer unavailable ALM work without consuming retry attempts    | `handler-finalized-rtc-topology`                                                                                     |
| `d53616b07`      | Unify canonical ALM storage and deadline-bounded recovery      | `al-durable-runtime`, `auth-http-idempotency-security`, `rallar-server-ws-router`, `psql-admission-optimistic-retry` |
| `29e80fc65`      | Reject malformed captured policies and record reviewed owners  | `repo-style-check` (the disposition file crossed the 1,200-line backstop)                                            |

None of these commits modified the test it broke. All sixteen pass on merged `main`; the
repairs are the commits after `f4bc1a9bd` ("Align release tests with canonical ALM recovery",
"Replace coupled ALM assertions with observable behavior", and siblings). This review did not
re-derive whether each repair changed the test or the production code.

## How the review was done

1. Deterministic gates and inventories first (the table above), including a `git bisect run`
   per failing file.
2. A multi-agent review was launched: ten scopes, three lenses each (repo code standard,
   correctness and concurrency, architecture and Rallar alignment), plus test-quality,
   coverage, governance, and six roadmap-assessment agents, with adversarial verification of
   every medium or high finding. The account's weekly usage limit stopped it after 6 of 48
   agents: the inbound architecture lens, the outbound standards lens, and four roadmap agents
   completed. Their findings are cited below only where this session re-read the line on the
   merged head.
3. The remaining scopes were read directly in this session using targeted searches for the
   doctrine's failure modes (thrown expected failures, hidden defaults, clock reads inside
   transactions, whole-store reads, banned vocabulary) plus a function-length scan.

Coverage is therefore uneven: `alm/inbound` and `alm/outbound` were read most closely; the
server, transport, and browser scopes were read by search and spot-check; `packages/tests`
(278 files) was not read file by file.

## Strengths

- **One bounded decode at ingress.** `ALInboundMessageRuntime.handleIncomingMessage` takes
  `unknown`, decodes once, and validates the authenticated source before any state is touched
  (`packages/shared/alm/inbound/al-inbound-message-runtime.ts:119-135`). The WS server
  additionally pre-validates envelope size and control identity before admission
  (`packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts:368-381`).
  Resource ceilings are one contract, `AL_MESSAGE_RESOURCE_LIMITS`, with UTF-8 byte accounting
  (`packages/shared/al-contracts/al-message-resource-limits.ts:7-16, 59-72`).
- **The conditional guard is the first write.** Inbound admission re-reads every observed key
  inside the transaction and compares the complete observation before mutating
  (`al-inbound-admission-store.ts:650-651, 701-716`); the result is the value
  `'committed' | 'conflict' | 'expired'`, not an exception. This is the convergent-service
  doctrine applied to ALM's own store.
- **The original deadline is a captured fact.** `constraints.expiresAtMs` is resolved once at the
  sender (`browser-rallar-message-sender.ts:138, 184, 203`), carried into the persisted candidate
  (`prepare-al-inbound-commit-bundle.ts:113-115`), and checked by `requireLivePersistenceWrite`
  before and after the mutations in memory, IndexedDB, and PostgreSQL
  (`packages/shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts:86-104`). The
  cluster pub/sub bridge refuses a notification without a canonical deadline and re-checks it on
  both sides (`queue-box-pub-sub-bridge.ts:295-300, 320-354`).
- **Conflict becomes retained work, not a retry loop.** The pre-branch per-sender promise queue
  and `tryWithPolicy` retry are gone; a losing first admission retains an `admit-message` row and
  the existing worker replays it once with fresh authority
  (`al-inbound-message-admission.ts:40, 89-97, 132-156`). No `setTimeout`, lease manager, or
  scheduler was added under `packages/shared/alm`.
- **Pure decision owners with `Either`.** `computeALInboundAdmission`,
  `validateALInboundCommitBundle`, `computeALOutboundDispatch`, and the control-admission
  validators take value snapshots and return values; they are tested directly.
- **Truthful RTC settlement.** `QRtcDataChannel.SendDisposition` carries `submissionAttempted`
  and a closed status set, and the overlay manager bridges it to a queued-then-settled outbound
  result (`packages/shared/webrtc/qrtc-data-channel.ts:151-155`;
  `al-outbound-message-runtime.ts:33-39, 497-513`). A void return no longer counts as a send.
- **Readiness landed inside QueueBox.** `NotReadyException` and the release computation refund
  only the current reservation's attempt (`packages/shared/queuebox/resource-inbox/not-ready-exception.ts`,
  `compute-resource-inbox-release.ts`), so waiting on a predecessor does not consume the retry
  budget. This is the plan's most important mechanical decision and it is in the right owner.
- **Dead owners removed.** `DequeueController` (527 lines), `DequeueResourceEntryController`
  (711), `al-outbound-effect-drain` (273), the browser per-session queue persistence, and the
  unused outbound fallback hook are gone with no remaining production consumer.
- **Navigation maps exist** for both ALM feature folders, as the realtime skill requires for a
  feature above twenty modules, and they are mostly accurate.

## Weaknesses

Severity: **high** blocks a merge under the repo rules or risks data; **medium** a maintainer
would require fixed in the next touch; **low** an observation. Line numbers are on merged `main`.

### 1. Ownership: QueueBox is reused, then wrapped twice

- **medium** `ALInboundAdmissionStore` both exposes the raw queue
  (`al-inbound-admission-store.ts:334 readonly workQueue`) and forwards six one-line methods to
  `ALInboundDurableEffectStore` (`:719-737`), so admission and the work handler reach the queue two
  ways (`al-inbound-message-admission.ts:116` uses the raw queue).
- **medium** The FAILED/RETRY decision is computed twice by two owners with different jitter:
  the handler derives a delay with `retryAfterAttempt(policy, attempts, random())`
  (`al-inbound-work-handler.ts:241`), then `rescheduleEffect` re-evaluates the same policy with a
  constant `0.5` to decide the status (`al-inbound-durable-effect-store.ts:127-131`). Outbound
  mirrors it (`al-outbound-work-handler.ts:229`, `al-outbound-admission-effect-store.ts:320`).
  Policy constants (`0.5`, `Math.random()`) sit four calls below the runtime, against the
  decision-depth rule.
- **medium** Inbound and outbound each keep their own claim/run/release loop with divergent
  readiness strategies (`al-inbound-work-handler.ts:13, 146` scan-state rotation vs
  `al-outbound-work-handler.ts:102-104 peekNextEffectReadyAt`) beside
  `createDefaultResourceInboxDequeuer`, which already orchestrates the same lanes.
- **medium** The server still has two consumers on one ALM work queue: the legacy `dequeue()`
  path through `QueueBoxUtilities.defaultDequeue` with a 33-line `onDequeuedDo` policy callback
  (`al-outbound-message-runtime.ts:301-350`), and the engine-registered `ALOutboundWorkHandler`.
  The plan's milestone 5 ("one durable work owner") is therefore half done, not done.

### 2. Size and density are pinned, not resolved

- **medium** `al-outbound-admission-store.ts` is 1,120 lines at cognitive load 124 (review tier
  is 110); `al-inbound-admission-store.ts` is 1,176 lines against the 1,200 backstop;
  `qrtc-data-channel.ts` is at 118. A function-length scan over the 149 changed `shared`/`shared-web`
  files found no function above 60 lines, 12 in the 50-60 required-review band, and 14 in the
  41-49 warning band; the densest are `decodeInboundDurableEffect` (60),
  `decodeStoredResourceEntryValue` (59), `decodeALOutboundCapturedPolicy` (59),
  `toDefaultEffectivePolicy` (57), `computeMutation` (55).
- **medium** Instead of splitting, the branch pinned the magnitudes in
  `scripts/repo-style-check/reviewed-dispositions.mjs` (`maximumMagnitude: 124`, `118`, `54`,
  `68`, `79`, `85`, `80`). The pins share one batch comment ("...magnitudes, not permission to
  grow or retain a standards violation"); there is no per-finding disposition of the kind the
  standard's review section asks for ("resolved throughout the touched file or demonstrated
  false positive"). This is why the changed-range gate reports zero findings in
  `packages/shared` while the full checker reports 14 cognitive-load warnings there.
- **low** `normalize-al-qos-policy.ts` is a new 846-line file: a `toXxx`/`mergeXxx`/`clampXxx`/
  `authorizeXxx` pipeline with 27 top-level functions. It reads well function by function but is
  one file with at least four reasons to change (requests, capabilities, authorization, live
  state).

### 3. Expected failure is sometimes a value, sometimes an exception

- **high** In the outbound control store an optimistic conflict is thrown
  (`al-outbound-admission-control-store.ts:161, 170 throw new ALAdmissionBackendConflictError`)
  and no caller on the `acceptControlMessage` path catches it: the only `instanceof` handlers are
  in the inbound runtime, pending admission, and the two commit paths of the admission stores.
  A control that races a concurrent commit surfaces as an unhandled rejection to the transport
  callback rather than as `'conflict'` returned to QueueBox. The data-admission path in the same
  file family returns the value (`al-outbound-admission-store.ts:715-716, 753`).
- **medium** `validateEffects` builds `TypeError` objects and every caller throws the first
  (`al-outbound-admission-effect-store.ts:145`; store `:667-668`). The work handler treats a
  `TypeError` as retryable (only `ALAdmissionCorruptionError` and `NonRetryableException` are
  terminal, `al-outbound-work-handler.ts:177`), while `acceptClaimedEffect` in the same file treats
  it as corruption. The same malformed row is therefore retried on one path and finalized on the
  other.
- **medium** `assertObservations`, `assertMutationObservations`, and
  `assertControlAdmissionFence` use the `assertXxx` prefix, reserved for programmer invariants, to
  signal an expected concurrency conflict.
- **low** `validateALInboundCommitBundle` runs twice with two failure channels: callers branch on
  its `Either`, then `commitBundle` re-validates and throws a `TypeError` on the same left
  (`al-inbound-admission-store.ts:624-627`).

### 4. Contracts and construction

- **medium** Persisted snapshots carry optional fields whose absence is not a distinct domain
  state (`al-runtime-state-stores.ts:86-91 outboxKey?`, `supersedenceKey?`), against the
  required-fields default for persisted contracts.
- **medium** `createALOutboundAdmissionStore` introduces optional `nowMs?` and `canonicalScope?`
  with inline `Date.now`/namespace fallbacks (`al-outbound-admission-store.ts:96-97, 411`), and
  `createDefaultALOutboundRuntimeResources` takes an all-optional input with inline defaults
  (flagged by the checker as `factory.defaults` and waived by a disposition). The standard asks
  for one required input contract plus a separate default factory.
- **medium** Five store mutation methods make the caller resupply
  `decodePrepared: ALOutboundPreparedMessageDecoder` per call (`al-outbound-admission-store.ts:354-357`)
  instead of receiving it once at construction.
- **medium** The persisted key schema (`msg-owner`, `version`, `sent`, `pending-ack`,
  `repair-attempt`) is implemented twice under two names
  (`al-outbound-admission-control-store.ts:212-229` vs `al-outbound-admission-store.ts:1070-1090`).
- **low** `toAdmissionAcceptance` decides `'duplicate'` by
  `plan.dropReason?.startsWith('Duplicate message')` (`al-inbound-message-admission.ts:163`),
  coupling a typed acceptance to prose produced in `al-policy.ts`.

### 5. Hidden decisions

- **medium** When `readPendingAdmissionAuthority` is not supplied, pending replay substitutes
  `{ status: 'authorized' }` (`al-outbound-message-runtime.ts:182-185, 447-448`). The RTC overlay
  manager (`:147`) and the WS server (`ws-queue-box-server-service.ts:210`) supply it; the browser
  WS client outbound runtime does not. The exposure is bounded because the server re-authorizes
  every client message on receipt, but the default is a policy decision hidden four helper calls
  below the boundary behind an optional dependency.
- **medium** Ingress acceptance awaits an inline drain: after commit,
  `handleIncomingMessage` awaits `effects.committed()`
  (`al-inbound-message-runtime.ts:151`), which resets the scan and, when idle, runs a full page
  of up to sixteen unrelated effects including application dispatch and forwarding sends
  (`al-inbound-work-handler.ts:84-90`). The inbound README says the runtime "wakes the existing
  worker after commit"; the code does more than wake.
- **low** `readALInboundWorkSelection` probes readiness for every page entry before reservation
  and the delivery path re-reads the same state after reservation
  (`read-al-inbound-work-selection.ts:38`; `al-inbound-admitted-delivery.ts:79-91`), doubling the
  per-item read path on every engine poll.

### 6. Vocabulary and terminology

- **medium** Banned verbs survive in materially rewritten files: `handleIncomingMessage`,
  `handleControlMessage`, `processPage` (`alm/inbound`), `handlePendingAckTimeout`,
  `executeRepairFromHint`, `processBatch`, `processCommitted` (`alm/outbound`),
  `handleAuthInvalidError` (`shared-web/browser/session`). Touched-file closure was owed and not
  done.
- **low** The persisted inbound `Source` uses the product term `room`
  (`al-inbound-message-runtime.ts:28 roomRecipientPeerIds`) in a `packages/shared` protocol
  contract, outside the single translation module the standard names.

### 7. Product semantics that the code quietly decides

- **high** `ack: 'receiver'` is mapped to `'hop'` (`normalize-al-qos-policy.ts:457-458`). The
  only production consumer that asks for a receipt, the game authority client, asks for
  `reliability: 'at-least-once', ack: 'receiver'`
  (`packages/shared-web/game/authority/rallar-game-authority-client.ts:137-138`) and then treats
  admission as success. The requested guarantee is silently weakened, which the roadmap itself
  forbids ("a required guarantee must not be silently weakened").
- **high** Every typed browser send defaults to `reliability: 'at-least-once', ack: 'none'`
  (`browser-rallar-message-sender.ts:139-140`), which normalizes to
  `durability: 'local-outbox'` (`normalize-al-qos-policy.ts:272`), which selects the IndexedDB
  backend whenever the browser supports it
  (`packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts:46, 160-161`). The
  product's "zero AL-owned IndexedDB on the common path" criterion is therefore inverted by the
  default, not merely deferred.
- **medium** Whole-store reads survive the "indexed due/expiry queries" claim:
  `readAllStoredQueueEntries` uses `objectStore.getAll()`
  (`packages/shared/queuebox/indexed-db-queue-box-store.ts:108`) and is still called from seven
  sites in `indexed-db-queue-box.ts`; browser cleanup scans the whole `AL_INBOUND..AL_OUTBOUND`
  range before filtering by session (`browser-al-work-cleanup.ts:43, 72, 145`).

### 8. Governance and delivery

- **high** The branch edits the already-applied base migration
  `apps/api-v1/prisma/migrations/20260216141946_repository/migration.sql` to change the
  `resource_inbox_ix` index, instead of adding a new migration as the other twenty-two
  migrations in the directory do. Fresh CI databases get the new composite index; every existing
  database does not, and Prisma will report checksum drift on the modified migration.
- **high** Evidence quality. At the reviewed head the PR body reported "580/580 tests in 46
  files" while the full suite had 16 failures in 10 files, three of them in
  `auth-http-idempotency-security.test.ts` (login TTL and credential-fact timing) and three in
  the WS router; the changed-style gate was red on GitHub for every run; `deno task check`
  and `dprint check` were red locally. All were repaired before merge, but the PR body was the
  handoff document and it did not describe the head it accompanied.
- **medium** `reviewed-dispositions.mjs` grew from 110 entries to 235 on the reviewed head, then
  was split into three files totaling 386 entries on merged `main` after the file itself crossed
  the 1,200-line backstop and broke `repo-style-check.test.ts`. 91 of the additions are
  `boundary.unknown` waivers and 26 are cognitive-load pins.
- **medium** The facade bundle budget was raised from 180 KiB to 200 KiB with the measured
  198.9 KiB recorded, per the maintainer ruling on budgets, but that leaves 1.1 KiB for the
  delivery handle, shared receiver dedup, and volatile stores the next slice adds to the same
  facade.
- **low** A 674-file, 53-commit PR with two merges from `main` and zero GitHub reviews is not
  reviewable as a unit; the roadmap's "coordinated cutover" argument justifies contract and
  consumer changes landing together, not the harness rewrite (`packages/shared-test`, 78 files)
  and the perf tooling riding along.

## Code-analysis properties

The terms below are the standard vocabulary for what the sections above describe. Verdicts are
for the ALM cluster (`alm`, `al-contracts`, `queuebox`, `services/ws-queue-box-*`,
`multicast`) on merged `main`.

| Property                                    | Verdict         | Where it shows                                                                                                  |
| ------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------- |
| Cohesion (one reason to change per unit)    | mixed           | Pure compute/validate files: high. The two admission stores and the QoS normalizer: several reasons each.       |
| Coupling (afferent/efferent dependencies)   | high            | Store <-> effect store <-> work handler <-> runtime form a cycle of forwarding; mostly type-level, still dense. |
| Cognitive complexity (Sonar-style)          | over tier       | 124 and 118 in review tier; 12 further files in the warn tier, all pinned.                                      |
| Cyclomatic complexity per function          | acceptable      | No function above 60 lines; guards are dense but linear.                                                        |
| Cognitive indirection (semantic hops)       | deep            | Entry -> runtime -> admission -> store -> effect store -> backend -> work context before the first guard.       |
| Decision depth (policy near the boundary)   | violated        | `'authorized'` default, jitter `0.5`, `Math.random()` four calls down.                                          |
| Purity and side-effect separation           | good/blurred    | `compute*`/`validate*` pure; `read*` in stores both read and decide.                                            |
| Immutability of candidates                  | good            | Frozen inputs survive conflict and send; observation comparison is exact.                                       |
| Idempotency and crash convergence           | good            | Identical effect rows are no-ops; progress plus delete commit together; replay skips completed sequences.       |
| Optimistic concurrency (compare-and-set)    | good            | Every observed key re-read in-transaction; conflict is a typed value on the data path.                          |
| Fail-closed boundaries                      | good            | Corrupt persisted rows are typed corruption, never repaired by guessing.                                        |
| Expected failure as value (`Either`)        | inconsistent    | Value on data admission; exception on control admission and effect validation.                                  |
| Contract completeness (required by default) | partial         | Optional persisted fields; optional factory inputs with inline defaults.                                        |
| Duplication (DRY)                           | present         | Key schema twice; retry decision twice; claim loop twice.                                                       |
| Temporal coupling                           | present         | `ready()` fired from constructors; work handlers register in constructors; drain awaited on ingress.            |
| Leaky abstraction                           | present         | Raw `workQueue` exposed beside its wrapper; decoder resupplied per call.                                        |
| Naming consistency (canonical verbs)        | drifting        | `handle*`, `process*`, `execute*`, `capture*`, `apply*` beside the canonical set.                               |
| Navigability (5-landmark cold probe)        | pass, 2 escapes | Entry, policy, first guard, durable result, after-commit reachable; two searches needed for the work handler.   |
| Testability                                 | good            | Real owners with narrow clock/transport fakes; two tests at the reviewed head were coupled to removed layout.   |
| Dead code                                   | resolved        | Removed owners have no consumers; one dead per-call planner override remains on the inbound entry.              |

## Alignment with the Rallar standard and product

The engineering discipline matches the code standard's doctrine where it matters most: the
mutation grammar, the finite deadline, typed corruption, QueueBox retry ownership, and the
absence of a global readiness barrier. Where it drifts, it drifts in the direction every large
generated change drifts: more layers, more forwarding, more waivers.

The product alignment is the larger question and is argued in the companion document. In short:
both shipped games send their traffic through `rallar.realtime.room`, which bypasses ALM
entirely; the one reliable consumer asks for a receipt the protocol downgrades; and the default
typed send persists to IndexedDB. The code is well-built for a product that does not yet have a
consumer for its distinguishing features.

## Recommendations for the follow-up PR

Ordered by value per line changed.

1. Return the control-admission conflict as a value and catch nothing
   (`al-outbound-admission-control-store.ts:161, 170`); make `validateEffects` return issue
   records and let one owner classify corruption versus retryable.
2. Decide `ack: 'receiver'` honestly: implement it as reply correlation on the WS command path
   or reject it at the sender boundary; never map it to `hop`.
3. Flip the typed-send default to best-effort/volatile and make durability an explicit opt-in
   per channel. This makes the product's zero-IndexedDB criterion the default rather than a
   milestone, and removes the unperformed browser-storage reset from the risk register.
4. Collapse inbound and outbound work handlers onto one named QueueBox port owner; delete the raw
   `workQueue` leak, the split retry decision, and the legacy `dequeue()`/`onDequeuedDo` path.
5. Lift control admission out of the persistence owner so it has the same
   attempt/pending shape as data admission, then split the two admission stores along that
   boundary. Retire the cognitive-load pins in the same change.
6. Add a proper migration for the `resource_inbox_ix` change and restore the base migration.
7. Replace the seven `getAll()` call sites with the existing indexed page reader and make browser
   cleanup select by session prefix.
8. Remove the banned-verb names in the touched files and the `room` term from the shared
   contract.

## Appendix: commands and results

Passed on merged `main` (`a28e61b61`): `tsc` for `packages/shared`; `shared-web` and
`shared-server` `typecheck`; `npx dprint check`; `apps/api-v1 deno task check`;
`check:browser-bundles`; `vitest run` of the ten files that failed at the reviewed head
(117/117).

Failed at the reviewed head (`3e69cdd8b`) and repaired before merge: `dprint check`; `deno task
check`; `check:repo-style:changed` (100 findings); full `vitest run` (16 failures).

Skipped: `test:postgres:integration` and the medium-scale black-box gate, because the branch
changes the Prisma schema and this review does not migrate the shared development database;
the Hetzner distributed manifests; the three-browser Playwright workflow.

Also passed on merged `main`: `check:repo-style:changed c5e068516 a28e61b61` (no new or
worsened findings) and the full `vitest run` (1,165 files, 10,539 tests, 0 failed, 12 skipped).
The facade bundle on merged `main` measures 199.0 KiB Brotli against the 200 KiB budget.
