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
   work directly on the default branch.
5. After the first meaningful commit, open a draft pull request. A committed
   plan or design already on the branch is meaningful progress.
6. After each completed plan milestone or cohesive vertical slice, run focused
   verification, commit only in-scope files, push, and update the draft pull
   request with progress and exact validation status.
7. Before yielding after a substantial work interval, publish coherent progress
   that is safe to share. Never create empty commits or include secrets,
   generated junk, or unrelated changes just to meet the cadence.
8. Continue without waiting for human review. Report publication, push, pull
   request, validation, and skipped-check failures honestly; stop only for a
   real blocker, conflicting direction, or an explicit request to wait.

## Draft Pull Request Record

Keep the draft pull request current with the written-plan link, milestone
checklist, current behavior and incomplete areas, plus exact passed, failed, and
skipped validation results.

## Publication Failure

If the environment cannot create or push the branch, preserve the work and
report the exact authorization or native action needed. Do not claim progress is
published when it is not.
