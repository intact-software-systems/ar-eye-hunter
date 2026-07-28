# Repository Human Traceability Program Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:writing-plans` when drafting a child plan. Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` only after the human explicitly approves that
> child plan. Use `rallar-repo:publishing-plan-progress` while executing an
> approved plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give humans and agents one safe, repeatable procedure for drafting,
reviewing, approving, executing, publishing, and handing off every child plan
in the repository human-traceability program.

**Architecture:** The master program controls sequence and shared constraints;
each child plan controls one reviewable implementation scope. This execution
plan controls the transition between those documents. Planning and execution
are separate human approval states, and every completed step ends with evidence,
human review instructions, and an exact next prompt.

**Tech Stack:** Markdown plans, Git, GitHub draft pull requests, repository-local
Codex skills, npm validation commands, and GitHub Actions completion gates.

## Global Constraints

- Human understandability is the governing design criterion within the
  non-negotiable requirements for correctness, safety, security,
  compatibility, and required performance.
- The [master refactoring program](repo-human-traceability-refactoring-program-plan.md)
  controls program order, terminology, migration constraints, and completion
  requirements.
- The [governance and checker child plan](repo-human-traceability-governance-and-checker-plan.md)
  is the first executable child plan and changes no production code.
- Creating or editing a child plan never authorizes its implementation.
- Approval applies to one exact child-plan revision. A material scope,
  compatibility, or architectural change returns the plan to human review.
- Execute only one child plan at a time. Do not silently begin the next child
  after completing the active one.
- Use a separate persistent Codex goal for each approved child plan, not one
  goal for the entire refactoring program.
- Begin implementation on a fresh, descriptively named `codex/` branch based
  on current `origin/main`. Obey the default-branch commit and push approval
  rules in `AGENTS.md` without exception.
- Preserve unrelated working-tree changes. Inspect them before changing
  branches, and stage only files belonging to the active plan.
- Keep the draft pull request current after each cohesive milestone, including
  exact passed, failed, unavailable, and skipped validation results.
- A child plan is not complete until its focused checks, repository completion
  gates, pull-request gate, merge, and resulting default-branch workflow have
  passed for the exact applicable commits.
- Do not begin the next child until any required evidence-only ledger update
  has independently reached `ledger-published`; the ledger's own future merge
  and workflow evidence belongs in its PR/handoff, not inside itself.
- Every agent response that completes a planning or implementation step must
  use the completion handoff in this document.

---

Date: 2026-07-28

Status: Published on `main` for human review. This document authorizes no
child-plan implementation. The governance/checker child has been revised for
execution readiness and remains unapproved pending human review.

## 1. Document Roles And Plan Graph

The documents deliberately have different responsibilities:

| Document                                                                                    | Responsibility                                                                                                                 | Current state                                             |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| [Master refactoring program](repo-human-traceability-refactoring-program-plan.md)           | Defines why the work exists, target organization, migration waves, shared entry and exit criteria, and program-level progress. | Published; approved for child-plan drafting.              |
| This execution plan                                                                         | Defines approval boundaries, reusable prompts, publication cadence, and completion handoffs.                                   | Published; human review remains pending.                  |
| [Governance and checker child plan](repo-human-traceability-governance-and-checker-plan.md) | Implements Wave 0 governance, warning-only checks, fixtures, and measured baselines without production movement.               | Published; revised and awaiting approval.                 |
| `plans/rallar-room-group-state-translation-boundary-plan.md`                                | Will define the browser `room` to authoritative `group-state` translation boundary and consumer compatibility.                 | Planned; must be drafted after Wave 0.                    |
| `plans/rallar-group-state-server-structure-plan.md`                                         | Will define authoritative server group-state ownership, moves, AppInbox flow, persistence, presence, and mirrored tests.       | Planned; must be drafted after the browser boundary plan. |
| `plans/api-v1-group-state-route-structure-plan.md`                                          | Will define API-v1 group-state routes, defaults, translation, composition, OpenAPI, and black-box compatibility.               | Planned; must be drafted after the server structure plan. |

The dependency order is:

```text
master program
    -> execution protocol
        -> Wave 0 governance and checker
            -> browser room/group-state boundary
                -> shared-server group-state structure
                    -> API-v1 group-state route structure
                        -> pilot evaluation
                            -> later feature child plans
```

The three future child-plan paths become Markdown links in this document and
the master program when their files are created. Do not create empty plan stubs
solely to make a link resolve.

## 2. Child-Plan State Model

Every child plan moves through these states in order:

| State              | Meaning                                                                                                                                                                                                  | Production changes allowed?                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `needed`           | The master program identifies a bounded child plan that does not yet exist.                                                                                                                              | No.                                                    |
| `drafting`         | An agent is inspecting code, tests, exports, consumers, and call paths and writing the child plan.                                                                                                       | No.                                                    |
| `human-review`     | The complete child plan has passed agent self-review and awaits a human decision.                                                                                                                        | No.                                                    |
| `approved`         | The human explicitly approved the exact plan revision for execution.                                                                                                                                     | Not until execution starts on the intended branch.     |
| `in-progress`      | Tasks are executing with focused validation and published progress.                                                                                                                                      | Only changes authorized by the child plan.             |
| `implemented`      | Local plan tasks are finished, but one or more completion or publication gates remain.                                                                                                                   | Only completion corrections within scope.              |
| `verified`         | Local focused and repository-wide gates pass for the final feature-branch content.                                                                                                                       | No additional edits without invalidating verification. |
| `published`        | The final branch commit and required Branch Release Gate are recorded in the draft PR.                                                                                                                   | Await human merge decision.                            |
| `merged`           | The approved pull request reached the default branch.                                                                                                                                                    | No.                                                    |
| `complete`         | The exact implementation default-branch commit passed the required distributed-manifest workflow, and its PR/handoff publication envelope records the frozen tree, branch, merge, and workflow evidence. | No.                                                    |
| `ledger-published` | A later evidence-only ledger update records the completed implementation, and that ledger's own tree, PR, branch gate, merge, and default workflow are verified in its external publication envelope.    | No; the next child may now be selected.                |

An agent may move a plan into `human-review`, `in-progress`, `implemented`,
`verified`, `complete`, or `ledger-published` from the exact evidence defined
below. Only a human may move it from `human-review` to `approved`, authorize a
default-branch operation, or approve a compatibility exception reserved for
human judgment.

## 3. Mandatory Completion Handoff

After every completed planning task, implementation task, or substantial work
interval, the agent response must contain these sections.

### Outcome

- State the plan and task that completed.
- State whether the result is local, committed, pushed, represented in a draft
  pull request, merged, or fully complete.
- Link the affected plan and draft pull request when available.

### What Was Done

- List changed files and the responsibility of each change.
- Describe behavior, contracts, file locations, checker output, or plan state
  that changed.
- Identify work deliberately left unchanged.

### Why

- Connect each material decision to human traceability, compatibility, safety,
  or another plan constraint.
- Call out tradeoffs and temporary compatibility structures explicitly.

### How

- Summarize the implementation or planning method at reviewer depth.
- Describe relevant dataflow, call-path, file-move, test, or publication
  mechanics without reproducing the complete diff.

### Evidence

- Give exact commands and pass, fail, unavailable, or skipped results.
- Give branch, commit SHA, pull request, and workflow SHA when applicable.
- Distinguish focused feedback from completion-gate evidence.
- State whether unrelated local changes remain preserved and excluded.

### Human Review Required

- Name the exact files, diff areas, decisions, compatibility points, and test
  results the human should review.
- State whether the requested response is approval, requested revision, merge
  authorization, default-branch authorization, or no action.
- Never describe an unapproved plan as approved merely because it was drafted
  or published.

### Next Steps

- Identify the next safe step and anything that blocks it.
- End with one exact copy-and-paste prompt for the human to send next.
- If human approval is required, the prompt must explicitly identify the plan
  path and approval scope.
- If no safe next prompt exists, explain the blocking decision instead of
  inventing one.

This handoff is part of the deliverable. A task is not ready for human review
when its response omits the evidence or exact next prompt needed to continue.

## 4. Safe Execution Loop

For each child plan, apply this loop:

- [ ] **Step 1: Reconstruct repository state from evidence.**
      Read `AGENTS.md`, the master program, this execution plan, the active child
      plan, Git status, branch history, the draft pull request, and recorded test
      results. Preserve unrelated work.

- [ ] **Step 2: Decide whether the next action is planning or execution.**
      If the child plan is missing or materially incomplete, draft it and stop for
      human review. If the exact plan is approved, create a goal for that child
      only and execute it. Do not infer approval from prior approval of the master
      program.

- [ ] **Step 3: Review the child plan before implementation.**
      Verify current file paths, public consumers, representative call traces,
      compatibility assumptions, test commands, task boundaries, and completion
      gates. Stop when a material contradiction makes execution unsafe.

- [ ] **Step 4: Work on a publishable non-default branch.**
      Start from current `origin/main`, publish the branch, and open a draft pull
      request after the first meaningful commit. A committed plan is meaningful
      progress.

- [ ] **Step 5: Execute one independently reviewable task at a time.**
      Mark the task in progress, use the required repository and implementation
      skills, follow test-first steps where behavior changes, run focused checks,
      and record evidence before marking the task complete.

- [ ] **Step 6: Publish cohesive progress.**
      Commit only in-scope files, push the feature branch, update the draft pull
      request, and update the child and master ledgers after each milestone.
      Ordinary milestone publication does not require a pause unless the plan names
      a human decision gate.

- [ ] **Step 7: Complete all final gates.**
      Finalize task checkboxes and baseline data before freezing the feature
      tree. Run `npm run test:unit`, `npm run test:ci`, and `npm run build` on
      that unchanged tree. Store its tree ID, final branch SHA, local results,
      and Branch Release Gate in the PR/handoff. After human merge, append the
      exact merge SHA and distributed-manifest workflow to that external record;
      do not edit the frozen plan to add future evidence.

- [ ] **Step 8: Hand control back to the human.**
      Use the mandatory completion handoff. If the child requires an in-repo
      completion ledger, publish it later as a separately frozen and gated
      evidence-only change. Do not start the next child until that ledger reaches
      `ledger-published`. Give the human the exact next prompt.

### 4.1 Non-Circular Completion Evidence Contract

Completion evidence has two immutable trees and two mutable external
publication envelopes:

1. **Feature tree.** Before final local gates, the child plan records completed
   implementation tasks and measured baselines but no future commit or workflow
   values. Stage the exact in-scope content, record `git write-tree`, and run all
   local gates without another in-scope edit. The final branch commit must have
   that exact tree.
2. **Feature publication envelope.** The draft PR and Mandatory Completion
   Handoff record the feature tree ID, final branch SHA, local results, Branch
   Release Gate, human merge decision, resulting default SHA, and required
   default-workflow run. Updating this external envelope does not change or
   invalidate the feature tree. This envelope is authoritative for post-freeze
   and post-merge evidence.
3. **Evidence-ledger tree.** When the program requires durable in-repo progress,
   create a later non-default branch from the successful implementation default
   SHA. Change only the named plan ledgers to cite the completed implementation
   evidence. Run that documentation change's focused and repository completion
   gates, record its own `git write-tree`, and publish it through a separate PR.
4. **Ledger publication envelope.** The ledger PR/handoff records the ledger
   tree, branch SHA and gate, merge SHA, and default-workflow result. The plan
   files do not need and cannot contain their own future merge SHA or workflow
   result. Once this envelope is green, the state is `ledger-published`; no
   follow-up commit is created solely to restate that envelope.

A content correction to either frozen tree invalidates only that tree's local
and branch evidence and requires a new freeze. A later ledger-only change does
not relabel or invalidate the completed implementation tree. A failed ledger
publication blocks `ledger-published` and the next child, while a failed
implementation workflow blocks `complete` itself.

## 5. Prompt 1 Record: Reconcile And Publish The Program Documents

Do not execute the historical prompt below. Its publication outcome was
satisfied by direct publication to `main`, followed by evidence reconciliation:

- live GitHub `main` resolves to
  `4ec117db1e09e00f86ed8f66cbf8adab1cdeb4a9`;
- the commit adds only the three linked plan documents and has no associated
  pull request;
- the previous PR #45 branch and the proposed Wave 0 branch are both absent
  from the remote;
- GitHub CLI authentication was invalid during reconciliation, so GitHub
  connector data and the public GitHub API supplied remote evidence;
- **Run Hetzner Supported Distributed Manifests** run `30328273358` failed for
  the exact published commit, while **Push on main** run `30328273160` and
  **Deploy Web + API** run `30328273405` passed.
- GitHub's combined commit status separately reports three failed Deno
  deployment contexts: `rallar-bb-server`, `relic-hunters`, and
  `rallar-server`. They were recorded but not diagnosed in this
  documentation-only step.

The prompt is retained as the historical requested path and must not be used to
republish documents that are already on `main`. Direct publication did not
approve the governance child and did not satisfy a draft-PR or Branch Release
Gate path for the plan-document commit.

```text
Prepare the Repository Human Traceability Refactoring Program for execution.

Read and follow:
- AGENTS.md
- plans/repo-human-traceability-refactoring-program-plan.md
- plans/repo-human-traceability-program-execution-plan.md
- plans/repo-human-traceability-governance-and-checker-plan.md

Use:
- rallar-repo:publishing-plan-progress
- superpowers:writing-plans only if a material plan correction is required
- rallar-repo:rallar-code-writing when reviewing checker requirements
- rallar-repo:rallar-testing when reviewing validation commands

Known evidence to verify rather than assume:
- GitHub PR #45, “Make human understanding the primary code goal”, was merged.
- The previous branch codex/repo-human-traceability-governance-checker has a
  merged pull request and its upstream branch may no longer exist.
- Local GitHub CLI authentication is available. If a required `gh` command is
  blocked by sandbox network restrictions, retry it outside the sandbox through
  the normal approval mechanism.
- The three repo-human-traceability plan documents may still be untracked or
  unpublished locally.
- plans/rallar-rest-snapshot-read-convergence-implementation-plan.md contains
  unrelated user changes and must not be modified, staged, committed, or
  included in the traceability pull request.

First inspect Git status, current and remote branches, PR #45, the three plan
documents, and the files changed by PR #45. Reconcile the written status and
progress records with direct evidence:

- Record exactly what PR #45 completed.
- Keep unfinished governance, checker, baseline, and verification work pending.
- Do not record the governance child plan as approved unless explicit human
  approval is already written in that exact plan revision.
- Correct stale branch or publication statements that would make later
  execution unsafe.
- Keep the master program, execution plan, and governance child linked to one
  another.

Create the fresh branch
codex/repo-human-traceability-governance-checker-wave-0 from current origin/main
without losing or including unrelated local work. Publish the three
traceability plan documents and only directly related governance-document
corrections. Open a draft pull request, or update the correct existing open
draft pull request if direct evidence shows one exists for this unmerged work.
Do not change production code or implement checker behavior in this step.

After the step, respond using every section in “Mandatory Completion Handoff”
from plans/repo-human-traceability-program-execution-plan.md:
- Outcome
- What Was Done
- Why
- How
- Evidence
- Human Review Required
- Next Steps

The Next Steps section must end with the exact prompt the human should use to
approve or request revisions to
plans/repo-human-traceability-governance-and-checker-plan.md. Do not begin that
child plan’s implementation in this step.
```

## 6. Prompt 2: Execute The Approved Governance Child Plan

The human sends this prompt only after reviewing and approving the exact child
plan revision.

```text
I approve plans/repo-human-traceability-governance-and-checker-plan.md for
execution at its current committed revision. This approval applies only to that
child plan and does not approve later production child plans.

Read and follow:
- AGENTS.md
- plans/repo-human-traceability-refactoring-program-plan.md
- plans/repo-human-traceability-program-execution-plan.md
- plans/repo-human-traceability-governance-and-checker-plan.md

Create a goal for completing this child plan only. Use:
- rallar-repo:publishing-plan-progress
- superpowers:subagent-driven-development
- superpowers:test-driven-development for checker behavior
- rallar-repo:rallar-code-writing
- rallar-repo:rallar-testing

Review the plan critically against the current repository before editing. Stop
and explain any material contradiction that makes execution unsafe. Otherwise,
execute its tasks in order, preserve unrelated work, and keep all checker output
warning-only. Do not modify production code, introduce strict mode, or add a
blocking CI style gate.

Update the child-plan and master progress records from evidence after each
milestone. Commit and push cohesive in-scope progress on the non-default branch
and keep the draft pull request current. Continue through ordinary milestones;
stop only for a real blocker, a material undecided design choice, or required
human/default-branch authorization.

Do not mark the plan complete until all local and published completion gates in
AGENTS.md and the plan pass for the exact commits. Apply Section 4.1 exactly:
freeze the feature tree before final gates, place later branch/merge/workflow
facts in the PR and handoff, and publish any later in-repo completion ledger as
a separately frozen evidence task. After each substantial work interval and at
completion, respond using every section in “Mandatory Completion Handoff” from
the execution plan. The final Next Steps section must contain the exact human
prompt for reviewing the governance result and, only after it is
`ledger-published`, drafting
plans/rallar-room-group-state-translation-boundary-plan.md.
```

## 7. Prompt 3: Draft The Browser Translation-Boundary Child Plan

This prompt is used only after the governance child is `ledger-published`.

```text
Draft plans/rallar-room-group-state-translation-boundary-plan.md as the next
child of plans/repo-human-traceability-refactoring-program-plan.md. This is
planning only; do not modify production code.

Read AGENTS.md, the master program, the program execution plan, and the
completed governance child plan. Use superpowers:writing-plans,
rallar-repo:rallar-platform, rallar-repo:rallar-realtime,
rallar-repo:rallar-code-writing, and rallar-repo:rallar-testing.

Inspect the current browser room implementation, examples, tests, public
exports, application consumers, API calls, and representative call paths. The
plan must contain the entry and exit material required by the master program,
including:

- the exact current and target file trees;
- one representative top-to-bottom dataflow and call trace;
- one explicitly named browser room to authoritative group-state translation
  boundary;
- descriptive filenames and matching primary symbols;
- the RallarRoomsFacade compatibility decision already fixed by the master;
- any proposed temporary re-export with consumers and removal condition;
- characterization tests and exact focused validation commands;
- a structure pass separated from semantic code-standard changes;
- publication and completion gates;
- remaining risks and decisions reserved for human review.

Add reciprocal links among the new child plan, master program, and execution
plan. Update the master ledger to show that the child is drafted, not approved.
Self-review the plan for coverage, placeholders, inconsistent names, unsafe
compatibility assumptions, and tasks too broad for independent review.

Finish with the Mandatory Completion Handoff. The Next Steps section must give
the exact prompt for human review and explicit approval of this child plan. Do
not execute it.
```

## 8. Prompt 4: Execute The Approved Browser Translation Plan

```text
I approve plans/rallar-room-group-state-translation-boundary-plan.md for
execution at its current committed revision. This approval applies only to this
browser translation-boundary child plan.

Read AGENTS.md, the master program, the program execution plan, and the approved
child plan. Create one goal for this child plan. Use
superpowers:subagent-driven-development,
rallar-repo:publishing-plan-progress, rallar-repo:rallar-platform,
rallar-repo:rallar-realtime, rallar-repo:rallar-code-writing, and
rallar-repo:rallar-testing, plus test-driven-development where behavior or
contracts change.

Review the plan against current Git and consumers before editing. Execute only
the approved tasks, preserve unrelated work, publish cohesive milestones to a
draft pull request, and update both progress ledgers from evidence. Stop for
material plan drift, an unapproved compatibility change, a blocker, or required
human/default-branch authorization.

Use the Mandatory Completion Handoff after substantial intervals and at the
end. After genuine completion, the final Next Steps prompt must draft
plans/rallar-group-state-server-structure-plan.md and must not begin its
implementation.
```

## 9. Prompt 5: Draft The Server Group-State Structure Plan

```text
Draft plans/rallar-group-state-server-structure-plan.md as the next child of the
Repository Human Traceability Refactoring Program. This is planning only; do
not modify production code.

Read AGENTS.md, the master program, the program execution plan, the completed
governance child, and the completed browser translation-boundary child. Use
superpowers:writing-plans, rallar-repo:rallar-platform,
rallar-repo:rallar-realtime, rallar-repo:rallar-code-writing, and
rallar-repo:rallar-testing.

Inspect authoritative group-state service, mutation, AppInbox, persistence,
presence, snapshot, topology, RTC RTT, public exports, consumers, and mirrored
tests. Include the exact current-to-target file map, representative route or
inbox-to-write call trace, public compatibility decisions, structural and
semantic pass boundaries, characterization tests, focused commands, AppInbox
and retry invariants, publication gates, and explicit human decisions.

Add reciprocal plan links, update the master ledger as drafted but unapproved,
and self-review for omissions, placeholders, inconsistent names, hidden
behavior changes, or overly broad tasks. Finish with the Mandatory Completion
Handoff and the exact human approval prompt. Do not execute the plan.
```

## 10. Prompt 6: Execute The Approved Server Structure Plan

```text
I approve plans/rallar-group-state-server-structure-plan.md for execution at its
current committed revision. This approval applies only to this server
group-state child plan.

Read AGENTS.md and every program and child plan linked by this plan. Create one
goal for this child. Use superpowers:subagent-driven-development,
rallar-repo:publishing-plan-progress, rallar-repo:rallar-platform,
rallar-repo:rallar-realtime, rallar-repo:rallar-code-writing, and
rallar-repo:rallar-testing, plus test-driven-development where behavior or
contracts change.

Review current paths, exports, consumers, characterization tests, AppInbox
invariants, and plan assumptions before editing. Execute only approved work,
preserve unrelated changes, publish reviewable milestones, and keep the child
and master ledgers evidence-based. Stop for material plan drift, unapproved
compatibility or authority changes, blockers, or required human/default-branch
authorization.

Use the Mandatory Completion Handoff after substantial intervals and at the
end. After genuine completion, the final Next Steps prompt must draft
plans/api-v1-group-state-route-structure-plan.md and must not implement it.
```

## 11. Prompt 7: Draft The API-v1 Group-State Route Plan

```text
Draft plans/api-v1-group-state-route-structure-plan.md as the next child of the
Repository Human Traceability Refactoring Program. This is planning only; do
not modify production code.

Read AGENTS.md, the master program, the execution plan, and all completed pilot
children. Use superpowers:writing-plans, rallar-repo:rallar-platform,
rallar-repo:rallar-realtime, rallar-repo:rallar-code-writing, and
rallar-repo:rallar-testing.

Inspect API-v1 group-state routes, OpenAPI contracts, request defaults,
request-to-command translations, composition, AppInbox entry, errors,
serializers, consumers, route tests, and black-box evidence. Include exact
current and target files, representative HTTP-to-authoritative-write call
trace, descriptive route registration symbols, compatibility decisions,
structure-versus-semantics task separation, focused and complete validation,
and explicit human review points.

Add reciprocal plan links, update the master ledger as drafted but unapproved,
and self-review the complete plan. Finish with the Mandatory Completion Handoff
and the exact approval prompt. Do not execute the plan.
```

## 12. Prompt 8: Execute The Approved API-v1 Route Plan

```text
I approve plans/api-v1-group-state-route-structure-plan.md for execution at its
current committed revision. This approval applies only to this API-v1
group-state child plan.

Read AGENTS.md and all linked program and pilot plans. Create one goal for this
child. Use superpowers:subagent-driven-development,
rallar-repo:publishing-plan-progress, rallar-repo:rallar-platform,
rallar-repo:rallar-realtime, rallar-repo:rallar-code-writing, and
rallar-repo:rallar-testing, plus test-driven-development for behavior or
contract changes.

Review current routes, OpenAPI, consumers, tests, black-box coverage, and plan
assumptions before editing. Execute only approved work, preserve unrelated
changes, publish cohesive milestones, and update the child and master ledgers
from evidence. Stop for material drift, unapproved API or compatibility
changes, blockers, or required human/default-branch authorization.

Use the Mandatory Completion Handoff after substantial intervals and at the
end. After genuine completion, the final Next Steps prompt must evaluate the
complete pilot before proposing any Wave 2 child plan.
```

## 13. Prompt 9: Evaluate The Pilot And Select The Next Child

```text
Evaluate the completed Repository Human Traceability room/group-state pilot.
This is analysis and planning only; do not change production code.

Read AGENTS.md, the master program, the execution plan, the governance child,
and all three completed pilot child plans. Inspect their final diffs, call
traces, checker results, review findings, validation evidence, compatibility
structures, and remaining-debt records.

Determine whether the pilot made ownership, filenames, dataflow, decision
points, side effects, failures, and call paths materially easier for a human to
locate and follow. Identify rules that helped, rules that created indirection,
temporary compatibility structures still awaiting removal, and changes needed
to the migration method.

Recommend exactly one next bounded child plan from Wave 2 of the master program
and explain why it is the safest next feature. Do not draft or execute that
child in this step. Update only program planning records necessary to preserve
the evidence and recommendation.

Finish with the Mandatory Completion Handoff. The final Next Steps prompt must
ask the human to approve or revise the pilot conclusions and authorize drafting
the one recommended child plan.
```

## 14. Resuming Interrupted Work

When a child plan is already approved and in progress, use this procedure rather
than relying on conversation memory:

```text
Resume the currently approved Repository Human Traceability child plan.

Read AGENTS.md, plans/repo-human-traceability-program-execution-plan.md, the
master program, and the active child plan. Reconstruct state from Git status,
branch history, the draft pull request, committed diffs, plan checkboxes, and
exact validation evidence. Treat previous summaries and checked boxes as claims
to verify, not sufficient evidence.

Report completed and published tasks, completed but unpublished work, current
uncommitted work, stale or missing verification, unrelated preserved changes,
and the first genuinely incomplete task. Confirm that the exact child-plan
revision is approved before editing. Then continue within that approval scope.

Use the Mandatory Completion Handoff after the next substantial interval. Do
not start another child plan.
```

## 15. Progress Record

| Milestone                              | Status         | Evidence                                                                                                                                                      |
| -------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution protocol drafted             | complete       | This document contains the state model, safe loop, handoff, and exact pilot prompts.                                                                          |
| Reciprocal master-plan link            | complete       | The master program links this execution protocol and the governance child.                                                                                    |
| Reciprocal governance-child link       | complete       | The governance child links the master program and this execution protocol.                                                                                    |
| Human review of execution protocol     | pending        | No approval recorded.                                                                                                                                         |
| Program documents published            | complete       | Direct `main` commit `4ec117db1e09e00f86ed8f66cbf8adab1cdeb4a9` added exactly the three plan documents; GitHub `main` resolves to that SHA.                   |
| Program-document Branch Release Gate   | not applicable | Direct publication had no feature branch or pull request, so no Branch Release Gate exists for the plan-document commit.                                      |
| Program-document default workflow      | failed         | **Run Hetzner Supported Distributed Manifests** run `30328273358` failed for exact SHA `4ec117db1e09e00f86ed8f66cbf8adab1cdeb4a9`.                            |
| Program-document deployment statuses   | failed         | GitHub reports failed `rallar-bb-server`, `relic-hunters`, and `rallar-server` deployment contexts; this review did not diagnose them.                        |
| Governance execution-readiness review  | revised        | Section 5.1 now fixes the load-once TypeScript projection, one-finding-per-prefix model, exact browser import classifier, and non-circular evidence contract. |
| Governance child approved              | pending        | The revised plan remains unapproved and requires explicit human approval of this exact revision.                                                              |
| Governance child complete              | pending        | No checker implementation is authorized; all implementation and completion gates remain pending.                                                              |
| Pilot child plans drafted and executed | pending        | They intentionally do not exist yet.                                                                                                                          |
| Pilot evaluated                        | pending        | Requires all three pilot children to be complete.                                                                                                             |
