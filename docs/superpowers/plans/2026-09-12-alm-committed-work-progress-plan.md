# ALM Committed-Work Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` to implement this plan task-by-task,
> with independent specification and code-quality review. Also use the current
> repository adaptive-plan, code, realtime, performance, and testing skills.

**Goal:** Make committed inbound work progress without scan starvation, then
retain a successor-discovery optimization only if browser evidence justifies it.

**Architecture:** Admission announces committed work to its existing QueueBox
worker without rewinding the selector. The ordinary worker remains the sole
reservation/retry owner. Optional original-claims-first continuation reuses that
owner and has no capacity beyond the existing page limit.

**Tech Stack:** Existing TypeScript, QueueBox, IndexedDB, Vitest, Playwright
Chromium, and repository diagnostic/performance tooling; no new dependencies.

**Spec:** [Committed-work progress design](../specs/2026-09-12-alm-committed-work-progress-design.md).

## Global Constraints

- Use existing QueueBox, readiness, CAS, leases, retries, and release handling.
- Add no queue, retry mechanism, fence, lock, timer, dependency, persisted format,
  migration, or legacy path.
- Remove affected obsolete code; remediate whole touched files and recursively
  affected support files under current repo guidance, not historical line caps.
- Do not change protocol/public exports or weaken deadlines, workloads, or gates.
- Keep implementation and proof in PR #566. Do not merge test-only experiments.
- Main may move. Record each measurement's source and environment; repair actual
  conflicts, but do not rebase a mergeable branch for `BEHIND` alone.
- Keep generated profiles under `tmp/perf/`; do not commit them. Continue the
  normal observation stream only after the correction passes its proof gates.

---

## Current state and ownership map

PR #567 has merged, and its replay notifications, grouped read sessions, and
diagnostics are incorporated in this branch. Notification without scan rewind
is implemented; its focused tests and independent review are green. The selector
has one explicit state owner, `ALInboundWorkSelector`, rather than two stateful
factories. Native timing and the complete RTC proof remain required; a green
lifecycle test group is not an RTC-B06 observation.

The local synthetic latency diagnostic remains uncommitted and intentionally RED.
Keep it as diagnostic evidence, not a shipping regression with private batch
expectations. Behavior-named tests own the scan-progress and notification
contracts independently of its imposed costs.

Wider integration validation exposed RTC/WS fixture-completion and caller-owned
engine-startup defects. The correction waits for actual delivery or durable
settlement, preserves expiry boundaries, and mutation-checks forbidden control
delivery, readiness bypass, and post-disposal delivery. Independent review and
the scoped re-review are complete. Local native ALM conformance now
passes all three carriers, and the ordinary three-browser RTC matrix passes;
all-scenarios and 100-cycle retention still need to run. These are correctness
results, not native storage timing or B06 observation evidence.

The maintainer explicitly approved raising only the browser facade ceiling to
**strict `<208 KiB`**. The measured payload remains **207.16796875 KiB**;
the five bundle tests and measurement command pass under Node 24. This changes
the approved budget, not runtime performance. Other entry budgets and bundle
settings remain unchanged.

Hosted validation still exposes unresolved integration evidence: server WS
router/admission tests fail, the headless bundle measures **260.556640625 KiB
against strict `<260 KiB`**, and ALM conformance fails all three carriers despite
the local pass. The facade approval does not authorize a headless budget change.
Classify and repair the affected checks before claiming integration closure;
do not assume they are all storage regressions or all obsolete tests.

The failed RTC observation includes a 12-claim batch lasting 32,120 ms, with
18,795 ms running claims and 11,558 ms releasing them. These are batch intervals,
not native IndexedDB request timings. The connection commands still time out at
30,000 ms. This evidence makes phase attribution necessary: successor discovery
cannot remove time spent executing and releasing original claims. The next two
concrete pieces of work are the remaining integration closure and native
measurement below; no deadline relaxation or unconditional continuation follows.

| Owner                                                                                                                                           | Planned responsibility                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/alm/inbound/al-inbound-message-admission.ts`                                                                                   | Preserve successful data-replay committed-work information; no new retry owner.                                       |
| `packages/shared/alm/inbound/control/al-inbound-control-admission.ts`                                                                           | Symmetric control-replay committed-work information.                                                                  |
| `packages/shared/alm/inbound/al-inbound-message-runtime.ts`                                                                                     | Notify before callbacks; remove per-commit scan rewind.                                                               |
| `packages/shared/alm/inbound/al-inbound-work-selector.ts`                                                                                       | Own the natural scan, shared cached page, and claimed readiness observations; no restart API.                         |
| `packages/shared/alm/inbound/al-inbound-admission-store.ts`, `al-inbound-durable-effect-store.ts`                                               | Only if continuation is selected: return actual committed effect observations.                                        |
| `packages/shared/alm/work/al-work-handler.ts`                                                                                                   | Only if continuation is selected: original-first bounded execution using existing claim/release.                      |
| `tests/playwright/rallar-black-box/browser-indexeddb-transaction-writes.spec.ts` and adjacent `browser-indexeddb-transaction-writes-fixture.ts` | Native IndexedDB correctness and storage measurement fixture.                                                         |
| `packages/shared-test/rallar-bb-test/conformance/alm/**`                                                                                        | Reusable ALM observation contracts/analysis if existing bounded diagnostics cannot express the required measurements. |

This is a navigation map, not a mandate to edit every file. Avoid new production
files unless a real ownership boundary requires one. Read nearby tests/examples
before selecting shapes. No outbound adapter is planned solely for continuation.
PR #567's read-session and diagnostic changes are already present. Preserve
fresh authority checks, not stale observations across awaits, and add only
measurement boundaries that the existing diagnostics cannot express.

## Slice 1: Restore committed-work progress and prove the smaller lifecycle

**Interfaces:** Consume `ALWorkHandler.committed(): void` and the current
selector/port. Carry mandatory `wroteWork: boolean` with replay outcome/acceptance
for both admission owners; use one canonical result per owner rather than
retaining old union forms through adapters. PR #567 supplies the result shape;
reuse it. Successful control commit notification
must precede `onControlMessage`. Remove `restartScan()` if the verified runtime
and test usages remain its only consumers.

**Tests:**

- `packages/tests/shared/alm/al-inbound-pending-admission.test.ts`
- `packages/tests/shared/alm/inbound/al-inbound-control-admission.test.ts`
- `packages/tests/shared/alm/inbound/al-inbound-work-selector.test.ts`
- `packages/tests/shared/alm/inbound/al-inbound-committed-work-progress.test.ts`
- `packages/tests/shared/alm/al-inbound-effect-worker-lifecycle.test.ts`
- `packages/tests/shared/alm/work/al-work-handler.test.ts`
- `packages/tests/shared/webrtc/ws-rtc-control-handoff-latency.test.ts`

- [x] Inspect PR delivery status and the relevant PR #567/main diff; preserve the
      local RED and unrelated files. Assign one implementation agent this ownership
      slice; independent reviewers do not edit the same files concurrently.
- [x] Write semantic RED cases using existing fixtures: deferred data/control
      commits wake ordinary progress without a test-authored wake; a throwing control
      callback cannot hide already-committed work; a failed admission transaction
      publishes no successful admission notice. Separately, a successful
      `retainPending`/control-pending write must still wake its durable retry row
      after an admission conflict. Verify each RED fails for its intended missing
      lifecycle behavior before implementation.
- [x] Add a finite-backlog progress RED: waiting rows on the first NEW page,
      ready admission work that generates successors, an eligible later NEW row,
      ready RETRY, and expired RESERVED work. Require those eligible identities to
      progress **while a bounded producer is still committing**, within a fixture
      budget derived from a finite workload rather than the current restart trace.
      Then stop/drain for recovery coverage. Waiting rows consume no premature retry
      attempts. Verify the old implementation fails; progress only after stopping
      arrivals would not distinguish it. Do not assert exact page/status call sequences.
- [x] Add the stale-probe case: let an empty/cached page finish, commit new work,
      and prove natural worker progress reaches it without an external wake. Cover
      a commit during an in-flight selection so scan advancement is not discarded.
- [x] Implement the owner correction. The intended runtime control flow is:

  ```text
  replay through existing admission owner
  if replay reports committed work:
      work.committed()             # no selector rewind
  if control acceptance exists and runtime is not disposed:
      await existing control callback
  return existing QueueBox outcome
  ```

  The existing runtime method becomes:

  ```ts
  private commitWork(): void {
      this.work.committed();
  }
  ```

  Fresh admissions use the same notification semantics. The selector keeps its
  current cached-page consumption and natural rotation; do not introduce a
  reset flag, successor queue, alternate retry, or local timer.

- [x] Extract delivery, retry ownership, recovery, and notification contracts
      into behavior-named regression tests. Keep the synthetic cost model
      explicitly labeled and uncommitted while its deadline remains RED. If it
      becomes useful shipping coverage, first replace its private batch/status
      expectations with independent identity/order/expiry/deadline assertions.
      Do not relax its deadline to claim success.
- [x] Run focused checks, review every touched file in full, remove affected
      unused contracts/helpers/tests, and obtain fresh specification and quality
      reviews. Commit only coherent green lifecycle coverage, not the pending
      synthetic experiment or generated artifacts.
- [x] Close the wider RTC/WS integration failures. Check the owned completion
      boundary in `rtc-endpoint-fixture.ts` and the WS socket fixture before
      changing assertions. Prove snapshot-floor rejection, negative-control
      identity, actual delivery, ordering, and latest-value suppression through
      the existing worker. Remove obsolete completion helpers rather than keep
      two test paths. Investigate the browser-facade overage within the affected
      production surface; report any genuinely necessary budget decision instead
      of weakening the gate. Review this coherent follow-on fix independently.
- [x] Apply the explicit facade-budget approval: strict `<208 KiB` in the
      measurement script and matching bundle test. Preserve other budgets,
      entrypoints, compression/build settings, and runtime behavior. The five
      bundle tests, measurement command, and shared-web typecheck pass. Full-file
      review also closes unchecked manifest/metafile JSON boundaries in the test;
      valid/invalid envelope checks and maintained test typechecking pass.
- [ ] Diagnose the hosted server WS router/admission failures and headless
      bundle overage. Reproduce focused failures and classify production
      regressions versus obsolete test assumptions before changing behavior.
      Keep the headless ceiling unchanged without its own explicit approval;
      investigate justified reductions in the affected surface first. Preserve
      the failed hosted ALM evidence for Slice 2's causal measurement.

Run the focused tests above together with:

```sh
npx vitest run packages/tests/shared/alm/al-inbound-pending-admission.test.ts packages/tests/shared/alm/inbound/al-inbound-control-admission.test.ts packages/tests/shared/alm/inbound/al-inbound-work-selector.test.ts packages/tests/shared/alm/work/al-work-handler.test.ts packages/tests/shared/alm/inbound/al-inbound-committed-work-progress.test.ts packages/tests/shared/alm/al-inbound-effect-worker-lifecycle.test.ts
npx vitest run packages/tests/shared/webrtc/ws-rtc-control-handoff-latency.test.ts -t 'hands RTC admission past a full control page'
npx tsc -p packages/shared/tsconfig.json --noEmit
node scripts/check-tests-typecheck.mjs
npx vitest run packages/tests/shared/rtc-snapshot-floor-admission.test.ts packages/tests/shared/ws-qos-policy.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
```

Run the new case separately as a diagnostic and retain its actual outcome;
its expected RED is not a passing acceptance check:

```sh
npx vitest run packages/tests/shared/webrtc/ws-rtc-control-handoff-latency.test.ts -t 'completes retained RTC candidate and answer callbacks'
```

**Exit:** Green lifecycle/finite-backlog recovery tests, original handoff behavior
green, affected RTC/WS integration and bundle checks green, no per-commit rewind,
and reviewed committed-work ownership. The synthetic
deadline result is explicitly reported, not used alone to select continuation.

## Slice 2: Measure residual delay and evaluate bounded continuation

**Interfaces:** Use existing observation events and native-browser fixture first.
No persisted/protocol shape changes. If continuation is selected, the commit
result exposes actual committed `ResourceEntry` observations after successful
`backend.write`; the inbound selector treats them as candidates and the existing
port returns independent CAS claims. The handler owns capacity and release.

**Additional tests:**

- `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`
- `packages/tests/shared/alm/al-indexeddb-queue-admission.test.ts`
- `packages/tests/shared/alm/work/al-work-queue-port.test.ts`
- Native transaction-write fixture/spec in the ownership map.

- [ ] Read `scripts/perf/README.md` and the applicable existing harness. Add only
      missing bounded timing at the spec's request, transaction, operation, and
      queue-phase boundaries. Measure with `performance.now()`; request success is
      not transaction completion. Validate counts/outcomes against fixture results
      and redact payloads; instrumentation is the same on both comparison sides.
- [ ] Capture baseline and Slice 1 candidate locally before another broad hosted
      run. Cover sparse traffic, 16 claimable admissions each producing work, fanout
      exceeding remaining capacity, finite multi-page backlog/recovery, and live
      game traffic with durable backlog/reconnect. Use same-context tabs for shared
      IndexedDB contention. Preserve sample distributions and environment/source
      identity under `tmp/perf/`; repeat A/B in balanced order if variance dominates.
- [ ] Attribute late delivery to pre-admission wait, admission/storage, successor
      rediscovery, callback, or release. Compare related read-session work from
      PR #567 before duplicating it. If the simpler implementation meets unchanged
      acceptance, stop here: omit continuation and proceed to final proof.
- [ ] Select continuation only when measured successor rediscovery remains a
      material contributor to an unmet acceptance condition and spare-capacity
      opportunities exist. If full batches/storage/callbacks dominate, document that
      residual bottleneck and replan the next bounded slice; do not add unused
      continuation machinery or claim this design solves saturation.
- [ ] For a selected continuation, first add semantic REDs for the cases below,
      then implement exactly the spec's bounded algorithm:

  ```text
  candidates = bounded actual committed observations from admission attempts
  finish original runOne pass in existing order, including ordinary releases
  preserve detached retained settlement; retained claims still consume budget
  remaining = max(0, pageSize - originalSelectedCount)
  for each distinct candidate in commit/effect order, at most remaining:
      recheck current eligibility and disposal
      claim once through existing port with exact observed entry
      execute/release only the claim actually returned
  leave all other effects durable for ordinary rotation
  ```

  Candidate storage/readiness attempts are bounded too. Failed eligibility/CAS
  consumes its consideration slot; there is no refill, recursion, increased page
  allowance, or immediate retry. Actual duplicate rows are not reconstructed.

- [ ] Cover spare capacity and full capacity; excess fanout; terminal/duplicate,
      concurrently reserved/completed, expired, and not-ready successors; absent
      consumers/predecessors; commit rollback/conflict; throwing callback/release;
      lost parent ownership; disposal during awaits; and two independent same-
      database workers. Assert original work is not delayed by child insertion,
      ordinary recovery progresses, and callback identity/order remains correct.
- [ ] Re-run the same native comparison. Retain continuation only with reduced
      measured rediscovery/eligible successor age and no correctness regression or
      material degradation in unrelated-work age, retries, lease recovery, or live
      message-age tails. Report inconclusive/no benefit honestly and remove the
      candidate if it does not earn its added code.
- [ ] Close touched-file standards and perform independent specification and
      quality reviews before publishing the coherent result to the same PR.

Focused native check (not a substitute for the mixed workload comparison):

```sh
npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/browser-indexeddb-transaction-writes.spec.ts --workers=1
```

**Exit:** Reproducible native timing/causal evidence with a justified retained or
omitted continuation. No invented per-operation latency and no performance
claim based only on the synthetic diagnostic.

## Later outcomes, not additional speculative implementation slices

- Prove actual data-channel readiness, existing ALM conformance, ordinary RTC
  matrix, reconnect/100-cycle retention, and all required lifecycle scenarios
  under unchanged acceptance. Use the isolated local runners already in PR #566
  for rapid iteration, retain first failures, and avoid repeated broad builds of
  an unchanged candidate. `npm run test:rallar:full-stack:memory:alm` is the
  existing memory conformance entry point; select the existing live-RTC matrix/
  lifecycle scripts for the retained browser proof. Do not reduce workload or
  increase timeout thresholds to manufacture green results.
- Run affected shared/shared-web tests and both game builds for realtime
  changes; include browser bundle/public snapshots only if their surfaces
  change. Run `npm run check:repo-style`, affected structure/coupling/legacy
  checks, formatting, whitespace, and canonical test typechecks. The current
  repo standard, not a historical plan, defines touched-file closure.
- Run `npm run pr:delivery -- status` before broad final validation. Repair real
  conflicts first; review the final branch independently. Require Branch Release
  Gate and the workload-selected proof; run `npm run pr:delivery -- ready` once
  only when the whole PR is ready. No default-branch commit/push is authorized
  by this plan, and no test-only merge is needed to obtain evidence.
- After merge, stop ordinary PR delivery work. A separately requested RTC-B06
  observation uses then-current main; archive only validated primary/repeat
  evidence, then follow the existing E4/ranking/human-completion rules. B07 stays
  held. This plan does not redefine the Phase 1 exit.

No separate follow-up issue is needed; unresolved work remains in PR #566.
