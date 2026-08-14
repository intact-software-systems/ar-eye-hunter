---
name: adaptive-plan-execution
description: Use when executing a written or multi-slice repository plan, when implementation changes ownership or structure, or when new evidence invalidates assumptions, expands scope, degrades navigation, or tempts work beyond the current horizon.
---

# Adaptive Plan Execution

## Core principle

Keep planning useful and local to the work. The GitHub pull request is the remote delivery entity;
the repository does not mirror its state in an active-plan catalog, progress ledger, ownership
reservation, digest record, or completion ledger.

Keep at most the next two independently testable slices concrete. Later work stays outcome-shaped
until evidence earns it. A slice is a useful capability or structural increment, not a commit, task
number, or file batch.

**REQUIRED SUB-SKILL:** Use `publishing-plan-progress` for publication.

**REQUIRED SUB-SKILL:** Use `rallar-testing` to select affected validation.

## Maintenance stewardship boundary

For every code or human-authored support-file change, route standards judgment
to `rallar-code-writing` and keep touched-file standards closure inside each
slice. Implement the requested behavior while resolving pre-existing and new
noncompliance throughout each touched file. When remediation changes a support
file, that file enters the closure recursively. Independent untouched code
remains outside the closure. Checker tolerance is not authority and does not
define touched-file standards closure.

When giving a next-action decision before edits, and again in the final
handoff, state all three closure facts explicitly:

- every changed human-authored file is reviewed and remediated in full;
- every support file modified by that remediation enters closure recursively
  until closure; and
- independent untouched code remains outside closure.

The `touched-file standards closure` label alone, an extraction label, or a
consolidation label is not a substitute for those explicit statements.

Before edits, state that the requested behavior remains the intended outcome
and name two distinct planned validations: a direct test that exercises that
behavior, and a concrete validation of the affected application or package,
such as its build or typecheck. In the final handoff, report each result as
passed, failed, or skipped. Remediation may sequence the work, but it must not
replace or indefinitely defer the requested behavior.

Scope growth caused by this recursive closure is deterministic execution work,
not a reason to request permission to retain old findings. Reflect the expanded
affected surface at the next required checkpoint without using a third active
slice. Escalate only for a genuine exception for a remaining real standards
violation, a public compatibility or migration decision, an unresolved
correctness or safety conflict, or a failed post-consolidation navigation probe.
Do not escalate for pre-existing debt, deadline pressure, diff size, cleanup
volume, ownership recovery, package boundaries, substantial remediation, or
reprioritization alone.

Only a navigation probe that fails after one autonomous coherent consolidation
of the changed capability qualifies as the fourth escalation. Failures involving pre-work
repository state, stale or unrelated governance state, and checker or resource failures must be classified
and reported as validation or environment evidence. They do not justify seeking
permission, retaining a real standards violation, or deferring safe in-scope
implementation unless their concrete consequence is already one of the four
escalation conditions.

If consolidation must run first, it is the sole active slice. Keep the
requested behavior named as the next outcome during consolidation; when the
post-consolidation navigation check passes, make it the immediately following
active slice.

## Working-plan loop

1. State the goal, observable acceptance criteria, important constraints, affected owners, and the
   next one or two slices in the agent's working plan. A durable design document may explain a large
   architectural decision, but it is not a live status database.
2. Before implementation, recover the current owner, entry, dataflow, failure boundary, and tests
   from the repository. Do not use a historical plan as the only navigation map.
3. Implement one slice test-first and run its focused checks.
4. Reflect when evidence changes the goal, acceptance, scope, ownership, structure, compatibility,
   or validation risk. Update the working plan and the semantic PR explanation only when the change
   is material. Do not create a tracked transition record.
5. After two completed slices, choose the next one or two useful slices from current evidence. Do
   not perform a bookkeeping checkpoint.
6. Finish only after affected validation, code/structure review, production-legacy review, and the
   live PR delivery state support the claimed outcome.

## Pull-request state comes first

Run `npm run pr:delivery -- status` before broad final validation and whenever the next delivery
action is uncertain.

- `REPAIR_CONFLICT` means stop and repair the real source conflict before validation or publication
  work.
- `REPAIR_CHECK` means diagnose the failing check; do not edit governance metadata.
- `WAIT_CI` and `WAIT_GITHUB` mean wait for GitHub without creating local evidence records.
- `AWAIT_REVIEW_OR_ADMIN_MERGE` supports either native review or an intentional role-based
  administrator merge.
- `DONE` is terminal and permits no post-merge governance work.

`BEHIND` is not a repair state when GitHub reports the pull request mergeable. Base-branch movement
alone is not work. Do not update the branch, merge `main`, rebase, repeat review, rerun unrelated
checks, or refresh metadata merely because the base changed.

## Material adaptation

Change the working plan when new evidence invalidates an assumption, changes acceptance, expands or
shrinks scope, moves ownership, exposes an unsafe compatibility boundary, or changes the validation
risk. Explain the smallest resulting change in the PR when it matters to review.

Do not change the working plan for a new commit identifier, a harmless base movement, an unrelated
prose edit, or a check rerun with no new behavior evidence.

Consolidate ownership before continuing feature work when repository navigation cannot recover a
truthful owner-to-result path. If one focused consolidation still cannot establish safe ownership,
stop for human direction.

## Failure classification and validation

Classify each failing check before editing:

- `regression` — production behavior or an independent contract broke;
- `infrastructure/flaky` — the environment or nondeterministic dependency failed;
- `obsolete coupled test` — a test protects private topology rather than independent behavior;
- `invalid assumption` — the working plan's product or architecture premise is false.

Only a regression or invalid assumption changes implementation. An invalid assumption also changes
the working plan. Replace obsolete coupling with semantic coverage; never restore inferior
production structure merely to satisfy it.

Select validation from changed behavior, boundaries, and risk. Run focused affected checks first,
broad CI for a build-affecting change, and distributed validation only for classified distributed
risk or explicit acceptance. Report passed, failed, and skipped checks. Do not copy workflow IDs,
commit IDs, digests, or check snapshots into tracked governance state.

## Completion boundary

At handoff, the PR body contains Goal, Changes, Acceptance, Validation, Risk and rollback, and
Follow-up. Run `npm run pr:delivery -- ready` once. Native auto-merge may wait for review and checks;
an authorized administrator may merge through GitHub when independent approval is unavailable.

After GitHub reports `merged`, stop. Do not close or archive a plan, write a receipt, update a
catalog, refresh evidence, rebase, or make a governance-only commit.
