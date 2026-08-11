---
name: publishing-plan-progress
description: Use when executing a written implementation plan or clearly long-running implementation expected to require multiple substantial work intervals.
---

# Publishing Plan Progress

Make long-running plan execution observable on GitHub while continuing the work.
Human review observes checkpoints; it does not pause execution by default.

## Workflow

1. Inspect Git state before implementation and preserve unrelated user work.
2. Use the installed GitHub publication workflow for branch, push, and draft
   pull request operations.
3. If execution starts in a detached worktree, use the Codex app **Create branch here** action before publication.
4. Obey an explicit current-task branch override. Otherwise, create
   `codex/<topic>` and push it with upstream tracking before implementation.
   **Explicit user instructions may narrow or disable publication**, including
   work directly on the default branch. A default-branch override changes where
   uncommitted edits are made; it authorizes neither a default-branch commit nor
   a default-branch push.
5. On a non-default branch, after the first meaningful commit, open or update
   one draft pull request for the whole plan-to-implementation lifecycle. A
   committed plan or design is meaningful progress and is the initial review
   checkpoint, not a separate plan-only pull request. The written
   stacked-versus-single decision under **Draft Pull Request Record** is the
   only exception. When it selects a stack, the existing lifecycle PR is the
   first stack layer; create follow-on PRs only for the documented review
   slices, link their parent and shared plan, and maintain the required record
   on every active layer.
6. After each completed plan milestone or cohesive vertical slice, run focused
   verification and, subject to **Default Branch Commit and Push Permission**
   below, commit only in-scope files, push, and update the draft pull request
   with progress and exact validation status.
7. Before yielding after a substantial work interval, and subject to the same
   default-branch gate, publish coherent progress that is safe to share. Never
   create empty commits or include secrets, generated junk, or unrelated changes
   just to meet the cadence.
8. Continue implementation without waiting for human review. Pending approval
   for a default-branch commit or push pauses only that Git operation, not safe
   uncommitted local plan work. Report publication, push, pull request,
   validation, and skipped-check failures honestly; stop only for a real
   blocker, conflicting direction, or an explicit request to wait.

## Plan Authoring And Production Legacy Closure

Every production-affecting implementation plan must include a `Legacy baseline
and exit criteria` section before implementation tasks. Reject or amend a plan
that lacks it or lacks its final `Complete Code and Legacy Review` task.

Production code is the primary design artifact; tests are secondary evidence.
When an independently valid production design improves, rewrite, replace, or
discard coupled tests rather than preserving an inferior production structure.
Tests may prove approved compatibility behavior, but they never authorize an
implicit legacy path or make a plan complete.

The baseline inventories known affected-surface legacy by path, symbol, call
path, and purpose; names the canonical production owner and behavior; and states
whether each item will be removed, minimized, migrated, or proposed for
retention. It records real compatibility and rollback requirements that prevent
immediate removal. Newly discovered in-scope legacy is added to the active plan
rather than deferred through an issue. Unclassified legacy at completion is
prohibited.

Each implementation task includes a `Legacy impact` field: it creates, uses,
removes, minimizes, or does not affect production legacy. The affected surface
includes legacy created, retained, depended on, expanded, materially touched, or
placed on a changed production call path by the plan. Unrelated untouched legacy
is outside this completion gate.

Every production-affecting plan ends with `Complete Code and Legacy Review`.
Freeze and record the base and head SHAs; dispatch an independent read-only
reviewer; trace changed production paths from entry owner to result; and review
the baseline, candidates, diff, and call paths for unnamed legacy. Give each
item one disposition: `removed`, `minimized-boundary`, `resolved`, or
`retained-pending-human-approval`.

Resolve all Critical and Important findings, repeating the reviews after every
production change. A proposed retained item must be presented to a human with
its exact path and symbol, purpose and consumer dependency, unsafe-removal
reason, minimization, canonical owner, compatibility tests, named owner,
review/removal condition, and exact head SHA. Only explicit human approval of
that exact ledger and SHA permits retention. An issue, silence, earlier plan
approval, agent judgment, or automation is not approval. Record approval in the
durable exception registry and PR review record; a corrective production change
invalidates the reviews and approval.

## Follow-Up Issues

When a discovery is mature enough to describe safely, search this repository's
native GitHub Issues before deferring it. A material discovery affects
correctness, security, compatibility, reliability, operator/customer value, or
the task's promised validation. It is mature once the required issue headings
can contain known facts and clearly named unknowns. File it promptly after that
classification, not only at handoff. Use the narrowest correct outcome:

## Active-Plan Boundary

Before calling any discovery outside the task, trace it against the active plan
or, when there is no written plan, the task's declared outcome. Name the owning
task, declared behavior, owner, acceptance criterion, and promised validation
that could be affected. Work is in scope when it is required to deliver or
prove any of those things, regardless of how many modules it touches, how hard
it appears, how near a deadline is, or how slowly a normal test runs.

For every dimension concluded not affected, record the concrete contract,
call path, test, or other evidence that supports that conclusion. Package or
directory separation, a passing nearby test, or an unsupported assertion of
independence is not enough.

A missing planned behavior, known regression, failed required validation, or
unmet acceptance criterion stays in the active plan. Fix it and pass its exact
validation before marking its owning milestone, slice, or plan complete. An
issue can record a human-approved re-scope and the resulting incomplete
dependency; opening it never authorizes a re-scope, substitutes for the fix, or
makes dependent work complete.

A re-scope is approved only by explicit current user direction that names the
removed or changed behavior/criterion, affected milestone, and resulting
incomplete obligation. Update the active plan and PR in the same checkpoint.
An issue, a pending review, deadline pressure, or assumed user preference is
not re-scope approval.

An independent discovery stays outside the active plan even if its fix seems
small or nearby. Track it in a focused issue without expanding the plan unless
the user explicitly changes scope.

| Discovery | Required action |
| --- | --- |
| Active-plan behavior, owner, acceptance criterion, promised validation, or a regression in changed behavior | Keep it in the active plan. Fix and validate it before marking the owning work complete; do not create an issue as a substitute. |
| Existing matching issue | Reuse and link it. Add evidence only when it is precise, material, and safe to publish. |
| Verified material work proven independent of the active plan, uncertain priority, or a separately scoped concern | Create a native GitHub Issue promptly, then link it from the active PR and final handoff. |
| Product, ownership, compatibility, or permission decision | Create or reuse an issue, ask the user for direction, and continue only work independent of that decision. Do not claim the dependent work is complete. |

Treat an issue as matching only when its observed behavior, required outcome,
and scope are the same. A broad parent or loosely related issue is not a match:
link it as context and create a narrow issue if the discovery otherwise needs
one.

An issue must let a human or a later agent start without rediscovering the
context. Include these headings, omitting none unless the issue itself explains
why a heading is inapplicable:

```markdown
## Problem
## Why deferred
## Active-plan boundary
## Evidence
## Decision needed or desired outcome
## Acceptance criteria or first safe step
## Guardrails
## Related plan, PR, and issues
```

Use concise reproduction facts, affected behavior, and safe command or workflow
references as evidence. Do not include credentials, tokens, authorization
headers, environment-file contents, private personal data, or other secrets. If
issue search or creation is unavailable or the user prohibits it, preserve the
complete issue draft and exact reason in the handoff; do not pretend it was
filed. Link the issue from the active PR when one exists, or add it when the PR
is created. End every handoff with URLs of created or reused follow-up issues,
`Follow-up issues: none` when no material follow-up exists, or
`Follow-up issue not filed: <reason>` when a required issue could not be filed.

### Deferral Red Flags

The following are not evidence that active-plan work is independent:

| Rationalization | Required action |
| --- | --- |
| “The fix spans more modules than expected.” | Keep it in the plan; update the plan only for a real material impact, then implement and validate it. |
| “We are out of time” or “the normal test is slow.” | Record the work as incomplete or use the resource-contention procedure only when its observed condition exists; never issue-and-complete. |
| “A review finding or regression can be fixed later.” | Fix and validate it when it affects declared behavior or acceptance; link a follow-up only after an approved re-scope. |
| “The issue makes this separately scoped.” | An issue records an already-proven independent boundary or approved re-scope; it does not create either one. |

If the active-plan boundary is genuinely disputed, create or reuse the decision
issue, ask the user, and mark the dependent work incomplete while independent
work continues.

## Local Resource Contention

Observed CPU or memory contention from concurrent worktrees is a valid reason
to avoid heavyweight local checks at an intermediate checkpoint; it is not a
reason to stall safe branch work or weaken a completion claim. Record the
observable contention symptom, such as constrained available memory, a stalled
job, or sustained competing load; do not assert contention without evidence.

1. Run the focused validation that is practical without worsening contention.
2. Commit and push the cohesive non-default-branch checkpoint, preserving
   unrelated work. Update the existing draft PR rather than opening a separate
   plan-only PR.
3. Record the exact head SHA, completed behavior, passed commands, and every
   skipped heavyweight command with `skipped due to local CPU/memory contention`.
4. Monitor **Branch Release Gate** for that exact head SHA when the checkpoint's
   paths schedule it. Record its run, attempt, conclusion, and verified SHA;
   record `not triggered` when its path rules exclude the checkpoint, and
   `pending or unavailable` with the reason when no exact-SHA run starts.
   Continue unrelated safe work while it runs, but do not call pending or
   skipped evidence green.
5. Run every final local and remote completion gate required by this skill once
   the final tree is ready. Local contention never waives those gates.

Do not terminate other users' work, discard their artifacts, or suppress a
memory-pressure failure. If pressure risks data loss, stop only the affected
operation and report the condition honestly.

## Plan Revalidation

Record the default-branch base used by the active plan. Refresh and compare the
default branch before each published milestone and before completion. When a
newly observed default-branch SHA appears, perform one compatibility review for
that SHA and write one of these outcomes in the active PR:

- `Compatible — no plan delta`: the base change does not alter a touched
  contract, owner, dependency, validation path, or acceptance criterion; keep
  executing the existing plan. Name the compared base range and the touched
  contracts, owners, dependencies, validation paths, or acceptance criteria
  checked.
- `Material impact — plan delta`: name the changed assumption and the smallest
  affected task, interface, validation, or compatibility update. Preserve
  completed work and amend only that active plan in the same PR.

A default branch moving, review still being pending, or a desire for a cleaner
design is not a re-planning trigger. Fully replace the plan only when a product
decision changes, a public or ownership contract becomes incompatible, an
integration or merge conflict changes the required behavior, or new evidence
invalidates an acceptance criterion. Do not repeat a review for the same base
SHA without new material evidence. A discovered but independent follow-up
belongs in a reused or new issue rather than restarting the current plan.

## Default Branch Commit and Push Permission

Never create, rewrite, or place a commit on `main`, `master`, or the local
default branch without just-in-time permission. Working directly on the default
branch is not permission to commit. A standing instruction to publish progress,
deadline pressure, or approval given before the exact commit was presented is
not approval for the commit.

Treat any commit, amend, merge, revert, cherry-pick, rebase, or squash operation
that creates, rewrites, or moves a default-branch commit as a default-branch
commit. Before every default-branch commit:

1. Keep changes uncommitted and identify the exact local branch, staged file
   list, staged diff summary and staged Git tree ID from `git write-tree`,
   proposed commit message, and operation type. For a history-changing or
   multi-commit operation, list the current tip, every input and target as full
   commit IDs, and all proposed commit messages.
2. Ask permission for that exact commit immediately before performing it.
3. Wait for explicit approval. Do not commit while the user is unavailable or treat silence as approval.
4. Recheck the staged Git tree ID and full commit IDs, then perform only the
   described operation over the disclosed commit set. If content, message, input
   commit, conflict resolution, or target changes, the approval is invalid and a
   new exact request is required. Any later default-branch commit requires a new
   request and approval.

Approval to commit is not approval to push, and approval to push is not approval to commit.

Never push `main`, `master`, or the remote default branch without just-in-time
permission. A completed or approved default-branch commit is not permission to
push it. A standing instruction to publish progress, available authentication,
deadline pressure, or approval given before the exact push was presented is not
approval for the push.

Before every default-branch push:

1. Keep commits local and identify the exact remote, destination ref and
   refspec, resolved full commit IDs for the current remote tip and proposed new
   tip, and whether the push is forced. Use resolved full commit IDs, not moving symbolic ranges.
2. Ask permission for that exact push immediately before performing it.
3. Wait for explicit approval. Do not push while the user is unavailable or
   treat silence as approval.
4. Recheck both tips, then push only the described range and refspec. If either
   tip or the commit range changes, the approval is invalid and a new request is
   required. Approval covers a normal fast-forward push unless a force push was
   separately disclosed and approved. Any later default-branch push requires a
   new request and approval.

This gate does not apply when the destination ref is a non-default published
branch. It does apply when any source branch is pushed to the remote default ref.

## Draft Pull Request Record

Keep the one draft pull request current with the written-plan link, requested
review, milestone checklist, current behavior and incomplete areas, exact
passed, failed, and skipped validation results, created or reused follow-up
issues, current default-branch base, and the latest plan-revalidation outcome.
When contention defers a local command, retain its exact reason and the exact
head SHA/workflow evidence in the same record. If the written review-pressure
decision selects a stack, the initial PR remains the first layer and each active
layer records its parent, shared plan, owned milestone/slice, exact base and
head SHA, revalidation outcome, validation evidence, and related issues. A
stack never creates a separate plan-only PR.

Review pressure exists when a change has more than 100 changed files, more than
10,000 changed lines (`additions + deletions`), more than 20 changed production
modules, or more than three materially different control-flow families. Crossing
any threshold requires a written stacked-versus-single decision; it does not
automatically require splitting the pull request. Base the decision on cohesion,
dependency order, compatibility risk, and whether reviewers can verify one
invariant at a time.

When a single large pull request is accepted, its body includes a one-screen
read-first map ordered by entry owners, transaction and exit owners,
compatibility surfaces, review slices, and exact evidence. Keep current
head/tree/workflow evidence in the pull request. The rule is that stale evidence
blocks completion: correct any head, tree, run, attempt, conclusion, or verified
SHA that refers to older code before publication can be complete.

A feature with more than 20 production modules or more than three materially
different control-flow families retains a durable repository navigation map in
the repository. A historical PR body is not a durable substitute. Keep semantic
tests primary; source inventories, exact-tree checks, string assertions, and
line/count ratchets remain supplementary and temporary with a named owner and
removal condition.

## Plan Completion Gate

Plan-only branches do not wait for local or Branch Release Gate builds. This
exception applies only when every changed path is an implementation-plan or
agent-guidance path excluded by `.github/workflows/branch-release-gate.yml`.
Branch Release Gate remains required for branches that change code, workflows,
scripts, tests, or plugin metadata.

For build-affecting written implementation plans, do not approve, report, or
mark the plan complete until the final uncommitted working tree passes all three
commands:

```bash
npm run test:unit
npm run test:ci
npm run build
```

Focused checks are earlier feedback and never replace these final commands. Any
change after a successful gate invalidates that gate and requires a fresh run.

For build-affecting implementation plans, completion also requires a current
draft pull request and successful published gates. **Branch Release Gate** must
be green for the final feature-branch commit. **Run Hetzner Supported Distributed
Manifests** must be green for the resulting default-branch commit. Record the
exact commit SHA for each workflow; do not infer success from a run on different
code. Do not approve completion: the plan is not complete while any required
command or workflow is pending, skipped, failed, or attached to an older commit.

For build-affecting implementation plans, an instruction not to commit or push
postpones publication; it does not waive any completion gate. Continue safe
uncommitted work and report the plan as incomplete until the publication and
remote gates are permitted and successful.

## Feature-Branch Check Scope

Cloudflare Workers, Cloudflare Pages, and Deno Deploy production or preview
contexts are default-branch deployment concerns. They must run only for `main`;
they are not additional feature-branch release gates. If one appears on a
feature branch, report provider branch-control configuration drift and use
`docs/production-deployment.md` for remediation. Do not reinterpret a provider
preview failure as an application failure required by **Branch Release Gate**.

On `main`, provider deployment failures remain real release evidence and must
be investigated when those deployments are enabled.

## Publication Failure

If the environment cannot create or push the branch, preserve the work and
report the exact authorization or native action needed. Do not claim progress is
published when it is not.
