const ANY = 'any' as const;
const ANY_INTEGER = 'integer' as const;
const ANY_FLOAT = 'float' as const;
const ANY_STRING = 'string' as const;
const OR = '|';

export type JsonValue =
    | string
    | number
    | boolean
    | null
    | { [key: string]: JsonValue | undefined; }
    | JsonValue[];

export interface CompareConfig {
    compareValues: boolean;
    compareExact: boolean;
    compareArraysComplete: boolean;
    compareArrayOrder: boolean;
    ignoreJsonKeys: string[];
    ignoreJsonPaths: string[];
}

export interface CompatibleResult {
    isEqual: true;
}

export interface NotCompatibleResult {
    isEqual: false;
    message: string;
    expected: unknown;
    actual: unknown;
    [key: string]: unknown;
}

export type ComparisonResult = CompatibleResult | NotCompatibleResult;

interface ComparisonContext {
    config: CompareConfig;
    path: string;
}

interface ComparisonInput {
    expected: unknown;
    actual: unknown;
    context: ComparisonContext;
}

interface Mismatch {
    message: string;
    details?: Record<string, unknown>;
}

interface ArrayMatches {
    expectedFound: unknown[];
    expectedNotFound: unknown[];
    actualNotFound: unknown[];
}

interface ObjectPropertyComparison {
    key: string;
    expected: Readonly<Record<string, unknown>>;
    actual: Readonly<Record<string, unknown>>;
    context: ComparisonContext;
}

export function expandPath(path: string, key: string): string {
    return path.length === 0 ? key : path + '.' + key;
}

function toNotCompatible(expected: unknown, actual: unknown, mismatch: Mismatch): NotCompatibleResult {
    return {
        isEqual: false,
        message: mismatch.message,
        expected,
        actual,
        ...mismatch.details
    };
}

function toCompatible(): CompatibleResult {
    return { isEqual: true };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesWildcard(expected: unknown, actual: unknown): boolean | undefined {
    if (expected === ANY) {
        return true;
    }
    if (expected === ANY_INTEGER) {
        return typeof actual === 'number'
            ? Number.isInteger(actual)
            : typeof actual === 'string' && /^-?\d+$/.test(actual);
    }
    if (expected === ANY_FLOAT) {
        const number = typeof actual === 'number'
            ? actual
            : typeof actual === 'string'
            ? Number.parseFloat(actual)
            : Number.NaN;
        return Number.isFinite(number) && !Number.isInteger(number);
    }
    if (expected === ANY_STRING) {
        return typeof actual === 'string';
    }
    if (typeof expected === 'string' && typeof actual === 'string' && expected.includes(OR)) {
        return expected.split(OR).some((alternative) => alternative === actual);
    }
    return undefined;
}

function isValueEqual(expected: unknown, actual: unknown, compareExact: boolean): boolean {
    if (expected === undefined || actual === undefined) {
        return expected === actual;
    }

    if (!compareExact) {
        const wildcardMatch = matchesWildcard(expected, actual);
        if (wildcardMatch !== undefined) {
            return wildcardMatch;
        }
    }

    if (typeof expected === 'number' && typeof actual === 'string') {
        return Number(actual) === expected;
    }
    if (typeof expected === 'string' && typeof actual === 'number') {
        return Number(expected) === actual;
    }
    return expected === actual;
}

function compareKeys(
    expected: Readonly<Record<string, unknown>>,
    actual: Readonly<Record<string, unknown>>
): ComparisonResult {
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    const unexpectedKey = expectedKeys.find((key) => !actualKeys.includes(key)) ??
        actualKeys.find((key) => !expectedKeys.includes(key));
    return unexpectedKey === undefined
        ? toCompatible()
        : toNotCompatible(expectedKeys, actualKeys, {
            message: ' Not exact equal keys in json object',
            details: { keyNotExpected: unexpectedKey }
        });
}

function compareScalar(input: ComparisonInput): ComparisonResult {
    const { expected, actual, context: { config } } = input;
    return config.compareValues && !isValueEqual(expected, actual, config.compareExact)
        ? toNotCompatible(expected, actual, {
            message: '!isValueEqual(' + String(expected) + ', ' + String(actual) + ')'
        })
        : toCompatible();
}

function compareObjectProperty(input: ObjectPropertyComparison): ComparisonResult {
    const { key, expected, actual, context } = input;
    if (
        context.config.ignoreJsonKeys.includes(key) ||
        context.config.ignoreJsonPaths.includes(expandPath(context.path, key))
    ) {
        return toCompatible();
    }
    if (!Object.hasOwn(actual, key)) {
        return toNotCompatible(expected, actual, {
            message: '!' + String(actual) + '.hasOwnProperty(' + key + ')'
        });
    }
    return compareValue({
        expected: expected[key],
        actual: actual[key],
        context: { ...context, path: expandPath(context.path, key) }
    });
}

function compareObjects(input: ComparisonInput): ComparisonResult {
    const { expected, actual, context } = input;
    if (!isRecord(expected)) {
        return compareScalar(input);
    }
    if (!isRecord(actual)) {
        return toNotCompatible(expected, actual, { message: 'actual is not a json object' });
    }
    if (context.config.compareExact) {
        const keyResult = compareKeys(expected, actual);
        if (!keyResult.isEqual) {
            return keyResult;
        }
    }
    for (const key of Object.keys(expected)) {
        const result = compareObjectProperty({ key, expected, actual, context });
        if (!result.isEqual) {
            return result;
        }
    }
    return toCompatible();
}

function computeArrayMatches(
    expected: readonly unknown[],
    actual: readonly unknown[],
    context: ComparisonContext
): ArrayMatches {
    const matchedActualIndexes = new Set<number>();
    const expectedFound: unknown[] = [];
    const expectedNotFound: unknown[] = [];
    for (const expectedValue of expected) {
        const matchIndex = actual.findIndex((actualValue, index) =>
            !matchedActualIndexes.has(index) &&
            compareValue({
                expected: expectedValue,
                actual: actualValue,
                context: { ...context, path: expandPath(context.path, 'n') }
            }).isEqual
        );
        if (matchIndex < 0) {
            expectedNotFound.push(expectedValue);
        }
        else {
            expectedFound.push(expectedValue);
            matchedActualIndexes.add(matchIndex);
        }
    }
    return {
        expectedFound,
        expectedNotFound,
        actualNotFound: actual.filter((_value, index) => !matchedActualIndexes.has(index))
    };
}

function compareArrayMatches(input: ComparisonInput, matches: ArrayMatches): ComparisonResult {
    const { expected, actual, context: { config } } = input;
    const details = { ...matches };
    if (config.compareExact && matches.actualNotFound.length > 0) {
        return toNotCompatible(expected, actual, { message: 'Json structures not exact equals', details });
    }
    if (config.compareArraysComplete && !config.compareExact && matches.actualNotFound.length > 0) {
        return toNotCompatible(expected, actual, { message: 'Json array has unexpected elements', details });
    }
    if (config.compareValues && matches.expectedNotFound.length > 0) {
        return toNotCompatible(expected, actual, { message: 'Json structures not compatible', details });
    }
    if (!config.compareValues && matches.expectedNotFound.length > 0) {
        return toNotCompatible(expected, actual, { message: 'Did not find the expected in actual', details });
    }
    return toCompatible();
}

function compareArrays(input: ComparisonInput): ComparisonResult {
    const { expected, actual, context } = input;
    if (!Array.isArray(expected)) {
        return compareScalar(input);
    }
    if (!Array.isArray(actual)) {
        return toNotCompatible(expected, actual, { message: 'expected array was object' });
    }
    return context.config.compareArrayOrder
        ? compareOrderedArrays(expected, actual, context)
        : compareArrayMatches(input, computeArrayMatches(expected, actual, context));
}

function compareOrderedArrays(
    expected: readonly unknown[],
    actual: readonly unknown[],
    context: ComparisonContext
): ComparisonResult {
    if (expected.length !== actual.length) {
        return toNotCompatible(expected, actual, { message: 'Json array length differs under exact-ordered' });
    }
    for (let index = 0; index < expected.length; index++) {
        const result = compareValue({
            expected: expected[index],
            actual: actual[index],
            context: { ...context, path: `${context.path}[${index}]` }
        });
        if (!result.isEqual) {
            return toNotCompatible(expected, actual, {
                message: `Json array element ${index} differs`,
                details: { cause: result }
            });
        }
    }
    return toCompatible();
}

function compareValue(input: ComparisonInput): ComparisonResult {
    if (Array.isArray(input.expected)) {
        return compareArrays(input);
    }
    if (isRecord(input.expected)) {
        return compareObjects(input);
    }
    return compareScalar(input);
}

export function compareJson(expected: unknown, actual: unknown, config: CompareConfig): ComparisonResult {
    return compareValue({ expected, actual, context: { config, path: '' } });
}

export const COMPARISON = {
    COMPATIBLE_STRUCTURE: 'compatible-structure',
    COMPATIBLE: 'compatible',
    COMPATIBLE_COMPLETE: 'compatible-complete',
    EXACT_STRUCTURE: 'exact-structure',
    EXACT: 'exact',
    EXACT_ORDERED: 'exact-ordered'
} as const;

export type Comparison = typeof COMPARISON[keyof typeof COMPARISON];

const COMPARE_FLAGS_BY_COMPARISON: Record<
    Comparison,
    Pick<CompareConfig, 'compareValues' | 'compareExact' | 'compareArraysComplete' | 'compareArrayOrder'>
> = {
    [COMPARISON.COMPATIBLE_STRUCTURE]: {
        compareValues: false,
        compareExact: false,
        compareArraysComplete: false,
        compareArrayOrder: false
    },
    [COMPARISON.COMPATIBLE]: {
        compareValues: true,
        compareExact: false,
        compareArraysComplete: false,
        compareArrayOrder: false
    },
    [COMPARISON.COMPATIBLE_COMPLETE]: {
        compareValues: true,
        compareExact: false,
        compareArraysComplete: true,
        compareArrayOrder: false
    },
    [COMPARISON.EXACT_STRUCTURE]: {
        compareValues: false,
        compareExact: true,
        compareArraysComplete: false,
        compareArrayOrder: false
    },
    [COMPARISON.EXACT]: {
        compareValues: true,
        compareExact: true,
        compareArraysComplete: false,
        compareArrayOrder: false
    },
    [COMPARISON.EXACT_ORDERED]: {
        compareValues: true,
        compareExact: true,
        compareArraysComplete: true,
        compareArrayOrder: true
    }
};

function isComparison(value: string): value is Comparison {
    return Object.prototype.hasOwnProperty.call(COMPARE_FLAGS_BY_COMPARISON, value);
}

export function toConfig(
    comparison: Comparison | string,
    ignoreJsonKeys: string[] = [],
    ignoreJsonPaths: string[] = []
): CompareConfig {
    const normalizedComparison = comparison.toLowerCase();
    if (!isComparison(normalizedComparison)) {
        throw {
            error: 'Comparison unsupported: ' + normalizedComparison,
            comparisons: COMPARISON
        };
    }
    const compareFlags = COMPARE_FLAGS_BY_COMPARISON[normalizedComparison];
    return { ...compareFlags, ignoreJsonKeys, ignoreJsonPaths };
}
