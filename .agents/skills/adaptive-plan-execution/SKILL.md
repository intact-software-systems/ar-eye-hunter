---
name: adaptive-plan-execution
description: Use when executing a written or multi-slice repository plan, when implementation changes ownership or structure, or when new evidence invalidates assumptions, expands scope, degrades navigation, or tempts work beyond the current horizon.
---

# Adaptive Plan Execution

## Core principle

Use deterministic tooling for facts and agent judgment for decisions. Keep only
the next two independently testable capability slices concrete; later outcomes
stay outcome-shaped until a checkpoint earns their activation.

**REQUIRED SUB-SKILL:** Use `publishing-plan-progress` for publication only.

**REQUIRED SUB-SKILL:** Use `rallar-testing` to select surface-specific commands.

## Maintenance stewardship boundary

For every code or human-authored support-file change, route standards judgment
to `rallar-code-writing` and keep touched-file standards closure inside each
slice. Implement the requested behavior while resolving pre-existing and new
noncompliance throughout each touched file. When remediation changes a support
file, that file enters the closure recursively. Independent untouched code
remains outside the closure. Checker tolerance is not authority and does not
define touched-file standards closure.

Scope growth caused by this recursive closure is deterministic execution work,
not a reason to request permission to retain old findings. Reflect the expanded
affected surface at the next required checkpoint without using a third active
slice. Escalate only for a genuine exception for a remaining real standards
violation, a public compatibility or migration decision, an unresolved
correctness or safety conflict, or a failed post-consolidation navigation probe.
Do not escalate for pre-existing debt, deadline pressure, diff size, cleanup
volume, ownership recovery, package boundaries, substantial remediation, or
reprioritization alone.

## Control loop

1. Qualify the work. An adaptive plan is required for a written plan,
   directory creation or movement, three or more added/moved production
   modules, package or capability crossings, or public ownership changes. Run
   `npm run plan:adapt -- init --plan <plan-path>` when the work has no owning active record.
   Keep one canonical `plan-adaptation-v1` block with the goal, acceptance,
   affected capability roots, canonical entries, test roots, navigation maps,
   and at most two slices. A fresh agent reviews the initial capability-tree
   hypothesis, owner, entry, and first horizon.
2. Execute one slice. A slice is an independently testable capability increment
   or structural consolidation, not a task, commit, or file batch. Run focused
   checks, then
   `npm run plan:adapt -- complete-slice --plan <plan-path> --slice <slice-name>`.
3. Reflect when facts require it. Run `npm run plan:adapt -- prepare --plan <plan-path>` after an
   ownership, folder, public-surface, lifecycle, or navigation change; an
   invalid assumption; scope growth; or two completed slices. It writes the
   ignored draft containing computed triggers, undeclared paths, and the
   affected-code digest. A new SHA or unrelated prose edit is not itself a
   checkpoint trigger.
4. Write exactly five judgments in the draft: `outcome`, `learning`,
   `structure`, `decision`, and `nextSlices`. Then run
   `npm run plan:adapt -- apply --plan <plan-path>`. Choose `continue`, `amend`, `consolidate`, or
   `stop`; the next horizon remains at most two slices.
5. Run `npm run plan:adapt -- check` for read-only validation of every active plan. After the final
   fresh review and PR evidence, run `npm run plan:adapt -- close` to remove the
   target tactical plan:
   `npm run plan:adapt -- close --plan <plan-path> --final-pr-evidence <pull-request-evidence>`.
6. Use `npm run plan:adapt -- overview` for the ignored live catalog view. When work must release
   capacity or mutable ownership, use
   `npm run plan:adapt -- postpone --plan <plan-path> --reason <reason>`; use
   `npm run plan:adapt -- resume --plan <plan-path> --reason <reason>` only after capacity and
   ownership are valid. Supply `--plan` whenever more than one eligible record exists.

When an administrator explicitly chooses one of the fixed authenticated
governance operations, use `governance:decide`; preview is optional. An AI must
show the exact canonical request and expected main head and obtain one
just-in-time approval before `apply`. A changed request or head invalidates the
approval. Never hand-write a receipt, directly edit/delete a plan, fabricate
completion or review evidence, or alter plan status or an overview by hand as
a substitute. Do not construct a tracked overview; `plans/README.md` is static navigation and the
live overview belongs only in ignored `.plan-adaptation/overview.md`.

## Decision and validation judgment

| Evidence                                                               | Decision      |
| ---------------------------------------------------------------------- | ------------- |
| Outcome and assumptions still hold                                     | `continue`    |
| Goal holds but horizon or approach changed                             | `amend`       |
| Ownership or navigation needs repair first                             | `consolidate` |
| A required decision is unsafe or a post-consolidation cold probe fails | `stop`        |

Never continue when repository ownership/navigation cannot be recovered or the
next slice deepens a known structural failure. One autonomous consolidation may
replace the next feature slice. `consolidate` must expose exactly one
consolidation slice in `nextSlices`. Feature work stays inactive until the
post-consolidation checkpoint; a failed cold-navigation probe then requires
human direction.

Select validation from changed behavior, boundaries, and risk: focused local
tests and `npm run check:adaptive-governance` first; broad GitHub CI when the
build-affecting tree changed; distributed validation only for classified
distributed risk or plan acceptance. Explanatory Markdown that does not alter
the build tree does not justify a full local rerun. Never claim remote evidence
reuse that the current workflow has not actually produced.

Classify every CI failure before editing: `regression`,
`infrastructure/flaky`, `obsolete coupled test`, or `invalid plan assumption`.
Only the last automatically amends the plan.

## Automation boundary and red flags

The commands own qualification facts, triggers, digests, undeclared paths,
horizon counts, catalog capacity, mutable-ownership conflicts, and serialization. The agent owns the five
judgments, structural dispositions, validation scope, and whether new evidence
changes the plan. Automation never chooses a folder or architecture.

Stop and checkpoint when you are about to execute a third slice, continue
through a known navigation failure, hand-compute facts instead of using the
draft, treat every red CI job as an invalid plan, rerun every suite for an
unrelated Markdown edit, or use commit SHA freshness in place of the
affected-code digest.
