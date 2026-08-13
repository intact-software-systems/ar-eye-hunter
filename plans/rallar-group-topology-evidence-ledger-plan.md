# Rallar Group-Topology Evidence Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `rallar-repo:adaptive-plan-execution` for the checkpoint lifecycle and
> `rallar-repo:publishing-plan-progress` for publication. Execute only the
> current adaptive slice and stop before merge.

**Goal:** Publish the already-existing group-topology implementation and
closure evidence into one non-circular ledger without changing code,
performance evidence, or the historical closed child.

**Architecture:** Keep the authenticated closure receipt and deleted
implementation plan as immutable historical evidence. The new active plan owns
one evidence-only slice. Its only external write surface is the two reciprocal
program planning records; the adaptive lifecycle owns this plan and the
generated active-plan registry.

**Tech Stack:** Markdown, Git, GitHub pull requests and Actions, the repository
adaptive-plan lifecycle, repository-structure governance, Prettier, and focused
Vitest governance suites.

Date: 2026-08-13

Status: Active plan initialized from exact `origin/main`
`8ee348e215a3e30d9b4959ce90369aea1b55b620`, tree
`a4b05fe3c16fff6092efad40335ab2d5b371eb96`. The sole authorized slice is
`publish-later-evidence-ledger`.

## 1. Authority And Immutable Boundary

The human authorized this new plan after the prior group-topology plan was
closed. The existing receipt
`plans/rallar-group-topology-server-structure.closure.json` remains unchanged.
The deleted `plans/rallar-group-topology-server-structure-plan.md` remains
available only through Git history and must not be restored, rewritten, or
replaced.

This plan may change exactly:

- this new plan;
- generated `plans/README.md`;
- `plans/repo-human-traceability-refactoring-program-plan.md`; and
- `plans/repo-human-traceability-program-execution-plan.md`.

It may not change production code, tests, configuration, dependencies,
workflows, performance tooling, performance artifacts, thresholds, or any
closure receipt. It may not run, prepare, pool, compare, or evaluate a
performance workload. It stops before merge.

## 2. Evidence Sources And Non-Circularity

The ledger reads immutable evidence already produced by planning PR #95,
plan-only amendments #125, #127, #129, and #131, implementation PRs #103,
#151, #155, and #209, their recorded merge and workflow envelopes, the final
Git history, and the authenticated closure receipt. It does not recreate
evidence that was absent at publication time.

The complete approved planning authority is:

| Pull request                                                              | Approved plan blob                         | Resulting main                             |
| ------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| [#95](https://github.com/intact-software-systems/ar-eye-hunter/pull/95)   | `c9b5e92686ebbc5d4ff136dbea678c93fea1579f` | `3fa0c94b748281dc326b814e700c06f6c4dd9d07` |
| [#125](https://github.com/intact-software-systems/ar-eye-hunter/pull/125) | `f83cc311369fff2bf255116253ec0f4fe911a43f` | `fccda1c6d3dd3114b50775a78b83c4e788bb7043` |
| [#127](https://github.com/intact-software-systems/ar-eye-hunter/pull/127) | `ef3cb7c7faeb9757a03ef6c39ca589cacdffa9cc` | `df8346aaf39e8d8730e73a530da3e6f182aa071b` |
| [#129](https://github.com/intact-software-systems/ar-eye-hunter/pull/129) | `b6fd5aebfa77ee489e65fa30fbee165e033c14f9` | `c7d6d4ec017edb23de239bba18c6d79f2ebb5dac` |
| [#131](https://github.com/intact-software-systems/ar-eye-hunter/pull/131) | `cf4d92db310c928b2e020f926efa4f731a2fd3b6` | `5e892aaff06cce0d994fbf79cfbcc12b235c7e48` |

Those amendments remain historical planning inputs. They authorize no new
benchmark, measurement, comparison, evaluation, tooling change, or performance
claim in this ledger.

The ledger must preserve these classifications:

- PR A's resulting-main distributed failure remains a closure deviation.
- PR B's accepted one-candidate performance disposition remains exact,
  including the retained block-2 evaluator failure.
- PR C's failed Branch Release and review-record runs remain failed; no PR C
  performance position was consumed, and the later performance work remains
  explicitly skipped without a pass claim.
- PR D's immutable publication deviation remains accepted for closure purposes
  without becoming a pass.
- The ledger's own future commit, tree, pull-request result, release gate,
  merge, and default-branch workflow cannot appear as completed evidence in the
  tree that produces them.

### 2.1 Existing issues and exact-base close-out

- [#153](https://github.com/intact-software-systems/ar-eye-hunter/issues/153)
  remains open and separately owns the CodeQL scope-isolation classification;
  this ledger neither resolves nor absorbs it.
- [#188](https://github.com/intact-software-systems/ar-eye-hunter/issues/188)
  remains open provider/deployment history unrelated to this evidence-only
  slice.
- [#207](https://github.com/intact-software-systems/ar-eye-hunter/issues/207)
  is closed by merged PR #210 and remains historical closure-receipt policy
  evidence only.
- [#211](https://github.com/intact-software-systems/ar-eye-hunter/issues/211)
  remains open. Its lifecycle-design alternative applies to the exact-base
  close-out failure; this plan records but does not implement that policy.

Exact base `8ee348e215a3e30d9b4959ce90369aea1b55b620` has failed **Deploy Web +
API** run
[31727393040](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31727393040),
attempt 1. The root CI suite reported 7,315 passed, five skipped, and one failed
test out of 7,321. The navigation-evidence scenario failed because the
standalone closed tree had neither an active plan nor the exact authenticated
last-plan-close-out diff. That is a failed default-branch close-out workflow,
not a pass and not a topology behavior regression. Initializing this separately
authorized active plan makes current plan navigation valid; it does not rewrite
the historical run.

After branch publication, remote `main` advanced to
`124e09924f1b20682f1a9407a0c3c91a2bfeeaff`, tree
`9d058d1045eb314b5d7bffa718464fef1f6db14c`, through PR #212. The exact range
from the authorized base changes only
`plans/rallar-bb-test-distributed-assertion-parity-plan.md`; it does not touch
this plan, the generated registry, either reciprocal program record, the
closure receipt, topology ownership, or the evidence sources. Compatibility
result: **Compatible — no plan delta**. This branch intentionally retains the
human-authorized diff base `8ee348e2`; GitHub targets the advanced `main` and
can preserve the unrelated plan change without widening this slice.

### 2.2 Planning and implementation ledger

| Stage                                                                            | Immutable evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Disposition                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Planning                                                                         | PR #95 feature `73097dae41e3f1c0f70e453684931144c526a5d1` merged as `3fa0c94b748281dc326b814e700c06f6c4dd9d07`; the exact approved plan blob and four later approved amendment blobs are listed above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Historical planning authority is complete. Plan-only deployment failures are not implementation evidence.                                                                                                                                                                                                                                                                            |
| PR A — [#103](https://github.com/intact-software-systems/ar-eye-hunter/pull/103) | Final feature `d86524adc051ab0b64cae160eb3a847f75d59d7a`, tree `fd8069eddc01f6a4784bc9a7a06b3e808f3aed5d`; Branch Release Gate `31337007511` succeeded; merge `cd69565936d881c960dbe151cfe48917a4a2e1bb` has the same tree. Exact resulting-main Hetzner run `31358158337` failed in `05a-rtc-realtime-stability-2-agent-5s` without an exact-SHA successful rerun.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Integrated with an explicit closure deviation. The governed comparison remains failed historical evidence: shared throughput moved adversely by `5.068999%`, and shared PostgreSQL transaction duration moved adversely by `3.088188%` without the required pre-recorded reason. Later human disposition did not turn that evidence into a pass.                                     |
| PR B — [#151](https://github.com/intact-software-systems/ar-eye-hunter/pull/151) | Feature `17f9c237afd9fb006776aaa0335b86e1cb650c88`, tree `7199b061bf1a6fe3abb9c83c02313f5a676a6a5b`; measured base `cc98414867f22cc28f0137ef40a1887ab862f87d`, tree `6c071954df939b7dea9ba59aa5116fe7922a6cab`; envelope SHA-256 `27a9c8e8acdcaa8f1d737ced31a46708a973c0f92e586526b3c7369467f12ae6`; merge `1e5f5e55e6ff94c016bfe2cc11af92952a30e32f`; Branch Release Gate `31431692263` and resulting-main Hetzner `31432113008` succeeded.                                                                                                                                                                                                                                                                                                                                                                                                                         | Complete. The accepted one-candidate disposition remains exact and retains the block-2 child-evaluator failure honestly; it is not extended to PR C or D.                                                                                                                                                                                                                            |
| PR C — [#155](https://github.com/intact-software-systems/ar-eye-hunter/pull/155) | Feature `8ec6b8150850d1b7a653d7e6552cb81528e5090a` and merge `bbcec6b9413678d85d0c97f63b18bb4216b5d767` share tree `a272104e0c7638165867e8431cec9afa21870c30`. Medium-scale run `31576056918`, topology-replay run `31576056919`, and resulting-main Hetzner run `31580601865` succeeded. Branch Release Gate `31576055172` and review-record runs `31576055103` and `31580589561` failed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Integrated with publication deviations. No warmup or governed performance position was consumed. Every prepared envelope remains superseded historical preparation; the human skipped the remaining PR C performance work on 2026-08-13 without a pass claim.                                                                                                                        |
| PR D — [#209](https://github.com/intact-software-systems/ar-eye-hunter/pull/209) | Actual base `939d63d28a1cf8dac0f3610415152074aa941db0`, tree `bc5720b20811cd047b58f7233ab9657fce321621`; final feature `5f415783f365fde844f7868e22ce81681d7e0ba9`, tree `7b0bf26652d3183f8da013903291913b5d4f09eb`; merge `44cda16e4633a27d4315dc3a3eb41405651e39c3` has the same tree. Branch Release Gate [31723292697](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31723292697), attempt 1, succeeded on the exact feature head. PR Human Review Record [31723552393](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31723552393), attempt 1, failed because the immutable PR body remained bound to the pre-rebase reviewed head/tree. Resulting-main Hetzner [31723602513](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31723602513), attempt 1, succeeded on exact merge `44cda16e`. | Integrated with the human-accepted immutable publication deviation for closure purposes. Exact rebased content review reported Critical 0 and Important 0, while publication review retained one Important stale-evidence finding. Neither the human merge nor later successful gates relabels the review-record failure as a pass. No PR D performance work existed or is inferred. |
| Authenticated close-out                                                          | Direct human commit `8ee348e215a3e30d9b4959ce90369aea1b55b620`, tree `a4b05fe3c16fff6092efad40335ab2d5b371eb96`, deleted the old plan, added receipt blob `6ccfdc10740aca349961959eb7752430c660b800`, and emptied the generated active-plan registry. Receipt plan digest is `9016fa3cd8521609fd8ef27d8e16d459b4c8c6a072b2e68e271b7973b535eb85`; receipt file SHA-256 is `89dbf8e59f4639841aeaa960cf2f2d5c01f362e70903de2c33e2ef5e693294b5`.                                                                                                                                                                                                                                                                                                                                                                                                                         | Immutable historical close-out. This new plan neither edits the receipt nor restores the closed plan.                                                                                                                                                                                                                                                                                |

### 2.3 Navigation, compatibility, and semantic evidence

The durable production README traces five families: config/override mutation,
explicit reconfigure, query/planning, maintenance/expiry, and downstream RTC
publication. Each trace names ingress, authority, read/compute/validate/write,
transaction or read exits, retry and terminal failure, cleanup, caller result,
and canonical versus compatibility path. The controlled human comparison is
explicitly waived because no valid Task 1 sample exists. No time, wrong-file,
compatibility-hop, unresolved-question, productivity, causal, or statistical
claim is inferred.

The final move baseline is 31 tracked predecessor files, 26 test modules, 85
`it`/`test` callsites, and 356 `expect` callsites. Historical 13-file, 68-case,
281-assertion evidence remains unchanged historical evidence. PR D focused
validation passed 24 files with three opt-in files skipped and 123 tests with
five opt-in tests skipped. PostgreSQL integration evidence covered 12 files and
25 tests; the four directly affected concurrency modules covered seven tests.

Canonical package and API composition imports point to the production owner;
replay imports planning symbols from their declaration owner; the public
management facade and `AppGroupInboxService` export remain direct compatibility
boundaries; and nine deleted private predecessor owners remain absent. No
public or persisted contract, authority, transaction, retry, receipt, outbox,
reconfiguration, planning, replay, or downstream publication behavior changed.

### 2.4 Warning dispositions

Final warning-only modes reported default/construction/layout/layout-details/
output-contract/object-interface counts of `43/44/0/0/39/40`. The union is 49
displayed rows, with the identical grouped durable-command unknown summary
counted twice. The two materially changed PR C style owners contributed zero
rows after correction. The retained rows keep these exact owners:

| Owner                                                             | Retained disposition                                                                                           |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `config/maintenance/migrate-legacy-group-topology-config-keys.ts` | Two unknown-boundary rows remain at the raw legacy JSON normalization boundary.                                |
| `config/mutation/group-topology-config-mutation-contracts.ts`     | One rename-alias row remains exported contract debt; changing the API is outside this ledger.                  |
| `config/mutation/topology-config-mutation-boundary.ts`            | Six unknown rows remain at the untrusted input boundary and are narrowed before computation.                   |
| `config/persistence/decode-stored-group-topology-config.ts`       | Six unknown rows remain at the persisted JSON decoder boundary.                                                |
| `config/persistence/group-topology-config-persistence-codec.ts`   | Five unknown, two input-contract, and one responsibility-count rows remain cohesive codec debt.                |
| `config/persistence/group-topology-config-storage-keys.ts`        | One responsibility-count and three pass-through rows retain topology slot vocabulary over shared key encoding. |
| `config/persistence/read-exact-group-topology-config-mutation.ts` | Seven unknown and one input-contract rows remain at the exact persisted-read boundary.                         |
| `inbox/topology-app-inbox-authority.ts`                           | Two unknown rows remain at authenticated durable-proof decoding and verification.                              |
| `inbox/topology-app-inbox-command.ts`                             | Seven unknown and one pass-through rows retain exact durable-command narrowing and validation.                 |
| `rallar-rtc-topology-metrics.ts`                                  | One object-interface row remains separately owned untouched RTC metrics debt.                                  |
| `replay/rtc-topology-reconnect-hydrator.ts`                       | One cognitive-load row remains untouched RTC lifecycle debt at score 80.                                       |
| `replay/rtc-topology-replay-service.ts`                           | One cognitive-load row remains untouched replay lifecycle debt at score 80.                                    |
| `replay/rtc-topology-work-codec.ts`                               | One pass-through row remains the named QueueBox context identity and decode-equality protocol boundary.        |

No warning row changed or worsened in the final slice, and no compatibility or
style exception was added.

### 2.5 Supplementary-ratchet decisions

| Ratchet                              | Ledger decision                                                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Focused source/style snapshot        | Retain. This plan cannot edit code or tests. Removal requires a separately authorized code change that relocates every protected semantic and size assertion to permanent owners before deleting the temporary snapshot. |
| Exact per-PR structural lineage      | Retain as immutable Git history and the authenticated old-plan digest. No replacement private-path manifest is added.                                                                                                    |
| Test ownership inventory             | Retain the historical 13/68/281 and final 31/26/85/356 facts through the existing snapshot until the separately authorized removal condition above is satisfied.                                                         |
| Consumer compatibility inventory     | Replaced for active execution by permanent export-identity, direct-import, API-composition, and deleted-private-path tests; no extra ledger ratchet is needed.                                                           |
| README path/primary-symbol integrity | Retain permanently as the `repository-navigation-v1` owner and repository-structure input.                                                                                                                               |

Semantic and concurrency tests remain primary. These supplementary decisions
authorize no cleanup in this plan.

### 2.6 Performance and distributed-validation disposition

No performance command is authorized or run by this ledger. PR A's failed
governed result and PR B's accepted one-candidate disposition remain bound to
their original candidates and envelopes. PR C's unconsumed work remains
skipped, not passed. PR D has no performance record.

PR D's plan-selected resulting-main distributed obligation is satisfied only
by successful exact-merge run `31723602513`. The current evidence-only changed
paths introduce no distributed product risk and do not select a new recipe or
fleet run. The ledger's own remote publication follows only the gates selected
for its exact final head; no future result is fabricated in advance.

## 3. Sole Slice: `publish-later-evidence-ledger`

- [x] Complete one independent initial read-only review of the evidence
      hypothesis, owner, source records, reciprocal update surface, focused
      commands, and sole slice.
- [x] Record the planning and PR A-D evidence already existing at the exact
      base, including every immutable success, failure, waiver, and human
      closure disposition.
- [x] Record warning dispositions, the controlled-human-sample waiver,
      compatibility owners, supplementary-ratchet decisions, semantic and
      concurrency coverage, and the no-performance disposition.
- [x] Update both reciprocal program records from stale drafted/unapproved
      topology state to closed implementation plus active evidence-ledger
      publication state.
- [x] Preserve the old receipt and deleted plan history byte-for-byte.
- [x] Complete the adaptive slice, write and apply the five checkpoint
      judgments, and expose no second slice.
- [ ] Obtain independent final plan/legacy review with Critical 0 and Important
      0 on the exact final head.
- [ ] Run proportional plan, structure, review, formatting, and publication
      gates on an unchanged tree; publish one pull request and stop before
      merge.

## 4. Initial Evidence Hypothesis

The production owner remains
`packages/shared-server/rallar-system/topology`, with
`group-topology-management-service.ts` as the canonical management entry,
`packages/tests/shared-server/rallar-system/topology` as the recognized mirror,
`npm run test:group-topology` as the focused capability command, and the
production-root README as the durable navigation owner. This evidence plan
does not reopen or modify those owners.

The ledger owner is the adaptive-plan lifecycle. Its canonical entry is
`scripts/plan-adaptation.mjs`; the focused command is
`npm run test:plan-adaptation`; and `scripts/plan-adaptation/README.md` is the
navigation owner. Existing repository-structure governance is the second
unchanged capability owner because it validates active-plan declarations and
stored navigation scenarios through `scripts/repo-structure-check.mjs`,
`npm run test:repo-structure`, and its README. The two program plans are exact
non-code contracts because they are the only reciprocal records that can
transition the topology child to ledger publication without touching
historical closure evidence.

## 5. Validation And Publication Contract

Focused validation begins with `npm run test:plan-adaptation` and
`npm run test:repo-structure`. Final local validation includes the read-only adaptive check,
repository adaptive governance, repository structure, PR review metadata,
validation-evidence and distributed-risk policy where selected, Prettier for
the four allowed paths, and `git diff --check`.

This is a plan-only evidence publication. No local product build, unit suite,
CI suite, distributed recipe, or performance command is justified by the
changed paths. Remote publication still follows the current repository policy
selected by the exact pull-request head. Every failed-then-passed command is
retained in the ledger; no rerun erases the failure.

Initial validation history is explicit: the first repository-structure suite
after adding that owner failed one of 116 tests because four cross-owner
plan-adaptation fact contracts were absent. After declaring the exact facts
named by the repository-structure README, the immediate complete rerun passed
116 of 116. The independent initial re-review accepted that correction and the
exact default-branch count above with Critical 0 and Important 0.

## 6. Adaptive Execution Record

```plan-adaptation-v1
{
  "version": 1,
  "planId": "rallar-group-topology-evidence-ledger",
  "status": "postponed",
  "goal": "Publish the already-existing group-topology implementation and closure evidence into one non-circular ledger without code or performance changes.",
  "acceptanceCriteria": [
    "Only the new plan, generated plan registry, and two reciprocal program planning records change.",
    "The existing closure receipt remains byte-identical and the deleted implementation plan remains deleted historical evidence.",
    "Planning and PR A-D evidence retains every exact success, failure, waiver, and closure disposition without relabeling a deviation as a pass.",
    "Warning, controlled-sample, compatibility, supplementary-ratchet, semantic-coverage, distributed-validation, and no-performance dispositions are explicit.",
    "The sole publish-later-evidence-ledger slice completes with an empty next horizon and independent review reports Critical 0 and Important 0.",
    "One non-default-branch pull request is publication-ready under current repository gates and remains unmerged."
  ],
  "capabilities": [
    {
      "owner": "plan adaptation",
      "root": "scripts/plan-adaptation",
      "entry": "scripts/plan-adaptation.mjs",
      "testRoot": "packages/tests/repo/plan-adaptation",
      "focusedCommand": "npm run test:plan-adaptation",
      "navigationMap": "scripts/plan-adaptation/README.md",
      "factContracts": [],
      "contractPaths": [
        "plans/repo-human-traceability-refactoring-program-plan.md",
        "plans/repo-human-traceability-program-execution-plan.md"
      ],
      "controlFlowFamilies": [
        "plan initialization",
        "evidence-ledger reconciliation",
        "checkpoint application",
        "plan close-out"
      ]
    },
    {
      "owner": "repository structure",
      "root": "scripts/repo-structure-check",
      "entry": "scripts/repo-structure-check.mjs",
      "testRoot": "packages/tests/repo/repo-structure-check",
      "focusedCommand": "npm run test:repo-structure",
      "navigationMap": "scripts/repo-structure-check/README.md",
      "factContracts": [
        "scripts/plan-adaptation/active-plan-registry.mjs",
        "scripts/plan-adaptation/adaptive-plan-record.mjs",
        "scripts/plan-adaptation/plan-change-facts.mjs",
        "scripts/plan-adaptation/plan-closure-receipt.mjs",
        "scripts/repo-style-check/structural-facts.mjs"
      ],
      "controlFlowFamilies": [
        "structural scan",
        "capability declaration validation",
        "navigation evidence"
      ]
    }
  ],
  "architecture": {
    "currentHypothesis": "The prior implementation plan is authentically closed, but its reciprocal program records still describe the topology child as drafted and unapproved.",
    "intendedHypothesis": "One new evidence-only plan reconciles immutable planning and PR A-D facts into both reciprocal program records while preserving the prior closure receipt and deleted-plan history.",
    "freshInitialReview": {
      "status": "complete",
      "reviewer": "group_topology_reviewer",
      "verdict": "pass; Critical 0; Important 0",
      "findings": [
        "I1: declare repository structure so its complete focused suite can validate stored navigation scenarios.",
        "I2: include planning amendments PRs #125, #127, #129, and #131 as immutable source authority.",
        "I3: record issues #153, #188, #207, #211 and failed exact-base Deploy Web + API run 31727393040."
      ],
      "disposition": "All three Important findings were resolved before reciprocal program implementation. The first corrected repository-structure run failed 1/116 for four omitted cross-owner fact contracts; after adding the exact README-declared facts, the complete rerun passed 116/116 and independent re-review passed."
    }
  },
  "completedSlicesSinceCheckpoint": [],
  "facts": {
    "diffBase": "8ee348e215a3e30d9b4959ce90369aea1b55b620",
    "affectedCodeDigest": "974e5278725f96bd7bf35789bed06e8a790f08a236e2d25c348e27a7b2c8240e",
    "computedTriggers": [
      "folder-change",
      "ownership-change",
      "public-contract-change",
      "scope-growth"
    ],
    "undeclaredChangedPaths": [
      "apps/api-v1/resources/api-v1-openapi.yaml",
      "apps/api-v1/src/group-state/README.md",
      "apps/api-v1/src/group-state/group-state-route-errors.ts",
      "apps/api-v1/src/group-state/register-group-admission-routes.ts",
      "apps/api-v1/src/group-state/register-group-membership-routes.ts",
      "apps/api-v1/src/group-state/register-group-presence-routes.ts",
      "apps/api-v1/src/main.ts",
      "apps/api-v1/src/middleware-contract.ts",
      "apps/api-v1/src/middleware.ts",
      "apps/api-v1/src/runtime/group-formation/group-capacity-config.ts",
      "apps/api-v1/src/runtime/group-formation/group-state-dissemination-config.ts",
      "apps/api-v1/src/services/group-admission-rate-limit.ts",
      "apps/api-v1/src/services/group-state-service.ts",
      "apps/api-v1/test/db/pglite-app-inbox-ws-close-convergence.test.ts",
      "apps/api-v1/test/db/pglite-sql-adapter.test.ts",
      "apps/api-v1/test/group-capacity-config.test.ts",
      "apps/api-v1/test/group-state-dissemination-config.test.ts",
      "apps/api-v1/test/group-state/group-admission-rate-limit-routes.test.ts",
      "apps/api-v1/test/rallar-server.test.ts",
      "apps/api-v1/test/services/group-admission-rate-limit.test.ts",
      "docs/environment-variables.md",
      "packages/shared-server/rallar-system/formation-metrics.ts",
      "packages/shared-server/rallar-system/formation-metrics/formation-metrics.ts",
      "packages/shared-server/rallar-system/group-policy.ts",
      "packages/shared-server/rallar-system/group-state/README.md",
      "packages/shared-server/rallar-system/group-state/group-mutation-authority.ts",
      "packages/shared-server/rallar-system/group-state/group-state-service-contracts.ts",
      "packages/shared-server/rallar-system/group-state/group-state-service.ts",
      "packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts",
      "packages/shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts",
      "packages/shared-server/rallar-system/group-state/mutation/membership/compute-group-membership-mutation.ts",
      "packages/shared-server/rallar-system/group-state/mutation/membership/group-membership-mutation-policy.ts",
      "packages/shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts",
      "packages/shared-server/rallar-system/group-state/presence/group-presence-summary-work.ts",
      "packages/shared-server/rallar-system/rtc-topology/inbox/rtc-rtt-app-inbox-contracts.ts",
      "packages/shared-server/rallar-system/services/AppGroupInboxService.ts",
      "packages/shared-server/rallar-system/state-sync-publisher.ts",
      "packages/shared-server/rallar-system/state-sync-routing.ts",
      "packages/shared-server/rallar-system/state-sync/state-sync-payload.ts",
      "packages/shared-server/rallar-system/state-sync/validate-state-sync.ts",
      "packages/shared-test/black-box-runner/README.md",
      "packages/shared-test/black-box-runner/http/normalize-black-box-response-headers.ts",
      "packages/shared-test/black-box-runner/recipe-matrix.json",
      "packages/shared-test/black-box-runner/tests/api-v1/api-v1-group-join-admission.json",
      "packages/shared-test/black-box-runner/tests/api-v1/api-v1-group-state-reconnect-resync.json",
      "packages/shared-test/black-box-runner/tests/api-v1/api-v1-group-topology-late-joiner.json",
      "packages/shared-web/browser/data-caches.ts",
      "packages/shared-web/browser/middleware.ts",
      "packages/shared-web/browser/rooms/room-events.ts",
      "packages/shared-web/browser/state-cache/README.md",
      "packages/shared-web/browser/state-cache/group-state-delta-application.ts",
      "packages/shared-web/browser/state-read/diagnostics.ts",
      "packages/shared-web/browser/state-read/group-state-resync-on-reopen.ts",
      "packages/shared-web/browser/state-read/hydrate-group-topology-overlays.ts",
      "packages/shared/api/README.md",
      "packages/shared/api/group-state-delta.ts",
      "packages/shared/rtc/group-formation-metrics.ts",
      "packages/shared/services/WsQueueBoxServerService.ts",
      "packages/shared/services/ws-queue-box-server-contracts.ts",
      "packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts",
      "packages/tests/shared-server/admin-operations-service.test.ts",
      "packages/tests/shared-server/direct-resource-outbox.test.ts",
      "packages/tests/shared-server/formation-metrics.test.ts",
      "packages/tests/shared-server/group-policy.test.ts",
      "packages/tests/shared-server/group-state-delta-audience-routing.test.ts",
      "packages/tests/shared-server/group-state/presence/group-presence-concurrency.test.ts",
      "packages/tests/shared-server/group-state/presence/group-presence-summary-dissemination-emission.test.ts",
      "packages/tests/shared-server/group-state/presence/group-presence-summary-formation-metrics.test.ts",
      "packages/tests/shared-server/group-state/presence/group-presence-summary-validation.test.ts",
      "packages/tests/shared-server/group-state/presence/group-presence-summary-work.test.ts",
      "packages/tests/shared-server/group-state/presence/group-state-delta-envelope.test.ts",
      "packages/tests/shared-server/group-state/snapshot/group-state-snapshot-read-through-cache.test.ts",
      "packages/tests/shared-test/recipe-matrix.test.ts",
      "packages/tests/shared-web/data-caches.test.ts",
      "packages/tests/shared-web/group-state-delta-application.test.ts",
      "packages/tests/shared-web/group-state-resync-on-reopen.test.ts",
      "packages/tests/shared-web/group-topology-read-through.test.ts",
      "packages/tests/shared-web/rooms/room-event-test-runtime.ts",
      "packages/tests/shared-web/rooms/room-events-subscription.test.ts",
      "packages/tests/shared/ws-outbox-owner-miss-retry.test.ts",
      "plans/rallar-bb-test-distributed-assertion-parity-plan.md",
      "plans/rallar-group-formation-phase3-delta-dissemination-plan.md",
      "playground/rtc-design/baselines/2026-08-13-phase3-delta-dissemination-results.md",
      "scripts/perf/api-v1-state-write-concurrency-bench.ts"
    ]
  },
  "checkpoint": {
    "outcome": "The sole publish-later-evidence-ledger slice records complete planning and PR A-D facts, updates both reciprocal program records, and preserves the authenticated receipt and deleted implementation plan without code or performance changes.",
    "learning": "Evidence-ledger publication must keep successful correctness gates, failed publication evidence, human closure deviations, waived navigation sampling, retained ratchets, and skipped performance work as distinct non-circular facts; remote main movement through PR #212 changes none of those contracts.",
    "structure": "Plan adaptation owns the active record and generated registry, repository structure owns capability and navigation validation, and exactly two declared non-code contracts own reciprocal program reconciliation; the completed plan exposes no second slice.",
    "decision": "continue",
    "nextSlices": []
  },
  "structuralDispositions": [],
  "freshStructuralReview": null,
  "coldNavigationEvidence": null,
  "materialDecisions": [
    {
      "date": "2026-08-13",
      "decision": "continue",
      "summary": "The sole publish-later-evidence-ledger slice records complete planning and PR A-D facts, updates both reciprocal program records, and preserves the authenticated receipt and deleted implementation plan without code or performance changes."
    },
    {
      "date": "2026-08-14",
      "decision": "postpone",
      "summary": "Postpone while configurable multi-plan governance replaces the shared plan-adaptation ownership boundary."
    }
  ]
}
```
