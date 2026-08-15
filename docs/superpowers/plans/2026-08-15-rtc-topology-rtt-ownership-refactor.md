# RTC Topology And RTT Ownership Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give authoritative RTC RTT ingress, mutation, policy, and persistence one direct
`rallar-system/rtc-topology` owner while fixing the two verified persistent-path bugs and preserving
all other observable behavior.

**Architecture:** The first slice moves the WebSocket entry, process-local refinement lifecycle,
AppInbox mutation phases, and policy into the existing RTC-topology feature. Durable RTT mutation
continues to write measurement, receipt, and final AppOutbox work atomically, but the work is
truthfully encoded as an RTT refresh and the executor applies an idempotent process-local refinement
decision before planning. The second slice moves repository, validation, key, migration, and cleanup
owners into `rtc-topology/persistence`; expired receipt cleanup stops requiring obsolete
intermediate-outbox siblings.

**Tech Stack:** TypeScript 7 with `erasableSyntaxOnly`, Vitest, Deno, PostgreSQL/PGlite runtime-state
repositories, ResourceInbox/AppInbox, QueueBox AppOutbox, Vivaldi RTT coordinates, GitHub CLI.

## Global Constraints

- Preserve the WebSocket topic and payload, AppInbox type and authority, command hashes, storage
  keys, runtime namespaces, persisted shapes, transaction/retry boundaries, receipts, and final
  caller-visible results.
- Preserve topology algorithms, RTT acceptance policy, configured thresholds, distributed recipes,
  and performance thresholds.
- The only intended behavior changes are: persistent RTT work obeys the already configured
  refinement threshold/interval, and valid expired RTT receipts clean up without legacy siblings.
- Keep canonical topology input, evolution, hysteresis, publication, replay, and reconnect owners
  under `rallar-system/topology`.
- Keep the package-level exported symbol set compatible through `packages/shared-server/mod.ts`; do
  not retain old private file paths as pass-through modules.
- Every changed human-authored file is reviewed and remediated in full.
- Every support file modified by remediation enters closure recursively until closure.
- Independent untouched code remains outside closure.
- A real newly discovered bug gets a failing semantic test and a separate fix explanation.
- A verified weakness outside these slices reuses or creates a focused issue; current follow-ups are
  [#235](https://github.com/intact-software-systems/ar-eye-hunter/issues/235) and
  [#236](https://github.com/intact-software-systems/ar-eye-hunter/issues/236).
- Do not push or create the pull request until implementation and affected local validation are
  complete.

---

## Locked file structure

### Canonical RTC RTT production owners

- `packages/shared-server/rallar-system/rtc-topology/README.md` — entry/result/failure navigation map
  and construction/runtime traces.
- `packages/shared-server/rallar-system/rtc-topology/topic/init-rtc-rtt-topic.ts` — WebSocket RTT
  decoding and durable-versus-in-memory handoff.
- `packages/shared-server/rallar-system/rtc-topology/topic/rtc-rtt-refinement-gate.ts` — pure
  per-group threshold and interval state.
- `packages/shared-server/rallar-system/rtc-topology/topic/rtc-rtt-refinement-service.ts` —
  idempotent durable-work observation and gate decisions around Vivaldi side effects.
- `packages/shared-server/rallar-system/rtc-topology/policy/rtc-rtt-measurement-policy.ts` — accepted
  and rejected RTT policy plus topology-planning measurement filtering.
- `packages/shared-server/rallar-system/rtc-topology/policy/read-rtc-rtt-expired-authority.ts` —
  expired measurement/admission authority and canonical affected-group order.
- `packages/shared-server/rallar-system/rtc-topology/mutation/rtc-rtt-mutation-contracts.ts` — stable
  request, read, facts, decision, guard, receipt, and final computed contracts.
- `packages/shared-server/rallar-system/rtc-topology/mutation/rtc-rtt-mutation-identifiers.ts` —
  receipt and final RTT-refresh work identity.
- `packages/shared-server/rallar-system/rtc-topology/mutation/compute-rtc-rtt-mutation.ts` — pure
  replay/reject/write computation.
- `packages/shared-server/rallar-system/rtc-topology/mutation/validate-rtc-rtt-mutation.ts` — exact
  deterministic recomputation and complete write-candidate validation.
- `packages/shared-server/rallar-system/rtc-topology/mutation/read-rtc-rtt-mutation.ts` — exact
  receipt-first measurement and endpoint reads.
- `packages/shared-server/rallar-system/rtc-topology/mutation/write-rtc-rtt-mutation.ts` — one
  transaction-owned conditional write sequence and final AppOutbox insertion.
- `packages/shared-server/rallar-system/rtc-topology/mutation/execute-rtc-rtt-mutation.ts` — direct
  non-AppInbox test/maintenance entry with no retry ownership.
- `packages/shared-server/rallar-system/rtc-topology/inbox/rtc-rtt-app-inbox-result.ts` — durable
  AppInbox result projection.

### Canonical RTC RTT persistence owners

- `packages/shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-persistence-contracts.ts`
  — endpoint admission and immutable receipt records.
- `packages/shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-runtime-namespaces.ts` —
  canonical namespace constants and protected-namespace inventory.
- `packages/shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-storage-keys.ts` — injective
  measurement and endpoint keys plus strict decoders.
- `packages/shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-persistence-validation.ts`
  — persisted measurement, admission, receipt, and physical-expiry validation.
- `packages/shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-repository.ts` — exact
  reads, listing, CAS writes, receipt probes, and lifecycle facts.
- `packages/shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-receipt-cleanup.ts` —
  periodic, guarded expired-receipt cleanup and failure reporting.
- `packages/shared-server/rallar-system/rtc-topology/persistence/migrate-legacy-rtc-rtt-measurement-keys.ts`
  — offline canonical pair-key migration.
- `packages/shared-server/rallar-system/rtc-topology/persistence/migrate-legacy-rtc-rtt-recompute-intents.ts`
  — retained offline decoder/upgrader for already stored legacy rows; it is not an active mutation
  path and the namespace is no longer protected from ordinary expiry.

### Mirrored focused tests

- `packages/tests/shared-server/rallar-system/rtc-topology/rtc-rtt-refinement-gate.test.ts`
- `packages/tests/shared-server/rallar-system/rtc-topology/rtc-rtt-refinement-service.test.ts`
- `packages/tests/shared-server/rallar-system/rtc-topology/rtc-rtt-topic.test.ts`
- `packages/tests/shared-server/rallar-system/rtc-topology/rtc-rtt-mutation.test.ts`
- `packages/tests/shared-server/rallar-system/rtc-topology/rtc-rtt-app-inbox.test.ts`
- `packages/tests/shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-repository-read-write.test.ts`
- `packages/tests/shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-repository-convergence.test.ts`
- `packages/tests/shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-receipt-cleanup.test.ts`
- `packages/tests/shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-persistence-corruption.test.ts`
- `packages/tests/shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-migration.test.ts`

---

### Task 1: Correct durable RTT refinement before moving ownership

**Files:**

- Create: `packages/shared-server/rallar-system/topology/rtt/rtc-rtt-refinement-service.ts`
- Modify: `packages/shared-server/rallar-system/topology/rtt/rtc-rtt-refinement-gate.ts`
- Modify: `packages/shared-server/rallar-system/services/RtcTopologyOutboxWork.ts`
- Modify: `packages/shared-server/rallar-system/services/rtc-topology-outbox-entry.ts`
- Modify: `packages/shared-server/rallar-system/topology/replay/rtc-topology-work-codec.ts`
- Modify: `packages/shared-server/rallar-system/topology/replay/create-rtc-topology-work-handler.ts`
- Modify: `packages/shared-server/rallar-system/services/rtc-rtt-mutation-service.ts`
- Modify: `packages/shared-server/rallar-system/ws-system-topics.ts`
- Modify: `apps/api-v1/src/create-rallar-server.ts`
- Modify: `docs/production-legacy-exceptions.md`
- Test: `packages/tests/shared-server/rallar-system/topology/rtt/rtc-rtt-refinement-gate.test.ts`
- Create: `packages/tests/shared-server/rallar-system/topology/rtt/rtc-rtt-refinement-service.test.ts`
- Modify: `packages/tests/shared-server/rtc-topology-outbox-work.test.ts`
- Create: `packages/tests/shared-server/rtc-rtt-durable-refinement.test.ts`

**Interfaces:**

- Consumes: existing `RtcRttRecomputeIntent`, `RtcTopologyRttRefreshWork`, final ResourceInbox
  AppOutbox transaction, `RtcRttRefinementGate.claimRefinement`, and Vivaldi service functions.
- Produces:

```ts
export interface RtcRttRefinementServiceDependencies {
  readonly gate: RtcRttRefinementGate;
  readonly nowEpochMs: () => number;
  readonly observeRtt: (rtt: RttMeasurementInfo) => boolean;
  readonly readPredictedNodeData: () => ReadonlyMap<string, VivaldiNodeData>;
}

export interface ClaimRtcRttRefinementWorkInput {
  readonly observationId: string;
  readonly workId: string;
  readonly groupKey: string;
  readonly rtt: RttMeasurementInfo | null;
  readonly expireAtEpochMs: number;
}

export class RtcRttRefinementService {
  claimWork(input: ClaimRtcRttRefinementWorkInput): boolean;
}
```

Canonical `RtcTopologyRttRefreshWork` carries required `rtt` and `refinementObservationId`.
The decoder returns a separately discriminated legacy form for old RTT-refresh work without
those fields and for durable RTT work previously mislabeled `group-revision`; legacy work claims
one early refinement and never weakens validation of canonical new work.

- [ ] **Step 1: Record the clean rebased baseline**

Run:

```bash
npx vitest run \
  packages/tests/shared-server/rallar-system/topology/rtt/rtc-rtt-refinement-gate.test.ts \
  packages/tests/shared-server/rtc-topology-outbox-work.test.ts \
  packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts \
  packages/tests/shared-server/rtc-topology-mutations.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npm run check:repo-structure
```

Expected: all existing semantic tests and the package typecheck pass; the structure command reports
facts but exits zero. Classify any failure before changing production.

- [ ] **Step 2: Write the failing persistent-path tests**

Add a test that executes one accepted RTT AppInbox mutation through the real transaction harness,
parses its final `APP_OUTBOX` entry, and asserts:

```ts
expect(envelope.data).toMatchObject({
  kind: 'rtt-refresh',
  rtt,
  refinementObservationId: toRtcRttMutationReceiptId(rtt),
});
```

Add executor tests proving a 10ms threshold receives 4ms + 4ms as skipped work, the next 4ms as one
planned work item with a zero interval floor, the same durable work ID returns the same decision on
retry, zero knobs plan every canonical work item, and a legacy work item plans once without
pretending it contained an RTT.

- [ ] **Step 3: Run the new tests to verify the bug**

Run:

```bash
npx vitest run \
  packages/tests/shared-server/rtc-rtt-durable-refinement.test.ts \
  packages/tests/shared-server/rallar-system/topology/rtt/rtc-rtt-refinement-service.test.ts \
  packages/tests/shared-server/rtc-topology-outbox-work.test.ts
```

Expected: FAIL because the durable entry says `group-revision`, contains no RTT observation, and the
production handler never invokes a refinement service.

- [ ] **Step 4: Separate pure gate configuration from side-effect dependencies**

Keep `RtcRttRefinementGateConfig` to `minIntervalMs` and `vivaldiDeltaThresholdMs`. Supply the clock
to the new refinement service and make time an explicit gate input:

```ts
gate.claimRefinement({ groupKey, predictedDeltaMs, nowEpochMs });
```

Preserve all existing threshold, accumulation, per-group, first-observation, and zero-knob
assertions.

- [ ] **Step 5: Implement idempotent observation and claim ownership**

`RtcRttRefinementService.claimWork` must prune cached observations and work decisions whose
`expireAtEpochMs <= nowEpochMs()`, observe each `observationId` at most once per process, compute the
absolute predicted RTT delta before/after observation, reuse that delta across all groups for the
same receipt, and cache each `workId` decision. A `null` legacy RTT uses positive infinity and does
not call Vivaldi.

- [ ] **Step 6: Encode canonical durable RTT work and normalize legacy work**

Make `ComputedRtcTopologyOutbox` a discriminated group-revision/RTT-refresh union. For
`payloadKind: 'rtt-refresh'`, require the exact `rtt` and `refinementObservationId`, serialize
`RtcTopologyRttRefreshWork`, and validate their version/identity. Update both the direct publisher
and `writeRttMutation` to use the canonical RTT branch. In the decoder, normalize only a strict old
RTT resource identity to the legacy form; arbitrary group work remains group work.

Register that decoder as one minimized compatibility boundary in
`docs/production-legacy-exceptions.md`: canonical owner `rtc-topology-work-codec.ts`, consumer
dependency “in-flight final AppOutbox work written before this deployment,” unsafe-removal reason
“up to 24 hours of valid work may remain,” and removal condition “all production writers have run
the canonical RTT-refresh envelope for more than the fixed 24-hour work retention.”

- [ ] **Step 7: Gate durable work before topology planning**

Pass `RtcRttRefinementService` from API-v1 composition through `initRallarSystemWsTopics` to
`createRtcTopologyWorkHandler`. For decoded RTT refresh work, call `claimWork` before reading
planning authority. When false, return a named `skipped-rtt-refinement` decision that completes the
work without snapshot, publication, delivery, or wake writes. Qualified work continues through the
existing full-rebuild and unchanged-result gate.

- [ ] **Step 8: Run focused red/green verification**

Run:

```bash
npx vitest run \
  packages/tests/shared-server/rtc-rtt-durable-refinement.test.ts \
  packages/tests/shared-server/rallar-system/topology/rtt/rtc-rtt-refinement-gate.test.ts \
  packages/tests/shared-server/rallar-system/topology/rtt/rtc-rtt-refinement-service.test.ts \
  packages/tests/shared-server/rtc-topology-outbox-work.test.ts \
  packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
```

Expected: PASS, including one idempotent decision per durable work identity and unchanged legacy
early-refinement behavior.

- [ ] **Step 9: Review the complete changed-file closure and commit**

Review every changed production/test file in full, resolve all style and legacy findings in those
files, include recursively changed support files, then run `git diff --check` and commit:

```bash
git add packages/shared-server packages/tests/shared-server apps/api-v1/src/create-rallar-server.ts docs/production-legacy-exceptions.md
git commit -m "fix(rtc): apply refinement to durable RTT work"
```

---

### Task 2: Move RTT topic and policy ownership

**Files:**

- Move: `packages/shared-server/rallar-system/topology/rtt/init-rtc-rtt-topic.ts` to
  `packages/shared-server/rallar-system/rtc-topology/topic/init-rtc-rtt-topic.ts`
- Move: `packages/shared-server/rallar-system/topology/rtt/rtc-rtt-refinement-gate.ts` to
  `packages/shared-server/rallar-system/rtc-topology/topic/rtc-rtt-refinement-gate.ts`
- Move: `packages/shared-server/rallar-system/topology/rtt/rtc-rtt-refinement-service.ts` to
  `packages/shared-server/rallar-system/rtc-topology/topic/rtc-rtt-refinement-service.ts`
- Move: `packages/shared-server/rallar-system/services/rtc-rtt-measurement-policy.ts` to
  `packages/shared-server/rallar-system/rtc-topology/policy/rtc-rtt-measurement-policy.ts`
- Move: `packages/shared-server/rallar-system/services/rtc-rtt-expired-authority.ts` to
  `packages/shared-server/rallar-system/rtc-topology/policy/read-rtc-rtt-expired-authority.ts`
- Modify: all direct imports in shared-server, API-v1, and tests
- Split: RTT cases from `packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`
- Move/Create: the three RTT topic test files at the `rtc-topology` feature test root

**Interfaces:**

- Consumes: the Task 1 refinement contracts unchanged.
- Produces: the same runtime exports from canonical feature paths; `packages/shared-server/mod.ts`
  continues exporting the same package-level names where they were already public.

- [ ] **Step 1: Move behavior-named tests first**

Move the gate/service tests and extract RTT-specific WebSocket cases into the mirrored topic path.
Keep group snapshot, topology publication, and generic WebSocket tests in their existing owner.

- [ ] **Step 2: Run moved tests before production paths change**

Run the three new topic test paths. Expected: FAIL with module-not-found errors for the future
canonical imports; assertions and fixtures otherwise remain unchanged.

- [ ] **Step 3: Move the production owners and update direct consumers**

Use direct imports from the new files in `ws-system-topics.ts`, API-v1 configuration/composition,
planning, mutation, and tests. Delete the old private modules; do not add forwarding modules.

- [ ] **Step 4: Add the RTC-topology navigation map**

Create `rtc-topology/README.md` with a `repository-navigation-v1` block whose entry is
`topic/init-rtc-rtt-topic.ts#initRtcRttTopic`, whose results include
`inbox/rtc-rtt-app-inbox-result.ts#toRtcRttAppInboxResult` and the final AppOutbox writer, and whose
failures include authority rejection, repository corruption, and idempotency conflict. Add the
construction/registration and runtime invocation timelines required by the code-writing standard.

- [ ] **Step 5: Run focused ownership verification**

Run:

```bash
npx vitest run packages/tests/shared-server/rallar-system/rtc-topology
npx vitest run packages/tests/shared-server/rallar-system/topology/planning
npx tsc -p packages/shared-server/tsconfig.json --noEmit
```

Expected: PASS with no import from `rallar-system/topology/rtt` or
`rallar-system/services/rtc-rtt-measurement-policy.ts` remaining.

- [ ] **Step 6: Review closure and commit**

Run `rg` for old paths, review every moved/changed file in full, format, run `git diff --check`, and
commit:

```bash
git add packages/shared-server packages/tests/shared-server apps/api-v1 docs
git commit -m "refactor(rtc): move RTT ingress and policy ownership"
```

---

### Task 3: Consolidate AppInbox mutation ownership

**Files:**

- Create: the six `rtc-topology/mutation` files and the inbox result file named in the locked
  structure
- Modify: `packages/shared-server/rallar-system/rtc-topology/inbox/rtc-rtt-app-inbox-contracts.ts`
- Modify: `packages/shared-server/rallar-system/rtc-topology/inbox/rtc-rtt-app-inbox-authority.ts`
- Modify: `packages/shared-server/rallar-system/rtc-topology/inbox/rtc-rtt-app-inbox-handler.ts`
- Modify: `packages/shared-server/rallar-system/services/rtc-topology-mutations.ts` to retain only
  topology publication mutation
- Delete: `packages/shared-server/rallar-system/services/rtc-rtt-mutation-service.ts`
- Delete: `packages/shared-server/rallar-system/services/rtc-rtt-app-inbox-result.ts`
- Modify: `packages/shared-server/rallar-system/services/AppGroupInboxService.ts`
- Modify: `packages/shared-server/mod.ts`
- Split: RTT cases from `packages/tests/shared-server/rtc-topology-mutations.test.ts`
- Create: mirrored mutation and inbox tests named in the locked structure

**Interfaces:**

- Consumes: `RtcRttRepository`, policy owners, AppInbox transaction writer, and Task 1 final
  RTT-refresh outbox contract.
- Produces: direct `readRtcRttMutation`, `computeRtcRttMutation`, `validateRtcRttMutation`,
  `writeRtcRttMutation`, `executeRtcRttMutation`, and `toRtcRttAppInboxResult` owners. AppInbox
  retains whole-attempt retry ownership; the mutation writer receives one transaction and never
  opens, commits, or retries it.

- [ ] **Step 1: Move semantic mutation tests to the feature path**

Extract every RTT describe case—stale/equal-version, all policy rejections, endpoint capacity,
canonical affected groups, immutable replay, divergent idempotency, complete candidate validation,
and final outbox intent—without copying topology-publication cases.

- [ ] **Step 2: Run the new tests against future imports**

Expected: module-not-found failure for the new mutation paths.

- [ ] **Step 3: Extract contracts and pure compute/validate phases**

Move only RTT contracts and functions out of `rtc-topology-mutations.ts`. Keep persisted admission
and receipt records imported from persistence contracts, not redefined. Rename functions to the
canonical `computeRtcRttMutation` and `validateRtcRttMutation` vocabulary and update every direct
consumer once.

- [ ] **Step 4: Extract read, write, execute, and result owners**

Keep receipt-first reads and parallel exact authority reads in `read-rtc-rtt-mutation.ts`. Keep the
first conditional endpoint write, measurement CAS, immutable receipt insert, and final AppOutbox
insertion visibly ordered in `write-rtc-rtt-mutation.ts`. Keep the direct execute entry free of
retry loops. Move AppInbox result projection beside the handler.

- [ ] **Step 5: Rewire AppInbox without a compatibility hop**

Update `RtcRttAppInboxHandler`, `AppGroupInboxService`, API/test consumers, and `mod.ts` to canonical
files. Delete old RTT service files. Preserve the existing public symbol names in `mod.ts`.

- [ ] **Step 6: Verify the full AppInbox family**

Run:

```bash
npx vitest run \
  packages/tests/shared-server/rallar-system/rtc-topology/rtc-rtt-mutation.test.ts \
  packages/tests/shared-server/rallar-system/rtc-topology/rtc-rtt-app-inbox.test.ts \
  packages/tests/shared-server/group-state/inbox/app-group-inbox-registration-lifecycle.test.ts \
  packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts \
  packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
```

Expected: PASS with unchanged authority, receipt, retry, transaction, after-commit, and result
semantics apart from the separately asserted refinement fix.

- [ ] **Step 7: Review closure and commit**

Review all changed files in full, including the remaining topology-only mutation test/module, run
format and diff checks, and commit:

```bash
git add packages/shared-server packages/tests/shared-server
git commit -m "refactor(rtc): consolidate RTT mutation ownership"
```

---

### Task 4: Move persistence ownership and fix expired receipt cleanup

**Files:**

- Create: the eight canonical persistence files named in the locked structure
- Delete: `packages/shared-server/rallar-system/repositories/RtcRttRepository.ts`
- Delete: `packages/shared-server/rallar-system/rtc-rtt-persistence-validation.ts`
- Modify: `packages/shared-server/rallar-system/rtc-topology-identifiers.ts` to retain only shared
  topology identities; move RTT keys and mutation IDs to their canonical owners
- Modify: API-v1, shared-server, performance harness, test, and `mod.ts` direct imports
- Split: `packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts` into focused
  topology and RTC RTT repository suites so no changed test remains a multi-thousand-line mixed
  owner
- Create: the five mirrored RTC RTT persistence tests named in the locked structure
- Modify: `packages/tests/shared-server/integration/postgres/rtt-runtime-concurrency.test.ts`

**Interfaces:**

- Consumes: runtime-state exact reads and optimistic transaction capabilities.
- Produces: the same package-level repository, constants, cleanup handle/error, migration functions,
  `cleanupExpiredRtcRttReceipts`, and validation names from canonical persistence files. The legacy
  intermediate namespace constant and migration function remain available for offline inspection,
  but the namespace is removed from `RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES` because no active
  writer or consumer remains.

- [ ] **Step 1: Write the failing receipt cleanup regression test**

Seed one valid expired `RtcRttMutationReceipt` whose `affectedGroupRefs` is non-empty and seed no
`rtc-rtt:recompute-outbox` sibling. Call the cleanup owner and assert:

```ts
await expect(cleanupExpiredRtcRttReceipts(repository)).resolves.toBe(1);
await expect(repository.probeMutationReceiptEntry(receipt.receiptId)).resolves.toBeUndefined();
```

Also assert a live receipt remains, a changed optimistic revision conflicts without deletion, and an
expired legacy intermediate row is outside the protected namespace inventory.

- [ ] **Step 2: Run the regression test to prove the current cleanup bug**

Expected: FAIL with the current “recompute intent set is incomplete” corruption error.

- [ ] **Step 3: Extract contracts, namespaces, keys, and validators**

Move values without changing string constants or codecs. Keep strict canonical decoders beside key
builders. Split persisted-row validation from mutation computed-candidate validation so persistence
does not import the mutation implementation.

- [ ] **Step 4: Extract the repository and guarded cleanup lifecycle**

Keep exact reads, lists, pages, CAS writes, receipt probes, and lifecycle facts in
`RtcRttRepository`. Put scheduling and receipt deletion in `rtc-rtt-receipt-cleanup.ts`. Cleanup
reads and validates the receipt outside the transaction, then uses one transaction to guard its
exact revision and conditionally delete it; it neither reads nor requires obsolete intent siblings.

- [ ] **Step 5: Extract offline migrations and close legacy runtime use**

Keep `oldWritersStopped: true` fail-closed guards and value-verified canonical destination behavior.
Keep the legacy recompute-intent upgrader callable for offline retained data, but remove the
intermediate namespace from active protected cleanup and production mutation imports.

- [ ] **Step 6: Split and mirror repository tests**

Move RTT cases into the five persistence suites. Split the remaining topology snapshot,
publication, and migration cases by their existing production owners so the changed support-file
closure contains no mixed 3,000-line test. Preserve all semantic assertions; discard dead underscored
helpers that no test invokes.

- [ ] **Step 7: Update all consumers and delete old private paths**

Update shared-server, API-v1, performance harness, PGlite, PostgreSQL integration, and tests to the
canonical files. Update `mod.ts` so package-level names remain available. Delete old modules only
after `rg` reports no direct consumer.

- [ ] **Step 8: Run focused persistence and concurrency verification**

Run:

```bash
npx vitest run packages/tests/shared-server/rallar-system/rtc-topology/persistence
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npm run test:postgres:integration
```

Expected: unit suites and typecheck pass; PostgreSQL RTT overlap proves one accepted winner and one
typed conflict, plus final convergence. If PostgreSQL is unavailable, report the command failed or
skipped with the environment reason and do not claim concurrency proof.

- [ ] **Step 9: Review closure and commit**

Review every created, moved, and changed file in full; run format/diff checks; then commit:

```bash
git add packages/shared-server packages/shared-test packages/tests apps/api-v1
git commit -m "refactor(rtc): move RTT persistence ownership"
```

---

### Task 5: Validate the two slices and publish one pull request

**Files:**

- Modify: `packages/shared-server/rallar-system/rtc-topology/README.md` only if final code-derived
  traces reveal a material owner/result mismatch
- Modify: pull request body through GitHub; no tracked plan ledger, receipt, or catalog

**Interfaces:**

- Consumes: Tasks 1-4 and issues #235/#236.
- Produces: one pushed `codex/rtc-topology-rtt-structure` branch and one pull request with Goal,
  Changes, Acceptance, Validation, Risk and rollback, and Follow-up.

- [ ] **Step 1: Run navigation, style, structure, legacy, and formatting review**

Run:

```bash
npm run check:repo-style -- --root packages/shared-server/rallar-system/rtc-topology
npm run check:repo-style:changed -- origin/main
npm run check:repo-structure -- --base origin/main
npm run test:repo-structure
npm run check:retained-legacy
npx prettier --check packages/shared-server packages/tests/shared-server apps/api-v1/src docs/superpowers
git diff --check origin/main...HEAD
```

Expected: changed-file gates pass. Record a path/rule/symbol disposition for every construction
warning. Confirm no old private RTC RTT path remains and the navigation map matches production.

- [ ] **Step 2: Run affected semantic and package checks**

Run:

```bash
npx vitest run packages/tests/shared-server/rallar-system/rtc-topology
npx vitest run \
  packages/tests/shared-server/rtc-topology-outbox-work.test.ts \
  packages/tests/shared-server/rtc-topology-replay-service.test.ts \
  packages/tests/shared-server/rtc-topology-replay-entry-handler.test.ts \
  packages/tests/shared-server/rtc-topology-replay-decision.test.ts \
  packages/tests/shared-server/rtc-topology-coalesced-group-revision-work.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning \
  packages/tests/shared-server/group-state/inbox/app-group-inbox-registration-lifecycle.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
(cd apps/api-v1 && deno task check)
```

Expected: PASS.

- [ ] **Step 3: Run mutation-path and topology-replay risk gates**

Because Task 1 changes durable RTT mutation output and topology work classification, run:

```bash
npm run test:api-v1:black-box:postgres:medium-scale
npm run test:api-v1:black-box:postgres:topology-replay
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

Expected: both black-box gates and the comparative result gate pass. Preserve generated artifacts
under `tmp/perf/`; do not commit them. Classify environmental failures without weakening constants.

- [ ] **Step 4: Complete final code-derived traces and legacy review**

Trace construction/registration and runtime invocation separately for the in-memory WebSocket RTT
path, persistent WebSocket → AppInbox mutation path, durable RTT-refresh executor, and receipt
cleanup lifecycle. Classify every affected legacy item as removed, minimized-boundary, resolved, or
retained; no unclassified affected legacy may remain.

- [ ] **Step 5: Check delivery state and prepare the PR**

Run:

```bash
npm run pr:delivery -- status
git status --short --branch
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
```

Expected before first publication: no conflicting PR state, a clean feature branch, and only the
reviewed RTC RTT/design/plan scope.

- [ ] **Step 6: Push the feature branch and create the PR**

Push `codex/rtc-topology-rtt-structure` to `origin` without force. Create one pull request against
`main` whose body contains only Goal, Changes, Acceptance, Validation, Risk and rollback, and
Follow-up; link the design and issues #235/#236. Keep it draft until remote checks are visible, then
run `npm run pr:delivery -- ready` once after affected validation is complete.

- [ ] **Step 7: Report the exact handoff**

Report files/behavior changed, the two corrected bugs, compatibility rationale, every passed,
failed, or skipped command, current GitHub checks, the PR URL, and issues #235/#236. Do not create a
post-merge receipt or plan closure commit.
