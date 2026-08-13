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
control-plane paths.

## Starting evidence

- Base commit: `8ee348e215a3e30d9b4959ce90369aea1b55b620`.
- Base tree: `a4b05fe3c16fff6092efad40335ab2d5b371eb96`.
- Authoritative RTC plan blob: `c1edd59d9d57799f7b955013acf624a76312740f`.
- Roadmap blob: `1bca52cd619fb98e4800e10ee2896ff34c5febaa`.
- Group-topology closure receipt blob:
  `6ccfdc10740aca349961959eb7752430c660b800`.
- Between-plans `npm run plan:adapt -- check`: passed before this plan was
  created.

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
    }
  ],
  "architecture": {
    "currentHypothesis": "One private package owns RTC benchmark commands, accepted evidence lifecycle, workloads, standalone diagnostics, and mirrored tests, but its executable map and existing owners require a complete code-derived review.",
    "intendedHypothesis": "One private package remains the obvious owner while its README and capability tests expose direct entry-to-result navigation and every retained module owns one coherent measurement, protocol, lifecycle, or side-effect boundary.",
    "freshInitialReview": null
  },
  "completedSlicesSinceCheckpoint": [],
  "facts": {
    "diffBase": "8ee348e215a3e30d9b4959ce90369aea1b55b620",
    "affectedCodeDigest": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "computedTriggers": [],
    "undeclaredChangedPaths": []
  },
  "checkpoint": {
    "outcome": "Task 4B is activated on the verified base with one initial package capability hypothesis and no implementation edits.",
    "learning": "The approved reservation provides exactly two independently testable slices; repository truth and independent review must validate the declared owner before either slice begins.",
    "structure": "Keep the shared RTC benchmark as one private package while the code-derived trace tests whether its baseline, workload, standalone diagnostic, maintained diagnostic, and native browser control-flow families remain coherent subowners.",
    "decision": "continue",
    "nextSlices": [
      "complete-executable-trace-and-legacy-ledger",
      "separate-signaling-data-channel-topology-tests"
    ]
  },
  "structuralDispositions": [
    {
      "kind": "ownership-contract",
      "target": "packages/shared-rtc-bench",
      "disposition": "keep",
      "rationale": "Initial hypothesis only: the private package is the authorized RTC benchmark owner; actual code-derived trace and fresh review will decide whether existing internal owners remain coherent and navigable. Reopen if trace evidence shows copied RTC behavior, an owner outside the package, or an unresolvable mixed responsibility."
    }
  ],
  "freshStructuralReview": null,
  "coldNavigationEvidence": null,
  "materialDecisions": []
}
```
