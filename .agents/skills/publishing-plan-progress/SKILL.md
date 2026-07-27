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
5. On a non-default branch, after the first meaningful commit, open a draft
   pull request. A committed plan or design already on the branch is meaningful
   progress.
6. After each completed plan milestone or cohesive vertical slice, run focused
   verification and, subject to **Default Branch Commit and Push Permission**
   below, commit only in-scope files, push, and update the draft pull request
   with progress and exact validation status.
7. Before yielding after a substantial work interval, and subject to the same
   default-branch gate, publish coherent progress that is safe to share. Never
   create empty commits or include secrets, generated junk, or unrelated changes
   just to meet the cadence.
8. Continue implementation without waiting for human review. Pending default-
   branch commit or push approval pauses only that Git operation, not safe
   uncommitted local plan work. Report publication, push, pull request,
   validation, and skipped-check failures honestly; stop only for a real
   blocker, conflicting direction, or an explicit request to wait.

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
   list, proposed commit message, and operation type. For a history-changing
   operation, also identify the current and proposed target commits.
2. Ask permission for that exact commit immediately before performing it.
3. Wait for explicit approval. Do not commit while the user is unavailable or treat silence as approval.
4. Perform only the described operation. Any later default-branch commit requires a new request and approval.

Approval to commit is not approval to push, and approval to push is not approval to commit.

Never push `main`, `master`, or the remote default branch without just-in-time
permission. A completed or approved default-branch commit is not permission to
push it. A standing instruction to publish progress, available authentication,
deadline pressure, or approval given before the exact push was presented is not
approval for the push.

Before every default-branch push:

1. Keep commits local and identify the exact remote, destination ref, commit
   range, and whether the push is forced.
2. Ask permission for that exact push immediately before performing it.
3. Wait for explicit approval. Do not push while the user is unavailable or
   treat silence as approval.
4. After approval, push only the described range and refspec. Approval covers a
   normal fast-forward push unless a force push was separately disclosed and
   approved. Any later default-branch push requires a new request and approval.

This gate does not apply when the destination ref is a non-default published
branch. It does apply when any source branch is pushed to the remote default ref.

## Draft Pull Request Record

Keep the draft pull request current with the written-plan link, milestone
checklist, current behavior and incomplete areas, plus exact passed, failed, and
skipped validation results.

## Publication Failure

If the environment cannot create or push the branch, preserve the work and
report the exact authorization or native action needed. Do not claim progress is
published when it is not.
