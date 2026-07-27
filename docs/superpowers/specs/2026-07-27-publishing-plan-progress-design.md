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

## Workflow Contract

1. Before implementation, inspect the Git state and preserve unrelated user
   changes. Work on a `codex/<topic>` branch, never `main` or `master`.
2. Push the branch with upstream tracking as soon as the branch exists.
3. Open a draft pull request after the first meaningful commit. If the branch
   already contains a committed plan or design, that commit is sufficient.
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

The draft PR description should contain:

- the goal and implementation-plan link or path;
- a milestone checklist;
- the current behavior and known incomplete areas;
- exact validation results, including failures and skips.

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
- Re-run the scenario with the new skill and confirm that it chooses a
  `codex/*` branch, early push, draft PR, checkpoint updates, and no review gate.
- Run the focused repository skill-integrity suite named by `rallar-testing`.
- Inspect the final diff for conflicting branch naming, unsafe staging advice,
  accidental review gates, and claims that unsupported Git operations succeed.

## Compatibility and Risk

The rule is limited to plan execution and long-running work, avoiding PR noise
for small tasks. Publishing remains conditional on an accessible remote and
authentication. Explicit user instructions can narrow or disable publication
for sensitive work. Existing branch protection, required reviews, and merge
controls remain authoritative.
