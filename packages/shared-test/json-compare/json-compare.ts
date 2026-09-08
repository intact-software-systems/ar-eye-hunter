import type {
    CompareConfig,
    Comparison,
    ComparisonResult
} from './compare-json-values.ts';
import {
    compareJson,
    COMPARISON,
    toConfig
} from './compare-json-values.ts';

export interface CompareJsonOptions {
    ignoreJsonKeys?: string[];
    ignoreJsonPaths?: string[];
}

export interface CompareJsonInput {
    comparison: Comparison | string;
    options?: CompareJsonOptions;
}

export interface CompareJsonFacade {
    compatibleStructure(expected: unknown, actual: unknown, options?: CompareJsonOptions): ComparisonResult;
    compatible(expected: unknown, actual: unknown, options?: CompareJsonOptions): ComparisonResult;
    compatibleComplete(
        expected: unknown,
        actual: unknown,
        options?: CompareJsonOptions
    ): ComparisonResult;
    exactStructure(expected: unknown, actual: unknown, options?: CompareJsonOptions): ComparisonResult;
    exact(expected: unknown, actual: unknown, options?: CompareJsonOptions): ComparisonResult;
    compare(
        expected: unknown,
        actual: unknown,
        input: CompareJsonInput
    ): ComparisonResult;
    assertCompatibleStructure(expected: unknown, actual: unknown, options?: CompareJsonOptions): void;
    assertCompatible(expected: unknown, actual: unknown, options?: CompareJsonOptions): void;
    assertCompatibleComplete(
        expected: unknown,
        actual: unknown,
        options?: CompareJsonOptions
    ): void;
    assertExactStructure(expected: unknown, actual: unknown, options?: CompareJsonOptions): void;
    assertExact(expected: unknown, actual: unknown, options?: CompareJsonOptions): void;
}

function toFacadeConfig(comparison: Comparison | string, options: CompareJsonOptions = {}): CompareConfig {
    return toConfig(
        comparison,
        options.ignoreJsonKeys ?? [],
        options.ignoreJsonPaths ?? []
    );
}

function assertComparisonResult(result: ComparisonResult): void {
    if (!result.isEqual) {
        throw new Error(JSON.stringify(result, null, 2));
    }
}

export const CompareJson: CompareJsonFacade = {
    compatibleStructure(expected: unknown, actual: unknown, options: CompareJsonOptions = {}): ComparisonResult {
        return compareJson(expected, actual, toFacadeConfig(COMPARISON.COMPATIBLE_STRUCTURE, options));
    },

    compatible(expected: unknown, actual: unknown, options: CompareJsonOptions = {}): ComparisonResult {
        return compareJson(expected, actual, toFacadeConfig(COMPARISON.COMPATIBLE, options));
    },

    compatibleComplete(
        expected: unknown,
        actual: unknown,
        options: CompareJsonOptions = {}
    ): ComparisonResult {
        const config = toFacadeConfig(COMPARISON.COMPATIBLE_COMPLETE, options);
        return compareJson(expected, actual, config);
    },

    exactStructure(expected: unknown, actual: unknown, options: CompareJsonOptions = {}): ComparisonResult {
        return compareJson(expected, actual, toFacadeConfig(COMPARISON.EXACT_STRUCTURE, options));
    },

    exact(expected: unknown, actual: unknown, options: CompareJsonOptions = {}): ComparisonResult {
        return compareJson(expected, actual, toFacadeConfig(COMPARISON.EXACT, options));
    },

    compare(
        expected: unknown,
        actual: unknown,
        input: CompareJsonInput
    ): ComparisonResult {
        return compareJson(expected, actual, toFacadeConfig(input.comparison, input.options));
    },

    assertCompatibleStructure(expected: unknown, actual: unknown, options: CompareJsonOptions = {}): void {
        assertComparisonResult(this.compatibleStructure(expected, actual, options));
    },

    assertCompatible(expected: unknown, actual: unknown, options: CompareJsonOptions = {}): void {
        assertComparisonResult(this.compatible(expected, actual, options));
    },

    assertCompatibleComplete(
        expected: unknown,
        actual: unknown,
        options: CompareJsonOptions = {}
    ): void {
        assertComparisonResult(this.compatibleComplete(expected, actual, options));
    },

    assertExactStructure(expected: unknown, actual: unknown, options: CompareJsonOptions = {}): void {
        assertComparisonResult(this.exactStructure(expected, actual, options));
    },

    assertExact(expected: unknown, actual: unknown, options: CompareJsonOptions = {}): void {
        assertComparisonResult(this.exact(expected, actual, options));
    }
};
