# PR Handoff Release Gate Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` with the repository's
> `adaptive-plan-execution`, `rallar-testing`, and `publishing-plan-progress` skills.
> Implement and publish on the same non-default branch as this plan.

**Goal:** Run inexpensive checks while a PR is draft, then require broad verification
on the final candidate at handoff and keep the agent working until its checks finish.

**Architecture:** Keep the existing Branch Release Gate coordinator, reusable suites,
and stable required result. Draft state controls admission to expensive jobs. Existing
validation-evidence rules remain authoritative for ready PRs; drafts cannot select,
publish, or reuse release evidence.

**Tech stack:** GitHub Actions YAML, Node.js delivery scripts, Vitest workflow tests,
and repository agent guidance.

**Spec:** The accepted design below records the conversation's handoff contract.

## Accepted design and alternatives

The agent opens a draft PR, iterates with focused local tests, completes its review,
and marks the PR ready for review. That transition starts broad required validation.
The agent monitors the final candidate, investigates failures, and reports verified
completion only after the required gate succeeds. Human review and merge authority
remain unchanged. For a batch of fixes, return to draft before pushing and mark ready
again after the fixes are complete.

We considered full validation on every push, dependency-selected suites on every
push, and broad validation at handoff. Handoff validation was selected: it removes
repeated broad runs without introducing a new test-impact engine or reducing the
existing pre-merge suite. Separate domain workflows and installation optimizations
are independent future work, not prerequisites for this change.

## Global constraints

- Keep the required check name `Branch Release Gate result` and read-only workflow permissions.
- Draft pushes run the existing governance gate and `npm run typecheck`; focused
  behavioural tests remain the implementing agent's responsibility.
- Drafts must not run browser installation, broad suites, observations, or evidence selection/publication.
- The final result must execute even when dependencies skip or fail. A draft result
  fails with an explicit awaiting-handoff explanation; skipping it would let GitHub
  treat missing verification as a passing required check.
- Handle `converted_to_draft` to cancel superseded broad runs. Keep current ready,
  opened, synchronize, reopened, and label events. Ready-PR pushes still validate
  their new revision; batch revisions in draft to avoid repeated broad runs.
- Preserve current suite commands, game-change selection, trusted evidence reuse,
  RTC observation integrity, and deployment validation.
- Only explicit `SUCCESS` satisfies the agent's required check interpretation;
  missing/incomplete checks wait, and skipped/neutral checks require investigation.
- No new branch-protection settings, credentials, PR comments, automatic draft
  mutation, or merge-authority changes.
- Review and remediate every changed human-authored file in full. Support files
  changed by remediation enter closure recursively. Independent untouched code is outside closure.

## Review focus

1. Draft events cannot launch expensive work or publish a successful release result.
2. Converting to draft cancels prior work; ready again validates the candidate.
3. Failed/cancelled dependencies cannot become a green aggregate through skipped jobs.
4. A ready PR's new commit cannot use another revision's check as approval.
5. Agents do not stop at `ready`, repeatedly invoke it while waiting, or change merge policy.

## Slice 1: Gate broad validation on PR readiness

**Files:** `.github/workflows/branch-release-gate.yml`, new
`packages/tests/repo/validation-evidence/branch-handoff-workflow.test.ts`, and the
existing event contract in `packages/tests/repo/pull-request-delivery/pull-request-workflow.test.ts`.

**Interfaces:** GitHub's `pull_request.draft` boolean and `converted_to_draft` event;
existing job outputs and conclusion CLI remain unchanged.

- [ ] Add tests that evaluate actual job/step conditions with draft, ready,
  failed-governance and cancelled inputs. Execute the draft refusal shell step in
  a temporary directory and assert nonzero exit plus a useful summary. Assert ready
  candidates reach the existing conclusion command and every broad root is excluded
  during draft. Update the trigger contract for `converted_to_draft`.
- [ ] Run `npx vitest run packages/tests/repo/validation-evidence/branch-handoff-workflow.test.ts`;
  expect failures proving draft isolation is absent before implementation.
- [ ] Add a draft-only typecheck job using cached npm downloads and `npm ci`.
  Gate evidence selection and game detection on explicit ready state. Keep downstream
  broad paths closed when selection does not run. Add an always-evaluated final
  draft refusal step and run the existing conclusion only for ready PRs.
- [ ] Run `npx vitest run packages/tests/repo/validation-evidence packages/tests/repo/pull-request-delivery packages/tests/repo/governance-gate`;
  expect all tests to pass. Run `npm run typecheck:tests` to validate maintained test types.
- [ ] Commit and push the coherent change to this PR; inspect live draft job admission.

## Slice 2: Require agents to wait for verified handoff

**Files:** `AGENTS.md`, `.agents/skills/publishing-plan-progress/SKILL.md`,
`.agents/skills/adaptive-plan-execution/SKILL.md`, `scripts/pull-request-delivery/README.md`,
`scripts/pull-request-delivery/read-pull-request.mjs`, and focused tests under
`packages/tests/repo/pull-request-delivery/`.

**Interfaces:** Preserve `status` and `ready` commands and their existing delivery actions.
The workflow result remains the authoritative required check on the PR revision.

- [ ] Add a behavioural test using `readPullRequest` through its existing command
  port: SUCCESS passes; SKIPPED/NEUTRAL/unknown completed outcomes fail closed;
  absent/in-progress results wait; newer results supersede older ones. Watch it fail.
- [ ] Tighten the result classification to accept only explicit success.
- [ ] Document draft iteration, focused local validation, one readiness transition,
  waiting for the new handoff run, failure classification, draft-before-fixes,
  and reporting only after the current candidate passes. A prior draft refusal may
  briefly remain visible while GitHub schedules the ready-triggered run; wait for
  that run before treating the old refusal as a test failure.
- [ ] Run focused delivery tests, `npm run test:repo-governance`,
  `npm run check:repo-style`, and `npm run check:repo-structure`. Review all touched-file findings.
  A fresh agent pressure evaluation must demonstrate the wait and repair behaviour;
  source-integrity checks alone do not establish agent compliance.
- [ ] Obtain a fresh whole-branch review; fix actionable findings and run affected checks.

## Publication and acceptance

Publish this plan as the first commit in a draft PR, then implement both slices on
the same branch. Before broad final validation, run `npm run pr:delivery -- status`
and repair a real conflict if reported. Keep the PR description current with the
behaviour, validation, risks, and follow-up. When implementation is complete,
remove this active plan from the final tree (its first commit remains the archive),
push, and run `npm run pr:delivery -- ready` once. Observe the ready-triggered run,
wait for its required result, investigate failures, and report the actual outcome.
Do not merge merely to prove the gate.

Acceptance requires live draft jobs to omit broad work, live handoff to schedule
the unchanged required suites, and no skipped/draft result to be treated as verified.
Network or unrelated baseline failures remain explicit limitations, never passing evidence.

## Risk and rollback

Integration regressions may be found later, at handoff. Focused local tests provide
development feedback. Draft release checks intentionally appear failed/awaiting
handoff; document this so it is not mistaken for a regression. Reverting this PR
restores broad checks on every PR update without changing test coverage or branch rules.
