import type { RallarBlackBoxRuntimeDiagnosticEvidence } from '../../diagnostics.ts';

export function isClosedRecord(
    value: unknown,
    keys: readonly string[]
): value is Record<string, RallarBlackBoxRuntimeDiagnosticEvidence | undefined> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) &&
        Object.keys(value).every((key) => keys.includes(key)) &&
        Object.values(value).every((entry) =>
            entry === undefined || entry === null ||
            typeof entry === 'object' || typeof entry === 'string' || typeof entry === 'number' ||
            typeof entry === 'boolean'
        );
}

export function isIdentity(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

export function isNonnegativeNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isIdentityList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(isIdentity) && new Set(value).size === value.length;
}

export function isSameIdentitySet(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((identity) => right.includes(identity));
}

export function isOneOf(value: unknown, choices: readonly string[]): value is string {
    return typeof value === 'string' && choices.includes(value);
}

export function isNonnegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
