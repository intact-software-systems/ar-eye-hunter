import type { RtcBaselineJson } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';

export function jsonRecord(
    value: RtcBaselineJson | undefined
): { [key: string]: RtcBaselineJson; } | null {
    return value !== undefined &&
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value)
        ? value
        : null;
}

export function exactStringArray(value: RtcBaselineJson | undefined): readonly string[] | null {
    return Array.isArray(value) &&
            value.every((entry): entry is string => typeof entry === 'string')
        ? value
        : null;
}

export function isFiniteNonnegativeNumber(
    value: RtcBaselineJson | undefined
): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function optionalJsonArray(
    value: RtcBaselineJson | undefined,
    path: string
): readonly RtcBaselineJson[] {
    return value === undefined ? [] : requiredJsonArray(value, path);
}

export function optionalString(
    value: RtcBaselineJson | undefined,
    path: string
): string | undefined {
    return value === undefined ? undefined : requiredString(value, path);
}

export function stringValue(value: RtcBaselineJson | undefined): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function numberValue(value: RtcBaselineJson | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function stringArrayValue(value: RtcBaselineJson | undefined): readonly string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
}

export function requiredJsonRecord(
    value: RtcBaselineJson | undefined,
    path: string
): { [key: string]: RtcBaselineJson; } {
    const record = jsonRecord(value);
    if (!record) {
        throw new Error(`${path} must be a JSON object.`);
    }
    return record;
}

export function requiredJsonArray(
    value: RtcBaselineJson | undefined,
    path: string
): readonly RtcBaselineJson[] {
    if (!Array.isArray(value)) {
        throw new Error(`${path} must be a JSON array.`);
    }
    return value;
}

export function requiredStringArray(
    value: RtcBaselineJson | undefined,
    path: string
): string[] {
    const values = exactStringArray(value);
    if (!values) {
        throw new Error(`${path} must contain only strings.`);
    }
    return [...values];
}

export function requiredString(value: RtcBaselineJson | undefined, field: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${field} must be a nonempty string.`);
    }
    return value;
}

export function requiredBoolean(value: RtcBaselineJson | undefined, field: string): boolean {
    if (typeof value !== 'boolean') {
        throw new Error(`${field} must be boolean.`);
    }
    return value;
}

export function requiredNonnegativeNumber(
    value: RtcBaselineJson | undefined,
    field: string
): number {
    if (!isFiniteNonnegativeNumber(value)) {
        throw new Error(`${field} must be a finite nonnegative number.`);
    }
    return value;
}

export function normalizeJson(value: RtcBaselineJson | object): RtcBaselineJson {
    assertJsonValue(value, '$');
    return JSON.parse(JSON.stringify(value)) as RtcBaselineJson;
}

function assertJsonValue(value: RtcBaselineJson | object, path: string): void {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error(`${path} contains a non-finite number.`);
        }
        return;
    }
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            if (!(index in value)) {
                throw new Error(`${path}[${index}] is a sparse array entry.`);
            }
            assertJsonValue(value[index], `${path}[${index}]`);
        }
        return;
    }
    if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error(`${path} is not a plain JSON value.`);
    }
    for (const [field, entry] of Object.entries(value)) {
        if (entry === undefined) {
            throw new Error(`${path}.${field} is undefined.`);
        }
        assertJsonValue(entry, `${path}.${field}`);
    }
}
