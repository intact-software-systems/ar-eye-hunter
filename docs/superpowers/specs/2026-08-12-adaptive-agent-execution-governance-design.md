# Adaptive Agent Execution Governance Design

Date: 2026-08-12

Status: implemented and closed

## Problem

Long agent plans currently optimize for following an early sequence, even when
implementation changes what the repository teaches us. The result can be
correct code spread across locations that do not communicate ownership to a
human. Reconstructing the feature then requires a fresh agent analysis instead
of ordinary repository navigation.

The repository already contains useful code-writing, testing, publication, and
review rules. What is missing is an execution-time feedback loop that turns
structural facts and new learning into a bounded plan correction.

## Goal

Let agents explore and make local judgments while forcing their work to
converge into a repository whose owners, entry points, behavior, tests, and
legacy paths are recoverable by a human from the tree and code.

No product runtime API changes are part of this design.

## Control loop

Qualifying work uses three review levels:

1. A lightweight fresh-context architecture review before implementation.
2. Cheap, automated execution checkpoints whenever material structure or plan
   assumptions change, or after two completed capability slices.
3. One thorough fresh-context final review of outcomes, owner-to-result paths,
   navigation, tests, compatibility, and legacy closure.

An active plan exposes only the next two concrete slices. A slice is one
independently testable capability increment or structural consolidation, not a
commit, task, or group of files. Later outcomes retain their owner, invariants,
and evidence requirements without predicting exact file placement.

At a checkpoint the implementing agent records five judgments: outcome,
learning, structure, decision, and the next slices. The decision is one of
`continue`, `amend`, `consolidate`, or `stop`. A known ownership or navigation
failure makes `continue` invalid when the next slice would deepen it. One
autonomous consolidation slice may replace the next feature slice; a failed
cold-navigation probe after that consolidation requires human direction.

## Canonical adaptive-plan record

Every active qualifying plan contains exactly one fenced
`plan-adaptation-v1` JSON record. It is the durable coordination surface for:

- goal and acceptance criteria;
- declared capability roots, canonical entries, mirrored test roots, and
  navigation maps;
- current and intended capability-tree hypotheses plus the initial fresh-agent
  verdict;
- completed slices since the prior checkpoint;
- computed checkpoint triggers, affected-code content digest, and undeclared
  changed paths;
- the five checkpoint judgments;
- `keep`, `split`, `move`, and `consolidate` structural dispositions;
- fresh structural-review and cold-navigation evidence when required; and
- a concise material-decision log.

Digests use sorted path, Git mode, and content tuples. They intentionally do not
include the current commit SHA. The declared affected surface is checked
against the actual diff so an agent cannot make a review appear fresh by
omitting changed paths.

The command surface is:

```text
npm run plan:adapt -- init
npm run plan:adapt -- complete-slice
npm run plan:adapt -- prepare
npm run plan:adapt -- apply
npm run plan:adapt -- check
npm run plan:adapt -- close
```

`prepare` writes a Git-ignored draft containing computed facts. `apply`
validates the five judgments and canonically replaces the record. `check` is
read-only and is the CI entry. `close` is allowed only after final evidence has
been recorded in the pull request; it removes the tactical plan and its active
registry entry. Durable decisions remain with the code or document that owns
them.

`plans/README.md` is generated from active records and lists each plan's
capability owner, status, current checkpoint decision, and next slice.

## Qualification and checkpoint triggers

An adaptive plan is required for any written implementation plan, directory
creation or movement, three or more added or moved production modules,
package/capability crossings, or public ownership changes.

Checkpoints are required for ownership, folder, public-contract, or lifecycle
changes; navigation degradation; invalid assumptions; scope growth; or two
completed slices. Trigger computation is mechanical. Architectural judgment
and the checkpoint decision remain agent work.

## Repository-tree governance

A dedicated repository-structure analyzer covers authored code under `apps`,
`packages`, `scripts`, `examples`, and tests. Generated and tool-mandated trees
have explicit exclusions.

On changed surfaces it blocks:

- a new authored-code subtree whose only code descendant is one file;
- redundant one-child directory chains; and
- an existing singleton subtree when the capability is materially changed.

A README does not make a one-code-file subtree meaningful. A new singleton
production exception requires explicit human approval, an owner, and a review
or removal condition. Path-only, formatting-only, and typo-only changes do not
activate existing debt.

Declared capabilities require a canonical entry and a mirrored test root.
Features with more than 20 production modules or at least three control-flow
families require a durable navigation map. Density, prefix clustering, module
size, and semantic depth produce mandatory human dispositions rather than
automatic folder instructions. Automation supplies facts; it never invents a
folder taxonomy.

The existing repo-style capability remains the canonical source for its
directory-density, feature-prefix-clustering, and file-size facts. The new
repository-structure analyzer consumes an intentionally exported fact contract
instead of reimplementing those measurements. It alone owns cross-tree
capability topology, canonical entry/test-root declarations,
singleton/redundant-chain enforcement, navigation-map requirements, and the
required structural dispositions.

## Behavior guidance

Two repo-local skills will own the agent behavior:

- `adaptive-plan-execution` owns qualification, the two-slice horizon,
  checkpoint decisions, failure classification, and plan close-out.
- `organizing-repository-structure` owns human navigation, capability trees,
  entries, test mirrors, maps, structural dispositions, and cold-navigation
  probes.

Plan writing, code writing, testing, and publication guidance route to these
owners. Duplicated plan-adaptation, unconditional full-suite, exact-SHA, and
startup issue-search rules are removed from general guidance.
`publishing-plan-progress` retains publication responsibilities only.

## Review Record v2

PR Human Review Record v2 directly replaces v1:

- initial review covers the goal, acceptance criteria, capability-tree
  hypothesis, canonical entry/owner, and first two slices;
- checkpoint review links the current adaptive-plan digest and does not repeat
  milestone narratives; and
- final review verifies declared outcomes, every owner-to-result path,
  navigation, tests, compatibility and legacy closure, and proportional
  validation.

Final-review freshness binds the build-affecting tree digest to the plan goal,
acceptance criteria, and current structural decision. Unrelated documentation
changes do not invalidate evidence. Existing open pull requests migrate on
their next synchronization; no permanent v1 validator remains.

The introducing pull request is the sole bootstrap exception because
`pull_request_target` cannot validate its own replacement workflow from the
candidate branch. It still records a fresh-agent initial review and thorough
final review outside the unavailable base-branch v2 gate.

## Validation routing

Local work runs affected behavior tests, relevant type/build boundaries,
governance and structure checks, and explicitly required high-risk proofs.
Broad unit/CI/build validation belongs to GitHub for each new build-tree
digest. Distributed validation runs only when the risk classifier or active
plan acceptance requires it.

Trusted `validation-evidence-v1` artifacts bind workflow/run identity, head,
build-tree digest, conclusion, and completion time. A later commit may reuse a
successful, unexpired artifact only when the recorded head is its ancestor and
the build-tree digest is unchanged. Changes to code, tests, workflows, package
metadata, lockfiles, or plan contracts invalidate that evidence.

A fast classifier runs on pushes to `main`. Hetzner jobs run for distributed
protocol/controller/headless behavior, realtime routing/topology,
deployment-runner changes, or explicit active-plan acceptance. Manual dispatch
remains available.

Before editing after a CI failure, the agent classifies it as `regression`,
`infrastructure/flaky`, `obsolete-coupled-test`, or
`invalid-plan-assumption`. Only the last classification automatically amends
the plan.

The focused commands are `test:plan-adaptation`, `test:repo-structure`, and the
aggregate `test:adaptive-governance`. The read-only check entry is
`check:adaptive-governance`. Their combined local path targets less than ten
seconds and the GitHub Governance Gate targets less than two minutes.

## Evaluation strategy

Deterministic tests cover record parsing and replacement, content digests,
qualifying diffs, trigger and horizon rules, undeclared paths, consolidation
escalation, plan registry and deletion, structure findings and debt activation,
review v2 freshness, validation-evidence reuse, and distributed-risk routing.

Versioned fresh-agent RED-GREEN-REFACTOR scenarios cover invalidated long
plans, pressure to manufacture near-limit modules, flat versus meaningless
singleton folders, Markdown-only validation, obsolete test coupling versus
invalid assumptions, and repositories understandable only through their plan.
Live model evaluations run only when behavior-shaping skills change and their
reports are preserved as workflow artifacts. Every critical with-skill case
must comply.

## Rollout

### Merge-close authorization receipt

The merged implementation exposed one final lifecycle ambiguity: deleting the
only tactical plan removes the evidence that distinguishes an authorized close
from an unplanned plan deletion. `close` therefore writes one deterministic
`plans/<plan-id>.closure.json` receipt in the same file transaction that removes
the tactical plan and regenerates `plans/README.md`.

The receipt is data-only. It binds the plan ID and path, the exact digest of the
removed active record, and the already-validated final PR URL and completed
review status. It contains no architecture judgment and no clock-derived
freshness claim.

The final receipt-only pull request uses the PR Human Review Record v2
`plan-only` exemption. That exemption accepts only implementation-plan Markdown
and canonical `plans/<plan-id>.closure.json` paths, and its declared path set
must still exactly equal the observed diff. Arbitrary JSON, mixed code changes,
and unsafe or noncanonical receipt paths remain ineligible. Adaptive governance,
not the exemption parser, authenticates the receipt against the deleted base
record and generated registry transition.

Its closed shape is `schemaVersion`, `planId`, `planPath`, `planDigest`,
`pullRequestUrl`, and `finalReviewStatus`, in that deterministic order. The
schema version is `plan-adaptation-closure-v1`, and the review status must be
`complete`.

On a close-out branch with no active plan, read-only governance may disregard
the deleted plan's `written-plan` qualification only when repository truth
proves all of the following:

- the comparison base contains the matching active plan and generated registry
  entry;
- the current tree contains exactly one regular, non-symlink receipt at the
  canonical path and no tactical plan at the recorded path;
- the receipt has the closed v1 shape and its record/review digests match the
  base plan; and
- the current generated registry no longer contains that plan.

Malformed, forged, misplaced, stale, partial, or unrelated receipts remain
ordinary qualifying work and fail closed without an active plan. Any other
qualification reason still requires an active plan. After the receipt lands on
the default branch, ordinary checks see no close-out diff and need no special
state.

Existing structural debt is baselined and activated only by material changed
surface. The first horizon contains plan-adaptation tooling and the separate
repository-structure analyzer. Their checkpoint and cold-navigation probe choose
the exact placement of the later fixed outcomes: behavior skills and guidance
simplification, PR v2 and Governance Gate, content-sensitive CI, risk-scoped
distributed validation, and close-out.
