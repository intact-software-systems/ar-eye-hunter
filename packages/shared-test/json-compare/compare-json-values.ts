import {
    decodeJsonComparisonInput,
    type JsonComparisonInputIssue,
    type JsonComparisonValues
} from './json-comparison-input.ts';

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
    | JsonComparisonObject
    | readonly (JsonValue | undefined)[];

export interface JsonComparisonObject {
    readonly [key: string]: JsonValue | undefined;
}

export interface CompareConfig {
    readonly compareValues: boolean;
    readonly compareExact: boolean;
    readonly compareArraysComplete: boolean;
    readonly compareArrayOrder: boolean;
    readonly ignoreJsonKeys: readonly string[];
    readonly ignoreJsonPaths: readonly string[];
}

export interface CompatibleResult {
    readonly isEqual: true;
}

export interface NotCompatibleResult extends ComparisonMismatchDetails {
    readonly isEqual: false;
    readonly message: string;
    readonly expected: JsonValue | undefined;
    readonly actual: JsonValue | undefined;
    readonly inputIssues?: readonly JsonComparisonInputIssue[];
}

export type ComparisonResult = CompatibleResult | NotCompatibleResult;

interface ComparisonContext {
    readonly config: CompareConfig;
    readonly path: string;
}

interface ComparisonInput extends JsonComparisonValues {
    readonly context: ComparisonContext;
}

interface Mismatch {
    readonly message: string;
    readonly details?: ComparisonMismatchDetails;
}

interface ArrayMatches {
    readonly expectedFound: readonly (JsonValue | undefined)[];
    readonly expectedNotFound: readonly (JsonValue | undefined)[];
    readonly actualNotFound: readonly (JsonValue | undefined)[];
}

interface ComparisonMismatchDetails {
    readonly keyNotExpected?: string;
    readonly expectedFound?: readonly (JsonValue | undefined)[];
    readonly expectedNotFound?: readonly (JsonValue | undefined)[];
    readonly actualNotFound?: readonly (JsonValue | undefined)[];
    readonly cause?: NotCompatibleResult;
}

interface ObjectComparisonInput extends ComparisonInput {
    readonly expected: JsonComparisonObject;
}

interface ArrayComparisonInput extends ComparisonInput {
    readonly expected: readonly (JsonValue | undefined)[];
}

interface ObjectPropertyComparison {
    readonly key: string;
    readonly expected: JsonComparisonObject;
    readonly actual: JsonComparisonObject;
    readonly context: ComparisonContext;
}

export function expandPath(path: string, key: string): string {
    return path.length === 0 ? key : path + '.' + key;
}

function toNotCompatible(
    expected: JsonValue | undefined,
    actual: JsonValue | undefined,
    mismatch: Mismatch
): NotCompatibleResult {
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

function isRecord(value: JsonValue | undefined): value is JsonComparisonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonArray(value: JsonValue | undefined): value is readonly (JsonValue | undefined)[] {
    return Array.isArray(value);
}

function matchesWildcard(expected: JsonValue | undefined, actual: JsonValue | undefined): boolean | undefined {
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

function isValueEqual(expected: JsonValue | undefined, actual: JsonValue | undefined, compareExact: boolean): boolean {
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
    expected: JsonComparisonObject,
    actual: JsonComparisonObject
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
            message: 'JSON values differ'
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
            message: 'actual.hasOwnProperty(' + key + ') is false'
        });
    }
    return compareValue({
        expected: expected[key],
        actual: actual[key],
        context: { ...context, path: expandPath(context.path, key) }
    });
}

function compareObjects(input: ObjectComparisonInput): ComparisonResult {
    const { expected, actual, context } = input;
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
    expected: readonly (JsonValue | undefined)[],
    actual: readonly (JsonValue | undefined)[],
    context: ComparisonContext
): ArrayMatches {
    const matchedActualIndexes = new Set<number>();
    const expectedFound: (JsonValue | undefined)[] = [];
    const expectedNotFound: (JsonValue | undefined)[] = [];
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

function compareArrays(input: ArrayComparisonInput): ComparisonResult {
    const { expected, actual, context } = input;
    if (!isJsonArray(actual)) {
        return toNotCompatible(expected, actual, { message: 'expected array was object' });
    }
    return context.config.compareArrayOrder
        ? compareOrderedArrays(expected, actual, context)
        : compareArrayMatches(input, computeArrayMatches(expected, actual, context));
}

function compareOrderedArrays(
    expected: readonly (JsonValue | undefined)[],
    actual: readonly (JsonValue | undefined)[],
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
    if (isJsonArray(input.expected)) {
        return compareArrays({ ...input, expected: input.expected });
    }
    if (isRecord(input.expected)) {
        return compareObjects({ ...input, expected: input.expected });
    }
    return compareScalar(input);
}

export function compareJson(expected: unknown, actual: unknown, config: CompareConfig): ComparisonResult {
    const decoded = decodeJsonComparisonInput(expected, actual);
    if (decoded.left) {
        return {
            isEqual: false,
            message: 'Comparison input is not a JSON value',
            expected: undefined,
            actual: undefined,
            inputIssues: decoded.left
        };
    }
    return compareValue({ ...decoded.right!, context: { config, path: '' } });
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
    ignoreJsonKeys: readonly string[] = [],
    ignoreJsonPaths: readonly string[] = []
): CompareConfig {
    const normalizedComparison = comparison.toLowerCase();
    if (!isComparison(normalizedComparison)) {
        throw new TypeError('Comparison unsupported: ' + normalizedComparison);
    }
    const compareFlags = COMPARE_FLAGS_BY_COMPARISON[normalizedComparison];
    return { ...compareFlags, ignoreJsonKeys, ignoreJsonPaths };
}
