// deno-lint-ignore-file no-explicit-any
import { compareJson, COMPARISON, toConfig } from '../../json-compare/compare-json-values.ts';

interface ReportPathValue {
    readonly found: boolean;
    readonly value?: unknown;
}

interface NumericComparison {
    readonly pass: boolean;
    readonly details?: JsonRecord;
}

interface JsonRecord {
    [key: string]: unknown;
}

interface PostRunComparisonInput {
    readonly spec: JsonRecord;
    readonly operator: string;
    readonly found: boolean;
    readonly actual: unknown;
}

interface PostRunComparison {
    readonly expected: unknown;
    readonly pass: boolean;
    readonly details?: JsonRecord;
}

function asRecord(value: unknown): JsonRecord {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : {};
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberFromPath(value: unknown): number | undefined {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}

function postRunOperatorKeys(): string[] {
    return [
        'equals',
        'eq',
        'expected',
        'notEquals',
        'ne',
        'gte',
        'min',
        'atLeast',
        'lte',
        'max',
        'atMost',
        'gt',
        'lt',
        'between',
        'includes',
        'contains',
        'notIncludes',
        'exists'
    ];
}

function isPostRunAssertionSpec(value: JsonRecord): boolean {
    return value.path !== undefined ||
        value.metric !== undefined ||
        value.from !== undefined ||
        value.actual !== undefined ||
        value.operator !== undefined ||
        value.op !== undefined ||
        postRunOperatorKeys().some((key) => value[key] !== undefined);
}

export function normalizePostRunAssertionSource(value: unknown, source: string): JsonRecord[] {
    if (Array.isArray(value)) {
        return value
            .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
            .map((item, index) => ({
                source,
                index,
                ...(item as JsonRecord)
            }));
    }

    const record = asRecord(value);
    if (Object.keys(record).length <= 0) {
        return [];
    }

    if (isPostRunAssertionSpec(record)) {
        return [{
            source,
            ...record
        }];
    }

    return Object.entries(record).map(([name, spec]) => {
        if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
            const specRecord = spec as JsonRecord;
            return {
                source,
                name: stringValue(specRecord.name) ?? name,
                ...specRecord,
                path: specRecord.path ?? specRecord.metric ?? specRecord.from ?? name
            };
        }

        return {
            source,
            name,
            path: name,
            equals: spec
        };
    });
}

function reportPathSegments(path: string): string[] {
    const segments: string[] = [];
    let current = '';

    for (let index = 0; index < path.length; index++) {
        const character = path[index];

        if (character === '.') {
            if (current.length > 0) {
                segments.push(current);
                current = '';
            }
            continue;
        }

        if (character === '[') {
            if (current.length > 0) {
                segments.push(current);
                current = '';
            }
            const endIndex = path.indexOf(']', index);
            if (endIndex < 0) {
                current += character;
                continue;
            }
            const rawSegment = path.slice(index + 1, endIndex).trim();
            segments.push(rawSegment.replace(/^['"]|['"]$/g, ''));
            index = endIndex;
            continue;
        }

        current += character;
    }

    if (current.length > 0) {
        segments.push(current);
    }

    return segments.filter((segment) => segment.length > 0);
}

function resolveReportPath(report: any, path: string | undefined): ReportPathValue {
    if (!path || path.trim().length <= 0) {
        return {
            found: false
        };
    }

    const segments = reportPathSegments(path.trim());
    const normalizedSegments = segments[0] === 'report'
        ? segments.slice(1)
        : segments;
    let value = report;

    for (const segment of normalizedSegments) {
        if (value === undefined || value === null) {
            return {
                found: false
            };
        }

        value = value[segment];
    }

    return value === undefined
        ? {
            found: false
        }
        : {
            found: true,
            value
        };
}

function firstConfiguredOperator(spec: JsonRecord): string {
    const explicit = stringValue(spec.operator) ?? stringValue(spec.op);
    if (explicit) {
        return explicit;
    }

    return postRunOperatorKeys().find((key) => spec[key] !== undefined) ?? 'equals';
}

function operatorExpectedValue(spec: JsonRecord, aliases: string[]): unknown {
    for (const alias of aliases) {
        if (spec[alias] !== undefined) {
            return spec[alias];
        }
    }

    if (spec.value !== undefined) {
        return spec.value;
    }

    return spec.expected;
}

function numberComparison(
    operator: string,
    actual: unknown,
    expected: unknown
): NumericComparison {
    const actualNumber = Number(actual);
    const expectedNumber = Number(expected);

    if (!Number.isFinite(actualNumber) || !Number.isFinite(expectedNumber)) {
        return {
            pass: false,
            details: {
                reason: 'numeric-comparison-requires-finite-values',
                actual,
                expected
            }
        };
    }

    if (operator === 'gt') {
        return {
            pass: actualNumber > expectedNumber
        };
    }

    if (operator === 'gte' || operator === 'min' || operator === 'atLeast') {
        return {
            pass: actualNumber >= expectedNumber
        };
    }

    if (operator === 'lt') {
        return {
            pass: actualNumber < expectedNumber
        };
    }

    return {
        pass: actualNumber <= expectedNumber
    };
}

function includesValue(actual: unknown, expected: unknown, spec: JsonRecord): boolean {
    if (typeof actual === 'string') {
        return actual.includes(String(expected));
    }

    if (Array.isArray(actual)) {
        return actual.some((item) =>
            compareJson(
                expected,
                item,
                toConfig(
                    String(spec.comparison || COMPARISON.COMPATIBLE),
                    toIgnoredJsonMatchers(spec.ignoreJsonKeys),
                    toIgnoredJsonMatchers(spec.ignoreJsonPaths)
                )
            ).isEqual
        );
    }

    if (actual && typeof actual === 'object' && typeof expected === 'string') {
        return Object.prototype.hasOwnProperty.call(actual, expected);
    }

    return false;
}

function postRunAssertionName(spec: JsonRecord, index: number, path: string | undefined): string {
    return stringValue(spec.name) ??
        stringValue(spec.label) ??
        path ??
        'post-run-assertion-' + (index + 1);
}

export function toPostRunAssertionResult(spec: JsonRecord, index: number, report: any): JsonRecord {
    const path = stringValue(spec.path ?? spec.metric ?? spec.from);
    const operator = firstConfiguredOperator(spec);
    const resolved = spec.actual !== undefined ? { found: true, value: spec.actual } : resolveReportPath(report, path);
    const comparison = computePostRunComparison({ spec, operator, found: resolved.found, actual: resolved.value });
    return {
        name: postRunAssertionName(spec, index, path),
        path,
        operator,
        source: stringValue(spec.source),
        index: numberFromPath(spec.index),
        actual: resolved.value,
        expected: comparison.expected,
        status: comparison.pass ? 'SUCCESS' : 'FAILURE',
        ...(comparison.pass ? {} : { result: 'Post-run assertion failed', details: comparison.details })
    };
}

function computePostRunComparison(input: PostRunComparisonInput): PostRunComparison {
    const { spec, operator, found, actual } = input;
    if (operator === 'exists') {
        const expected = spec.exists === undefined ? true : Boolean(spec.exists);
        return { expected, pass: found === expected, details: { reason: expected ? 'path-missing' : 'path-present' } };
    }
    if (!found) {
        return {
            expected: operatorExpectedValue(spec, [operator, 'expected', 'equals', 'eq']),
            pass: false,
            details: { reason: 'path-missing' }
        };
    }
    if (['equals', 'eq', 'expected', 'notEquals', 'ne'].includes(operator)) {
        return computeEqualityComparison(spec, actual, operator === 'notEquals' || operator === 'ne');
    }
    if (['gt', 'gte', 'min', 'atLeast', 'lt', 'lte', 'max', 'atMost'].includes(operator)) {
        const expected = operatorExpectedValue(spec, [operator, 'value', 'expected']);
        const comparison = numberComparison(operator, actual, expected);
        return {
            expected,
            pass: comparison.pass,
            details: comparison.details ?? { reason: 'numeric-threshold-not-met' }
        };
    }
    if (operator === 'between') {
        return computeRangeComparison(spec, actual);
    }
    if (operator === 'includes' || operator === 'contains' || operator === 'notIncludes') {
        const expected = operatorExpectedValue(spec, ['includes', 'contains', 'notIncludes', 'expected', 'value']);
        const includes = includesValue(actual, expected, spec);
        return {
            expected,
            pass: operator === 'notIncludes' ? !includes : includes,
            details: { reason: operator === 'notIncludes' ? 'value-was-included' : 'value-was-not-included' }
        };
    }
    return {
        expected: operatorExpectedValue(spec, [operator, 'expected', 'value']),
        pass: false,
        details: { reason: 'unsupported-post-run-operator', supportedOperators: postRunOperatorKeys() }
    };
}

function computeEqualityComparison(spec: JsonRecord, actual: unknown, negate: boolean): PostRunComparison {
    const expected = operatorExpectedValue(
        spec,
        negate ? ['notEquals', 'ne', 'expected', 'equals', 'eq'] : ['equals', 'eq', 'expected']
    );
    const comparison = compareJson(
        expected,
        actual,
        toConfig(
            String(spec.comparison || COMPARISON.COMPATIBLE),
            negate ? [] : toIgnoredJsonMatchers(spec.ignoreJsonKeys),
            negate ? [] : toIgnoredJsonMatchers(spec.ignoreJsonPaths)
        )
    );
    return {
        expected,
        pass: negate ? !comparison.isEqual : comparison.isEqual,
        details: negate ? { reason: 'values-were-equal', comparison } : { comparison }
    };
}

function computeRangeComparison(spec: JsonRecord, actual: unknown): PostRunComparison {
    const expected = operatorExpectedValue(spec, ['between']);
    const range = Array.isArray(expected) ? expected : [];
    const actualNumber = Number(actual);
    const min = Number(range[0]);
    const max = Number(range[1]);
    return {
        expected,
        pass: Number.isFinite(actualNumber) && Number.isFinite(min) && Number.isFinite(max) && actualNumber >= min &&
            actualNumber <= max,
        details: { reason: 'between-threshold-not-met', min: range[0], max: range[1] }
    };
}

function toIgnoredJsonMatchers(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
