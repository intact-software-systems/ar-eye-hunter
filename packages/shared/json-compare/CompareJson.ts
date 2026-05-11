const ANY = 'any' as const;
const ANY_INTEGER = 'integer' as const;
const ANY_FLOAT = 'float' as const;
const ANY_STRING = 'string' as const;
const OR = '|';

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { [key: string]: JsonValue | undefined };
export type JsonArray = JsonValue[];

export interface CompareConfig {
    compareValues: boolean;
    compareExact: boolean;
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

export function expandPath(path: string, key: string): string {
    return !path || path.length <= 0
        ? key
        : path + '.' + key;
}

function toNotCompatible(
    expected: unknown,
    actual: unknown,
    message: string,
    details: Record<string, unknown> = {},
): NotCompatibleResult {
    return {
        isEqual: false,
        message,
        expected,
        actual,
        ...details,
    };
}

function toCompatible(): CompatibleResult {
    return {
        isEqual: true,
    };
}

function isRecord(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function isValueEqual(expected: unknown, actual: unknown, compareExact = false): boolean {
    if (expected === null && actual === null) {
        return true;
    }

    if (expected === undefined && actual !== undefined) {
        return false;
    }

    if (expected !== undefined && actual === undefined) {
        return false;
    }

    if (!compareExact) {
        if (expected === ANY) {
            return true;
        }

        if (expected === ANY_INTEGER) {
            if (typeof actual === 'number') {
                return Number.isInteger(actual);
            }
            if (typeof actual === 'string') {
                return /^-?\d+$/.test(actual);
            }
            return false;
        }

        if (expected === ANY_FLOAT) {
            if (typeof actual === 'number') {
                return Number.isFinite(actual) && !Number.isInteger(actual);
            }
            if (typeof actual === 'string') {
                const number = Number.parseFloat(actual);
                return Number.isFinite(number) && number % 1 !== 0;
            }
            return false;
        }

        if (expected === ANY_STRING) {
            return typeof actual === 'string';
        }

        if (typeof expected === 'string' && typeof actual === 'string' && expected.includes(OR)) {
            return expected.split(OR).some(e => e === actual);
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

function isIdenticalArrays(a: string[], b: string[]): ComparisonResult {
    for (const aKey of a) {
        if (!b.some(bKey => bKey === aKey)) {
            return toNotCompatible(a, b, ' Not exact equal keys in json object', { keyNotExpected: aKey });
        }
    }

    for (const bKey of b) {
        if (!a.some(aKey => aKey === bKey)) {
            return toNotCompatible(a, b, ' Not exact equal keys in json object', { keyNotExpected: bKey });
        }
    }

    return toCompatible();
}

function isCompatibleObjects(
    expected: JsonValue | undefined,
    actual: JsonValue | undefined,
    config: CompareConfig,
    currPath: string,
): ComparisonResult {
    if (Array.isArray(expected)) {
        return isCompatibleArrays(expected, actual, config, currPath);
    }

    if (!isRecord(expected)) {
        return config.compareValues && !isValueEqual(expected, actual, config.compareExact)
            ? toNotCompatible(expected, actual, '!isValueEqual(' + expected + ', ' + actual + ')')
            : toCompatible();
    }

    if (!isRecord(actual)) {
        return toNotCompatible(expected, actual, 'actual is not a json object');
    }

    if (config.compareExact) {
        const compatibilityMessage = isIdenticalArrays(Object.keys(expected), Object.keys(actual));
        if (!compatibilityMessage.isEqual) {
            return compatibilityMessage;
        }
    }

    for (const key of Object.keys(expected)) {
        if (config.ignoreJsonKeys.includes(key) || config.ignoreJsonPaths.includes(expandPath(currPath, key))) {
            continue;
        }

        const expectedValue = expected[key];
        const actualValue = actual[key];

        if (Array.isArray(expectedValue)) {
            if (!Array.isArray(actualValue)) {
                return toNotCompatible(expected, actual, '!Array.isArray(' + actualValue + ')');
            }

            const compatibleArrays = isCompatibleArrays(expectedValue, actualValue, config, expandPath(currPath, key));
            if (!compatibleArrays.isEqual) {
                return compatibleArrays;
            }
        }
        else if (isRecord(expectedValue)) {
            if (!isRecord(actualValue)) {
                return toNotCompatible(expected, actual, '!(' + actualValue + ') instanceof Object');
            }

            const compatibleObjects = isCompatibleObjects(expectedValue, actualValue, config, expandPath(currPath, key));
            if (!compatibleObjects.isEqual) {
                return compatibleObjects;
            }
        }
        else {
            if (!hasOwn(actual, key)) {
                return toNotCompatible(expected, actual, '!' + actual + '.hasOwnProperty(' + key + ')');
            }

            if (config.compareValues && !isValueEqual(expectedValue, actualValue, config.compareExact)) {
                return toNotCompatible(expected, actual, '!isValueEqual(' + expectedValue + ', ' + actualValue + ')');
            }
        }
    }

    return toCompatible();
}

function isCompatibleArrays(
    expected: JsonArray,
    actual: JsonValue | undefined,
    config: CompareConfig,
    currPath: string,
): ComparisonResult {
    if (!Array.isArray(actual)) {
        return toNotCompatible(expected, actual, 'expected array was object');
    }

    const expectedFound: JsonValue[] = [];
    const expectedNotFound: Array<JsonValue | undefined> = [...expected];
    const actualToCompare: Array<JsonValue | undefined> = [...actual];

    for (let i = 0; i < expected.length; i++) {
        const expectedValue = expected[i];

        for (let j = 0; j < actualToCompare.length; j++) {
            if (actualToCompare[j] === undefined) {
                continue;
            }

            const actualValue = actualToCompare[j];

            if (Array.isArray(expectedValue)) {
                const compatibilityMessage = isCompatibleArrays(expectedValue, actualValue, config, expandPath(currPath, 'n'));
                if (compatibilityMessage.isEqual) {
                    expectedFound.push(expectedValue);
                    actualToCompare[j] = undefined;
                    expectedNotFound[i] = undefined;
                    break;
                }
            }
            else {
                const compatibilityMessage = isCompatibleObjects(expectedValue, actualValue, config, expandPath(currPath, 'n'));
                if (compatibilityMessage.isEqual) {
                    expectedFound.push(expectedValue);
                    actualToCompare[j] = undefined;
                    expectedNotFound[i] = undefined;
                    break;
                }
            }
        }
    }

    if (config.compareExact) {
        const actualNotFound = actualToCompare.filter(a => a !== undefined);
        if (actualNotFound.length > 0) {
            return toNotCompatible(expected, actual, 'Json structures not exact equals', {
                expectedFound: expectedFound.filter(a => a !== undefined),
                expectedNotFound: expectedNotFound.filter(a => a !== undefined),
                actualNotFound,
            });
        }
    }

    if (config.compareValues) {
        return expectedFound.length === expected.length
            ? toCompatible()
            : toNotCompatible(expected, actual, 'Json structures not compatible', {
                expectedFound: expectedFound.filter(a => a !== undefined),
                expectedNotFound: expectedNotFound.filter(a => a !== undefined),
                actualNotFound: actualToCompare.filter(a => a !== undefined),
            });
    }

    const foundExpected = expectedFound.length >= expected.length;
    if (!foundExpected) {
        return toNotCompatible(expected, actual, 'Did not find the expected in actual', {
            expectedFound: expectedFound.filter(a => a !== undefined),
            expectedNotFound: expectedNotFound.filter(a => a !== undefined),
            actualNotFound: actualToCompare.filter(a => a !== undefined),
        });
    }

    return toCompatible();
}

export function compareJson(expected: JsonValue, actual: JsonValue, config: CompareConfig): ComparisonResult {
    return Array.isArray(expected)
        ? isCompatibleArrays(expected, actual, config, '')
        : isCompatibleObjects(expected, actual, config, '');
}

export const COMPARISON = {
    COMPATIBLE_STRUCTURE: 'compatible-structure',
    COMPATIBLE: 'compatible',
    EXACT_STRUCTURE: 'exact-structure',
    EXACT: 'exact',
} as const;

export type Comparison = typeof COMPARISON[keyof typeof COMPARISON];

export function toConfig(
    comparison: Comparison | string,
    ignoreJsonKeys: string[] = [],
    ignoreJsonPaths: string[] = [],
): CompareConfig {
    switch (comparison.toLowerCase()) {
        case COMPARISON.COMPATIBLE_STRUCTURE:
            return toConfigDto(false, false, ignoreJsonKeys, ignoreJsonPaths);
        case COMPARISON.COMPATIBLE:
            return toConfigDto(true, false, ignoreJsonKeys, ignoreJsonPaths);
        case COMPARISON.EXACT_STRUCTURE:
            return toConfigDto(false, true, ignoreJsonKeys, ignoreJsonPaths);
        case COMPARISON.EXACT:
            return toConfigDto(true, true, ignoreJsonKeys, ignoreJsonPaths);
        default:
            throw {
                error: 'Comparison unsupported: ' + comparison.toLowerCase(),
                comparisons: COMPARISON,
            };
    }
}

function toConfigDto(
    compareValues: boolean,
    compareExact: boolean,
    ignoreJsonKeys: string[],
    ignoreJsonPaths: string[],
): CompareConfig {
    return {
        compareValues,
        compareExact,
        ignoreJsonKeys,
        ignoreJsonPaths,
    };
}