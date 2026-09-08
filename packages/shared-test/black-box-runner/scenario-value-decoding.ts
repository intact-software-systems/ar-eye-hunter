import { Either } from '../../shared/resilience/Either.ts';
import { toConfig, type CompareConfig } from '../json-compare/compare-json-values.ts';

function isNumericScalar(value: unknown): value is number | string {
    return typeof value === 'number' || typeof value === 'string';
}

/** Report and assertion numbers accept numeric strings, never object coercion. */
export function decodeScenarioNumber(value: unknown): number | undefined {
    if (!isNumericScalar(value)) {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/** Keep the existing positive-integer configuration policy after scalar narrowing. */
export function decodeScenarioPositiveInteger(values: readonly unknown[]): number | undefined {
    for (const value of values) {
        if (!isNumericScalar(value) || value === '') {
            continue;
        }
        const parsed = Number.parseInt(String(value), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return undefined;
}

export function decodeScenarioText(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
        return String(value);
    }
    return undefined;
}

export function decodeScenarioComparison(
    comparison: unknown,
    ignoreJsonKeys: unknown,
    ignoreJsonPaths: unknown
): Either<Error, CompareConfig> {
    if (typeof comparison !== 'string') {
        return Either.ofLeft(new Error('Comparison must be a string.'));
    }
    if (!isStringArray(ignoreJsonKeys) || !isStringArray(ignoreJsonPaths)) {
        return Either.ofLeft(new Error('Ignored JSON keys and paths must be string arrays.'));
    }
    try {
        return Either.ofRight(toConfig(comparison, ignoreJsonKeys, ignoreJsonPaths));
    }
    catch (error) {
        return Either.ofLeft(error instanceof Error ? error : new Error('Comparison configuration is invalid.'));
    }
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && Array.from(value).every((entry) => typeof entry === 'string');
}
