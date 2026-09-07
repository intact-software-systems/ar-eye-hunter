// deno-lint-ignore-file no-explicit-any
import { Either } from '../../../shared/resilience/Either.ts';
import { toInteractionOutputFields } from './black-box-scenario-results.ts';

import { compareJson, COMPARISON, toConfig, type ComparisonResult } from '../../json-compare/compare-json-values.ts';
import {
    validateAssertValueComparators,
    type AssertComparatorIssue
} from '../expectations/assert-value-comparators.ts';
import { evaluateScenarioTransform } from './black-box-output-transform.ts';
import { isRecord } from './black-box-redaction.ts';
import { toCorrelationReportFields } from './black-box-run-correlation.ts';
import { resolveAssertActual, resolvePath } from './black-box-value-resolution.ts';

interface AssertStatusInput {
    readonly config: any;
    readonly interaction: any;
    readonly actual: any;
    readonly details?: any;
}
interface AssertFailureStatusInput extends AssertStatusInput {
    readonly result: string;
}

interface AssertComputed {
    readonly actual: any;
    readonly response: any;
    readonly expected: any;
    readonly alternatives: readonly any[];
    readonly comparators: readonly any[];
    readonly monotonicFailures: readonly any[];
    readonly comparatorIssues: readonly AssertComparatorIssue[];
    readonly comparisons: readonly ComparisonResult[];
}

interface AssertFailure {
    readonly result: string;
    readonly details: any;
}

interface AssertEvidence {
    readonly details: any;
}

const SUCCESS = 'SUCCESS';
const FAILURE = 'FAILURE';

export function executeAssertInteraction(interaction: any, config: any, context: any): Promise<any> {
    const actual = toResolvedAssertActual(interaction, context);
    const computed = computeAssertEvidence(actual, interaction.response);
    const validation = validateAssertEvidence(computed);
    const status = validation.left !== undefined
        ? toAssertFailureStatus({ config, interaction, actual, ...validation.left })
        : toAssertSuccessStatus({ config, interaction, actual, details: validation.right?.details });
    return Promise.resolve(status);
}

function computeAssertEvidence(actual: any, response: any): AssertComputed {
    const expected = response.body !== undefined
        ? response.body
        : response.expect !== undefined
        ? response.expect
        : response.expected;
    const alternatives = Array.isArray(response.anyOf) ? response.anyOf : [];
    const comparators = Array.isArray(response.comparators) ? response.comparators : [];
    const hasEvidence = actual !== undefined &&
        (expected !== undefined || alternatives.length > 0 || comparators.length > 0);
    const monotonicFailures = hasEvidence ? monotonicComparisonFailures(actual, response.monotonicPaths) : [];
    const comparatorIssues = hasEvidence && monotonicFailures.length === 0
        ? validateAssertValueComparators(actual, comparators)
        : [];
    const expectedValues = alternatives.length > 0 ? alternatives : expected !== undefined ? [expected] : [];
    const comparisons = hasEvidence && monotonicFailures.length === 0 && comparatorIssues.length === 0
        ? expectedValues.map((value: any) =>
            compareJson(
                value,
                actual,
                toConfig(
                    response.comparison || COMPARISON.COMPATIBLE,
                    response.ignoreJsonKeys || [],
                    response.ignoreJsonPaths || []
                )
            )
        )
        : [];
    return { actual, response, expected, alternatives, comparators, monotonicFailures, comparatorIssues, comparisons };
}

function validateAssertEvidence(computed: AssertComputed): Either<AssertFailure, AssertEvidence> {
    const { actual, expected, alternatives, comparators, monotonicFailures, comparatorIssues, comparisons } = computed;
    if (expected === undefined && alternatives.length === 0 && comparators.length === 0) {
        return Either.ofLeft({
            result: 'Assert step is missing expected value. ' +
                'Use expect.body, expect.expect, expect.expected, or expect.comparators.',
            details: {}
        });
    }
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

function toAssertSuccessStatus(input: AssertStatusInput): any {
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

function toAssertFailureStatus(input: AssertFailureStatusInput): any {
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

function monotonicComparisonFailures(actual: any, paths: unknown): any[] {
    if (!Array.isArray(paths)) {
        return [];
    }

    return paths.flatMap<any>((path) => {
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

        const numericValues = values.map((value) => Number(value));
        if (numericValues.some((value) => !Number.isFinite(value))) {
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

function toResolvedAssertActual(interaction: any, context: any): any {
    return interaction.response.actual !== undefined
        ? isRecord(interaction.response.actual) && interaction.response.actual.transform !== undefined
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
