---
name: publishing-plan-progress
description: Use when publishing a written plan or long-running implementation through a branch, draft pull request, milestone updates, compatibility reviews, or final remote evidence.
---

# Publishing Plan Progress

Make long-running work observable through one semantic pull request without turning publication
into a second implementation lifecycle.

**REQUIRED SUB-SKILL:** Use `adaptive-plan-execution` for working-plan decisions.

**REQUIRED SUB-SKILL:** Use `rallar-testing` to select validation commands.

## Publication workflow

1. Inspect Git state and preserve unrelated work.
2. Work on a non-default `codex/<topic>` branch unless the user provides another branch.
3. Publish the first coherent commit and open one draft pull request early for multi-slice work.
4. Keep the PR body current using only Goal, Changes, Acceptance, Validation, Risk and rollback, and
   Follow-up. Link a durable design document when useful; do not add identifiers, computed path
   lists, progress records, or machine metadata fences.
5. Publish coherent reviewed slices without empty commits or shared governance-file updates. Continue
   safe implementation without waiting for review.

The GitHub pull request is the remote delivery entity. Its current diff, checks, reviews,
conversations, mergeability, and merged state are authoritative.

## Conflict-first finalization

Run `npm run pr:delivery -- status` before broad final validation. If it reports
`REPAIR_CONFLICT`, repair the conflicting source first and restart from status. Do not spend time on
governance or broad validation before resolving the real conflict.

When GitHub reports `BEHIND` but still reports the PR mergeable, continue the current state. Do not
update the branch, merge `main`, or rebase merely to follow base movement. Re-review compatibility
only when the actual changed base introduces material product, contract, ownership, or acceptance
evidence.

## Readiness and merge paths

After affected validation and review are complete, run `npm run pr:delivery -- ready` once. It may
mark the draft ready and arm native auto-merge; it never performs an immediate administrator merge.

- With an available reviewer, leave native auto-merge armed and let GitHub merge after checks and
  review.
- Without an independent reviewer, report `AWAIT_REVIEW_OR_ADMIN_MERGE`. An authorized
  administrator may intentionally merge through GitHub.
- `DONE` permits no post-merge governance work. Do not archive a plan, write a receipt, refresh
  evidence, or create a closure commit.

## Follow-up issue handoff

Search for or create an issue only after evidence identifies material independent work or a human
decision outside the active outcome. An issue never makes dependent work complete. Link useful
follow-up issues in the PR; otherwise use `Follow-up: None`.

## Default branch commit and push permission

Never create, rewrite, or place a commit on `main`, `master`, or the local default branch without
just-in-time permission. Before every default-branch commit, keep changes uncommitted and state the
exact branch, operation, staged file list, staged diff summary, staged Git tree ID from
`git write-tree`, proposed message, and affected full commit IDs. Ask for permission immediately
before that exact operation; changed content, message, input, target, or conflict resolution
invalidates approval.

Never push `main`, `master`, or the remote default branch without separate just-in-time permission.
State the exact remote, destination ref and refspec, resolved full old and new commit IDs, and
whether the push is forced. Recheck immediately after approval and push only that range. Commit and
push approvals are independent. These gates do not apply to a non-default destination ref.

## Validation evidence

Report the exact commands that passed, failed, or were skipped and the current GitHub check state.
Require **Branch Release Gate** for affected PRs. Require **Run Hetzner Supported Distributed
Manifests** only when classified distributed risk or acceptance selects it. Do not copy workflow
run identities or content digests into the branch or PR body as governance inputs.

## Publication failure

If branch push or PR publication fails, preserve the work and report the exact authorization or
native action needed. Never claim unpublished work is published.
