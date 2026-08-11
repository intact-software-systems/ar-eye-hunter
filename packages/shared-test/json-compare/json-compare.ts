import {
    CompareConfig, compareJson,
    COMPARISON,
    Comparison,
    ComparisonResult,
    JsonValue, toConfig
} from './CompareJson.ts';

export interface CompareJsonOptions {
    ignoreJsonKeys?: string[];
    ignoreJsonPaths?: string[];
}

export interface CompareJsonFacade {
    compatibleStructure(expected: JsonValue, actual: JsonValue, options?: CompareJsonOptions): ComparisonResult;
    compatible(expected: JsonValue, actual: JsonValue, options?: CompareJsonOptions): ComparisonResult;
    compatibleComplete(
        expected: JsonValue,
        actual: JsonValue,
        options?: CompareJsonOptions,
    ): ComparisonResult;
    exactStructure(expected: JsonValue, actual: JsonValue, options?: CompareJsonOptions): ComparisonResult;
    exact(expected: JsonValue, actual: JsonValue, options?: CompareJsonOptions): ComparisonResult;
    compare(expected: JsonValue, actual: JsonValue, comparison: Comparison | string, options?: CompareJsonOptions): ComparisonResult;
    assertCompatibleStructure(expected: JsonValue, actual: JsonValue, options?: CompareJsonOptions): void;
    assertCompatible(expected: JsonValue, actual: JsonValue, options?: CompareJsonOptions): void;
    assertCompatibleComplete(
        expected: JsonValue,
        actual: JsonValue,
        options?: CompareJsonOptions,
    ): void;
    assertExactStructure(expected: JsonValue, actual: JsonValue, options?: CompareJsonOptions): void;
    assertExact(expected: JsonValue, actual: JsonValue, options?: CompareJsonOptions): void;
}

function toFacadeConfig(comparison: Comparison | string, options: CompareJsonOptions = {}): CompareConfig {
    return toConfig(
        comparison,
        options.ignoreJsonKeys ?? [],
        options.ignoreJsonPaths ?? [],
    );
}

function assertComparisonResult(result: ComparisonResult): void {
    if (!result.isEqual) {
        throw new Error(JSON.stringify(result, null, 2));
    }
}

export const CompareJson: CompareJsonFacade = {
    compatibleStructure(expected: JsonValue, actual: JsonValue, options: CompareJsonOptions = {}): ComparisonResult {
        return compareJson(expected, actual, toFacadeConfig(COMPARISON.COMPATIBLE_STRUCTURE, options));
    },

    compatible(expected: JsonValue, actual: JsonValue, options: CompareJsonOptions = {}): ComparisonResult {
        return compareJson(expected, actual, toFacadeConfig(COMPARISON.COMPATIBLE, options));
    },

    compatibleComplete(
        expected: JsonValue,
        actual: JsonValue,
        options: CompareJsonOptions = {},
    ): ComparisonResult {
        const config = toFacadeConfig(COMPARISON.COMPATIBLE_COMPLETE, options);
        return compareJson(expected, actual, config);
    },

    exactStructure(expected: JsonValue, actual: JsonValue, options: CompareJsonOptions = {}): ComparisonResult {
        return compareJson(expected, actual, toFacadeConfig(COMPARISON.EXACT_STRUCTURE, options));
    },

    exact(expected: JsonValue, actual: JsonValue, options: CompareJsonOptions = {}): ComparisonResult {
        return compareJson(expected, actual, toFacadeConfig(COMPARISON.EXACT, options));
    },

    compare(
        expected: JsonValue,
        actual: JsonValue,
        comparison: Comparison | string,
        options: CompareJsonOptions = {},
    ): ComparisonResult {
        return compareJson(expected, actual, toFacadeConfig(comparison, options));
    },

    assertCompatibleStructure(expected: JsonValue, actual: JsonValue, options: CompareJsonOptions = {}): void {
        assertComparisonResult(this.compatibleStructure(expected, actual, options));
    },

    assertCompatible(expected: JsonValue, actual: JsonValue, options: CompareJsonOptions = {}): void {
        assertComparisonResult(this.compatible(expected, actual, options));
    },

    assertCompatibleComplete(
        expected: JsonValue,
        actual: JsonValue,
        options: CompareJsonOptions = {},
    ): void {
        assertComparisonResult(this.compatibleComplete(expected, actual, options));
    },

    assertExactStructure(expected: JsonValue, actual: JsonValue, options: CompareJsonOptions = {}): void {
        assertComparisonResult(this.exactStructure(expected, actual, options));
    },

    assertExact(expected: JsonValue, actual: JsonValue, options: CompareJsonOptions = {}): void {
        assertComparisonResult(this.exact(expected, actual, options));
    },
};
