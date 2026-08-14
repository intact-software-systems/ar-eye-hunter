---
name: publishing-plan-progress
description: Use when publishing a written plan or long-running implementation through a branch, draft pull request, milestone updates, compatibility reviews, or final remote evidence.
---

# Publishing Plan Progress

Make long-running work observable without owning its architecture, checkpoints, or test scope.

**REQUIRED SUB-SKILL:** Use `adaptive-plan-execution` for plan adaptation and checkpoint decisions.

**REQUIRED SUB-SKILL:** Use `rallar-testing` to select validation commands.

## Publication workflow

1. Inspect Git state and preserve unrelated work.
2. Use the installed GitHub publication workflow for branch, push, draft pull request, and
   review operations. If execution starts in a detached worktree, use the Codex app **Create
   branch here** action before publication.
3. Obey an explicit current-task branch override. Otherwise, create `codex/<topic>` and push it
   with upstream tracking. Explicit user instructions may narrow or disable publication.
4. On a non-default branch, publish the first meaningful commit and open or update one draft pull
   request for the plan-to-implementation lifecycle. Keep a stack only when the active plan's
   review-pressure decision selects one.
5. After a completed capability slice or substantial coherent interval, publish only in-scope,
   reviewed files and update the draft pull request with outcomes and exact passed, failed, and
   skipped evidence. Do not create empty commits or include secrets, generated junk, or unrelated
   changes to meet a cadence.
6. Continue safe implementation without waiting for review. A publication failure or pending
   default-branch permission pauses only that Git operation unless it creates a real blocker.

## Compatibility Review

Before a published milestone and final publication, refresh the default branch and perform one
compatibility review for each newly observed base. Compare affected contracts, owners,
dependencies, validation paths, and acceptance criteria. Record either:

- `Compatible — no plan delta`, with the compared base range and checked surfaces; or
- `Material impact — plan delta`, with the changed assumption and smallest affected update.

Route any plan change to `adaptive-plan-execution`. Default-branch movement alone does not require
a replan or unrelated validation.

## Follow-Up Issue Handoff

Search for an existing issue only after evidence identifies verified material work that is
independent of the active outcome, or a product, ownership, compatibility, or permission decision
that needs a human. Reuse a matching issue; otherwise create a focused issue with the problem,
deferral reason, active-plan boundary, safe evidence, desired outcome, acceptance criteria or first
safe step, guardrails, and related plan/PR links.

An issue records an already-proven independent boundary or an explicit human re-scope. It never
creates that boundary, replaces required work, or makes dependent work complete. Do not publish
secrets. Link created or reused issues in the draft pull request and final handoff; otherwise state
`Follow-up issues: none`. If filing is required but unavailable or prohibited, preserve the complete
draft and exact reason.

## Default Branch Commit and Push Permission

Never create, rewrite, or place a commit on `main`, `master`, or the local default branch without
just-in-time permission. Working directly on the default branch is not permission to commit. A
standing publication instruction, deadline, or earlier approval is not approval for a later Git
operation.

Before every default-branch commit:

1. Keep changes uncommitted and identify the exact branch, operation, staged file list, staged diff
   summary, staged Git tree ID from `git write-tree`, proposed commit message, and affected full
   commit IDs. For a multi-commit or history-changing operation, list every input and target.
2. Ask permission for that exact operation immediately before it.
3. Wait for explicit approval; silence is not approval.
4. Recheck the tree and commit IDs, then perform only the disclosed commit, amend, merge, revert,
   cherry-pick, rebase, or squash. Changed content, message, input, target, or conflict resolution
   invalidates approval.

Never push `main`, `master`, or the remote default branch without separate just-in-time permission.
Before every default-branch push:

1. Identify the exact remote, destination ref and refspec, resolved full old and new commit IDs,
   and whether the push is forced.
2. Ask permission for that exact push immediately before it.
3. Wait for explicit approval; silence is not approval.
4. Recheck both tips and push only the disclosed range and refspec. A changed tip or range
   invalidates approval. A force push requires separate disclosure and approval.

Approval to commit is not approval to push, and approval to push is not approval to commit. These
gates apply whenever any source branch targets the remote default ref; they do not apply to a
non-default destination ref.

The fixed `governance:decide apply` capability is separate from ordinary Git commit and push
publication. An AI may use it only after showing the exact canonical request and expected main head
and receiving one just-in-time approval for that atomic decision; a changed request or head
invalidates the approval. This does not approve any ordinary default-branch commit or push. Never
hand-write a receipt, directly edit/delete a plan, fabricate completion or review evidence, or
construct a tracked plan overview as a substitute.

## Draft Pull Request Record

Keep one draft pull request current with the plan link, requested review, milestone checklist,
current behavior and incomplete areas, compatibility outcome, exact validation status, and
follow-up issues. For a plan-approved stack, each layer records its parent, shared plan, owned
slice, base and head, evidence, and related issues.

When review pressure exceeds 100 changed files, 10,000 changed lines, 20 production modules, or
three materially different control-flow families, record a stacked-versus-single decision based on
cohesion, dependency order, compatibility risk, and reviewability. A single large pull request adds
a one-screen read-first map ordered by entry owners, result/exit owners, compatibility surfaces,
review slices, and evidence. Durable repository navigation belongs to
`organizing-repository-structure`, not the pull request.

## Completion Publication

Use `adaptive-plan-execution` for affected-code freshness and completion decisions. This skill owns
publication evidence:

- keep the draft pull request current;
- require **Branch Release Gate** evidence for the final governed feature-branch build tree;
- require **Run Hetzner Supported Distributed Manifests** only when the risk classifier or plan
  acceptance selects distributed validation for the resulting default-branch change; and
- record the trusted workflow/run identity, conclusion, completion time, head, and
  build-affecting tree digest supplied by governance automation.

Do not treat a new commit identifier or unrelated documentation edit as proof that build evidence
is stale. Do not reuse remote evidence unless the current workflow contract verifies it. Pending,
skipped, failed, expired, or unverifiable required publication evidence keeps publication
incomplete. An instruction not to commit or push postpones publication; it does not turn missing
evidence green.

Historical-plan-only branches do not wait for Branch Release Gate when every changed path is
excluded by the workflow. Branch Release Gate remains required when its build-affecting path
contract includes changed code, workflows, scripts, tests, package metadata, lockfiles, active
plans, or agent and plugin contracts.

Cloudflare Workers, Cloudflare Pages, and Deno Deploy production or preview contexts are
default-branch deployment concerns. A feature-branch provider run is configuration drift, not an
additional feature-branch release gate. On the default branch, enabled provider failures remain
release evidence.

## Publication Failure

If the environment cannot create or push the branch, preserve the work and report the exact
authorization or native action needed. Never claim unpublished work is published.
