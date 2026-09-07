import { jsonEquals } from '@shared/repository/state-utils.ts';
import { decodeScenarioNumber, decodeScenarioText } from '../scenario-value-decoding.ts';

export interface AssertComparatorIssue {
    readonly path: unknown;
    readonly comparator: string;
    readonly expected: unknown;
    readonly actual: unknown;
    readonly message: string;
}

interface AssertComparator {
    readonly path: string;
    readonly gt?: unknown;
    readonly gte?: unknown;
    readonly lt?: unknown;
    readonly lte?: unknown;
    readonly between?: unknown;
    readonly length?: unknown;
    readonly contains?: unknown;
    readonly matches?: unknown;
    readonly equals?: unknown;
    readonly notEquals?: unknown;
    readonly exists?: unknown;
}

interface AssertComparatorValue {
    readonly found: boolean;
    readonly value: unknown;
}

function toPathSegments(path: string): string[] {
    return path
        .replaceAll(/\[(\d+)]/g, '.$1')
        .split('.')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);
}

function resolveComparatorValue(path: string, root: unknown): AssertComparatorValue {
    let value = root;

    for (const segment of toPathSegments(path)) {
        if (value === undefined || value === null) {
            return { found: false, value: undefined };
        }

        const record = Object(value) as Record<string, unknown>;
        value = record[segment];
    }

    return { found: value !== undefined, value };
}

function numericIssues(entry: AssertComparator, value: unknown): AssertComparatorIssue[] {
    const issues: AssertComparatorIssue[] = [];
    const numericComparators = ['gt', 'gte', 'lt', 'lte'] as const;

    if (!numericComparators.some((comparator) => entry[comparator] !== undefined)) {
        return issues;
    }
    const actualNumber = decodeScenarioNumber(value);

    for (const comparator of numericComparators) {
        if (entry[comparator] === undefined) {
            continue;
        }

        const bound = decodeScenarioNumber(entry[comparator]);
        if (actualNumber === undefined || bound === undefined) {
            issues.push({
                path: entry.path,
                comparator,
                expected: entry[comparator],
                actual: value,
                message: 'Comparator requires finite numeric values.'
            });
            continue;
        }

        const satisfied = comparator === 'gt'
            ? actualNumber > bound
            : comparator === 'gte'
            ? actualNumber >= bound
            : comparator === 'lt'
            ? actualNumber < bound
            : actualNumber <= bound;
        if (!satisfied) {
            issues.push({
                path: entry.path,
                comparator,
                expected: entry[comparator],
                actual: value,
                message: `Expected value ${comparator} ${bound}.`
            });
        }
    }

    return issues;
}

function betweenIssues(entry: AssertComparator, value: unknown): AssertComparatorIssue[] {
    if (entry.between === undefined) {
        return [];
    }

    const rawBounds: unknown[] = Array.isArray(entry.between) ? entry.between : [];
    const bounds = Array.from(rawBounds, decodeScenarioNumber);
    const actualNumber = decodeScenarioNumber(value);
    if (bounds.length !== 2 || !bounds.every((bound): bound is number => bound !== undefined)) {
        return [{
            path: entry.path,
            comparator: 'between',
            expected: entry.between,
            actual: value,
            message: 'Comparator between requires a [low, high] numeric pair.'
        }];
    }

    if (actualNumber === undefined || actualNumber < bounds[0] || actualNumber > bounds[1]) {
        return [{
            path: entry.path,
            comparator: 'between',
            expected: entry.between,
            actual: value,
            message: `Expected value between ${bounds[0]} and ${bounds[1]} inclusive.`
        }];
    }

    return [];
}

function lengthIssues(entry: AssertComparator, value: unknown): AssertComparatorIssue[] {
    if (entry.length === undefined) {
        return [];
    }

    const expectedLength = decodeScenarioNumber(entry.length);
    const actualLength = Array.isArray(value) || typeof value === 'string'
        ? value.length
        : undefined;
    if (actualLength === undefined || actualLength !== expectedLength) {
        return [{
            path: entry.path,
            comparator: 'length',
            expected: entry.length,
            actual: value,
            message: expectedLength === undefined
                ? 'Comparator length requires a finite numeric value.'
                : `Expected an array or string of length ${expectedLength}.`
        }];
    }

    return [];
}

function stringIssues(entry: AssertComparator, value: unknown): AssertComparatorIssue[] {
    const issues: AssertComparatorIssue[] = [];
    if (entry.contains !== undefined) {
        const expected = decodeScenarioText(entry.contains);
        if (typeof value !== 'string' || expected === undefined || !value.includes(expected)) {
            issues.push({
                path: entry.path,
                comparator: 'contains',
                expected: entry.contains,
                actual: value,
                message: expected === undefined
                    ? 'Comparator contains requires a scalar text value.'
                    : `Expected a string containing ${expected}.`
            });
        }
    }
    if (entry.matches !== undefined) {
        issues.push(...regexIssues(entry, value));
    }
    return issues;
}

function regexIssues(entry: AssertComparator, value: unknown): AssertComparatorIssue[] {
    const pattern = decodeScenarioText(entry.matches);
    let matches = false;
    let valid = pattern !== undefined;
    if (pattern !== undefined) {
        try {
            const expression = new RegExp(pattern);
            matches = typeof value === 'string' && expression.test(value);
        }
        catch {
            valid = false;
        }
    }
    return matches ? [] : [{
        path: entry.path,
        comparator: 'matches',
        expected: entry.matches,
        actual: value,
        message: valid
            ? `Expected a string matching /${pattern}/.`
            : 'Comparator matches requires a valid regular expression.'
    }];
}

function equalityIssues(entry: AssertComparator, value: unknown): AssertComparatorIssue[] {
    const issues: AssertComparatorIssue[] = [];

    if (entry.equals !== undefined && !jsonEquals(entry.equals, value)) {
        issues.push({
            path: entry.path,
            comparator: 'equals',
            expected: entry.equals,
            actual: value,
            message: 'Expected the value to equal the expected value.'
        });
    }

    if (entry.notEquals !== undefined && jsonEquals(entry.notEquals, value)) {
        issues.push({
            path: entry.path,
            comparator: 'notEquals',
            expected: entry.notEquals,
            actual: value,
            message: 'Expected the value to differ from the expected value.'
        });
    }

    return issues;
}

/**
 * `exists` is decided before the path is required to resolve, because an
 * absent path is the assertion rather than a failure to make one. Every other
 * comparator needs a value to compare and reports an unresolved path.
 */
function existenceIssues(entry: AssertComparator, found: boolean): AssertComparatorIssue[] {
    if (entry.exists === undefined) {
        return [];
    }

    if (typeof entry.exists !== 'boolean') {
        return [{
            path: entry.path,
            comparator: 'exists',
            expected: entry.exists,
            actual: found,
            message: 'Comparator exists requires a boolean value.'
        }];
    }
    const expected = entry.exists;
    return expected === found ? [] : [{
        path: entry.path,
        comparator: 'exists',
        expected,
        actual: found,
        message: expected ? 'Expected the path to resolve to a value.' : 'Expected the path to be absent.'
    }];
}

const COMPARATOR_KEYS = [
    'gt',
    'gte',
    'lt',
    'lte',
    'between',
    'length',
    'contains',
    'matches',
    'equals',
    'notEquals',
    'exists'
] as const;

function entryIssues(raw: unknown, actual: unknown): AssertComparatorIssue[] {
    const record = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {};
    if (typeof record.path !== 'string' || record.path.length <= 0) {
        return [{
            path: record.path,
            comparator: 'path',
            expected: undefined,
            actual: undefined,
            message: 'Comparator entries need a non-empty string path.'
        }];
    }

    const entry: AssertComparator = { ...record, path: record.path };
    if (!COMPARATOR_KEYS.some((key) => entry[key] !== undefined)) {
        return [{
            path: entry.path,
            comparator: 'none',
            expected: undefined,
            actual: undefined,
            message: `Comparator entries need at least one of: ${COMPARATOR_KEYS.join(', ')}.`
        }];
    }

    const resolved = resolveComparatorValue(entry.path, actual);
    const existence = existenceIssues(entry, resolved.found);
    const comparesValue = COMPARATOR_KEYS.some((key) => key !== 'exists' && entry[key] !== undefined);
    if (!comparesValue) {
        return existence;
    }

    if (!resolved.found) {
        return [
            ...existence,
            {
                path: entry.path,
                comparator: 'path',
                expected: undefined,
                actual: undefined,
                message: 'Comparator path did not resolve to a value.'
            }
        ];
    }

    return [
        ...existence,
        ...numericIssues(entry, resolved.value),
        ...betweenIssues(entry, resolved.value),
        ...lengthIssues(entry, resolved.value),
        ...stringIssues(entry, resolved.value),
        ...equalityIssues(entry, resolved.value)
    ];
}

// Pure validate-all pass over expect.comparators: every entry is evaluated and
// every failing comparator is reported, never just the first.
export function validateAssertValueComparators(
    actual: unknown,
    comparators: unknown
): readonly AssertComparatorIssue[] {
    if (comparators === undefined) {
        return [];
    }
    if (!Array.isArray(comparators)) {
        return [{
            path: undefined,
            comparator: 'collection',
            expected: 'array',
            actual: comparators,
            message: 'Assert comparators must be an array.'
        }];
    }

    return Array.from(comparators).flatMap((entry) => entryIssues(entry, actual));
}
