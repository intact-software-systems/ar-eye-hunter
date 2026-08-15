# PR-Centered Governance Design

## Purpose

Keep the useful decisions from plan governance while removing its duplicate state, identifiers,
shared bookkeeping, and post-approval ceremonies. For ordinary delivery, the GitHub pull request is
the governed entity and GitHub is the authority for whether that pull request is draft, open,
reviewed, checked, mergeable, conflicted, closed, or merged.

This design deliberately introduces no GitHub App, approval check, merge queue, repository transfer,
or commit-level governance identity.

## Decision summary

1. A pull request owns the goal, boundaries, acceptance criteria, validation summary, risk, and
   optional link to durable design documentation.
2. Agents and scripts read the current pull-request state directly from GitHub. They never mirror
   that state into the repository.
3. Git SHAs remain transient implementation inputs for GitHub checks and diffs. They are not
   approval records, plan identities, user inputs, or repository bookkeeping.
4. Ordinary pull requests never update a shared plan catalog, ownership reservation, receipt index,
   progress ledger, or tracked overview.
5. A change to `main` is not work by itself. An agent acts only when the pull request has a real
   conflict, a failing required check, a requested change, or a substantive requirement change.
6. The collaborative path is native approval followed by auto-merge. Before approval, auto-merge
   stays unarmed so the administrator path remains an immediate native administrator merge. Both
   paths end at the same terminal `merged` PR state.
7. Nothing performs governance work after GitHub reports the pull request as merged.

## The governed entity

The pull request is a mutable proposal. Its current diff, checks, reviews, conversations, and merge
decision belong to that proposal. A new source commit changes the proposal; it does not create a new
governance entity. A movement of the target branch changes GitHub's current compatibility
calculation; it does not create a new proposal.

Scripts may read the current head and base internally when GitHub or Git needs them to calculate a
diff or associate a check. They must not:

- ask a person or agent to copy a SHA, digest, run ID, review ID, plan ID, or workflow ID;
- write those values into the PR body or a tracked governance file;
- interpret a changed base SHA as an instruction to rebase, refresh metadata, or repeat review;
- create another check whose purpose is to restate GitHub's PR review decision.

The only remote identity an agent may present is the PR number or URL already assigned by GitHub.
The normal command discovers that identity from the current branch rather than requesting it from
the user.

## Pull-request intent

The PR body uses short semantic sections:

- **Goal** — the outcome and why it matters;
- **Changes** — the owned behavior or boundaries changed;
- **Acceptance** — observable conditions for success;
- **Validation** — passed, failed, and skipped evidence;
- **Risk and rollback** — material risk and the safe reversal;
- **Follow-up** — links only for independently useful deferred work, otherwise `None`.

For large or architectural work, the PR may link a durable design or implementation plan. That
document explains the design; it is not a live status database. Slice progress stays in the agent's
working plan and, when useful to a reviewer, in ordinary PR discussion. It does not require a
tracked state record.

No JSON metadata fence, computed changed-path list, digest, approval transcription, or closure
record belongs in the PR body.

## Agent state contract

Every delivery command starts by reading the live PR. Conflict and closure state are resolved before
any validation or publication ceremony.

| Current PR state                      | Agent result                  | Agent action                                                |
| ------------------------------------- | ----------------------------- | ----------------------------------------------------------- |
| No PR for a multi-slice branch        | `OPEN_DRAFT`                  | Publish the first coherent commit and open one draft PR     |
| Draft                                 | `WORK`                        | Continue the requested implementation                       |
| Closed without merge                  | `STOP_CLOSED`                 | Stop; do not recreate or reopen without direction           |
| Merged                                | `DONE`                        | Stop; perform no governance action                          |
| GitHub still calculating mergeability | `WAIT_GITHUB`                 | Wait briefly and read the same PR again                     |
| Real merge conflict                   | `REPAIR_CONFLICT`             | Report the conflicting paths and resolve source code first  |
| Required check failed                 | `REPAIR_CHECK`                | Diagnose that check; do not edit governance metadata        |
| Required checks pending               | `WAIT_CI`                     | Wait for GitHub; do not generate local evidence records     |
| Checks acceptable, review required    | `AWAIT_REVIEW_OR_ADMIN_MERGE` | Keep auto-merge unarmed; await review or let an admin merge |
| Approved and auto-merge not armed     | `ARM_AUTO_MERGE`              | Arm native auto-merge once                                  |
| Approved and auto-merge armed         | `WAIT_MERGE`                  | GitHub owns the merge                                       |

`BEHIND` is not an action state. When required status checks use loose mode, a behind but otherwise
mergeable PR remains eligible. The agent must not click **Update branch**, merge `main`, or rebase
merely to make the branch current.

If `main` movement produces a real conflict, the agent resolves the conflict because the source is
not mergeable. That is substantive source work, not plan-governance freshness work. The state check
happens first so an agent does not spend ten minutes updating records before discovering it.

## Approval and administrator merge

The design supports both current and future repository shapes without naming a person or assuming a
permanent contributor count.

### Collaborative path

1. The agent completes the PR, marks it ready, and requests review without arming auto-merge.
2. Another authorized developer reviews the PR using GitHub's normal review UI.
3. When GitHub reports approval, the agent runs the readiness command once to arm auto-merge.
4. GitHub merges when its required checks and review rules are satisfied.
5. Agents observe `merged` and stop.

### Administrator path

1. The agent completes the PR, leaves auto-merge unarmed, and reports
   `AWAIT_REVIEW_OR_ADMIN_MERGE`.
2. An administrator may intentionally merge through GitHub even when an independent approval is
   unavailable.
3. GitHub's authenticated administrator action is the decision record.
4. Agents observe `merged` and stop. They do not claim that absent reviews or bypassed checks passed,
   and they do not manufacture replacement evidence.

Administrator merge is a supported normal path, not an exception workflow. The authority is attached
to the repository role, not a hardcoded username.

## Cross-PR isolation

Ordinary PRs must not contend on governance files. Specifically, they do not modify:

- `plans/README.md`, `plans/policy.json`, a shared active-plan catalog, or an overview;
- closure receipts or hashed governance-decision files for PR completion;
- a shared milestone, reviewer, run, digest, ownership-reservation, or changed-path ledger;
- `package.json`, workflow files, agent guidance, or PR templates merely to record progress.

Concurrent PRs may each change their own PR body and their own uniquely named durable design
document without Git conflicts. CI concurrency is keyed by PR number and cancels only superseded runs
of that same PR. There is no repository-wide governance lock or active-plan capacity limit.

Two PRs can still conflict when they both change the same product source or the same meaningful
shared policy registry. That contention is real and must not be hidden. The delivery command reports
it before governance work. Resolving the actual source conflict is the only required repair; no plan
digest, scope list, or review record is refreshed afterward.

## CI and ruleset

`Branch Release Gate` runs for `pull_request` events, not generic feature-branch pushes. Its
concurrency group contains the PR number. It performs read-only repository checks and affected
product validation; it never writes evidence back to the branch.

The ruleset targets only `refs/heads/main`. It retains:

- pull requests before merge;
- native review requirements for the collaborative path;
- administrator role bypass for the administrator path;
- linear history and protection against deletion and force push;
- the stable `Branch Release Gate result` required check.

The required check uses loose mode: the PR branch does not have to be updated merely because `main`
moved. GitHub still rejects an actual conflict. Stale-review dismissal and last-push approval remain
disabled so base movement does not create review work.

Repository auto-merge is enabled as a collaborative capability. The readiness command arms it only
after GitHub reports approval; a review-required PR remains directly administrator-mergeable. No
merge queue is required.

Workflows use the event's PR context and the ordinary read-only GitHub token. No new App, private key,
webhook service, expected-App check source, or secret-bearing environment is created.

## Retained useful governance

The following value remains:

- the agent states the goal and acceptance criteria before broad implementation;
- at most two next implementation slices stay concrete in the agent's working plan;
- material new evidence can change scope or architecture;
- affected product tests and repository-structure checks still run;
- reviewers see a concise explanation, validation result, and risk in the PR;
- retained production legacy still requires a meaningful durable approval because it changes a real
  long-lived policy, not delivery bookkeeping;
- default-branch commit and push safety rules remain separate from ordinary PR merging.

The following mechanisms are retired from ordinary delivery:

- active `plan-adaptation-v1` records and catalog capacity;
- computed plan facts, digests, triggers, and mutable ownership reservations;
- PR Human Review Record metadata fences;
- plan closure receipts and post-implementation closure commits;
- plan completion through authenticated governance decisions;
- copied workflow evidence and build-tree identities in agent handoffs.

Historical records may remain readable but are inert. No migration rewrites every historical plan or
receipt, because that would create more bookkeeping and merge pressure.

## Performance boundaries

- Reading and reducing PR state should require at most two GitHub reads in the normal path: the
  current PR and the repository default branch.
- The local PR-state reducer and governance checks should complete in under two seconds excluding the
  GitHub network request.
- An implementation-complete agent needs one readiness command at handoff. If native approval
  arrives later, one more readiness command arms auto-merge; neither path runs plan close, receipt,
  digest, review-record, or rebase commands.
- A conflict must be reported before any broad validation rerun or governance mutation.
- Repeating `status` or `ready` is idempotent and creates no repository diff.
- After `merged`, the number of permitted governance mutations is zero.

## Migration and cutover

The migration is one PR:

1. Add the PR-state reducer and command with behavior tests.
2. Replace the PR template and agent guidance with the semantic PR contract.
3. Remove active plan enforcement and generic PR review-record enforcement while retaining focused
   product, structure, and production-legacy validation.
4. Move Branch Release Gate to PR events with per-PR concurrency and no branch writes.
5. Before final review, enable repository auto-merge and atomically update ruleset `15939552` to
   target `refs/heads/main`, retain role-based administrator bypass, and require the loose Branch
   Release Gate result.
6. Verify both native paths on the migration PR: the collaborative path is structurally available,
   and the current administrator can manually merge.
7. Run readiness without arming auto-merge, then request the final decision. After approval, one
   readiness call may arm auto-merge; without approval, the administrator can merge directly. No
   cutover action is scheduled after merge.

The obsolete base-resident PR-review workflow may fail on the migration PR because the PR removes its
metadata contract. That is expected cutover evidence, not a reason to recreate the metadata. The
administrator may merge the migration PR using the supported native bypass after the new focused
checks and product validations pass.

## Rollback

Rollback is another ordinary PR that reverts the focused implementation change. It uses the same
PR-centered checks and may be merged by the administrator if review is unavailable. It does not
restore active plan catalogs, closure receipts, or commit-bound approval Apps. If the new readiness
command fails, GitHub's web PR state and manual administrator merge remain the fallback.

## Acceptance criteria

- No planned Source Approval App, exact-source check, merge queue, organization transfer, or App
  credential appears in the implementation.
- Agents and scripts choose actions from live PR state.
- Ordinary PR bodies contain semantic intent and no machine metadata fence.
- Ordinary PR completion creates no tracked governance file and no post-merge action.
- Concurrent PRs have independent governance state and per-PR CI concurrency.
- `main` movement alone produces no agent action.
- Real conflicts are detected before governance or broad validation work.
- Native approval plus auto-merge and native administrator merge are both supported.
- Existing useful product, structure, safety, and retained-legacy checks remain enforced.
