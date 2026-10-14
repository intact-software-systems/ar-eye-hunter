import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

/** Compare two complete recipient lists without allowing a duplicate to hide a missing identity. */
export function areSameUniqueStringSet(actual: ApiJsonValue | undefined, expected: ApiJsonValue | undefined): boolean {
    if (!Array.isArray(actual) || !Array.isArray(expected)) {
        return false;
    }
    if (
        !actual.every((value) => typeof value === 'string' && value.trim().length > 0) ||
        !expected.every((value) => typeof value === 'string' && value.trim().length > 0)
    ) {
        return false;
    }
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    return actualSet.size === actual.length &&
        expectedSet.size === expected.length &&
        actualSet.size === expectedSet.size &&
        actual.every((value) => expectedSet.has(value));
}
