# Repository structure navigation map

```repository-navigation-v1
{
  "version": 1,
  "entry": {
    "path": "scripts/repo-structure-check.mjs",
    "symbol": "readInput"
  },
  "results": [
    {
      "path": "scripts/repo-structure-check.mjs",
      "symbol": "printResult"
    }
  ],
  "failures": [
    {
      "path": "scripts/repo-structure-check.mjs",
      "symbol": "toError"
    }
  ]
}
```

[scripts/repo-structure-check.mjs#readInput](../repo-structure-check.mjs#readInput) is the only
command entry. It resolves the content-bound comparison base and calls
[repository-structure-check.mjs#checkRepositoryStructure](./repository-structure-check.mjs#checkRepositoryStructure),
which returns sorted findings without choosing a folder layout for the agent.

## Control-flow families

- Authored inventory and material-change classification start at
  [repository-files.mjs#readRepositoryFiles](./repository-files.mjs#readRepositoryFiles).
  [repository-files.mjs#isMaterialChange](./repository-files.mjs#isMaterialChange) distinguishes
  material edits from unchanged renames and token-equivalent JavaScript or TypeScript changes.
- Topology checks converge in
  [repository-structure-check.mjs#collectSingletonFindings](./repository-structure-check.mjs#collectSingletonFindings)
  and
  [repository-structure-check.mjs#collectRedundantChainFindings](./repository-structure-check.mjs#collectRedundantChainFindings).
  [structural-dispositions.mjs#validateStructuralDispositions](./structural-dispositions.mjs#validateStructuralDispositions)
  requires an exact human disposition for current style or semantic-depth facts; it never selects
  `keep`, `split`, `move`, or `consolidate` itself.
- Capability ownership and cold-navigation evidence are validated by
  [capability-declarations.mjs#validateCapabilityDeclarations](./capability-declarations.mjs#validateCapabilityDeclarations).
  This is also the owner of entry, mirrored-test, focused-command, map-link, and source-symbol
  validation. Exact code-capability `contractPaths` are validated against repository inventory as
  non-code files and deliberately bypass source-symbol and topology rules. Guidance declarations
  validate either an existing skill entry or a first-class routing entry, plus mirrored contract
  tests, evaluation evidence, focused commands, and shared specialist contracts. Guidance router
  evidence remains repository inventory and deliberately bypasses authored-code topology and
  source-symbol rules.
- `--navigation-evidence <capability-owner>` selects one active code declaration, then
  [navigation-evidence.mjs#createRepositoryNavigationEvidence](./navigation-evidence.mjs#createRepositoryNavigationEvidence)
  validates this map's fenced contract and composes the digest-bound JSON evidence record. The
  mode reuses canonical capability-declaration and adaptive-facts validation, then validates the
  fenced navigation contract; it never runs topology policy or selects a structural disposition.
  During an authenticated last-plan close-out, it reads the declaration from the exact deleted
  base plan and re-authenticates the close-out after composing evidence.
- Production singleton exceptions enter through
  [structure-exceptions.mjs#readStructureExceptions](./structure-exceptions.mjs#readStructureExceptions).
  [structure-exceptions.mjs#readRepositoryExceptionContext](./structure-exceptions.mjs#readRepositoryExceptionContext)
  binds a nonempty registry to the exact clean Git head and authenticated GitHub review; missing or
  ambiguous trust evidence fails closed.

## Declared cross-owner facts

The checker consumes, but does not own, five explicitly declared contracts:

- [active-plan-registry.mjs#readAdaptivePlans](../plan-adaptation/active-plan-registry.mjs#readAdaptivePlans)
  supplies the single active plan and generated registry.
- [adaptive-plan-record.mjs#validateAdaptivePlanRecord](../plan-adaptation/adaptive-plan-record.mjs#validateAdaptivePlanRecord)
  validates its configuration before structure policy uses it.
- [plan-closure-receipt.mjs#readAuthenticatedPlanClosureChanges](../plan-adaptation/plan-closure-receipt.mjs#readAuthenticatedPlanClosureChanges)
  authenticates the exact last-plan close-out transition when no active plan remains. Repository
  structure and navigation evidence accept that transition only when the generated registry is
  empty and no other changed surface remains.
- [plan-change-facts.mjs#computeAffectedCodeDigest](../plan-adaptation/plan-change-facts.mjs#computeAffectedCodeDigest)
  binds current structural dispositions to the affected-code surface.
- [structural-facts.mjs#collectRepositoryStyleFacts](../repo-style-check/structural-facts.mjs#collectRepositoryStyleFacts)
  remains the canonical owner of density, prefix-clustering, and file-size facts.

The command exits successfully only when no findings remain. Policy findings exit with status 1;
invalid configuration, unsafe filesystem state, or unavailable required trust evidence exits with
status 2. Mirrored semantic tests live under `packages/tests/repo/repo-structure-check/` and run
through `npm run test:repo-structure`.
