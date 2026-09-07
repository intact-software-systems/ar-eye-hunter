import { Either } from '../../shared/resilience/Either.ts';
import type { JsonComparisonObject, JsonValue } from './compare-json-values.ts';

export interface JsonComparisonValues {
    readonly expected: JsonValue | undefined;
    readonly actual: JsonValue | undefined;
}

export interface JsonComparisonInputIssue {
    readonly input: 'expected' | 'actual';
    readonly path: string;
    readonly reason: 'unsupported-value' | 'cyclic-value' | 'accessor-property' | 'uninspectable-value';
}

interface JsonComparisonInputProperty {
    readonly value: unknown;
    readonly key: string;
    readonly path: string;
}

interface JsonComparisonInputObject {
    readonly snapshot: JsonComparisonObject | readonly (JsonValue | undefined)[];
    readonly properties: readonly JsonComparisonInputProperty[];
}

type JsonComparisonInputVisit =
    | { readonly kind: 'value'; readonly property: JsonComparisonInputProperty; readonly parent: object; }
    | { readonly kind: 'exit'; readonly value: object; readonly snapshot: JsonValue; };

interface JsonComparisonInputCapture {
    readonly value: JsonValue | undefined;
    readonly issues: readonly JsonComparisonInputIssue[];
}

export function decodeJsonComparisonInput(
    expected: unknown,
    actual: unknown
): Either<readonly JsonComparisonInputIssue[], JsonComparisonValues> {
    const expectedCapture = captureJsonComparisonValue(expected, 'expected');
    const actualCapture = captureJsonComparisonValue(actual, 'actual');
    const issues = [...expectedCapture.issues, ...actualCapture.issues];
    return issues.length > 0
        ? Either.ofLeft(issues)
        : Either.ofRight({ expected: expectedCapture.value, actual: actualCapture.value });
}

function isJsonComparisonScalar(value: unknown): value is string | number | boolean | null | undefined {
    return value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value));
}

function captureJsonComparisonValue(
    value: unknown,
    input: JsonComparisonInputIssue['input']
): JsonComparisonInputCapture {
    const root: JsonComparisonObject = {};
    const property = { value, key: 'value', path: '$' };
    const pending: JsonComparisonInputVisit[] = [{ kind: 'value', property, parent: root }];
    const ancestors = new Set<object>();
    const completed = new Map<object, JsonValue>();
    const issues: JsonComparisonInputIssue[] = [];
    while (pending.length > 0) {
        const visit = pending.pop()!;
        if (visit.kind === 'exit') {
            ancestors.delete(visit.value);
            completed.set(visit.value, Object.freeze(visit.snapshot));
            continue;
        }
        const { value, path, key } = visit.property;
        if (isJsonComparisonScalar(value)) {
            Object.defineProperty(visit.parent, key, { value, enumerable: true });
            continue;
        }
        if (typeof value !== 'object') {
            issues.push({ input, path, reason: 'unsupported-value' });
            continue;
        }
        if (ancestors.has(value)) {
            issues.push({ input, path, reason: 'cyclic-value' });
            continue;
        }
        const prior = completed.get(value);
        if (prior !== undefined) {
            Object.defineProperty(visit.parent, key, { value: prior, enumerable: true });
            continue;
        }
        const decoded = decodeJsonComparisonObject(value, path);
        if (decoded.left) {
            issues.push(...decoded.left.map((issue) => ({ ...issue, input })));
            continue;
        }
        const { snapshot, properties } = decoded.right!;
        Object.defineProperty(visit.parent, key, { value: snapshot, enumerable: true });
        ancestors.add(value);
        pending.push({ kind: 'exit', value, snapshot });
        for (const property of properties) {
            pending.push({ kind: 'value', property, parent: snapshot });
        }
    }
    return { value: root.value, issues };
}

function decodeJsonComparisonObject(
    value: object,
    path: string
): Either<readonly Omit<JsonComparisonInputIssue, 'input'>[], JsonComparisonInputObject> {
    try {
        const array = Array.isArray(value);
        const prototype = Object.getPrototypeOf(value);
        if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
            return Either.ofLeft([{ path, reason: 'unsupported-value' }]);
        }
        const properties: JsonComparisonInputProperty[] = [];
        const issues: Omit<JsonComparisonInputIssue, 'input'>[] = [];
        for (const key of Reflect.ownKeys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            const arrayIndex = array && typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) &&
                Number(key) < 4_294_967_295;
            if (!descriptor || (!descriptor.enumerable && !arrayIndex)) {
                continue;
            }
            const childPath = array ? `${path}[${String(key)}]` : `${path}.${String(key)}`;
            if (typeof key !== 'string' || (array && !arrayIndex)) {
                issues.push({ path: childPath, reason: 'unsupported-value' });
            }
            else if (!Object.hasOwn(descriptor, 'value')) {
                issues.push({ path: childPath, reason: 'accessor-property' });
            }
            else {
                properties.push({ path: childPath, key, value: descriptor.value });
            }
        }
        const length = array ? Object.getOwnPropertyDescriptor(value, 'length')?.value : undefined;
        if (
            array && (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 4_294_967_295)
        ) {
            return Either.ofLeft([...issues, { path, reason: 'unsupported-value' }]);
        }
        const snapshot: JsonComparisonObject | readonly (JsonValue | undefined)[] = array
            ? new Array<JsonValue | undefined>(length)
            : {};
        return issues.length > 0 ? Either.ofLeft(issues) : Either.ofRight({ snapshot, properties });
    }
    catch {
        return Either.ofLeft([{ path, reason: 'uninspectable-value' }]);
    }
}
