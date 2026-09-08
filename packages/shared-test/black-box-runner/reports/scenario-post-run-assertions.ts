import { Either } from '../../../shared/resilience/Either.ts';
import {
    compareJson,
    COMPARISON,
    type CompareConfig
} from '../../json-compare/compare-json-values.ts';
import {
    decodeScenarioComparison,
    decodeScenarioNumber,
    decodeScenarioText
} from '../scenario-value-decoding.ts';

export interface PostRunAssertionResult {
    readonly name: string;
    readonly path: string | undefined;
    readonly operator: string;
    readonly source: string | undefined;
    readonly index: number | undefined;
    readonly actual: unknown;
    readonly expected: unknown;
    readonly status: 'SUCCESS' | 'FAILURE';
    readonly result?: string;
    readonly details?: Readonly<Record<string, unknown>>;
}

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
    readonly config: CompareConfig;
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

function resolveReportPath(report: unknown, path: string | undefined): ReportPathValue {
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

        value = (Object(value) as JsonRecord)[segment];
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

function firstConfiguredOperator(spec: JsonRecord): Either<PostRunComparison, string> {
    const explicit = spec.operator !== undefined ? spec.operator : spec.op;
    if (explicit !== undefined) {
        const operator = stringValue(explicit);
        return operator !== undefined
            ? Either.ofRight(operator)
            : Either.ofLeft({
                pass: false,
                expected: spec.expected,
                details: { reason: 'invalid-post-run-operator', operator: explicit }
            });
    }
    return Either.ofRight(postRunOperatorKeys().find((key) => spec[key] !== undefined) ?? 'equals');
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
    const actualNumber = decodeScenarioNumber(actual);
    const expectedNumber = decodeScenarioNumber(expected);

    if (actualNumber === undefined || expectedNumber === undefined) {
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

function includesValue(actual: unknown, expected: unknown, config: CompareConfig): boolean | undefined {
    if (typeof actual === 'string') {
        const text = decodeScenarioText(expected);
        return text === undefined ? undefined : actual.includes(text);
    }
    if (Array.isArray(actual)) {
        return actual.some((item) => compareJson(expected, item, config).isEqual);
    }
    if (actual && typeof actual === 'object') {
        return typeof expected === 'string' ? Object.prototype.hasOwnProperty.call(actual, expected) : undefined;
    }
    return undefined;
}

function postRunAssertionName(spec: JsonRecord, index: number, path: string | undefined): string {
    return stringValue(spec.name) ??
        stringValue(spec.label) ??
        path ??
        'post-run-assertion-' + (index + 1);
}

export function toPostRunAssertionResult(spec: JsonRecord, index: number, report: unknown): PostRunAssertionResult {
    const path = stringValue(spec.path ?? spec.metric ?? spec.from);
    const selectedOperator = firstConfiguredOperator(spec);
    const resolved = spec.actual !== undefined ? { found: true, value: spec.actual } : resolveReportPath(report, path);
    const configuration = decodeScenarioComparison(
        spec.comparison === undefined ? COMPARISON.COMPATIBLE : spec.comparison,
        spec.ignoreJsonKeys === undefined ? [] : spec.ignoreJsonKeys,
        spec.ignoreJsonPaths === undefined ? [] : spec.ignoreJsonPaths
    );
    const comparison = selectedOperator.fold(
        (failure) => failure,
        (operator) =>
            configuration.fold<PostRunComparison>(
                (error) => ({
                    expected: operatorExpectedValue(spec, [operator]),
                    pass: false,
                    details: { reason: 'invalid-comparison', message: error.message }
                }),
                (config) =>
                    computePostRunComparison({ spec, operator, config, found: resolved.found, actual: resolved.value })
            )
    );
    return {
        name: postRunAssertionName(spec, index, path),
        path,
        operator: selectedOperator.right ?? 'unknown',
        source: stringValue(spec.source),
        index: decodeScenarioNumber(spec.index),
        actual: resolved.value,
        expected: comparison.expected,
        status: comparison.pass ? 'SUCCESS' : 'FAILURE',
        ...(comparison.pass ? {} : { result: 'Post-run assertion failed', details: comparison.details })
    };
}

function computePostRunComparison(input: PostRunComparisonInput): PostRunComparison {
    const { spec, operator, found, actual, config } = input;
    if (operator === 'exists') {
        const expected = spec.exists === undefined ? true : spec.exists;
        return {
            expected,
            pass: typeof expected === 'boolean' && found === expected,
            details: { reason: expected ? 'path-missing' : 'path-present' }
        };
    }
    if (!found) {
        return {
            expected: operatorExpectedValue(spec, [operator, 'expected', 'equals', 'eq']),
            pass: false,
            details: { reason: 'path-missing' }
        };
    }
    if (['equals', 'eq', 'expected', 'notEquals', 'ne'].includes(operator)) {
        return computeEqualityComparison(input);
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
        const includes = includesValue(actual, expected, config);
        return {
            expected,
            pass: includes !== undefined && (operator === 'notIncludes' ? !includes : includes),
            details: { reason: operator === 'notIncludes' ? 'value-was-included' : 'value-was-not-included' }
        };
    }
    return {
        expected: operatorExpectedValue(spec, [operator, 'expected', 'value']),
        pass: false,
        details: { reason: 'unsupported-post-run-operator', supportedOperators: postRunOperatorKeys() }
    };
}

function computeEqualityComparison(input: PostRunComparisonInput): PostRunComparison {
    const { spec, actual, operator, config } = input;
    const negate = operator === 'notEquals' || operator === 'ne';
    const expected = operatorExpectedValue(
        spec,
        negate ? ['notEquals', 'ne', 'expected', 'equals', 'eq'] : ['equals', 'eq', 'expected']
    );
    const comparison = compareJson(
        expected,
        actual,
        negate ? { ...config, ignoreJsonKeys: [], ignoreJsonPaths: [] } : config
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
    const bounds = Array.from(range, decodeScenarioNumber);
    if (bounds.length !== 2 || !bounds.every((value): value is number => value !== undefined)) {
        return { expected, pass: false, details: { reason: 'between-requires-numeric-pair' } };
    }
    const actualNumber = decodeScenarioNumber(actual);
    const [min, max] = bounds;
    return {
        expected,
        pass: actualNumber !== undefined && actualNumber >= min && actualNumber <= max,
        details: { reason: 'between-threshold-not-met', min: range[0], max: range[1] }
    };
}
