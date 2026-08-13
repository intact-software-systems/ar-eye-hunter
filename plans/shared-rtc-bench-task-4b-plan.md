# Shared RTC Bench Task 4B Plan

## Scope

Complete only Task 4B, “Complete Code and Legacy Review,” from the authoritative
RTC performance plan. Production RTC, ontology implementation, Task 5/B04,
B05 capture, B06, B07, optimization, accepted baseline capture, and raw artifact
publication remain inactive.

Task 4B may change existing `packages/shared-rtc-bench/**` owners and package
configuration, create only the three authorized lifecycle tests, delete the
combined B01–B03 lifecycle test, and update the authoritative RTC plan and
cross-program roadmap with review/publication evidence. The adaptive plan,
generated registry, and final generated closure receipt are the only additional
control-plane paths. The human additionally approved one prerequisite
repository-structure consolidation in exactly
`scripts/repo-structure-check/capability-declarations.mjs` and
`packages/tests/repo/repo-structure-check/capability-declarations.test.ts`.
That correction may only recognize package-local test mirrors and validate the
declared workspace command against the existing package test script.

## Starting evidence

- Base commit: `8ee348e215a3e30d9b4959ce90369aea1b55b620`.
- Base tree: `a4b05fe3c16fff6092efad40335ab2d5b371eb96`.
- Authoritative RTC plan blob: `c1edd59d9d57799f7b955013acf624a76312740f`.
- Roadmap blob: `1bca52cd619fb98e4800e10ee2896ff34c5febaa`.
- Group-topology closure receipt blob:
  `6ccfdc10740aca349961959eb7752430c660b800`.
- Between-plans `npm run plan:adapt -- check`: passed before this plan was
  created.
- Package baseline: 29 test files and 274 tests passed before Task 4B edits.
- Post-activation compatibility review: `origin/main` advanced to
  `124e09924f1b20682f1a9407a0c3c91a2bfeeaff` through PR #212. Its only delta
  from the Task 4B base is
  `plans/rallar-bb-test-distributed-assertion-parity-plan.md`; generated
  `plans/README.md` on that main still lists no active adaptive plan, and no
  Task 4B package, governance-owner, authoritative-plan, or roadmap path
  changed. The branch remains on exact merge base
  `8ee348e215a3e30d9b4959ce90369aea1b55b620`; adaptive facts use that immutable
  diff base, and no compatibility rebase is warranted.

## Initial capability hypothesis

`packages/shared-rtc-bench/**` is one private measurement capability with an
accepted-baseline command entry and separately visible accepted-workload,
standalone-benchmark, maintained-diagnostic, and browser-lifecycle control-flow
families. Its README is the durable map from every executable entry to setup,
the measured production symbol, timing, validation/failure, output/cleanup, and
owning tests. Task 4B will test this hypothesis against actual code and will
amend it only at an adaptive checkpoint.

## Two-slice horizon

1. `complete-executable-trace-and-legacy-ledger`: trace every command and README
   executable through actual code and production call paths; record structural
   facts, findings, construction/runtime timelines, and the complete initial
   legacy ledger; correct in-scope Critical/Important findings that fit existing
   owners and preserve frozen contracts.
2. `separate-signaling-data-channel-topology-tests`: move every B01/B02/B03
   lifecycle assertion into the three authorized capability tests, prove
   assertion parity and focused RED/GREEN behavior, delete the combined test,
   and correct any remaining in-scope Critical/Important findings.

No third slice begins without `complete-slice`, `prepare`, `apply`, and `check`
at the required checkpoint.

## Review records

The complete executable trace, structural dispositions, finding ledger,
legacy ledger, assertion-parity proof, compatibility reviews, validation
evidence, and independent reviews will be added here as Task 4B evidence is
produced. No retained legacy item is final without the exact OWNER approval
sentence required by the authoritative RTC plan.

### Initial independent capability review — stopped before package edits

The separate reviewer evaluated exact base
`8ee348e215a3e30d9b4959ce90369aea1b55b620` and initial adaptive-record digest
`88ef03a11c9737acc194f5d42bd57acdb20d82c2dae4d389de12baced2e17e11`.
The two-slice horizon is appropriately bounded, but the declared capability
cannot pass current repository governance:

- **TASK4B-FINDING-001 — Critical, blocking:**
  `scripts/repo-structure-check/capability-declarations.mjs` recognizes only
  `packages/tests/shared-rtc-bench` or `tests/shared-rtc-bench` as test mirrors
  for `packages/shared-rtc-bench`, while the authoritative Task 4B reservation
  requires package-local tests under `packages/shared-rtc-bench/tests`.
  The same validator accepts only `npm run <root-script>` whose root script is
  exactly `vitest run <testRoot>`; Task 4B forbids root configuration and the
  repository has no matching script. Consequently `npm run
check:repo-structure` fails and exact navigation evidence for owner `shared
RTC benchmark package` fails closed. The README's missing source-symbol and
  canonical-entry links are separately correctable within the authorized
  package README, but those corrections cannot resolve the test-root/command
  failures.

The proposed prerequisite owner is the repository-structure governance
capability, with exact paths
`scripts/repo-structure-check/capability-declarations.mjs`,
`packages/tests/repo/repo-structure-check/capability-declarations.test.ts`.
Its narrow correction would recognize colocated tests for a private package
capability and validate the declared workspace command against the exact test
script in the capability root's existing `package.json`. Those
paths are outside Task 4B's authoritative reservation, so neither the
governance correction nor any RTC package edit begins without a specific human
plan/scope decision. Moving the RTC tests to a mirrored hierarchy was rejected
because it contradicts the exact authorized test paths and package ownership.

On 2026-08-13 the human replied `approved` to the exact two-path expansion.
The repository-structure governance capability now owns one prerequisite
consolidation slice. The two original Task 4B slices stay inactive until its
focused test, full governance test, repository structure check, and exact-owner
navigation evidence are green.

### Task 4B split checkpoint — blocked by singleton governance

The exact three authorized lifecycle tests were created, the combined test was
deleted, and focused RED/GREEN plus package validation proved assertion parity.
The resulting `npm run check:repo-structure` fails with seven
`topology.singleton-subtree` findings:

- `packages/shared-rtc-bench/diagnostics/rtt-group-scan`;
- `packages/shared-rtc-bench/tests/topology-delivery`;
- `packages/shared-rtc-bench/tests/topology-replay`;
- `packages/shared-rtc-bench/tests/workloads/data-channel`;
- `packages/shared-rtc-bench/tests/workloads/signaling`;
- `packages/shared-rtc-bench/tests/workloads/topology`; and
- `packages/shared-rtc-bench/topology-replay`.

It also reports sixteen `structure.semantic-depth` facts. Those sixteen have an
existing exact affected-code-digest disposition mechanism. The seven singleton
facts do not: the checker accepts only an authenticated static exception for
production code and deliberately refuses that exception for test topology. The
three exact test paths required by Task 4B are consequently impossible to make
green without a further governance decision; adding artificial sibling files,
moving the mandated tests, or undoing Important corrections would violate the
authorized reservation and the cognitive-indirection standard.

`TASK4B-FINDING-008` is therefore Critical and blocking. The proposed owner is
repository-structure governance, with the generic correction confined to
`scripts/repo-structure-check/repository-structure-check.mjs`,
`scripts/repo-structure-check/structural-dispositions.mjs`,
`scripts/repo-structure-check/README.md`,
`packages/tests/repo/repo-structure-check/repository-structure-command.test.ts`,
and
`packages/tests/repo/repo-structure-check/structural-dispositions.test.ts`.
The proposed rule would let an active adaptive plan satisfy a singleton fact
only with an exact target, sole-descendant identity, magnitude, current
affected-code digest, one explicit `keep`/`split`/`move`/`consolidate` judgment,
and a non-empty rationale. Static between-plan exception policy remains
unchanged. No implementation begins without explicit human approval for those
five paths and that behavior.

On 2026-08-13 the human explicitly approved that exact five-path expansion.
Focused RED failed the two new singleton-disposition assertions among 29 tests;
focused GREEN passes all 29, the full repository-structure suite passes all
120, and exact current-plan judgments now bind every one of the seven singleton
facts plus all sixteen semantic-depth facts to affected-code digest
`3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece`.
`npm run check:repo-structure`, exact navigation evidence for owner
`shared RTC benchmark package`, `npm run check:adaptive-governance`, and
`git diff --check` pass. Static between-plan exception policy is unchanged;
`TASK4B-FINDING-008` is corrected without artificial package files or moved
test owners.

### Final changed-style correction batch

The required changed-file style gate then exposed `TASK4B-FINDING-009` as an
Important completion blocker: one signaling module crossed the cognitive warn
tier because outcome classification was nested inside the common worker
callback, and removing two obsolete aliases left the finalized-reader and Deno
runtime modules with single factory exports that exposed unclear contract
ownership. The correction keeps every CLI, schema, timing, validation, and
output contract unchanged: outcome classification is a named flat decision,
the finalized-reader interface is declared by its implementation owner, and
the Deno runtime exports the actual confined storage root instead of a duplicate
runtime type. Focused signaling/reader/runtime tests pass 15/15, package
typecheck passes, and `npm run check:repo-style:changed -- origin/main` reports
no new findings.

### Final CI timing correction

The exact unchanged-tree `test:ci` gate reproduced
`TASK4B-FINDING-010` twice: the stored navigation-evidence scenario exceeded
Vitest's default five-second timeout at 5.56s and 6.09s only while the complete
817-file unit suite competed for resources. The same semantic test passed 8/8
alone, so changing production navigation behavior or its assertions would be
incorrect. On 2026-08-13 the human approved the exact additional path
`packages/tests/repo/repo-structure-check/navigation-evidence-command.test.ts`.
Only that synchronous external-command scenario now has a 15-second timeout;
its assertions, commands, and production owners are unchanged.

```plan-adaptation-v1
{
  "version": 1,
  "planId": "shared-rtc-bench-task-4b",
  "status": "active",
  "goal": "Make every shared RTC benchmark executable human-traceable, resolve all in-scope Critical and Important code or legacy findings, and separate B01, B02, and B03 lifecycle tests without changing frozen measurement or evidence contracts.",
  "acceptanceCriteria": [
    "Every README executable is traced from command entry through setup, measured production operation, timing, validation and first failure, output confinement and schema, cleanup, tests, dependencies, and caller-visible result.",
    "Every RTC-LEGACY-01 through RTC-LEGACY-12 item and every newly discovered in-scope candidate has exactly one authorized disposition with exact evidence, rationale, tests, and reopening or removal trigger.",
    "The combined B01-B03 test is replaced by exactly the three authorized signaling, data-channel, and topology lifecycle tests with old/new assertion parity and focused RED/GREEN proof.",
    "Repository structure governance recognizes the authorized package-local shared-rtc-bench test mirror and validates its exact workspace test command without adding a root script or moving tests.",
    "An independent final review of the exact corrected head reports zero unresolved Critical and zero unresolved Important findings.",
    "All required focused, package, repository, final unchanged-tree, draft-PR, and exact-head Branch Release Gate evidence is recorded without running held benchmark capture.",
    "Task 5/B04, B05 capture, B06, B07, production RTC changes, ontology implementation, optimization, and accepted baseline capture remain inactive."
  ],
  "capabilities": [
    {
      "owner": "shared RTC benchmark package",
      "root": "packages/shared-rtc-bench",
      "entry": "packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts",
      "testRoot": "packages/shared-rtc-bench/tests",
      "focusedCommand": "npm --workspace @ar-eye-hunter/shared-rtc-bench run test",
      "navigationMap": "packages/shared-rtc-bench/README.md",
      "factContracts": [],
      "contractPaths": [
        "docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md",
        "plans/rallar-architecture-quality-and-rtc-program-roadmap.md"
      ],
      "controlFlowFamilies": [
        "accepted baseline lifecycle",
        "accepted workload lifecycle",
        "standalone topology benchmark lifecycle",
        "maintained diagnostic lifecycle",
        "native browser lifecycle"
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
        "scripts/plan-adaptation/plan-closure-receipt.mjs",
        "scripts/plan-adaptation/plan-change-facts.mjs",
        "scripts/repo-style-check/structural-facts.mjs"
      ],
      "contractPaths": [],
      "controlFlowFamilies": [
        "repository inventory and material change classification",
        "topology and structural disposition validation",
        "capability declaration and navigation evidence validation",
        "structure exception trust validation"
      ]
    },
    {
      "owner": "plan adaptation",
      "root": "scripts/plan-adaptation",
      "entry": "scripts/plan-adaptation.mjs",
      "testRoot": "packages/tests/repo/plan-adaptation",
      "focusedCommand": "npm run test:plan-adaptation",
      "navigationMap": "scripts/plan-adaptation/README.md",
      "factContracts": [],
      "contractPaths": [],
      "controlFlowFamilies": [
        "adaptive record and capability policy",
        "content-bound change facts",
        "plan lifecycle and file transactions",
        "active plan registry generation",
        "authenticated plan closure"
      ]
    }
  ],
  "architecture": {
    "currentHypothesis": "One private package owns RTC benchmark commands, accepted evidence lifecycle, workloads, standalone diagnostics, and mirrored tests, but its executable map and existing owners require a complete code-derived review.",
    "intendedHypothesis": "One private package remains the obvious owner while its README and capability tests expose direct entry-to-result navigation and every retained module owns one coherent measurement, protocol, lifecycle, or side-effect boundary.",
    "freshInitialReview": {
      "status": "failed",
      "reviewer": "/root/initial_task4b_review",
      "verdict": "Critical TASK4B-FINDING-001 blocks the declared capability: the repository checker cannot represent the mandated package-local test root or workspace command within Task 4B's authorized paths. Stop before package edits and obtain a specific human plan/scope decision."
    }
  },
  "completedSlicesSinceCheckpoint": [],
  "facts": {
    "diffBase": "8ee348e215a3e30d9b4959ce90369aea1b55b620",
    "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
    "computedTriggers": [
      "folder-change",
      "ownership-change",
      "lifecycle-change"
    ],
    "undeclaredChangedPaths": []
  },
  "checkpoint": {
    "outcome": "Both authorized Task 4B slices and the required correction batches are complete: all 25 executable traces and 18 legacy dispositions are recorded, every discovered Critical or Important finding is corrected, the exact three capability tests preserve assertion parity, and focused package, style, structure, and adaptive gates are green.",
    "learning": "Removing obsolete aliases can expose a real ownership question even when runtime behavior is unchanged. Declaring the finalized-reader contract with its implementation and the Deno confinement root with its runtime preserves canonical types while making the side-effect boundary easier to find.",
    "structure": "Keep the shared RTC benchmark as one private package with explicit baseline, workload, standalone diagnostic, and maintained diagnostic subowners; keep the exact three lifecycle tests and their mirrored baseline runtime test owner; retain each current structural fact only under its digest-bound rationale and reopening trigger.",
    "decision": "continue",
    "nextSlices": []
  },
  "structuralDispositions": [
    {
      "kind": "ownership-contract",
      "target": "packages/shared-rtc-bench",
      "disposition": "keep",
      "rationale": "Initial hypothesis only: the private package is the authorized RTC benchmark owner; actual code-derived trace and fresh review will decide whether existing internal owners remain coherent and navigable. Reopen if trace evidence shows copied RTC behavior, an owner outside the package, or an unresolvable mixed responsibility."
    },
    {
      "kind": "ownership-contract",
      "target": "scripts/repo-structure-check",
      "disposition": "keep",
      "rationale": "The existing repository-structure capability already owns capability declarations, mirrored-test policy, focused-command validation, and navigation evidence. Extend that owner directly for colocated private-package tests; reopen if the correction requires a root script, moved tests, package-specific branching, or another governance owner."
    },
    {
      "kind": "ownership-contract",
      "target": "scripts/plan-adaptation",
      "disposition": "keep",
      "rationale": "Declare the existing plan-adaptation owner because stored repository-structure scenarios execute its exact navigation command during the governance suite. No plan-adaptation source is changed; reopen if Task 4B begins depending on or modifying its lifecycle policy."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-rtc-bench/baseline/acceptance",
      "identity": null,
      "magnitude": 2,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "Acceptance is a real baseline lifecycle boundary for sample failure accounting and accepted artifact persistence; flattening it into baseline would hide first-failure ownership. Reopen when acceptance no longer owns those two coupled protocol concerns."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-rtc-bench/baseline/command",
      "identity": null,
      "magnitude": 2,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "Command owns the baseline CLI entry, exact grammar, and option decoding as one caller boundary; its depth makes command ownership visible beside contracts and runtime. Reopen if another command family appears."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-rtc-bench/baseline/contracts",
      "identity": null,
      "magnitude": 2,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "Contracts owns accepted schemas, decoding, and validation shared by command, runtime, and evidence without owning side effects. Reopen on an unrelated schema family, not physical size."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-rtc-bench/baseline/evidence",
      "identity": null,
      "magnitude": 2,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "Evidence owns confinement, storage, finalization, checksum verification, statistics, and finalized reading for one accepted-evidence lifecycle. Reopen if a second artifact lifecycle gains independent entry and failure ownership."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-rtc-bench/baseline/runtime",
      "identity": null,
      "magnitude": 2,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "Runtime composes adapters, the accepted envelope, and observations behind the command without absorbing schema or storage ownership. Reopen if runtime begins choosing workload policy or another environment adapter family is introduced."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-rtc-bench/diagnostics/rtt-group-scan",
      "identity": null,
      "magnitude": 2,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "The maintained RTT group-scan comparison is one explicitly non-accepted diagnostic capability, separated from room-graph and traffic diagnostics by measured production call path and output. Reopen when it is removed or another scan owner appears."
    },
    {
      "kind": "current-fact",
      "ruleId": "topology.singleton-subtree",
      "target": "packages/shared-rtc-bench/diagnostics/rtt-group-scan",
      "identity": "packages/shared-rtc-bench/diagnostics/rtt-group-scan/rtc-rtt-group-scan-bench.ts",
      "magnitude": 1,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "One executable fully owns the historical-versus-indexed group scan; an artificial sibling would add indirection without a second responsibility. Remove the subtree when the comparison decision disappears, or split only if a distinct scan lifecycle emerges."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-rtc-bench/tests/architecture",
      "identity": null,
      "magnitude": 2,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "Architecture tests own package inventory, navigation, and boundary contracts rather than a workload behavior. Their dedicated folder keeps structural failures separate from benchmark semantics. Reopen when one contract changes owner."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-rtc-bench/tests/baseline/acceptance",
      "identity": null,
      "magnitude": 3,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "Acceptance tests mirror the production baseline/acceptance protocol and directly own first-failure plus persistence assertions. Flattening them would separate tests from their production capability map. Reopen if acceptance production ownership changes."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-rtc-bench/tests/baseline/runtime",
      "identity": null,
      "magnitude": 3,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "Runtime tests mirror the baseline/runtime composition owner and directly prove the confined Deno adapter boundary beside the envelope behavior. Flattening them would detach execution-environment assertions from their production owner; reopen if another runtime family appears."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-rtc-bench/tests/topology-delivery",
      "identity": null,
      "magnitude": 2,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "This test folder mirrors the standalone topology-delivery diagnostic owner and keeps PostgreSQL policy, statistics, and cleanup proofs outside accepted workload tests. Reopen if delivery becomes accepted evidence or gains a second lifecycle."
    },
    {
      "kind": "current-fact",
      "ruleId": "topology.singleton-subtree",
      "target": "packages/shared-rtc-bench/tests/topology-delivery",
      "identity": "packages/shared-rtc-bench/tests/topology-delivery/rtc-topology-delivery-log-performance-harness.test.ts",
      "magnitude": 1,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "The single focused harness coherently proves policy, statistics, and partial-registration cleanup for one standalone delivery command. Splitting assertions would create extra navigation hops without a second test responsibility."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-rtc-bench/tests/topology-replay",
      "identity": null,
      "magnitude": 2,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "This test folder mirrors the standalone replay operation-count owner, which is intentionally separate from accepted latency evidence and topology delivery. Reopen if replay gains an independent schema or lifecycle test family."
    },
    {
      "kind": "current-fact",
      "ruleId": "topology.singleton-subtree",
      "target": "packages/shared-rtc-bench/tests/topology-replay",
      "identity": "packages/shared-rtc-bench/tests/topology-replay/rtc-topology-replay-drain-performance-harness.test.ts",
      "magnitude": 1,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "The one harness owns exact operation counts and started-service cleanup for the one replay diagnostic. An additional file would divide one causal lifecycle; split only when a separately testable replay contract appears."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-rtc-bench/tests/workloads/data-channel",
      "identity": null,
      "magnitude": 3,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "The mandated data-channel test path mirrors workloads/data-channel and exposes B02 grammar, timing, lifecycle, adversarial, failure, and diagnostic-output assertions under one capability name. Reopen if B02 divides into independently owned protocols."
    },
    {
      "kind": "current-fact",
      "ruleId": "topology.singleton-subtree",
      "target": "packages/shared-rtc-bench/tests/workloads/data-channel",
      "identity": "packages/shared-rtc-bench/tests/workloads/data-channel/rtc-data-channel-benchmark-lifecycle.test.ts",
      "magnitude": 1,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "Task 4B explicitly requires this one B02 lifecycle owner, and assertion parity shows its cases form one data-channel capability. Creating a sibling solely for topology compliance would weaken navigation; split on a real second lifecycle only."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-rtc-bench/tests/workloads/signaling",
      "identity": null,
      "magnitude": 3,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "The mandated signaling test path mirrors workloads/signaling and exposes B01 grammar, counters, cleanup, identity, failure persistence, and diagnostic confinement together. Reopen when signaling acquires a separately owned protocol lifecycle."
    },
    {
      "kind": "current-fact",
      "ruleId": "topology.singleton-subtree",
      "target": "packages/shared-rtc-bench/tests/workloads/signaling",
      "identity": "packages/shared-rtc-bench/tests/workloads/signaling/rtc-signaling-benchmark-lifecycle.test.ts",
      "magnitude": 1,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "Task 4B explicitly requires this one B01 lifecycle owner, and its relocated assertions share signaling setup, cleanup, and failure semantics. An artificial sibling would obscure the capability; split only at a real ownership boundary."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-rtc-bench/tests/workloads/topology",
      "identity": null,
      "magnitude": 3,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "The mandated topology test path mirrors workloads/topology and exposes B03 graph, repository, inactive-state, adversarial, identity, and diagnostic assertions together. Reopen when one B03 family becomes a distinct accepted capability."
    },
    {
      "kind": "current-fact",
      "ruleId": "topology.singleton-subtree",
      "target": "packages/shared-rtc-bench/tests/workloads/topology",
      "identity": "packages/shared-rtc-bench/tests/workloads/topology/rtc-topology-benchmark-lifecycle.test.ts",
      "magnitude": 1,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "Task 4B explicitly requires this one B03 lifecycle owner, and parity proves the graph and repository assertions belong to the same topology capability. Split only if a future authorization establishes separate capability ownership."
    },
    {
      "kind": "current-fact",
      "ruleId": "topology.singleton-subtree",
      "target": "packages/shared-rtc-bench/topology-replay",
      "identity": "packages/shared-rtc-bench/topology-replay/replay-drain-operation-counts.ts",
      "magnitude": 1,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "One executable coherently owns deterministic replay-drain setup, production service execution, cleanup, operation-count validation, and output. Splitting this single command would fragment its lifecycle; reopen on a second replay command or schema."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-rtc-bench/workloads/data-channel",
      "identity": null,
      "magnitude": 2,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "Data-channel groups the four B02 measurements around the authoritative QRtcDataChannel lifecycle while each executable keeps its timing and validation local. Reopen when a workload stops sharing that production capability."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-rtc-bench/workloads/signaling",
      "identity": null,
      "magnitude": 2,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "Signaling groups the three B01 measurements around QRtcPeerConnection setup, cleanup, and diagnostics while preserving visible per-workload clocks and validators. Reopen on a new signaling authority boundary."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-rtc-bench/workloads/topology",
      "identity": null,
      "magnitude": 2,
      "affectedCodeDigest": "3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece",
      "disposition": "keep",
      "rationale": "Topology groups the six B03 measurements around production graph and RTT repository operations, with deterministic setup helpers adjacent and operationally inert. Reopen if setup begins owning production decisions or a workload gains independent lifecycle ownership."
    }
  ],
  "freshStructuralReview": null,
  "coldNavigationEvidence": {
    "status": "passed",
    "summary": "Exact generated navigation evidence for the declared shared RTC benchmark package owner resolves the canonical command entry, result owner, failure owner, colocated test root, exact workspace focused command, and README map on affected-code digest 3b03137e3986777fb256690b4df30329edd5a57caec55047eeb3ae5d456e8ece.",
    "probes": [
      {
        "capabilityOwner": "shared RTC benchmark package",
        "symbol": "runRtcBaselineCli",
        "path": "packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts"
      },
      {
        "capabilityOwner": "shared RTC benchmark package",
        "symbol": "createRtcBaselineEnvelope",
        "path": "packages/shared-rtc-bench/baseline/runtime/rtc-baseline-envelope.ts"
      }
    ]
  },
  "materialDecisions": [
    {
      "date": "2026-08-13",
      "decision": "stop",
      "summary": "Initial independent review found an invalid governance assumption. Task 4B remains activated but no package slice starts until repository-structure governance can honestly declare the mandated package-local tests and focused command under separately approved scope."
    },
    {
      "date": "2026-08-13",
      "decision": "stop",
      "summary": "Task 4B activation and initial independent capability review completed on the exact expected base, but no implementation slice began because current governance cannot validate the authorized package-local test ownership."
    },
    {
      "date": "2026-08-13",
      "decision": "consolidate",
      "summary": "The human approved the exact two-path repository-structure prerequisite, and the post-activation main advance changes only an unrelated inactive written plan, so Task 4B can repair its declaration without rebasing or starting RTC feature work.",
      "checkpointDigest": "af594cb8c8b9502d9275708dead08af4d5c17887c055abe688a9c5a6194379dd"
    },
    {
      "date": "2026-08-13",
      "decision": "continue",
      "summary": "The approved prerequisite is consolidated: repository structure governance now accepts an exact colocated package test mirror only when the declared workspace command resolves to that mirror, focused and full governance tests pass, and exact generated shared RTC benchmark navigation evidence passes."
    },
    {
      "date": "2026-08-13",
      "decision": "continue",
      "summary": "Both authorized Task 4B slices are complete: all 25 executable traces and 18 legacy dispositions are recorded, every discovered Critical or Important finding is corrected, the combined B01-B03 test is replaced by the three exact capability owners with assertion parity, and focused/package/structure/adaptive gates are green."
    },
    {
      "date": "2026-08-13",
      "decision": "continue",
      "summary": "Both authorized Task 4B slices and the required correction batches are complete: all 25 executable traces and 18 legacy dispositions are recorded, every discovered Critical or Important finding is corrected, the exact three capability tests preserve assertion parity, and focused package, style, structure, and adaptive gates are green."
    }
  ]
}
```
