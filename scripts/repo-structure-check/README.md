# Repository structure navigation map

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
  validation.
- Production singleton exceptions enter through
  [structure-exceptions.mjs#readStructureExceptions](./structure-exceptions.mjs#readStructureExceptions).
  [structure-exceptions.mjs#readRepositoryExceptionContext](./structure-exceptions.mjs#readRepositoryExceptionContext)
  binds a nonempty registry to the exact clean Git head and authenticated GitHub review; missing or
  ambiguous trust evidence fails closed.

## Declared cross-owner facts

The checker consumes, but does not own, four explicitly declared contracts:

- [active-plan-registry.mjs#readAdaptivePlans](../plan-adaptation/active-plan-registry.mjs#readAdaptivePlans)
  supplies the single active plan.
- [adaptive-plan-record.mjs#validateAdaptivePlanRecord](../plan-adaptation/adaptive-plan-record.mjs#validateAdaptivePlanRecord)
  validates its configuration before structure policy uses it.
- [plan-change-facts.mjs#computeAffectedCodeDigest](../plan-adaptation/plan-change-facts.mjs#computeAffectedCodeDigest)
  binds current structural dispositions to the affected-code surface.
- [structural-facts.mjs#collectRepositoryStyleFacts](../repo-style-check/structural-facts.mjs#collectRepositoryStyleFacts)
  remains the canonical owner of density, prefix-clustering, and file-size facts.

The command exits successfully only when no findings remain. Policy findings exit with status 1;
invalid configuration, unsafe filesystem state, or unavailable required trust evidence exits with
status 2. Mirrored semantic tests live under `packages/tests/repo/repo-structure-check/` and run
through `npm run test:repo-structure`.
