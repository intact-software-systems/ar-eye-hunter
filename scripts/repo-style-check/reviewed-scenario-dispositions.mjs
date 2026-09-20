// Reviewed recipe, assertion and report boundaries. Exact keys and caps remain local to each owner.
export const reviewedScenarioDispositions = Object.freeze([
    // Reload command results retain opaque external evidence. These readers keep
    // malformed leaves intact until the adjacent validators reject them; JSON
    // normalization would erase NaN/Infinity and missing-value negative evidence.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-reload-identity.ts',
        rule: 'boundary.unknown',
        symbol: 'resultValue'
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-reload-identity.ts',
        rule: 'boundary.unknown',
        symbol: 'readPath'
    }),
    // Raw count maps and leaves are narrowed to finite nonnegative numbers before
    // acceptance. Missing write means zero only alongside the complete valid-map
    // check in assessReloadStorage; these boundaries return booleans, not raw state.
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-reload-identity.ts',
        rule: 'boundary.unknown',
        symbol: 'validStorageCounts'
    }),
    Object.freeze({
        path: 'packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-reload-identity.ts',
        rule: 'boundary.unknown',
        symbol: 'positiveCounterDelta'
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
