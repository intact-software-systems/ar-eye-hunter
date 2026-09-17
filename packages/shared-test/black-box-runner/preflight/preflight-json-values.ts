import type {
    ApiJsonObject,
    ApiJsonValue
} from '../../../shared/api/api-json-value.ts';

import { decodeJsonValue } from '../../rallar-bb-test/runtime/decode-runtime-result-values.ts';

/** A recipe value the runner read from JSON or YAML, in its JSON form; a value that is not an object reads as empty. */
export function decodePreflightJsonObject(value: unknown): ApiJsonObject {
    return toPreflightJsonObject(decodeJsonValue(value));
}

/** Executable steps in their JSON form; a value that is not an array reads as no steps. */
export function decodePreflightJsonArray(value: unknown): readonly ApiJsonValue[] {
    return toPreflightJsonArray(decodeJsonValue(value));
}

export function isPreflightJsonObject(value: ApiJsonValue | undefined): value is ApiJsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function toPreflightJsonObject(value: ApiJsonValue | undefined): ApiJsonObject {
    return isPreflightJsonObject(value) ? value : {};
}

export function toPreflightJsonArray(value: ApiJsonValue | undefined): readonly ApiJsonValue[] {
    return Array.isArray(value) ? value : [];
}

export function toNonEmptyText(value: ApiJsonValue | undefined): string | undefined {
    return typeof value === 'string' && value.length > 0
        ? value
        : undefined;
}

export function toFiniteNumber(value: ApiJsonValue | undefined): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export function toUniqueSortedTexts(values: readonly string[]): readonly string[] {
    return [...new Set(values.filter((value) => value.length > 0))].sort();
}
