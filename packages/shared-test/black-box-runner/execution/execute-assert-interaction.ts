import { Either } from '../../../shared/resilience/Either.ts';
import { toInteractionOutputFields } from './black-box-scenario-results.ts';

import {
    compareJson,
    COMPARISON,
    type ComparisonResult
} from '../../json-compare/compare-json-values.ts';
import {
    validateAssertValueComparators,
    type AssertComparatorIssue
} from '../expectations/assert-value-comparators.ts';
import { decodeScenarioComparison, decodeScenarioNumber } from '../scenario-value-decoding.ts';
import { evaluateScenarioTransform } from './black-box-output-transform.ts';
import { toCorrelationReportFields } from './black-box-run-correlation.ts';
import { resolveAssertActual, resolvePath } from './black-box-value-resolution.ts';

export interface AssertInteractionResult {
    readonly name: string;
    readonly status: 'SUCCESS' | 'FAILURE';
    readonly transport: 'ASSERT';
    readonly expected: unknown;
    readonly actual: unknown;
    readonly details: unknown;
    readonly result?: string;
    readonly [field: string]: unknown;
}

interface MonotonicComparisonFailure {
    readonly path: unknown;
    readonly error?: string;
    readonly values?: unknown;
    readonly regressionIndex?: number;
    readonly previous?: number;
    readonly current?: number;
}

interface AssertInteractionInput {
    readonly request: Readonly<Record<string, unknown>>;
    readonly response: Readonly<Record<string, unknown>>;
    readonly [field: string]: unknown;
}

interface AssertExecutionConfig {
    readonly interactionName: string;
    readonly interaction: AssertInteractionInput;
    readonly [field: string]: unknown;
}

interface AssertStatusInput {
    readonly config: AssertExecutionConfig;
    readonly interaction: AssertInteractionInput;
    readonly actual: unknown;
    readonly details?: unknown;
}
interface AssertFailureStatusInput extends AssertStatusInput {
    readonly result: string;
}

interface AssertComputed {
    readonly actual: unknown;
    readonly response: Readonly<Record<string, unknown>>;
    readonly expected: unknown;
    readonly alternatives: readonly unknown[];
    readonly comparators: readonly unknown[];
    readonly monotonicFailures: readonly MonotonicComparisonFailure[];
    readonly comparatorIssues: readonly AssertComparatorIssue[];
    readonly comparisons: readonly ComparisonResult[];
    readonly comparisonFailure: Error | undefined;
}

interface AssertFailure {
    readonly result: string;
    readonly details: unknown;
}

interface AssertEvidence {
    readonly details: unknown;
}

const SUCCESS = 'SUCCESS';
const FAILURE = 'FAILURE';

export function executeAssertInteraction(
    interaction: AssertInteractionInput,
    config: AssertExecutionConfig,
    context: unknown
): Promise<AssertInteractionResult> {
    const actual = toResolvedAssertActual(interaction, context);
    const computed = computeAssertEvidence(actual, interaction.response);
    const validation = validateAssertEvidence(computed);
    const status = validation.left !== undefined
        ? toAssertFailureStatus({ config, interaction, actual, ...validation.left })
        : toAssertSuccessStatus({ config, interaction, actual, details: validation.right?.details });
    return Promise.resolve(status);
}

function computeAssertEvidence(actual: unknown, response: Readonly<Record<string, unknown>>): AssertComputed {
    const expected = response.body !== undefined
        ? response.body
        : response.expect !== undefined
        ? response.expect
        : response.expected;
    const alternatives = Array.isArray(response.anyOf) ? Array.from(response.anyOf) : [];
    const comparators = Array.isArray(response.comparators) ? response.comparators : [];
    const hasEvidence = actual !== undefined &&
        (expected !== undefined || alternatives.length > 0 || comparators.length > 0);
    const monotonicFailures = actual !== undefined ? monotonicComparisonFailures(actual, response.monotonicPaths) : [];
    const comparatorIssues = actual !== undefined && monotonicFailures.length === 0
        ? validateAssertValueComparators(actual, response.comparators)
        : [];
    const configuration = decodeScenarioComparison(
        response.comparison === undefined ? COMPARISON.COMPATIBLE : response.comparison,
        response.ignoreJsonKeys === undefined ? [] : response.ignoreJsonKeys,
        response.ignoreJsonPaths === undefined ? [] : response.ignoreJsonPaths
    );
    const expectedValues = alternatives.length > 0 ? alternatives : expected !== undefined ? [expected] : [];
    const comparisonConfig = configuration.right;
    const comparisons = hasEvidence && monotonicFailures.length === 0 && comparatorIssues.length === 0 &&
            comparisonConfig !== undefined
        ? expectedValues.map((value: unknown) =>
            compareJson(
                value,
                actual,
                comparisonConfig
            )
        )
        : [];
    return {
        actual,
        response,
        expected,
        alternatives,
        comparators,
        monotonicFailures,
        comparatorIssues,
        comparisons,
        comparisonFailure: configuration.left ?? (response.anyOf !== undefined && !Array.isArray(response.anyOf)
            ? new Error('Assert anyOf must be an array.')
            : undefined)
    };
}

function validateAssertEvidence(computed: AssertComputed): Either<AssertFailure, AssertEvidence> {
    const { actual, expected, alternatives, comparators, monotonicFailures, comparatorIssues, comparisons } = computed;
    if (actual === undefined) {
        return Either.ofLeft({
            result: 'Assert step is missing actual value. Use actual or expect.actual.',
            details: {}
        });
    }
    if (monotonicFailures.length > 0) {
        return Either.ofLeft({
            result: 'Assert monotonic comparison failed',
            details: { monotonicPaths: computed.response.monotonicPaths, failures: monotonicFailures }
        });
    }
    if (comparatorIssues.length > 0) {
        return Either.ofLeft({
            result: 'Assert comparator failed',
            details: { comparators, failures: comparatorIssues }
        });
    }
    if (computed.comparisonFailure !== undefined) {
        return Either.ofLeft({
            result: 'Assert comparison failed',
            details: { reason: 'invalid-comparison', message: computed.comparisonFailure.message }
        });
    }
    if (expected === undefined && alternatives.length === 0 && comparators.length === 0) {
        return Either.ofLeft({
            result: 'Assert step is missing expected value. ' +
                'Use expect.body, expect.expect, expect.expected, or expect.comparators.',
            details: {}
        });
    }
    if (alternatives.length > 0) {
        const matchedIndex = comparisons.findIndex((comparison) => comparison.isEqual);
        return matchedIndex < 0
            ? Either.ofLeft({ result: 'Assert comparison failed', details: { anyOf: alternatives, comparisons } })
            : Either.ofRight({ details: { anyOfMatchedIndex: matchedIndex, comparison: comparisons[matchedIndex] } });
    }
    if (expected === undefined) {
        return Either.ofRight({ details: { comparators } });
    }
    const comparison = comparisons[0];
    return comparison.isEqual
        ? Either.ofRight({ details: comparison })
        : Either.ofLeft({ result: 'Assert comparison failed', details: comparison });
}

function toAssertSuccessStatus(input: AssertStatusInput): AssertInteractionResult {
    const { config, interaction, actual } = input;
    return {
        name: config.interactionName,
        status: SUCCESS,
        transport: 'ASSERT',
        ...toCorrelationReportFields(interaction),
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual,
        details: input.details ?? {},
        ...toInteractionOutputFields(interaction),
        input: interaction.request.input
    };
}

function toAssertFailureStatus(input: AssertFailureStatusInput): AssertInteractionResult {
    const { config, interaction, actual, result } = input;
    return {
        name: config.interactionName,
        status: FAILURE,
        transport: 'ASSERT',
        result,
        ...toCorrelationReportFields(interaction),
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual,
        details: input.details ?? {},
        ...config
    };
}

function monotonicComparisonFailures(actual: unknown, paths: unknown): MonotonicComparisonFailure[] {
    if (paths === undefined) {
        return [];
    }
    if (!Array.isArray(paths)) {
        return [{ path: paths, error: 'Monotonic assertion paths must be an array.' }];
    }

    return Array.from(paths).flatMap<MonotonicComparisonFailure>((path) => {
        if (typeof path !== 'string' || path.length <= 0) {
            return [{ path, error: 'Monotonic assertion paths must be non-empty strings.' }];
        }

        let values: unknown;
        try {
            values = resolvePath(path, actual);
        }
        catch (error) {
            return [{
                path,
                error: error instanceof Error ? error.message : String(error)
            }];
        }

        if (!Array.isArray(values) || values.length <= 0) {
            return [{ path, values, error: 'Monotonic assertion path must resolve to a non-empty array.' }];
        }

        const numericValues = Array.from(values, decodeScenarioNumber);
        if (!numericValues.every((value): value is number => value !== undefined)) {
            return [{ path, values, error: 'Monotonic assertion values must be finite numbers.' }];
        }

        const regressionIndex = numericValues.findIndex((value, index) =>
            index > 0 && value < numericValues[index - 1]
        );
        return regressionIndex < 0
            ? []
            : [{
                path,
                values,
                regressionIndex,
                previous: numericValues[regressionIndex - 1],
                current: numericValues[regressionIndex]
            }];
    });
}

function toResolvedAssertActual(interaction: AssertInteractionInput, context: unknown): unknown {
    return interaction.response.actual !== undefined
        ? typeof interaction.response.actual === 'object' && interaction.response.actual !== null &&
                'transform' in interaction.response.actual && interaction.response.actual.transform !== undefined
            ? evaluateScenarioTransform({
                transform: interaction.response.actual.transform,
                context,
                operatorPath: 'assert.actual'
            })
            : resolveAssertActual(
                interaction.response.actual,
                context,
                interaction.response.missingActualValue
            )
        : interaction.request.actual;
}
