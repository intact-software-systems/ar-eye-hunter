# Publishing Long-Running Plan Progress

## Goal

Make implementation-plan progress observable without turning human review into
an execution gate. Long-running work should appear on GitHub as checkpoint
commits on a feature branch and as a draft pull request while Codex continues
working.

## Scope

Add one repo-local skill for written implementation plans and other work that
is expected to span multiple substantial execution intervals. Route that work
to the skill from `AGENTS.md` and expose it through the existing Rallar plugin.

This change does not alter product code, CI, branch protection, or merge
policy. It does not make every small coding task publish a pull request.

## Terminology

- **Published branch:** a non-default branch with an upstream remote branch.
- **Draft pull request:** the GitHub review surface for work in progress.
- **Checkpoint:** a cohesive, reviewable commit associated with completed or
  explicitly partial plan progress.
- **Long-running work:** execution of a written plan, or implementation the
  agent reasonably expects to require multiple substantial work intervals.
- **Default-branch commit approval:** explicit, just-in-time user consent for
  one described operation that creates, rewrites, or places a commit on the
  local default branch.
- **Default-branch push approval:** explicit, just-in-time user consent for one
  described push to `main`, `master`, or the remote default branch.

## Workflow Contract

1. Before implementation, inspect the Git state and preserve unrelated user
   changes. Unless the user explicitly overrides branch placement for the
   current task, work on a `codex/<topic>` branch, never `main` or `master`.
2. Push a non-default branch with upstream tracking as soon as the branch
   exists. A default-branch override permits uncommitted local work only; it
   authorizes neither committing to nor pushing that branch.
3. On a non-default branch, open a draft pull request after the first meaningful
   commit. If it already contains a committed plan or design, that commit is
   sufficient.
4. Continue implementing without waiting for human review.
5. After each completed plan milestone or cohesive vertical slice:
   - run the focused verification appropriate to that checkpoint;
   - commit only in-scope files;
   - push the commit;
   - update the draft PR progress and validation record.
6. Before yielding at the end of a substantial work interval, publish any
   coherent progress that is safe to share. Do not create artificial empty
   commits or commit secrets, generated junk, or unrelated changes merely to
   satisfy cadence.
7. Record failing or skipped checks honestly. A draft PR may contain incomplete
   work when it is clearly labeled, but a checkpoint must not be described as
   passing when it is not.
8. Review feedback does not pause execution by default. Incorporate feedback at
   a safe checkpoint when it does not invalidate the active plan; stop only for
   a real blocker, conflicting direction, or an explicit request to wait.

## GitHub and Environment Handling

Use the installed GitHub publish workflow for branch, commit, push, and draft
PR operations, with the repository's `codex/` branch prefix overriding any
generic plugin naming default.

If the Codex app starts the task in a detached worktree, use its **Create branch
here** control before publication. If the environment cannot create or push a
branch, preserve the work and report the exact native action or authorization
needed; do not claim that progress is published.

### Default-Branch Commit and Push Gates

No AI or agent may create, rewrite, or place a commit on `main`, `master`, or
the local default branch on an implicit instruction. This includes commit,
amend, merge, revert, cherry-pick, rebase, and squash operations that create,
rewrite, or move a default-branch commit. Before each operation, the agent keeps
the changes uncommitted, states the exact local branch and operation, staged file
list, staged diff summary and staged Git tree ID from `git write-tree`, proposed
commit message, and all affected full commit IDs, asks permission immediately
before the operation, and waits for explicit approval. Multi-commit operations
disclose every input and target plus all proposed messages. The agent rechecks
the staged tree ID and commit IDs before acting. Any content, message,
input-commit, conflict-resolution, or target change invalidates approval and
requires a new exact request. Any later default-branch commit also requires a
new request.

Permission to edit files or work directly on the default branch is not
permission to commit. Standing publication preferences, deadlines, silence,
and approval given before the exact commit was presented do not satisfy the
gate. While approval is pending, safe uncommitted local plan execution
continues; only the commit operation pauses.

No AI or agent may push `main`, `master`, or the remote default branch on an
implicit instruction. Before each such push, the agent keeps the commits local,
states the exact remote, destination ref and refspec, resolved full commit IDs
for the current remote tip and proposed new tip, and whether the push is forced;
asks permission immediately before the operation; and waits for explicit
approval. Moving symbolic ranges are insufficient. The agent rechecks both tips
before pushing only the described range and refspec. A changed tip or range
invalidates approval. Approval covers only a normal fast-forward push unless
force was separately disclosed and approved; any later default-branch push
requires a new request.

A completed or approved default-branch commit is not permission to push.
Neither a standing progress-publication preference, available authentication,
deadline pressure, silence, nor approval given before the exact push was
presented satisfies the push gate. Commit and push approvals are independent.
The push gate does not delay automatic checkpoint pushes whose destination refs
are non-default published branches. It still applies when a feature source
branch is pushed to the remote default ref. While approval is pending, safe
local plan execution continues; only publication to the default branch pauses.

The draft PR description should contain:

- the goal and implementation-plan link or path;
- a milestone checklist;
- the current behavior and known incomplete areas;
- exact validation results, including failures and skips.

### Completion Semantics

Checkpoint publication makes work observable; it does not prove completion. A
written implementation plan remains incomplete until its final uncommitted
working tree passes `npm run test:unit`, `npm run test:ci`, and `npm run build`.
After publication, the draft PR must describe the final state, **Branch Release
Gate** must pass for the final feature-branch commit, and **Run Hetzner Supported
Distributed Manifests** must pass for the resulting default-branch commit. Each
result is bound to its exact commit SHA. Later changes invalidate earlier
results, and pending, skipped, failed, or stale results cannot approve plan
completion.

An explicit no-commit or no-push instruction delays the publication-dependent
gates without waiving them. The agent continues safe uncommitted work, reports
the remaining gates, and does not describe the plan as complete.

## Skill Placement and Routing

Create `.agents/skills/publishing-plan-progress/SKILL.md`. Its description must
trigger for written-plan execution and clearly long-running implementation. Add
a concise `AGENTS.md` routing rule and update `.codex-plugin/plugin.json`
metadata so the workflow is discoverable without repeating it in every prompt.

Keep detailed procedure in the skill. Keep `AGENTS.md` as a lightweight router
and durable statement that observable progress is required.

## Validation

- Establish a baseline scenario showing that the current repo instructions do
  not require early branch publication or a draft PR.
- Establish a baseline scenario showing that a direct-default-branch instruction
  would allow local commits without just-in-time approval.
- Re-run the scenario with the new skill and confirm that it chooses a
  `codex/*` branch, early push, draft PR, checkpoint updates, and no review gate,
  while default-branch commit and push operations remain independently gated.
- Run the focused repository skill-integrity suite named by `rallar-testing`.
- Run the mandatory final unit, CI, and build commands, then verify the draft
  pull request and both SHA-specific published workflow gates before marking the
  plan complete.
- Inspect the final diff for conflicting branch naming, unsafe staging advice,
  accidental review gates, and claims that unsupported Git operations succeed.

## Compatibility and Risk

The observable-progress rule is limited to plan execution and long-running
work, avoiding PR noise for small tasks. The default-branch commit and push
gates apply to all agent work in this repository. Publishing remains
conditional on an accessible remote and authentication. Explicit user
instructions can narrow or disable publication for sensitive work, but a
branch-placement instruction does not bypass either just-in-time default-branch
gate. Existing branch protection, required reviews, and merge controls remain
authoritative.
