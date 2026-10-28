// Reviewed recipe, assertion and report boundaries. Exact keys and caps remain local to each owner.
export const reviewedScenarioDispositions = Object.freeze([
    // Owner: Rallar shared-test maintainers; independently reviewed transform boundaries.
    // The module cap is the sum of five separately reviewed declarations, not a wildcard:
    // resolverRoot keeps heterogeneous authored/runtime leaves; remove when stores validate canonical values.
    // result keeps an optional raw envelope; remove when callers decode its full actual/body contract.
    // details.path retains invalid paths; remove when errors no longer retain raw operands.
    // details' index retains invalid operator operands; remove when a closed diagnostic union replaces them.
    // PathResolution.value proves presence only; remove when traversal admits only a validated value tree.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/scenario-transform/safe-output-transform-resolution.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
        maximumMagnitude: 5
    }),
    // Raw paths are string-validated here and selected leaves remain opaque for consuming operators.
    // Remove when paths arrive decoded and the entire result tree has a canonical validated contract.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/scenario-transform/safe-output-transform-resolution.ts',
        rule: 'boundary.unknown',
        symbol: 'resolveSafeOutputTransformPath',
        maximumMagnitude: 2
    }),
    // Exact replacement preserves original values while interpolation stringifies them.
    // Remove when exact replacement is restricted to a validated closed value contract.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/scenario-transform/safe-output-transform-resolution.ts',
        rule: 'boundary.unknown',
        symbol: 'resolveSafeOutputTransformTemplate',
        maximumMagnitude: 1
    }),
    // Generic rendering preserves raw selected values, including null and undefined.
    // Remove when every caller supplies a validated renderable contract with the same absence behavior.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/scenario-transform/safe-output-transform-resolution.ts',
        rule: 'boundary.unknown',
        symbol: 'stringifySafeOutputTransformValue',
        maximumMagnitude: 1
    }),
    // The object/nonarray guard proves a record, not validated JSON or a transform schema.
    // Remove when callers use closed decoded records and no longer need this generic guard.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/scenario-transform/safe-output-transform-resolution.ts',
        rule: 'boundary.unknown',
        symbol: 'isSafeOutputTransformRecord',
        maximumMagnitude: 1
    }),
    // Root assembly adds optional result/actual/body aliases without changing opaque leaves.
    // Remove when roots and interaction envelopes are validated before this assembly boundary.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/scenario-transform/safe-output-transform-resolution.ts',
        rule: 'boundary.unknown',
        symbol: 'toTransformResolverRoot',
        maximumMagnitude: 1
    }),
    // Template traversal preserves arbitrary roots and selected values; absent paths throw.
    // Remove when traversal accepts and returns only canonical validated tree values.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/scenario-transform/safe-output-transform-resolution.ts',
        rule: 'boundary.unknown',
        symbol: 'resolvePath',
        maximumMagnitude: 2
    }),
    // String-path normalization cannot validate the raw root's arbitrary leaf contract.
    // Remove when shared traversal is restricted to canonical validated roots.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/scenario-transform/safe-output-transform-resolution.ts',
        rule: 'boundary.unknown',
        symbol: 'tryResolvePath',
        maximumMagnitude: 1
    }),
    // Projection validates arrays while preserving every raw leaf, order and nested shape.
    // Remove when all traversed values and projected leaves have one canonical validated tree type.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/scenario-transform/safe-output-transform-resolution.ts',
        rule: 'boundary.unknown',
        symbol: 'readPathSegments',
        maximumMagnitude: 2
    }),
    // Dynamic property selection preserves actual opaque JavaScript leaves and null/undefined absence.
    // Remove when closed validated object/array contracts prove each selected property's type.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/scenario-transform/safe-output-transform-resolution.ts',
        rule: 'boundary.unknown',
        symbol: 'readProperty',
        maximumMagnitude: 2
    }),
    // Maintainer-approved bounded cohesion exceptions (2026-09-20). Prior review
    // separated command derivation, retained evidence and cleanup; the service
    // keeps actual mutations, while each reload policy remains a complete decision.
    // These exact ceilings authorize no growth or other rule suppression.
    Object.freeze({
        path: 'apps/rallar-black-box-control-server/src/control-service.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 125
    }),
    Object.freeze({
        path: 'apps/rallar-black-box-control-server/src/recipe-reload/compute-control-recipe-reload-step.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 52
    }),
    Object.freeze({
        path: 'apps/rallar-black-box-control-server/src/recipe-reload/control-recipe-reload-commands.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 59
    }),
    Object.freeze({
        path: 'apps/rallar-black-box-control-server/src/recipe-reload/control-recipe-reload-evidence.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 64
    }),
    // Arbitrary authored/bound command metadata is narrowed to nonempty checkpoint
    // arrays with every required string before binder or checkpoint policy reads it.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts',
        rule: 'boundary.unknown',
        symbol: 'toAlmReloadCheckpoints'
    }),
    // Intentional malformed evidence stays raw while recordAt checks each traversed
    // record. Sanitizing NaN, missing fields or wrong identities would weaken the
    // assessor negatives; known transcript construction uses canonical typed values.
    Object.freeze({
        path: 'packages/tests/shared-test/alm-identity-assessment.test.ts',
        rule: 'boundary.unknown',
        symbol: 'recordAt'
    }),
    // The module-owned HTTP fixture captures Playwright options.data as unknown,
    // checks its record/commandId, then calls parseControlServerMessage before use.
    Object.freeze({
        path: 'packages/tests/rallar-black-box/full-stack-reload-pair.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Module-owned stats/reports and nested result are opaque fetched HTTP artifacts.
    // fetchControlRun does not validate their protocol: ALM consumers separately use
    // parseControlClientMessage and decodeALMObservationSnapshot before policy.
    // These exact owner reviews do not certify future unknown occurrences.
    Object.freeze({
        path: 'tests/playwright/rallar-black-box/full-stack-helpers.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Assertion and report controls validate raw configuration before decisions;
    // arbitrary values remain opaque at these exact operand and artifact owners.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/scenario-value-decoding.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeScenarioPositiveInteger'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/scenario-black-box.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 83
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/scenario-black-box.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/scenario-black-box.ts',
        rule: 'boundary.unknown',
        symbol: 'asRecord'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/scenario-black-box.ts',
        rule: 'boundary.unknown',
        symbol: 'stringValue'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/scenario-black-box.ts',
        rule: 'boundary.unknown',
        symbol: 'normalizeEventKindCaps'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/scenario-black-box.ts',
        rule: 'boundary.unknown',
        symbol: 'mergeRunStores'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/scenario-black-box.ts',
        rule: 'control.nested-callback-depth',
        symbol: undefined,
        maximumMagnitude: 3
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/artifacts/scenario-run-artifacts.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 55
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/artifacts/scenario-run-artifacts.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/artifacts/scenario-run-artifacts.ts',
        rule: 'boundary.unknown',
        symbol: 'asRecord'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/artifacts/scenario-run-artifacts.ts',
        rule: 'boundary.unknown',
        symbol: 'stringValue'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/artifacts/scenario-run-artifacts.ts',
        rule: 'boundary.unknown',
        symbol: 'normalizeEventKindCaps'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/artifacts/scenario-run-artifacts.ts',
        rule: 'boundary.unknown',
        symbol: 'incrementCount'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/artifacts/scenario-run-artifacts.ts',
        rule: 'boundary.unknown',
        symbol: 'toJsonLine'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/artifacts/scenario-run-artifacts.ts',
        rule: 'boundary.unknown',
        symbol: 'resultEvents'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/artifacts/scenario-run-artifacts.ts',
        rule: 'boundary.unknown',
        symbol: 'postRunAssertionEvents'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/artifacts/scenario-run-artifacts.ts',
        rule: 'boundary.unknown',
        symbol: 'keyedStoreEvents'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/artifacts/scenario-run-artifacts.ts',
        rule: 'boundary.unknown',
        symbol: 'artifactEvents'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/artifacts/scenario-run-artifacts.ts',
        rule: 'boundary.unknown',
        symbol: 'artifactEventsWithTruncation'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/artifacts/scenario-run-artifacts.ts',
        rule: 'boundary.unknown',
        symbol: 'failureBundle'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/artifacts/scenario-run-artifacts.ts',
        rule: 'boundary.unknown',
        symbol: 'withExpandedPlanCorrelation'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-metrics.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-metrics.ts',
        rule: 'boundary.unknown',
        symbol: 'asRecord'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-metrics.ts',
        rule: 'boundary.unknown',
        symbol: 'incrementCount'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-metrics.ts',
        rule: 'boundary.unknown',
        symbol: 'countReconnects'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-metrics.ts',
        rule: 'boundary.unknown',
        symbol: 'countArrayValues'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-metrics.ts',
        rule: 'boundary.unknown',
        symbol: 'resultOutcomeMetrics'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-metrics.ts',
        rule: 'boundary.unknown',
        symbol: 'flattenStoreValues'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-metrics.ts',
        rule: 'boundary.unknown',
        symbol: 'diagnosticSeverity'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-metrics.ts',
        rule: 'boundary.unknown',
        symbol: 'diagnosticTopic'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-metrics.ts',
        rule: 'boundary.unknown',
        symbol: 'diagnosticMetricsFromValues'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-metrics.ts',
        rule: 'boundary.unknown',
        symbol: 'diagnosticMetricsFromReport'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-metrics.ts',
        rule: 'boundary.unknown',
        symbol: 'countNestedArrayValues'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-metrics.ts',
        rule: 'boundary.unknown',
        symbol: 'computeScenarioMetrics'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-metrics.ts',
        rule: 'boundary.unknown',
        symbol: 'computeScenarioLatencies'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-metrics.ts',
        rule: 'boundary.unknown',
        symbol: 'uniqueRepeatIndexes'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-metrics.ts',
        rule: 'boundary.unknown',
        symbol: 'computeScenarioScaleMetrics'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-metrics.ts',
        rule: 'boundary.unknown',
        symbol: 'computeScenarioSoakMetrics'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-post-run-assertions.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 96
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-post-run-assertions.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-post-run-assertions.ts',
        rule: 'boundary.unknown',
        symbol: 'asRecord'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-post-run-assertions.ts',
        rule: 'boundary.unknown',
        symbol: 'stringValue'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/reports/scenario-post-run-assertions.ts',
        rule: 'boundary.unknown',
        symbol: 'normalizePostRunAssertionSource'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/execution/execute-assert-interaction.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 57
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/execution/execute-assert-interaction.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/execution/execute-assert-interaction.ts',
        rule: 'boundary.unknown',
        symbol: 'executeAssertInteraction'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/execution/execute-assert-interaction.ts',
        rule: 'boundary.unknown',
        symbol: 'computeAssertEvidence'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/execution/execute-assert-interaction.ts',
        rule: 'boundary.unknown',
        symbol: 'monotonicComparisonFailures'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/execution/execute-assert-interaction.ts',
        rule: 'boundary.unknown',
        symbol: 'toResolvedAssertActual'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/expectations/assert-value-comparators.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 69
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/expectations/assert-value-comparators.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/expectations/assert-value-comparators.ts',
        rule: 'boundary.unknown',
        symbol: 'resolveComparatorValue'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/expectations/assert-value-comparators.ts',
        rule: 'boundary.unknown',
        symbol: 'numericIssues'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/expectations/assert-value-comparators.ts',
        rule: 'boundary.unknown',
        symbol: 'betweenIssues'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/expectations/assert-value-comparators.ts',
        rule: 'boundary.unknown',
        symbol: 'lengthIssues'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/expectations/assert-value-comparators.ts',
        rule: 'boundary.unknown',
        symbol: 'stringIssues'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/expectations/assert-value-comparators.ts',
        rule: 'boundary.unknown',
        symbol: 'regexIssues'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/expectations/assert-value-comparators.ts',
        rule: 'boundary.unknown',
        symbol: 'equalityIssues'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/expectations/assert-value-comparators.ts',
        rule: 'boundary.unknown',
        symbol: 'entryIssues'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/expectations/assert-value-comparators.ts',
        rule: 'boundary.unknown',
        symbol: 'validateAssertValueComparators'
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/scenario-report-boundaries.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/scenario-report-boundaries.test.ts',
        rule: 'control.nested-callback-depth',
        symbol: undefined,
        maximumMagnitude: 3
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/execution/black-box-scenario-results.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Recipe includes, template expansion and workload selection consume authored
    // inputs. Generated decisions are named; opaque templates retain their values.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/read-scenario-recipe-includes.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 59
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/read-scenario-recipe-includes.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/read-scenario-recipe-includes.ts',
        rule: 'boundary.unknown',
        symbol: 'asRecord'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/read-scenario-recipe-includes.ts',
        rule: 'boundary.unknown',
        symbol: 'asArray'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/read-scenario-recipe-includes.ts',
        rule: 'boundary.unknown',
        symbol: 'stringValue'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/read-scenario-recipe-includes.ts',
        rule: 'boundary.unknown',
        symbol: 'cloneJson'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/read-scenario-recipe-includes.ts',
        rule: 'boundary.unknown',
        symbol: 'includeReference'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/read-scenario-recipe-includes.ts',
        rule: 'boundary.unknown',
        symbol: 'parseIncludeFile'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/read-scenario-recipe-includes.ts',
        rule: 'boundary.unknown',
        symbol: 'applyIncludeVariables'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/read-scenario-recipe-includes.ts',
        rule: 'boundary.unknown',
        symbol: 'withIncludeNameAffixes'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/read-scenario-recipe-includes.ts',
        rule: 'boundary.unknown',
        symbol: 'fragmentSteps'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/read-scenario-recipe-includes.ts',
        rule: 'boundary.unknown',
        symbol: 'isRecipeRecord'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/read-scenario-recipe-includes.ts',
        rule: 'boundary.unknown',
        symbol: 'readRecipeSteps'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/read-scenario-recipe-includes.ts',
        rule: 'boundary.unknown',
        symbol: 'readNestedRecipeIncludes'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 150
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'asRecord'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'computeSoakSummary'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'firstPositiveInteger'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'firstNonNegativeInteger'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'firstPositiveNumber'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'stepName'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'cloneStep'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'resolveStepList'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'resolveRecipeStepList'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'resolveSoakLoopSteps'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'toUnsignedSeed'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'resolveTemplatePath'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'stringifyTemplateValue'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'resolveTrafficTemplate'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'isInlineLoopStep'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'toInlineLoopSteps'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'toInlineLoopIntervalMs'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'toInlineLoopMessageCount'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'toInlineLoopIterationCount'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'annotateInlineLoopStep'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'expandInlineLoopSteps'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'computeInlineLoopSteps'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'toTrafficOperationSteps'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'toTrafficOperations'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'toTrafficOperationWeight'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'annotateTrafficStep'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'toTrafficPacingConfig'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'readReplayTrafficPlan'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'toGeneratedTrafficPlan'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'toSoakMessageCount'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'toSoakIterationCount'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'annotateSoakStep'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/scenario-workload.ts',
        rule: 'boundary.unknown',
        symbol: 'toSoakExpandedConfig'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-executable-interactions.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 103
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-executable-interactions.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-executable-interactions.ts',
        rule: 'boundary.unknown',
        symbol: 'asRecord'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-executable-interactions.ts',
        rule: 'boundary.unknown',
        symbol: 'replaceVariableText'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-executable-interactions.ts',
        rule: 'boundary.unknown',
        symbol: 'replaceVariables'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-executable-interactions.ts',
        rule: 'boundary.unknown',
        symbol: 'replaceVariableValue'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-executable-interactions.ts',
        rule: 'boundary.unknown',
        symbol: 'toStepExecutionMetadata'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-executable-interactions.ts',
        rule: 'boundary.unknown',
        symbol: 'joinUrl'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-executable-interactions.ts',
        rule: 'boundary.unknown',
        symbol: 'connectionRequestDefaults'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-executable-interactions.ts',
        rule: 'boundary.unknown',
        symbol: 'toConnection'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-executable-interactions.ts',
        rule: 'boundary.unknown',
        symbol: 'withDefaultsAndConnection'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-executable-interactions.ts',
        rule: 'boundary.unknown',
        symbol: 'toExecutableStep'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-executable-interactions.ts',
        rule: 'boundary.unknown',
        symbol: 'isParallelStep'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-executable-interactions.ts',
        rule: 'boundary.unknown',
        symbol: 'toPlaceholderNames'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-executable-interactions.ts',
        rule: 'boundary.unknown',
        symbol: 'toStepOutputName'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-executable-interactions.ts',
        rule: 'boundary.unknown',
        symbol: 'toKnownOutputNames'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-executable-interactions.ts',
        rule: 'boundary.unknown',
        symbol: 'toInferredInputs'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-executable-interactions.ts',
        rule: 'boundary.unknown',
        symbol: 'toRepeatedSteps'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-executable-interactions.ts',
        rule: 'boundary.unknown',
        symbol: 'toParallelGroupSpecs'
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-executable-interactions.ts',
        rule: 'boundary.unknown',
        symbol: 'toExecutableSteps'
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/recipes/recipe-compilation-boundaries.test.ts',
        rule: 'boundary.unknown',
        symbol: 'compileVariable'
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/recipes/recipe-compilation-boundaries.test.ts',
        rule: 'control.nested-callback-depth',
        symbol: undefined,
        maximumMagnitude: 3
    }),
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/execute-black-box.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 144
    }),
    // Untrusted payloadFields is record-guarded and each operand is admitted by
    // decodeJsonValue. Only validation issues leave this issue-returning boundary.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/control/validate-wait-control-command.ts',
        rule: 'boundary.unknown',
        symbol: 'validateWaitPayloadFields'
    }),
    // This generic copier owns comparison arrays/records without admitting
    // them. Cycles and invalid non-JSON operands retain their existing validation
    // boundary; unknown array storage stays local. Its checker owner is absent.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/recipe/snapshot-comparison-value.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // JSON comparison accepts native input at its facade and decoder only.
    // Descriptor-built snapshots remove accessors, prototypes, and caller-owned
    // mutation before the JsonValue core runs. The private worklist is raw input
    // inside that decoder; the test deliberately exercises the native boundary.
    // Semantic tests cover invalid values, cycles, hidden hooks, shared graphs,
    // immutable diagnostics, and the existing comparison policies.
    Object.freeze({
        path: 'packages/shared-test/json-compare/compare-json-values.ts',
        rule: 'boundary.unknown',
        symbol: 'compareJson'
    }),
    Object.freeze({
        path: 'packages/shared-test/json-compare/json-compare.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/json-compare/json-comparison-input.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-test/json-compare/json-comparison-input.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeJsonComparisonInput'
    }),
    Object.freeze({
        path: 'packages/shared-test/json-compare/json-comparison-input.ts',
        rule: 'boundary.unknown',
        symbol: 'captureJsonComparisonValue'
    }),
    Object.freeze({
        path: 'packages/tests/shared-test/compare-json.test.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    // Scalar, object, and array branches form one recursive comparison policy.
    // Keep them together after extracting native-input decoding. This bounds the
    // reviewed warning; it does not permit growth into an exception tier.
    Object.freeze({
        path: 'packages/shared-test/json-compare/compare-json-values.ts',
        rule: 'file.cognitive-load',
        symbol: undefined,
        maximumMagnitude: 63
    }),
    // The recipe selector preserves an authored action for downstream compilation.
    Object.freeze({
        path: 'packages/shared-test/black-box-runner/recipes/to-recipe-step-action.ts',
        rule: 'boundary.unknown',
        symbol: 'toRecipeStepAction'
    })
]);
