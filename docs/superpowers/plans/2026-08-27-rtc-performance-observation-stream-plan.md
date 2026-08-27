# RTC Performance Observation Stream Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task by task.

**Goal:** Publish `RTC-B05` browser lifecycle measurements from the `main` commit selected at each scheduled or manual run as an append-only stream of timestamped, integrity-checked ZIP archives merged into `main` by observation-only pull requests.

**Architecture:** Extend the existing `packages/shared-rtc-bench` baseline identity, controller, browser producer, finalization, and evidence readers with one observation orchestration boundary. Extend the existing validation-evidence selector and pull-request delivery owner so archive-only PRs receive a narrow integrity gate and native auto-merge without running product validation or deployment. `main` is observed, never pinned: every run records the exact checked-out SHA and accepts subsequent branch movement.

**Tech Stack:** TypeScript and Deno, the existing RTC baseline package, `fflate` for deterministic ZIPs, Node repository scripts, Vitest, GitHub Actions, GitHub CLI.

**Approved design:** [2026-08-27-rtc-performance-observation-stream-design.md](../specs/2026-08-27-rtc-performance-observation-stream-design.md)

---

## Task 1: Make stream observation identity part of the existing baseline contract

**Files:**

- Create: `packages/shared-rtc-bench/baseline/contracts/rtc-baseline-id.ts`
- Modify: `packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-grammar.ts`
- Modify: `packages/shared-rtc-bench/baseline/contracts/rtc-baseline-validation.ts`
- Modify: `packages/shared-rtc-bench/baseline/contracts/rtc-baseline-artifact-validation.ts`
- Modify: `packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak-validation.ts`
- Modify: `packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs`
- Create: `packages/shared-rtc-bench/tests/baseline/contracts/rtc-baseline-id.test.ts`
- Modify: `packages/shared-rtc-bench/tests/baseline/command/rtc-performance-baseline-cli-grammar.test.ts`
- Modify: `packages/shared-rtc-bench/tests/baseline/contracts/rtc-performance-baseline-validation.test.ts`
- Modify: `packages/shared-rtc-bench/tests/baseline/contracts/rtc-performance-baseline-artifact-validation.test.ts`
- Modify: `packages/shared-rtc-bench/tests/workloads/browser-lifecycle/rtc-data-channel-browser-soak-validation.test.ts`
- Modify: `packages/shared-rtc-bench/tests/workloads/browser-lifecycle/rtc-data-channel-browser-soak.test.ts`

### Step 1: Write failing identity-contract tests

Cover these exact cases:

```ts
const streamId = '20260827T031500Z-eaf526518c70-e2-browser-gh123456789-a2';

expect(readRtcBaselineId(streamId)).toEqual({
    kind: 'stream',
    environmentId: 'E2-browser',
    sourceSha12: 'eaf526518c70',
    startedAt: '2026-08-27T03:15:00.000Z',
    githubRunId: 123456789,
    githubRunAttempt: 2,
    repeatOrdinal: undefined
});
expect(readRtcBaselineId(`${streamId}-repeat-01`).repeatOrdinal).toBe(1);
expect(readRtcBaselineId('20260827-eaf526518c70-e2-browser').kind).toBe('legacy');
expect(() => readRtcBaselineId(`${streamId}-repeat-02`)).toThrow();
```

Add consumer tests proving all currently duplicated validators accept both legacy IDs and the new `E2-browser` stream form, while the browser producer continues to reject non-browser environments and malformed run identities.

### Step 2: Run the focused tests and confirm red

Run:

```bash
npx vitest run \
  packages/shared-rtc-bench/tests/baseline/contracts/rtc-baseline-id.test.ts \
  packages/shared-rtc-bench/tests/baseline/command/rtc-performance-baseline-cli-grammar.test.ts \
  packages/shared-rtc-bench/tests/workloads/browser-lifecycle/rtc-data-channel-browser-soak-validation.test.ts \
  packages/shared-rtc-bench/tests/workloads/browser-lifecycle/rtc-data-channel-browser-soak.test.ts
```

Expected: FAIL because the canonical reader and stream grammar do not exist.

### Step 3: Add one canonical identity owner

Implement a named reader and predicates in `rtc-baseline-id.ts`; do not export aliases that rename the parsed type.

```ts
export namespace RtcBaselineId {
    export interface Parsed {
        kind: 'legacy' | 'stream';
        environmentId: RtcBaselineEnvironmentId;
        sourceSha12: string;
        repeatOrdinal: 1 | undefined;
        startedAt?: string;
        githubRunId?: number;
        githubRunAttempt?: number;
    }
}

export function readRtcBaselineId(value: string): RtcBaselineId.Parsed;
export function isRtcBaselineId(value: string): boolean;
export function isRtcBrowserBaselineId(value: string): boolean;
export function toRtcBaselineRepeatId(primaryId: string): string;
```

Preserve every currently accepted legacy ID. Accept the stream form only with a real canonical UTC timestamp, a positive safe run ID and attempt, a supported environment, and at most `-repeat-01`. Replace duplicate regexes in touched TypeScript consumers with this owner. Keep the `.mjs` producer thin by importing a TypeScript-free generated/projection module only if Deno can load it directly; otherwise pass identity validation through the existing TypeScript command boundary rather than maintaining another regex.

### Step 4: Run focused identity and browser tests

Run the Step 2 command plus:

```bash
npx vitest run \
  packages/shared-rtc-bench/tests/baseline/contracts/rtc-performance-baseline-validation.test.ts \
  packages/shared-rtc-bench/tests/baseline/contracts/rtc-performance-baseline-artifact-validation.test.ts
```

Expected: PASS.

### Step 5: Commit Task 1

```bash
git add packages/shared-rtc-bench/baseline packages/shared-rtc-bench/workloads/browser-lifecycle packages/shared-rtc-bench/tests
git commit -m "feat(rtc-bench): support stream observation identities"
```

## Task 2: Add package-owned `RTC-B05` observation capture and deterministic archive commands

**Files:**

- Create: `packages/shared-rtc-bench/baseline/observation/rtc-performance-observation.ts`
- Create: `packages/shared-rtc-bench/baseline/observation/rtc-performance-observation-archive.ts`
- Create: `packages/shared-rtc-bench/baseline/observation/rtc-b05-observation-runner.ts`
- Create: `packages/shared-rtc-bench/baseline/observation/rtc-b05-deno-observation.ts`
- Modify: `packages/shared-rtc-bench/baseline/evidence/rtc-baseline-finalized-artifact-reader.ts`
- Modify: `packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts`
- Modify: `packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-grammar.ts`
- Modify: `packages/shared-rtc-bench/package.json`
- Modify: `package-lock.json`
- Create: `packages/shared-rtc-bench/tests/baseline/observation/rtc-performance-observation-archive.test.ts`
- Create: `packages/shared-rtc-bench/tests/baseline/observation/rtc-b05-observation-runner.test.ts`
- Modify: `packages/shared-rtc-bench/tests/baseline/command/rtc-performance-baseline-cli.test.ts`
- Modify: `packages/shared-rtc-bench/tests/baseline/command/rtc-baseline-cli-process-output.test.ts`

### Step 1: Write failing archive-contract tests

Define one canonical JSONL row owned by the RTC package:

```ts
export interface RtcPerformanceObservation {
    schemaVersion: 1;
    observationId: string;
    startedAt: string;
    completedAt: string;
    source: { commit: string; tree: string; ref: string };
    workflow: { runId: number; runAttempt: number; url: string };
    primary: { outcome: 'passed' | 'failed' | 'incomplete'; acceptedMetrics: boolean };
    repeat: { decision: 'not-required' | 'required'; outcome: 'not-run' | 'passed' | 'failed' | 'incomplete' };
    archive: { path: string; byteLength: number; sha256: string };
}
```

Tests must prove:

- archive path is exactly `performance-observations/rtc-b05/YYYY/MM/DD/<observation-id>.zip`;
- ZIP entries have canonical forward-slash paths and fixed ordering/timestamps;
- `checksums.sha256` covers every content entry and not itself;
- the embedded observation row matches the external index row except for self-referential archive length/hash fields, which are finalized outside the ZIP;
- primary and optional repeat evidence are parsed by the existing finalized-artifact reader;
- a structurally complete failed outcome is accepted as a failed observation with `acceptedMetrics: false`;
- malformed, unaccounted, checksum-invalid, or incomplete evidence is rejected rather than mislabeled passed;
- re-verifying identical bytes returns the same SHA-256 and canonical row.

### Step 2: Run archive tests and confirm red

```bash
npx vitest run packages/shared-rtc-bench/tests/baseline/observation/rtc-performance-observation-archive.test.ts
```

Expected: FAIL because the observation archive owner does not exist.

### Step 3: Separate structural reading from passing acceptance

Expose the smallest useful structural result from `rtc-baseline-finalized-artifact-reader.ts`. Reuse it in both the existing strict finalized verifier and the new archive verifier. Do not weaken `validate` or any passing-baseline behavior: existing comparison/acceptance commands must still reject non-passing evidence.

Add `fflate@0.8.2` as a direct private tooling dependency of `packages/shared-rtc-bench`, using the already locked version. Implement deterministic `zipSync`/`unzipSync` archive assembly and verification in the package, not in workflow shell.

### Step 4: Write failing runner tests around existing controller ports

Use injected ports so tests do not launch Chromium. Prove the orchestration order:

```text
initialize E2-browser
list-external-attempts
capture each manifest-owned primary attempt in its own process
record-browser each canonical raw path
finalize
strict validate when primary passed
repeat-required
conditionally run the repeat manifest
archive
```

Also prove that tooling preflight failure produces no archive, while failure after initialization is finalized and archived when accounting is structurally complete.

### Step 5: Implement the runner by composing existing owners

The runner must invoke `RtcBaselineEnvelope` and the existing browser soak producer. It may own process launch and stop/continue policy, but it must not recreate manifests, raw-path construction, result validation, finalization, or repeat-selection logic.

Add CLI operations:

```text
observe-browser --source-ref=main --github-run-id=<id> --github-run-attempt=<n> --github-run-url=<url> --output=<dir>
verify-observation --archive=<zip> --index-entry=<json>
```

`observe-browser` derives the timestamped ID from the captured start time and current checked-out commit; it records `main` as the observed ref but never fetches or compares a newer `main`. It writes exactly one ZIP and one JSONL row to the output directory.

### Step 6: Run package observation and CLI tests

```bash
npx vitest run \
  packages/shared-rtc-bench/tests/baseline/observation \
  packages/shared-rtc-bench/tests/baseline/command/rtc-performance-baseline-cli.test.ts \
  packages/shared-rtc-bench/tests/baseline/command/rtc-baseline-cli-process-output.test.ts
```

Expected: PASS.

### Step 7: Commit Task 2

```bash
git add packages/shared-rtc-bench package-lock.json
git commit -m "feat(rtc-bench): archive browser observations"
```

## Task 3: Extend the existing validation gate for observation-only pull requests

**Files:**

- Create: `scripts/validation-evidence/rtc-observation-change.mjs`
- Modify: `scripts/validation-evidence/validation-evidence-selection.mjs`
- Modify: `scripts/validation-evidence/branch-release-result.mjs`
- Modify: `scripts/validation-evidence.mjs`
- Modify: `.github/workflows/branch-release-gate.yml`
- Create: `packages/tests/repo/validation-evidence/rtc-observation-change.test.ts`
- Modify: `packages/tests/repo/validation-evidence/validation-evidence-reuse.test.ts`
- Modify: `packages/tests/repo/validation-evidence/branch-release-result.test.ts`
- Modify: `packages/tests/repo/validation-evidence/validation-evidence-cli.test.ts`
- Modify: `packages/tests/repo/validation-evidence/validation-evidence-workflow.test.ts`

### Step 1: Write failing archive-only classification tests

Evolve selection from the binary `reuse` decision to one mode:

```ts
type ValidationMode = 'broad' | 'reuse' | 'rtc-observation';
```

The `rtc-observation` classifier must fail closed unless the base-to-head diff contains exactly:

- one newly added `.zip` below the canonical date partition;
- one append-only modification to `performance-observations/rtc-b05/index.jsonl` containing exactly one canonical line whose archive path names that ZIP; and
- no rename, deletion, replacement, workflow, script, source, or other file change.

Test binary-safe `git diff --name-status -z`, a first index creation, normal append, missing newline, changed historical row, two archives, archive replacement, path traversal, uppercase/non-canonical path, and unrelated file changes.

### Step 2: Run focused validation-evidence tests and confirm red

```bash
npx vitest run packages/tests/repo/validation-evidence
```

Expected: FAIL because the third mode and integrity job do not exist.

### Step 3: Implement classification inside the current selector

`select` must compute observation-only status before reusable broad evidence. Emit:

```text
mode=rtc-observation
reuse=false
reason=rtc-observation-only
```

Keep `reuse` during migration for existing consumers, but make `mode` authoritative in the workflow. The integrity verifier must call the package-owned `verify-observation` command; repository scripts own diff shape only, not RTC archive semantics.

### Step 4: Add the narrow workflow job and stable conclusion

Update `branch-release-gate.yml` so:

- `rtc-observation-integrity` runs only for `mode == 'rtc-observation'`;
- reusable or broad product validation is skipped in that mode;
- `release-gate` and validation-evidence publication retain their existing behavior for `broad` and `reuse`;
- `Branch Release Gate result` succeeds only when governance, selection, and RTC integrity succeeded and broad jobs were skipped;
- cancelled and malformed upstream state still fails closed.

### Step 5: Run focused gate tests

```bash
npx vitest run packages/tests/repo/validation-evidence
```

Expected: PASS.

### Step 6: Commit Task 3

```bash
git add scripts/validation-evidence scripts/validation-evidence.mjs .github/workflows/branch-release-gate.yml packages/tests/repo/validation-evidence
git commit -m "feat(ci): verify rtc observation-only changes"
```

## Task 4: Schedule capture from `main` and publish through the existing PR delivery owner

**Files:**

- Create: `.github/workflows/rtc-performance-observation.yml`
- Create: `scripts/pull-request-delivery/rtc-observation-pull-request.mjs`
- Modify: `scripts/pull-request-delivery.mjs`
- Modify: `scripts/pull-request-delivery/ready-pull-request.mjs`
- Modify: `scripts/pull-request-delivery/README.md`
- Modify: `.github/workflows/deploy.yml`
- Modify: `.github/workflows/hetzner-supported-distributed-manifests.yml`
- Create: `packages/tests/repo/pull-request-delivery/rtc-observation-pull-request.test.ts`
- Modify: `packages/tests/repo/pull-request-delivery/pull-request-command.test.ts`
- Modify: `packages/tests/repo/pull-request-delivery/pull-request-workflow.test.ts`
- Modify: `packages/tests/repo/validation-evidence/build-affecting-tree.test.ts`
- Modify: `packages/tests/repo/governance-decisions/governance-decision-workflow.test.ts`

### Step 1: Write failing publication tests

Add an explicit `publish-observation` operation under `scripts/pull-request-delivery.mjs`. With injected GitHub and Git ports, prove it:

1. verifies the incoming ZIP and row before any mutation;
2. reads current remote `main` immediately before publication;
3. creates a unique short-lived branch for this observation (not a storage branch);
4. adds exactly the new ZIP and one index row without altering old rows;
5. commits and pushes only that branch;
6. creates or reuses the one matching PR targeting `main`;
7. arms native squash auto-merge;
8. reports the PR URL and leaves the branch for GitHub to merge/delete; and
9. uploads the ZIP as a workflow artifact instead when publication cannot proceed.

The operation must reject an existing archive path, unexpected dirty files, a non-`main` base, an index race, or an already-used run identity.

### Step 2: Write failing workflow-shape tests

Parse the workflow and assert:

- triggers are one nightly UTC cron plus `workflow_dispatch`;
- concurrency serializes `RTC-B05` captures with `cancel-in-progress: false`;
- measurement job has `contents: read` only;
- checkout is the `main` snapshot supplied to the run and no later freshness comparison exists;
- observation command receives `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_SERVER_URL/GITHUB_REPOSITORY/actions/runs/GITHUB_RUN_ID`, and source ref `main`;
- publication uses the existing PR-delivery command;
- auto-merge is armed rather than an immediate/admin merge;
- capture output is always uploaded as a retained workflow artifact;
- repository publication runs only after archive verification;
- `deploy.yml` and the supported-distributed workflow ignore `performance-observations/**` on push while retaining manual dispatch;
- the release gate still runs for all non-observation PR changes.

### Step 3: Run tests and confirm red

```bash
npx vitest run \
  packages/tests/repo/pull-request-delivery \
  packages/tests/repo/validation-evidence \
  packages/tests/repo/governance-decisions/governance-decision-workflow.test.ts
```

Expected: FAIL because the publisher and workflow do not exist.

### Step 4: Implement ordinary bot publication with explicit authentication

Use the repository's existing GitHub CLI command style and `armPullRequestAutoMerge`; do not reuse governance decision mutation or bypass semantics. The workflow token must be an automation credential whose PR events run Actions. Configure it as `RTC_OBSERVATION_PR_TOKEN` with only repository Contents and Pull Requests access; fail closed and retain the workflow artifact when it is absent or insufficient. Do not use the restricted governance App, whose documented scope is Contents-only authenticated governance decisions.

The only long-lived repository state is the ZIP plus index row on `main`. The per-run branch name is disposable, for example:

```text
automation/rtc-b05-observation-gh<run-id>-a<attempt>
```

### Step 5: Implement the scheduled workflow

The measurement job checks out `main` once and calls:

```bash
npm run perf:rtc-baseline -- observe-browser \
  --source-ref=main \
  --github-run-id="$GITHUB_RUN_ID" \
  --github-run-attempt="$GITHUB_RUN_ATTEMPT" \
  --github-run-url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
  --output="$RUNNER_TEMP/rtc-observation"
```

Always upload the result with `actions/upload-artifact@v7`. The publication job downloads it, verifies it, and invokes `npm run pr:delivery -- publish-observation ...`. Its pull request body records the observed source SHA, run URL, archive outcome, and that `main` movement is accepted.

### Step 6: Run publication and workflow tests

Run the Step 3 command. Expected: PASS.

### Step 7: Commit Task 4

```bash
git add .github/workflows scripts/pull-request-delivery scripts/pull-request-delivery.mjs packages/tests/repo
git commit -m "feat(ci): publish nightly rtc observations"
```

## Task 5: Reconcile the historical RTC plan and operator documentation

**Files:**

- Modify: `docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md`
- Modify: `packages/shared-rtc-bench/README.md`
- Modify: `scripts/perf/README.md`
- Modify: `docs/superpowers/specs/2026-08-27-rtc-performance-observation-stream-design.md` only if implementation evidence exposes an approved-design correction

### Step 1: Replace stale Task 9 execution semantics

Keep the historical record but clearly supersede the frozen-main waiting procedure. Record that:

- Task 9 is delivered by the observation stream;
- `main` is the current source ref and is allowed to move;
- each observation is independently identified by timestamp, source SHA, run ID, and attempt;
- one warmup plus five retained samples is primary, with one plus ten only when the existing repeat rule selects it;
- capture failures are archived but do not count as accepted metrics;
- no single observation completes performance measurement forever;
- RTC-B06 remains a separate human activation decision after enough observations exist.

Remove or mark obsolete the direct `deno run` sequence, exact-main deploy wait, stale uppercase raw paths, and frozen Task 7 anchor from the active Task 9 instructions.

### Step 2: Document operator commands and archive reading

Document manual dispatch, local `observe-browser`, `verify-observation`, archive layout, index schema, outcomes, required automation credential, and the fact that archive-only main pushes do not trigger product build/deploy workflows.

### Step 3: Validate documentation examples

Run every safe help/verification command shown in the updated docs against a fixture archive. Expected: commands parse and paths match generated outputs.

### Step 4: Commit Task 5

```bash
git add docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md packages/shared-rtc-bench/README.md scripts/perf/README.md
git commit -m "docs(rtc-bench): adopt continuous observation stream"
```

## Task 6: Validate one real local browser observation

### Step 1: Run focused package correctness checks

```bash
npm run check --workspace=packages/shared-rtc-bench
```

Expected: all package type checks, Deno checks, and Vitest tests pass.

### Step 2: Run repository workflow and publication tests

```bash
npx vitest run \
  packages/tests/repo/validation-evidence \
  packages/tests/repo/pull-request-delivery \
  packages/tests/repo/governance-decisions/governance-decision-workflow.test.ts \
  packages/tests/repo/distributed-validation-risk/distributed-validation-risk-workflow.test.ts
```

Expected: PASS.

### Step 3: Capture one local browser observation

Use non-GitHub local provenance values that satisfy the same contract and isolate output under `tmp/perf/`:

```bash
npm run perf:rtc-baseline -- observe-browser \
  --source-ref=main \
  --github-run-id=1 \
  --github-run-attempt=1 \
  --github-run-url=https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/1 \
  --output=tmp/perf/rtc-observation-local
```

Expected: one canonical ZIP and row are produced. A failed workload result is acceptable evidence only if the command finalizes, archives, verifies, and labels it failed with no accepted metrics.

### Step 4: Verify the exact generated archive

```bash
RTC_OBSERVATION_ARCHIVE="$(find tmp/perf/rtc-observation-local -maxdepth 1 -type f -name '*.zip' -print -quit)"
npm run perf:rtc-baseline -- verify-observation \
  --archive="$RTC_OBSERVATION_ARCHIVE" \
  --index-entry=tmp/perf/rtc-observation-local/index-entry.json
```

Expected: PASS with archive digest and observation ID.

### Step 5: Run touched-file standards closure and broad proportional checks

```bash
npm run check:repo-style
npm run pr:delivery -- status
npm run test:unit
```

Use the repo testing skill to adjust the broad command to the actual root runner. Review every changed human-authored file in full, remediate touched-file noncompliance recursively, and report independent untouched findings separately.

### Step 6: Commit validation-driven fixes

```bash
git add <only files intentionally changed by validation fixes>
git commit -m "fix(rtc-bench): close observation stream validation"
```

Skip this commit when validation requires no fixes.

## Task 7: Review and publish the feature pull request

### Step 1: Self-review the complete diff

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
```

Confirm the implementation reuses current RTC, validation, and PR delivery owners; there is no parallel capture/gate/publication subsystem; archives are not accidentally committed from local validation; and no credential value is present.

### Step 2: Run delivery status before final validation

```bash
npm run pr:delivery -- status
```

Repair only real conflicts or failed checks. `BEHIND` alone is not a reason to merge/rebase moving `main` while GitHub reports the PR mergeable.

### Step 3: Push the feature branch and create a draft PR

```bash
git push -u origin codex/rtc-performance-observation-stream
gh pr create --draft --base main --head codex/rtc-performance-observation-stream \
  --title "feat(rtc-bench): stream browser performance observations" \
  --body-file tmp/rtc-performance-observation-stream-pr-body.md
```

The PR body must include behavior, reuse boundaries, the `main` uncertainty model, archive-only CI behavior, credential rollout requirement, exact validation results, and the local observation outcome.

### Step 4: Request code review and respond to evidence

Use `superpowers:requesting-code-review`. Fix correctness, security, archive-integrity, or ownership findings with tests first. Re-run the smallest affected checks, then the final focused suite.

### Step 5: Hand off once

```bash
npm run pr:delivery -- ready
```

Report the PR URL and current GitHub action. Do not merge/rebase merely because `main` advanced. After the feature PR merges, manually dispatch `RTC Performance Observation` on `main` once to validate the live scheduled path; that is post-merge operational evidence, not a reason to pin `main`.
