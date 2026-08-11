// deno-lint-ignore-file no-explicit-any
export interface AssertComparatorIssue {
    readonly path: any;
    readonly comparator: string;
    readonly expected: any;
    readonly actual: any;
    readonly message: string;
}

function toPathSegments(path: string): string[] {
    return path
        .replaceAll(/\[(\d+)]/g, '.$1')
        .split('.')
        .map(segment => segment.trim())
        .filter(segment => segment.length > 0);
}

function resolveComparatorValue(path: string, root: any): { found: boolean, value?: any } {
    let value = root;

    for (const segment of toPathSegments(path)) {
        if (value === undefined || value === null) {
            return { found: false };
        }

        value = value[segment];
    }

    return value === undefined ? { found: false } : { found: true, value };
}

function toIssue(input: {
    path: any;
    comparator: string;
    expected: any;
    actual: any;
    message: string;
}): AssertComparatorIssue {
    return {
        path: input.path,
        comparator: input.comparator,
        expected: input.expected,
        actual: input.actual,
        message: input.message,
    };
}

function numericIssues(entry: any, value: any): AssertComparatorIssue[] {
    const issues: AssertComparatorIssue[] = [];
    const actualNumber = Number(value);
    const numericComparators: Array<[string, (actual: number, bound: number) => boolean]> = [
        ['gt', (actual, bound) => actual > bound],
        ['gte', (actual, bound) => actual >= bound],
        ['lt', (actual, bound) => actual < bound],
        ['lte', (actual, bound) => actual <= bound],
    ];

    for (const [comparator, satisfies] of numericComparators) {
        if (entry[comparator] === undefined) {
            continue;
        }

        const bound = Number(entry[comparator]);
        if (!Number.isFinite(actualNumber) || !Number.isFinite(bound)) {
            issues.push(toIssue({
                path: entry.path,
                comparator,
                expected: entry[comparator],
                actual: value,
                message: 'Comparator requires finite numeric values.',
            }));
            continue;
        }

        if (!satisfies(actualNumber, bound)) {
            issues.push(toIssue({
                path: entry.path,
                comparator,
                expected: entry[comparator],
                actual: value,
                message: `Expected value ${comparator} ${bound}.`,
            }));
        }
    }

    return issues;
}

function betweenIssues(entry: any, value: any): AssertComparatorIssue[] {
    if (entry.between === undefined) {
        return [];
    }

    const bounds = Array.isArray(entry.between) ? entry.between.map(Number) : [];
    const actualNumber = Number(value);
    if (bounds.length !== 2 || bounds.some((bound: number) => !Number.isFinite(bound))) {
        return [toIssue({
            path: entry.path,
            comparator: 'between',
            expected: entry.between,
            actual: value,
            message: 'Comparator between requires a [low, high] numeric pair.',
        })];
    }

    if (!Number.isFinite(actualNumber) || actualNumber < bounds[0] || actualNumber > bounds[1]) {
        return [toIssue({
            path: entry.path,
            comparator: 'between',
            expected: entry.between,
            actual: value,
            message: `Expected value between ${bounds[0]} and ${bounds[1]} inclusive.`,
        })];
    }

    return [];
}

function lengthIssues(entry: any, value: any): AssertComparatorIssue[] {
    if (entry.length === undefined) {
        return [];
    }

    const expectedLength = Number(entry.length);
    const actualLength = Array.isArray(value) || typeof value === 'string'
        ? value.length
        : undefined;
    if (actualLength === undefined || actualLength !== expectedLength) {
        return [toIssue({
            path: entry.path,
            comparator: 'length',
            expected: entry.length,
            actual: value,
            message: `Expected an array or string of length ${expectedLength}.`,
        })];
    }

    return [];
}

function stringIssues(entry: any, value: any): AssertComparatorIssue[] {
    const issues: AssertComparatorIssue[] = [];

    if (entry.contains !== undefined) {
        if (typeof value !== 'string' || !value.includes(String(entry.contains))) {
            issues.push(toIssue({
                path: entry.path,
                comparator: 'contains',
                expected: entry.contains,
                actual: value,
                message: `Expected a string containing ${String(entry.contains)}.`,
            }));
        }
    }

    if (entry.matches !== undefined) {
        if (typeof value !== 'string' || !new RegExp(String(entry.matches)).test(value)) {
            issues.push(toIssue({
                path: entry.path,
                comparator: 'matches',
                expected: entry.matches,
                actual: value,
                message: `Expected a string matching /${String(entry.matches)}/.`,
            }));
        }
    }

    return issues;
}

const COMPARATOR_KEYS = ['gt', 'gte', 'lt', 'lte', 'between', 'length', 'contains', 'matches'];

function entryIssues(entry: any, actual: any): AssertComparatorIssue[] {
    if (typeof entry?.path !== 'string' || entry.path.length <= 0) {
        return [toIssue({
            path: entry?.path,
            comparator: 'path',
            expected: undefined,
            actual: undefined,
            message: 'Comparator entries need a non-empty string path.',
        })];
    }

    if (!COMPARATOR_KEYS.some(key => entry[key] !== undefined)) {
        return [toIssue({
            path: entry.path,
            comparator: 'none',
            expected: undefined,
            actual: undefined,
            message: `Comparator entries need at least one of: ${COMPARATOR_KEYS.join(', ')}.`,
        })];
    }

    const resolved = resolveComparatorValue(entry.path, actual);
    if (!resolved.found) {
        return [toIssue({
            path: entry.path,
            comparator: 'path',
            expected: undefined,
            actual: undefined,
            message: 'Comparator path did not resolve to a value.',
        })];
    }

    return [
        ...numericIssues(entry, resolved.value),
        ...betweenIssues(entry, resolved.value),
        ...lengthIssues(entry, resolved.value),
        ...stringIssues(entry, resolved.value),
    ];
}

// Pure validate-all pass over expect.comparators: every entry is evaluated and
// every failing comparator is reported, never just the first.
export function validateAssertValueComparators(
    actual: any,
    comparators: any,
): readonly AssertComparatorIssue[] {
    if (!Array.isArray(comparators)) {
        return [];
    }

    return comparators.flatMap(entry => entryIssues(entry, actual));
}
