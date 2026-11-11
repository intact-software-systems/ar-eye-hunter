# Deno → Bun landing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every code
> task is test-first (superpowers:test-driven-development). Read
> `.agents/skills/rallar-code-writing/references/repo-code-style.md` before writing TypeScript.

**Goal:** Land PR #794 (Deno → Bun), PR #801 (API origin + three-replica scale-out) and PR #798
(pre-merge verification) on `main`, each validated, with the 50-agent distributed recipes passing
on the Bun build against the real Hetzner fleet.

**Architecture:** One independent platform fix goes to `main` first (the retained topology head
that blocks a long-lived room, #782). The three-branch stack rebases on it, the remaining Bun debt
on the stack is removed, and hosted validation is collected once at the tip of #801, which contains
#794. The PRs then go to the maintainer in order: #794, #801, #798.

**Tech Stack:** Bun 1.4.4, Vitest, Playwright, Postgres 16, GitHub Actions, Hetzner (three roles),
dprint.

**Spec:** PR #794, #801 and #798 bodies; `plans/active/deno-to-bun-validation.md` (on #798);
`plans/active/github-api-origin-and-hetzner-api-scale-out.md` (on #801); issues #782, #799, #795,
#682, #693.

## State on 2026-11-11

- All three branches are rebased onto `main` `bdbf7b00c` locally: #794 is 56 commits (the 55
  originals plus `chore(bun): port main's Slice 7/8 additions to Bun`), #798 is four on top, #801 is
  eight on top. Pre-rebase tips are tagged `backup/pre-rebase-794`, `-798`, `-801`.
- **Not pushed.** The force-push needs the maintainer's approval (Task 0).
- Verified at the #801 tip: `npm run typecheck`, api-v1 `bunx tsc`, the five api-v1 tests main added
  or changed (52 pass), `control-generated-alm-reload` (38 pass), test reachability, structure
  coupling, the two release-gate lane tests, `dprint check` on the changed files.
- `check:repo-style:changed` passes on #794 and fails on #801 with one finding (Task 5). It needs
  `NODE_OPTIONS=--max-old-space-size=8192` locally.

## What blocks the 50-agent run

Run `42587199083` (#801 at `4bb65dcb0`, manifest 07, room `hetzner-headless-room`): 50/50 agents
connected, 6/50 failed with `RallarRoomJoinPartialFailureError`. The API journal has 53
`Coalesced group-revision predecessor is not coalesced topology work`, cause
`AL envelope version is unsupported`.

Read from the code, not yet observed at runtime:

- The topology head row for a group has one key for the group's whole life
  (`${overlayId}:group-revision`). The envelope version went to 4 on 2026-10-28 (#727), and only
  version 4 is accepted. A head written before that in the persistent Hetzner database is refused.
- `toMergedCoalescedGroupRevisionEntry` decodes the predecessor before it looks at its status
  (`rtc-topology-coalesced-group-revision-work.ts:186`), so even a finished head throws.
- The throw fails the `GROUP_PRESENCE_SUMMARY` work, which retries 20 times and ends `FAILED`. The
  head is never rewritten, so every later presence summary for that room fails the same way.
- The publication path already treats a pre-v4 row as a non-blocking `unsupported` refusal
  (`decode-rtc-topology-publication.ts:32-43`). The head has no such rule.

Task 1 confirms or refutes this before Task 2 changes code.

## Rulings during execution (2026-11-11)

- **Task 2, the rule changed.** "No predecessor" cannot land: it maps to insert-if-absent, which
  never writes over the existing head row. The unsupported head is instead replaced through the
  existing compare-and-set, with the stale row as the expected entry, at its stored coalescing
  generation plus one. From the old payload only that generation is read; the row's audit columns
  and, for a pending head, its attempts and next-retry time are carried because the compare-and-set
  does not rewrite them. Test 1 below asserts that replacement, and test 3 expects stored + 2.
- **Task 2, known gap.** A queued successor stamped with an unsupported version still fails closed:
  no existing operation replaces a queued successor.
- **Task 2 runs beside Task 1**, not after it: the defect is real on `main` whatever the run shows.
- **Task 6, the name.** `computeRtcConnectCommandTimeoutMs` already exists and means readiness plus
  margin. The new function is `computeRtcEstablishAndReadyCommandTimeoutMs`; one private function
  writes the shared sum.
- **Task 4, first gate after the rebase.** Every red lane but two was a runner DNS outage in the
  Playwright install step. #794 is green on rerun. The remaining suspect is
  `observed-group-authority.test.ts`, a 5 s timeout in its database fixture on #801.

## Global Constraints

- No Deno: `git grep -iw deno` in tracked source returns only the prose that describes the
  migration; no `Deno.*`, `jsr:`, `@std/*`, `deno.json`.
- No legacy reader: nothing decodes an envelope version other than `AL_MESSAGE_ENVELOPE_VERSION`.
- No skipped test stays: a test is fixed, moved to real Postgres, or deleted with the code only it
  used.
- No duplicated budget literals: recipe timeouts come from
  `packages/shared-test/rallar-bb-test/fixtures/live-rtc-setup.ts`.
- Reusable behaviour goes in `packages/shared*`; nothing purpose-built for one recipe or one room.
- Expected failure is an `Either` value. `write(transaction, computed)` never opens a transaction.
- Never widen a timeout or weaken an assertion to pass a lane. Never weaken the medium-scale gate.
- dprint formats only touched files, by explicit path.
- Push each commit as it lands, by SHA: `git push origin "${H}:refs/heads/<branch>"`.
- Never run `npm run pr:delivery -- ready`, never enable auto-merge, never merge. Each PR is handed
  to the maintainer. Any commit to or push of `main` needs the maintainer's approval per `AGENTS.md`.
- Hosted runs: dispatch with `--ref=<branch>`, `register_before_login=true`,
  `ready_timeout_seconds=900`, and never while a release gate is running on the same fleet.

## Review Focus

1. A pre-v4 head whose row status is still in flight (not finished): the new work must not lose a
   pending replan. Test in Task 2.
2. A head that is corrupt for any reason other than the version: must still fail closed. Test in
   Task 2 (the existing `fails closed` test stays green).
3. The same room entered twice in a row after the repair: the second presence summary must merge
   onto a version-4 head, not repair again. Test in Task 2.
4. Three API replicas: a presence summary claimed by replica 2 for a room whose head replica 1 just
   repaired. Covered by the cluster black-box profile in Task 2 step 7; if no recipe exercises it,
   add one there.
5. A recipe budget read from two places that drift apart: the generated manifests must fail
   `--check` when a constant changes. Test in Task 6.

---

### Task 0: Publish the rebased branches

**Files:** none.

- [ ] **Step 1: Get the maintainer's approval for three force-pushes.** Quote the three old and new
      SHAs.
- [ ] **Step 2: Push by SHA with a lease on the old remote tip**

```bash
for b in claude/deno-to-bun-migration-plan claude/deno-to-bun-validation-plan claude/github-api-origin-hetzner-scale-out; do
  H=$(git rev-parse "$b"); OLD=$(git rev-parse "origin/$b")
  git push --force-with-lease="${b}:${OLD}" origin "${H}:refs/heads/${b}"
done
```

- [ ] **Step 3: Confirm** `gh pr view 794 --json mergeable` is `MERGEABLE`, and #798 and #801 still
      target `claude/deno-to-bun-migration-plan`.

### Task 1: Decide whether the retained head is the 50-agent failure

No code. One hosted run that differs from `42587199083` only in the room.

- [ ] **Step 1: Check no gate is running**: `gh run list --limit 10`.
- [ ] **Step 2: Dispatch manifest 07 into a fresh room**

```bash
gh workflow run github-free-distributed-recipe.yml --ref=claude/github-api-origin-hetzner-scale-out \
  -f execution_mode=hetzner-control -f target_agent_count=50 -f agents_per_job=3 -f max_parallel_jobs=17 \
  -f manifest_path=apps/rallar-black-box/manifests/hetzner/07-rtc-messages-principal-50-agent-30s-20hz-tree.json \
  -f room_id="bun-landing-$(date -u +%Y%m%d%H%M)" -f rollout_control_plane=preserve-public-settings \
  -f register_before_login=true -f ready_timeout_seconds=900
```

- [ ] **Step 3: Read the result.** From the operation artifact count
      `not coalesced topology work` in `api-journal.log` and the failed agents in the analysis.
  - Zero occurrences and 50/50 pass: the hypothesis holds. Continue with Task 2.
  - Zero occurrences and agents still fail: stop. Record the new failure signatures and re-plan
    Task 2 with superpowers:systematic-debugging; Tasks 3–6 continue.
  - Occurrences in a room created minutes ago: the head is not a pre-v4 leftover. Stop and re-plan
    as above.
- [ ] **Step 4: Record** the run URL, the two counts and the `control-journal.log` line count for
      `canonicalNodes bound` (#682) in the #801 PR body.

### Task 2: A head from an unsupported envelope version no longer blocks its room (#782)

Own branch off `main`, own PR to `main`. Runtime-agnostic; it runs on `main`'s Deno lanes as they
are.

**Files:**

- Modify: `packages/shared/queuebox/rtc-topology-work-entry-contract.ts:50-64`
- Modify: `packages/shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts:181-200, 347-360, 394-428`
- Test: `packages/tests/shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.test.ts`
- Test: `packages/tests/shared/queuebox/rtc-topology-work-entry-contract.test.ts` (create if absent)
- Test: `packages/tests/shared-server/rallar-system/group-state/presence/group-presence-summary-coalescing.test.ts`
- Recipe: `packages/shared-test/black-box-runner` cluster profile, only if step 7 finds no cover

**Interfaces:**

- Produces: `decodeRtcTopologyWorkEntry(entry: ResourceEntry): Either<ALMessageRejection, ALMessage>`
  in `rtc-topology-work-entry-contract.ts`. `readRtcTopologyWorkEntry` keeps its signature and
  becomes the throwing wrapper over it, so the decode exists once.
- Rule: a predecessor whose decode is Left with `code: 'unsupported'` is **no predecessor**. It
  carries no lifecycle, no generation and no pending metadata; the new head replaces it. Any other
  Left throws as today.

- [ ] **Step 1: Write the failing contract test**

```ts
it('answers an unsupported left for a head stamped with another envelope version', () => {
    const decoded = decodeRtcTopologyWorkEntry(toEntryWithEnvelopeVersion(validEntry, 3));
    expect(decoded.left).toEqual({
        code: 'unsupported',
        message: 'AL envelope version is unsupported'
    });
});
it('answers the message for a current head', () => {
    expect(decodeRtcTopologyWorkEntry(validEntry).right).toEqual(
        readRtcTopologyWorkEntry(validEntry)
    );
});
```

`toEntryWithEnvelopeVersion` is a test-local function that parses `entry.resource`, sets `id.v`,
and serializes it back.

- [ ] **Step 2: Run it**: `npx vitest run packages/tests/shared/queuebox/rtc-topology-work-entry-contract.test.ts`
      — FAIL, `decodeRtcTopologyWorkEntry` is not exported.
- [ ] **Step 3: Implement `decodeRtcTopologyWorkEntry`**; the queue-identity and scope checks stay
      throws (programmer invariants), the envelope decode is the Either.
- [ ] **Step 4: Write the failing head tests** beside `fails closed when the predecessor is not
  coalesced topology work` (line 481), reusing its `first` construction:

```ts
it('replaces a finished head stamped with an unsupported envelope version', () => {
    const stale = {
        ...toEntryWithEnvelopeVersion(first.entryWrite.entry, 3),
        status: EntityStatus.FINISHED
    };
    const next = computeCoalescedRtcTopologyGroupRevisionWork({
        ...secondInput,
        previousEntry: stale
    });
    expect(next).toEqual(
        computeCoalescedRtcTopologyGroupRevisionWork({ ...secondInput, previousEntry: null })
    );
});
it('replaces an in-flight head stamped with an unsupported envelope version and keeps the new replan', () => {
    const stale = toEntryWithEnvelopeVersion(first.entryWrite.entry, 3); // status as first wrote it
    const next = computeCoalescedRtcTopologyGroupRevisionWork({
        ...secondInput,
        previousEntry: stale
    });
    expect(readRtcTopologyWorkEntry(next.entryWrite.entry).id.v).toBe(AL_MESSAGE_ENVELOPE_VERSION);
    expect(next.entryWrite.entry.status).toBe(first.entryWrite.entry.status);
});
it('merges onto the repaired head on the next revision', () => {
    const repaired = computeCoalescedRtcTopologyGroupRevisionWork({
        ...secondInput,
        previousEntry: staleFinished
    });
    const third = computeCoalescedRtcTopologyGroupRevisionWork({
        ...thirdInput,
        previousEntry: repaired.entryWrite.entry
    });
    expect(third.entryWrite.entry[COALESCED_APP_OUTBOX_WORK_FIELD].generation).toBe(2);
});
```

Add the same unsupported case for `resolveQueuedRtcTopologySuccessor` (line 347): it answers what
it answers for no queued successor.

- [ ] **Step 5: Run them** — FAIL with `not coalesced topology work`.
- [ ] **Step 6: Implement the rule** in one private function that the merge path, the successor
      path and `readPendingCoalescedMetadata` all call, so the "unsupported is absent" decision is
      written once, at the top of `computeCoalescedRtcTopologyGroupRevisionWork` and
      `resolveQueuedRtcTopologySuccessor`. The conditional-write guard is unchanged: the replacement is
      the ordinary compare-and-set on the head row.
- [ ] **Step 7: Prove it at the worker and across replicas.** Add to
      `group-presence-summary-coalescing.test.ts`: a presence summary for a room whose stored head is
      version 3 commits on the first attempt and leaves a version-4 head. Then run
      `npm run test:api-v1:black-box:postgres` and `npm run test:api-v1:black-box:postgres:medium-scale`.
- [ ] **Step 8: Run the blast radius**

```bash
npx vitest run packages/tests/shared-server/rallar-system/topology packages/tests/shared-server/rallar-system/group-state/presence packages/tests/shared/queuebox
npm run test:integration:postgres
npm run typecheck && NODE_OPTIONS=--max-old-space-size=8192 npm run check:repo-style:changed -- origin/main HEAD
```

- [ ] **Step 9: Commit, push, open the PR** (`Fixes #782`), hand it to the maintainer.

### Task 3: Remove the skipped pglite receipts test (#799)

On #794. Runs in parallel with Task 2.

**Files:**

- Delete or move: `apps/api-v1/test/db/native-receiver-receipts.test.ts`,
  `packages/tests/shared-server/rallar-system/websocket/native-receiver-receipts-child.ts`
- Test: `packages/tests/shared-server/integration/postgres/ws-receipt-worker-handoff.test.ts`
- Modify: `tests/manual-suites.json`, `docs/test-structure-coupling-exceptions.md` if they name the
  deleted files

- [ ] **Step 1: List what the skipped test proves that the Postgres test does not.** It runs
      fourteen receivers over native API WebSockets and completes receipts after a held ACK release.
- [ ] **Step 2: Write that case as a failing Postgres integration test** in
      `ws-receipt-worker-handoff.test.ts`, on the existing fixture
      (`packages/tests/shared/services/ws-queue-box-server-receipt-fixture.ts`): fourteen receivers, the
      ACKs held, then released; assert one `complete` receipt naming all fourteen and no `timed-out`
      phase. Tag rows with the run id and delete them after.
- [ ] **Step 3: Run**: `npm run db:test:up && npm run test:integration:postgres` — the new case
      FAILS for the right reason first (write the assertion before the release step), then PASSES.
- [ ] **Step 4: Delete** the pglite test, its child process file, and any export only they used.
- [ ] **Step 5: Run** `npm run check:test-reachability`, `npm run check:test-structure-coupling`,
      `cd apps/api-v1 && bun test --timeout=240000 test/db`.
- [ ] **Step 6: Commit and push**; `Fixes #799` goes in the #794 body.

### Task 4: Triage the two red lanes on #794

Last gate on the old tip (`42658780187`): `Unit tests (1/2)` failed two tests,
`game rooms relic` failed one. Neither is known to be a Bun regression or a flake.

- [ ] **Step 1: Wait for the gate on the rebased tip** and read the failing test names, not the
      exit code.
- [ ] **Step 2: For each of these that is still red, reproduce locally ten times**

```bash
npx vitest run packages/tests/shared/p-sql-resource-inbox-reservation.test.ts -t 'returns Either left for expired'
npx vitest run packages/tests/shared-server/rallar-system/group-state/aggregate/observed-group-authority.test.ts
npx playwright test --config apps/relic-hunters-v1/playwright.config.ts -g 'switches accounts through Logout'
```

- [ ] **Step 3: Compare with `main`**: `gh run list --branch main --workflow "Deploy Web + API" --limit 10`
      and search those logs for the same test names.
- [ ] **Step 4: Act on the evidence.** Red on `main` too: open an Issue with both run links and
      rerun. Red only on the branch: superpowers:systematic-debugging, failing test first, fix on #794.
      A test that passes 10/10 locally and is green on rerun is recorded in the PR body as a rerun.
- [ ] **Step 5: `#795`**: run
      `cd apps/api-v1 && for i in $(seq 10); do bun test --timeout=240000 test/ 2>&1 | grep -E '^ *[0-9]+ (pass|fail)'; done`.
      Zero failures: say so on #795. Any failure: same rule as step 4.

### Task 5: Type the world-fleet manifest test against the shared contract

On #801. This is its failing `Static checks` lane.

**Files:**

- Modify: `packages/tests/rallar-black-box/world-fleet-distributed-manifests.test.ts:15-34`

- [ ] **Step 1: Reproduce**: `NODE_OPTIONS=--max-old-space-size=8192 npm run check:repo-style:changed -- origin/main HEAD`
      — FAIL, `boundary.unknown` at line 18.
- [ ] **Step 2: Delete the local `ManifestCommand` type.** Walk the recipe with
      `RallarBlackBoxTestCommand` and `RallarBlackBoxTestRecord` from
      `packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts`, narrowing by `kind` to
      reach nested commands; remove the `as readonly ManifestCommand[]` cast.
- [ ] **Step 3: Run** the style check (PASS), `npx vitest run packages/tests/rallar-black-box/world-fleet-distributed-manifests.test.ts`,
      `npm run typecheck`.
- [ ] **Step 4: Commit and push.**

### Task 6: One owner for the recipe connect budgets

On #801. The three budgets live in `live-rtc-setup.ts`; the same numbers are written again in five
places.

**Files:**

- Modify: `packages/shared-test/rallar-bb-test/fixtures/live-rtc-setup.ts`
- Modify: `packages/shared-test/rallar-bb-test/fixtures/rtc-multicast-recipes.ts:147`
- Modify: `apps/rallar-black-box/src/hetzner/hetzner-multicast-manifest-entries.ts:31`
- Modify: `apps/rallar-black-box/src/hetzner/create-alm-scale-manifest-entries.ts:43`
- Modify: `apps/rallar-black-box/src/world-fleet-distributed-manifests.ts:59`
- Test: `packages/tests/shared-test/rallar-bb-test-recipe-fixtures.test.ts:82`
- Regenerate: `apps/rallar-black-box/manifests/hetzner/**`, `apps/rallar-black-box/manifests/world-fleet/**`

**Interfaces:**

- Produces, in `live-rtc-setup.ts`:
  `RALLAR_BLACK_BOX_RTC_READINESS_TIMEOUT_MS = 45_000` and
  `computeRtcConnectCommandTimeoutMs(readinessTimeoutMs: number): number`, which returns
  establishment + readiness + margin (95 000 for the default).

- [ ] **Step 1: Write the failing test** in `rallar-bb-test-recipe-fixtures.test.ts`: replace the
      literal `95_000` with
      `computeRtcConnectCommandTimeoutMs(RALLAR_BLACK_BOX_RTC_READINESS_TIMEOUT_MS)` and add
      `expect(computeRtcConnectCommandTimeoutMs(45_000)).toBe(95_000)`.
- [ ] **Step 2: Run** `npx vitest run packages/tests/shared-test/rallar-bb-test-recipe-fixtures.test.ts`
      — FAIL, not exported.
- [ ] **Step 3: Implement** the constant and the function; replace the five literals with them.
      Whether `DEFAULT_ACK_TIMEOUT_MS` is the same budget or a different one that happens to be 45 s
      is decided by reading its use: the same budget imports the constant, a different one keeps its
      own name and gets a one-line comment saying what it bounds.
- [ ] **Step 4: Regenerate and check drift**: run both
      `apps/rallar-black-box/scripts/write-*-distributed-manifests.ts`, then each with `--check`. The
      regenerated JSON must be byte-identical to what is committed.
- [ ] **Step 5: Run** `npx vitest run packages/tests/shared-test packages/tests/rallar-black-box packages/tests/hetzner`,
      `npm run typecheck`, the style check.
- [ ] **Step 6: Commit and push.**

### Task 7: Hosted validation at the #801 tip

Starts when Task 2's PR is merged and the stack is rebased on it
(`git rebase --onto origin/main <old-main> <branch>`, never chained with a push), and Tasks 3–6 are
pushed with a green `Branch Release Gate` on #794 and #801. This task executes the runbook in
`plans/active/deno-to-bun-validation.md`; that file stays the single description of the commands.
Every dispatch uses `--ref=claude/github-api-origin-hetzner-scale-out`.

- [ ] **Step 1: Roles and deploy.** Runbook Phase 1 and Steps 2.1–2.3. Evidence: three roles
      `active`, public endpoints 200, `api.rallar.intactss.com` answering from three replicas, no
      `deno` binary on any VM.
- [ ] **Step 2: Scale gates.** `API v1 Medium-Scale Gate` and `API v1 Formation Gate` green on the
      tip. `API v1 State-Write PR Measurement` in `diagnostic` mode only: its `comparison` mode refuses
      a Deno base against a Bun candidate.
- [ ] **Step 3: The 50-agent recipes, one at a time, into `hetzner-headless-room`** (the long-lived
      room, so the Task 2 repair is exercised on the real retained head), with the Task 1 inputs and
      each manifest in turn:
      `07-rtc-messages-principal-50-agent-30s-20hz-tree.json`,
      `08-rtc-messages-principal-50-agent-30s-20hz-mesh.json`,
      `09-rtc-messages-all-peer-50-agent-30s-5hz-tree.json`,
      `21-alm-conformance-50-agent-30s.json`.
- [ ] **Step 4: Acceptance for each run**: 50/50 agents connected and passed, zero failure groups,
      zero `not coalesced topology work` in `api-journal.log`, `analysis/performance.md` present. A red
      run is diagnosed from its artifacts before any rerun; a rerun is a fresh dispatch.
- [ ] **Step 5: Record #682 honestly.** Count `canonicalNodes bound` in each `control-journal.log`.
      It does not fail a run today; if it appears, the PR body says the control artifact export is not
      certified at 50 agents and links #682. It is not fixed here.
- [ ] **Step 6: `all-local-postgres`** observation once, green.
- [ ] **Step 7: Write the evidence table** (run URL, result, the counts above) into the #794 and
      #801 PR bodies. Replace the #801 sentence about six failing agents.

### Task 8: Hand over in order

- [ ] **Step 1: #794.** Body lists `Fixes #799`, the Task 4 outcome and the Task 7 table. Hand to
      the maintainer. Stop until GitHub reports it merged.
- [ ] **Step 2: #801.** `gh pr edit 801 --base main`;
      `git rebase --onto origin/main <old-794-tip> claude/github-api-origin-hetzner-scale-out`; delete
      `plans/active/github-api-origin-and-hetzner-api-scale-out.md` and this file in the PR; gate green;
      hand over.
- [ ] **Step 3: #798.** Its only file is the runbook Task 7 executed. Delete
      `plans/active/deno-to-bun-validation.md` on the branch. The PR is then empty: close it with a
      comment linking the evidence in #794 and #801. (Maintainer's call, see below.)
- [ ] **Step 4: After #794 merges**, `Run Hetzner Supported Distributed Manifests` fires on the
      push to `main`. Read its result; a red is a new Issue, not a revert, unless the maintainer says
      otherwise.

## Decisions for the maintainer

1. **#782 as its own PR to `main` first** (recommended: it is a mutation-path fix that `main` needs
   whatever the runtime), or as the first commit of #801.
2. **#798**: close once its runbook is executed and its evidence is in #794 and #801
   (recommended, `plans/README.md` deletes a finished plan), or merge the runbook as a document.
3. **The unsupported head is replaced, not read.** The alternative is wiping the Hetzner API
   database ("fresh start" in #794). That clears today's rooms but leaves the defect for the next
   envelope bump.
