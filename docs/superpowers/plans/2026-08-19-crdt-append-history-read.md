# CRDT Append History Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement
> this plan task-by-task. Use `rallar-repo:performance-analysis` for measurement decisions,
> `rallar-repo:rallar-code-writing` for every human-authored code change, and
> `rallar-repo:rallar-testing` for proportional validation.

**Goal:** Remove the PostgreSQL CRDT append path's full-history read and decode while preserving
AppInbox ownership, transaction and retry behavior, duplicate semantics, persisted contracts, and
history-wide validation for administration and integrity operations.

**Architecture:** Keep the public CRDT mutation service and `CrdtMutationRead` contract stable.
Inside `PSqlCrdtMutationRepository`, select an append's candidate update through the existing
`(document_key, update_id)` unique index and return no complete record history for append commands.
Continue loading and validating complete histories for mutation operations whose computation needs
them. Measure the real authenticated WebSocket -> AppInbox -> PostgreSQL -> committed reply path
with one parameterized black-box recipe at small, medium, and large bounded histories.

**Tech Stack:** TypeScript 7 with `erasableSyntaxOnly`, Deno 2, Vitest, PostgreSQL/PGlite,
ResourceInbox/AppInbox, the Rallar black-box runner, JSON performance artifacts, Prettier, and the
repository style, structure, coupling, and legacy checkers.

**Spec:** [Issue #265](https://github.com/intact-software-systems/ar-eye-hunter/issues/265) and the
follow-up boundary recorded in
`docs/superpowers/specs/2026-08-17-crdt-mutation-and-administration-ownership-design.md`.
The completed ownership plan at
`docs/superpowers/plans/2026-08-17-crdt-mutation-and-administration-ownership.md` remains historical;
this child plan owns the separately approved performance follow-up.

## Global Constraints

- Planning base is exact `origin/main`
  `e29dadd2148e3923c395ac18030e7d6bb85b58a1`.
- Preserve AppInbox as the only incoming database mutation owner. Do not move transaction, retry,
  optimistic compare-and-set, command decoding, compute, validation, final outbox, reply, or fanout
  behavior.
- Preserve REST paths, WebSocket topics and payloads, command/result versions, document keys,
  database schema, persisted rows, authorization order, policy defaults, duplicate hash behavior,
  and observable error classes.
- Use the existing unique PostgreSQL index on `(document_key, update_id)`; do not add a redundant
  index or migration.
- An append read returns at most the one update that can establish new-versus-duplicate behavior.
  A new update returns zero update rows; an existing update returns exactly one decoded row.
- Complete histories remain available to `compact`, `rebuild-projection`, `lifecycle`, and `erase`
  mutation computation. The read-set validator must explicitly distinguish a complete history from
  an append-local read; it must never pretend a partial read authenticates document-wide counters.
- Keep the existing actor-window count query unchanged in this slice. It may mask some improvement
  because no matching composite actor/time index has been established. Measure it as part of the
  real workflow and create or reuse a focused issue only if evidence confirms it is the next
  bottleneck.
- Use one parameterized black-box recipe, not three copied recipes and not a new synthetic SQL-only
  benchmark. Register three matrix rows:
  - `small`: seed 10 updates, measure through terminal history 30;
  - `medium`: seed 100 updates, measure through terminal history 120;
  - `large`: seed 480 updates, measure through terminal history 500.
- Seed through the supported authenticated WebSocket -> AppInbox workflow outside the measured
  phase. Do not insert benchmark history directly with SQL.
- Warm up with three duplicate replays so warmup does not grow history. Measure 20 new appends and
  20 duplicate replays. Every replay reuses the exact update envelope and update ID but uses a fresh
  outer delivery/message ID so ResourceInbox does not short-circuit the repository read.
- Derive one end-to-end sample from the `ws.send.startedAtEpochMs` to its paired committed-reply
  `ws.wait.endedAtEpochMs`. The recipe runner already records both timestamps; do not add a second
  timing clock inside product code.
- Black-box evidence is diagnostic rather than a hard microbenchmark gate. The comparison validates
  artifacts and prints p50/p95 values and candidate/baseline ratios for both new and replay paths at
  every scale. It does not claim improvement or regression solely from one noisy ratio.
- Each case must finish with exact integrity count, a final catch-up read, committed fanout evidence,
  and same-observation AppInbox/outbox evidence for the final new append.
- Do not claim a memory improvement. This plan does not capture process memory with a controlled
  sampler.
- Generated artifacts belong under `tmp/perf/crdt-append-history/` and are never committed.
- Every changed human-authored file is reviewed and remediated in full.
- Every support file modified by remediation enters closure recursively until closure.
- Independent untouched code remains outside closure.
- Remove affected legacy only when no verified public, persisted, protocol, migration, or consumer
  requirement needs it. Any retained affected legacy boundary requires explicit maintainer approval
  and a focused registry entry.
- Fix any affected correctness bug with a failing semantic test. For a confirmed performance or
  code weakness outside this two-slice horizon, search open issues and create or reuse one accurate
  issue before handoff.

---

## Working Horizon

Only these two slices are concrete:

1. **Slice 1 — representative black-box evidence and baseline.** Add one parameterized recipe,
   three bounded matrix cases, semantic recipe/artifact tests, a diagnostic comparator, and capture
   immutable baseline artifacts from the unoptimized repository.
2. **Slice 2 — indexed append-local read and candidate.** Prove the 0/1-row contract with PGlite,
   implement the operation-specific read boundary, retain complete-history validation for
   administration, capture candidate artifacts, and compare before/after evidence.

Do not start an actor-window index/query change or a custom PostgreSQL benchmark unless the two
slice result is inconclusive and a new plan decision explicitly activates that work.

### Execution status — 2026-08-19

- Slice 1 is complete. The first baseline attempt is retained as failed evidence: its medium and
  large cases exposed reused cross-case CRDT identities in the new recipe. A semantic regression
  test was added before the identity fix.
- Accepted baseline artifacts are under
  `tmp/perf/crdt-append-history/baseline-e29dadd2148e-attempt-02/`. All three cases passed, and the
  PostgreSQL mutation-repository blob exactly matched the planning base during capture.
- The baseline p50/p95 values are approximately 103–105/129–131 ms at every scale. The existing
  queue cadence therefore masks database-read scaling at the approved maximum of 500 updates. The
  black-box recipe remains the end-to-end correctness and no-regression layer; the real-PGlite
  repository test owns the precise 0/1-row boundary proof.
- Slice 2 is implemented and its immutable candidate capture passed all three cases at commit
  `72b4f565c4e97594da0847a9aa21bcd304e4e2e9`. The authenticated comparison reports no artifact
  issues. Candidate/baseline p50 and p95 ratios stay between 1.00 and 1.04 without increasing with
  history size, so they are classified as queue-cadence noise rather than a history-dependent
  regression.
- The general state-write benchmark was reviewed and is not run: its operation inventory is client
  profile/instance, group presence/configuration, and topology-source mutation; it does not execute
  the CRDT repository changed by this plan. Its available local baseline also binds unrelated commit
  `224c850bf1e3632532b49c17995a6183c8c4c7a3`. Running it would create large unrelated evidence, not
  a proportional regression check for this slice.

| Case   | Path   | Baseline p50/p95 | Candidate p50/p95 | Candidate ratios |
| ------ | ------ | ---------------- | ----------------- | ---------------- |
| small  | new    | 104/131 ms       | 108/134 ms        | 1.038/1.023      |
| small  | replay | 104/131 ms       | 107/131 ms        | 1.029/1.000      |
| medium | new    | 104/129 ms       | 106/134 ms        | 1.019/1.039      |
| medium | replay | 105/130 ms       | 107/131 ms        | 1.019/1.008      |
| large  | new    | 103/130 ms       | 107/133 ms        | 1.039/1.023      |
| large  | replay | 104/130 ms       | 107/133 ms        | 1.029/1.023      |

---

## Slice 1 — Parameterized Black-Box Evidence And Baseline

### Task 1: Add semantic RED coverage for the evidence surface

**Files:**

- Create: `packages/tests/shared-test/api-v1-crdt-append-history-recipe.test.ts`
- Reference: `packages/tests/shared-test/api-v1-recipe-test-fixture.ts`
- Reference: `packages/tests/shared-test/recipe-matrix.test.ts`
- Reference: `packages/shared-test/black-box-runner/scenario-black-box.ts`

- [x] Write a test that loads the matrix and requires exactly the `small`, `medium`, and `large`
      rows with seed/final counts `10/30`, `100/120`, and `480/500`.
- [x] Execute the recipe's strict/offline expansion for each row and assert semantic behavior:
      authenticated WS construction, seed loop count, three replay warmups, 20 measured new sends,
      20 measured replay sends, fresh replay delivery IDs, integrity count, catch-up, fanout, and
      final state-write evidence.
- [x] Add artifact fixtures with paired send/reply results and require the comparison owner to reject
      missing, duplicate, failed, unpaired, or non-monotonic samples.
- [x] Run RED:

```sh
npx vitest run packages/tests/shared-test/api-v1-crdt-append-history-recipe.test.ts
```

Expected: FAIL because the recipe, matrix rows, and comparison owner do not exist.

### Task 2: Implement one recipe, three matrix cases, and the diagnostic comparator

**Files:**

- Create: `packages/shared-test/black-box-runner/tests/api-v1/api-v1-crdt-append-history.json`
- Create: `scripts/perf/compare-api-v1-crdt-append-history-results.mjs`
- Modify: `packages/shared-test/black-box-runner/recipe-matrix.json`
- Modify: `packages/shared-test/package.json`
- Modify: `package.json`
- Modify: `scripts/perf/README.md`
- Test: `packages/tests/shared-test/api-v1-crdt-append-history-recipe.test.ts`

- [x] Build one recipe whose history size and expected final count come from matrix environment
      variables. Reuse the established three-server authentication, ticket, WS authorization,
      AppInbox evidence, catch-up, and cleanup shapes.
- [x] Keep the primary socket open while seeding. Open the tertiary socket before measurement so the
      measured final new update can be authenticated as a committed cross-node fanout.
- [x] Seed deterministic unique update envelopes. Preserve one seeded envelope for all replay
      warmups and measured replays; vary only the outer delivery/message identity.
- [x] Name measured steps `measureNewAppend{loop.iteration}` /
      `observeNewAppendReply{loop.iteration}` and `measureDuplicateReplay{loop.iteration}` /
      `observeDuplicateReplayReply{loop.iteration}` so artifact pairing is explicit.
- [x] Implement a total comparator that accepts two artifact roots, authenticates the three exact
      matrix cases and 20 paired samples per path, validates zero recipe failures, then prints
      baseline/candidate p50, p95, and ratios. Malformed artifacts exit nonzero; noisy but valid
      measurements remain diagnostic output.
- [x] Add dedicated commands:

```text
npm run test:api-v1:black-box:postgres:crdt-append-history
npm run perf:api-v1:crdt-append-history:compare -- <baseline-root> <candidate-root>
```

- [x] Run GREEN:

```sh
npx vitest run \
  packages/tests/shared-test/api-v1-crdt-append-history-recipe.test.ts \
  packages/tests/shared-test/recipe-matrix.test.ts
npm --workspace @ar-eye-hunter/shared-test run check
node scripts/check-changed-repo-style.mjs \
  e29dadd2148e3923c395ac18030e7d6bb85b58a1 HEAD
```

### Task 3: Capture the immutable baseline

**Files:**

- Generated only:
  `tmp/perf/crdt-append-history/baseline-e29dadd2148e-attempt-02/`

- [x] Confirm `git rev-parse HEAD` is still the unoptimized product tree for baseline capture. Recipe,
      comparator, docs, and tests may differ; the PostgreSQL mutation repository blob must equal
      base.
- [x] Start a fresh PostgreSQL environment and apply migrations using the managed black-box command.
- [x] Run:

```sh
RALLAR_CRDT_APPEND_HISTORY_ARTIFACT_DIR=\
../../tmp/perf/crdt-append-history/baseline-e29dadd2148e-attempt-02 \
  npm run test:api-v1:black-box:postgres:crdt-append-history
```

- [x] Validate every report and record exact host/runtime/database/source identity in the handoff.
      Preserve failures as failures; do not silently replace a bad attempt.

---

## Slice 2 — Indexed Append Read And Candidate Evidence

### Task 4: Prove the append-local 0/1-row read contract with RED tests

**Files:**

- Modify: `apps/api-v1/test/crdt/persistence/crdt-persisted-contracts.test.ts`
- Modify: `apps/api-v1/test/crdt/persistence/crdt-app-inbox-atomicity.test.ts`
- Reference: `apps/api-v1/test/crdt/crdt-api-test-fixtures.ts`

- [x] Add a recording callable SQL wrapper around real PGlite. Record returned row counts for actual
      `crdt_updates` reads without matching query source text.
- [x] Seed several valid updates through the mutation service.
- [x] Assert a new append reads zero update rows and returns `existingUpdate/existingAppend = null`.
- [x] Assert an exact duplicate reads and decodes one update row and returns replay without writing a
      new update or incrementing document counters.
- [x] Assert a mismatched duplicate reads one row and remains rejected as
      `duplicate-hash-mismatch`.
- [x] Assert a non-append administration command still reads the complete ordered history and still
      rejects document-counter, sequence, stored-byte, and child-without-document corruption.
- [x] Run RED:

```sh
cd apps/api-v1 && deno test -A \
  test/crdt/persistence/crdt-persisted-contracts.test.ts \
  test/crdt/persistence/crdt-app-inbox-atomicity.test.ts
```

Expected: FAIL because append currently reads every update row.

### Task 5: Implement the operation-specific PostgreSQL read boundary

**Files:**

- Modify:
  `packages/shared-server/rallar-system/crdt/persistence/psql-crdt-mutation-repository.ts`
- Test: `apps/api-v1/test/crdt/persistence/crdt-persisted-contracts.test.ts`
- Test: `apps/api-v1/test/crdt/persistence/crdt-app-inbox-atomicity.test.ts`

- [x] Replace the unconditional history query with an explicit operation decision:
      `append -> readAppendUpdate(documentKey, updateId)` and
      `administration -> readCompleteUpdateHistory(documentKey)`.
- [x] Decode the append candidate through the existing row codec. Do not add a lighter unchecked
      row shape.
- [x] Make complete-versus-local scope explicit in read-set validation. Local append validation may
      authenticate only document metadata, snapshot aggregate facts, absence-of-parent, and the
      selected update's physical/logical identity. Complete history validation retains count,
      contiguous sequence, terminal sequence, stored bytes, and snapshot count checks.
- [x] Preserve the same double document guard around all parallel reads and authorization.
- [x] Preserve `CrdtMutationRead.records` as the complete-history field: it is empty for append and
      complete for administrative commands. Do not populate it with a misleading partial record.
- [x] Run GREEN:

```sh
cd apps/api-v1 && deno test -A \
  test/crdt/persistence/crdt-persisted-contracts.test.ts \
  test/crdt/persistence/crdt-app-inbox-atomicity.test.ts \
  test/crdt/persistence/crdt-mutation-retry.test.ts \
  test/crdt/persistence/crdt-public-read-integrity.test.ts
npx vitest run packages/tests/shared-server/crdt
npx tsc -p packages/shared-server/tsconfig.json --noEmit
cd apps/api-v1 && deno task check
```

### Task 6: Capture candidate evidence and compare before/after

**Files:**

- Generated only:
  `tmp/perf/crdt-append-history/candidate-<head>/`

- [x] Use the same host, managed PostgreSQL workflow, recipe rows, environment, and run identity
      shape as baseline. Use a fresh database.
- [x] Run:

```sh
RALLAR_CRDT_APPEND_HISTORY_ARTIFACT_DIR=\
../../tmp/perf/crdt-append-history/candidate-<head> \
  npm run test:api-v1:black-box:postgres:crdt-append-history
node scripts/perf/compare-api-v1-crdt-append-history-results.mjs \
  tmp/perf/crdt-append-history/baseline-e29dadd2148e-attempt-02/cluster \
  tmp/perf/crdt-append-history/candidate-<head>/cluster
```

- [x] Report p50/p95 and candidate/baseline ratios for `new` and `replay` at all three scales.
      Classify rather than hide noise. If large-history results are flat because another query
      dominates, capture that as the result and decide whether actor-window evidence warrants a
      new focused issue.
- [x] Review the existing general state-write workload before running it. It does not execute CRDT,
      and the available artifact does not bind this plan's base, so record it as not applicable
      rather than manufacturing a large unrelated comparison. The focused CRDT persistence, atomic
      AppInbox, retry, public integrity, and black-box runs are the proportional regression evidence.

### Task 7: Final validation and handoff

**Files:**

- Modify only if evidence requires truthful navigation:
  `packages/shared-server/rallar-system/crdt/README.md`

- [x] Run `npm run pr:delivery -- status` before broad final validation. Repair only a real source
      conflict; `BEHIND` alone creates no rebase/merge work.
- [ ] Run focused CRDT, API, shared-test, and comparator tests.
- [ ] Run:

```sh
npm run typecheck
npm run test:repo-governance
npm run test:repo-structure
npm run check:repo-style:changed -- e29dadd2148e3923c395ac18030e7d6bb85b58a1 HEAD
npm run check:repo-structure
node scripts/check-test-structure-coupling.mjs --changed \
  e29dadd2148e3923c395ac18030e7d6bb85b58a1 HEAD
npm run review:legacy -- e29dadd2148e3923c395ac18030e7d6bb85b58a1 HEAD
npx prettier --check <every changed non-Deno human-authored file>
cd apps/api-v1 && deno fmt --check <every changed Deno-owned file>
git diff --check e29dadd2148e3923c395ac18030e7d6bb85b58a1..HEAD
```

- [ ] Review every changed file in full, rerun affected checks after every correction, and provide a
      structured handoff with exact commands/results, artifact identities, measurements, issue
      disposition, and explicit skipped checks.
- [ ] Do not push, create a PR, mark ready, merge, or mutate issue #265 unless the user separately
      requests publication or issue updates.
