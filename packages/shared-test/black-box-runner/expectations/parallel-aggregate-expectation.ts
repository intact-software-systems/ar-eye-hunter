// deno-lint-ignore-file no-explicit-any
import { compareJson, COMPARISON, toConfig } from '../../json-compare/CompareJson.ts';
import { validateAssertValueComparators } from './assert-value-comparators.ts';

export interface ParallelAggregateFailure {
    readonly message: string;
    readonly details: any;
}

/**
 * A parallel step's `expect` is compared against its aggregate — group results,
 * counts, concurrency and timing — which is the only place a bounded outcome
 * such as "at most K of N succeeded" can be asserted. Child failures are
 * decided before this, so an aggregate expectation can never mask one.
 */
export function parallelAggregateFailure(
    interaction: any,
    actual: any
): ParallelAggregateFailure | undefined {
    const expectation = interaction.response;
    if (!expectation) {
        return undefined;
    }

    const comparatorIssues = validateAssertValueComparators(actual, expectation.comparators);
    if (comparatorIssues.length > 0) {
        return {
            message: 'Parallel step comparator failed',
            details: { comparators: expectation.comparators, failures: comparatorIssues }
        };
    }

    const expected = expectation.body ?? expectation.expected;
    if (expected === undefined) {
        return undefined;
    }

    const comparison = compareJson(
        expected,
        actual,
        toConfig(
            expectation.comparison || COMPARISON.COMPATIBLE,
            expectation.ignoreJsonKeys || [],
            expectation.ignoreJsonPaths || []
        )
    );

    return comparison.isEqual ? undefined : {
        message: 'Parallel step aggregate comparison failed',
        details: { expected, comparison }
    };
}
