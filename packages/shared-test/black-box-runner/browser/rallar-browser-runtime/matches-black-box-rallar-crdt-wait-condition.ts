import type {
    RallarCrdtDocumentHealth,
    RallarCrdtJsonPrimitive,
    RallarCrdtJsonValue
} from '@shared/crdt/mod.ts';
import type { BlackBoxRallarCrdtWaitCondition } from './black-box-rallar-operation-contracts.ts';

// Health reports may omit fields; document values are canonical CRDT JSON.
type CrdtWaitValue =
    | RallarCrdtJsonPrimitive
    | readonly CrdtWaitValue[]
    | { readonly [key: string]: CrdtWaitValue | undefined; };

interface CrdtWaitLookup {
    readonly exists: boolean;
    readonly value?: CrdtWaitValue;
}

function isWaitArray(value: CrdtWaitValue): value is readonly CrdtWaitValue[] {
    return Array.isArray(value);
}

function lookupPath(root: CrdtWaitValue, path?: string): CrdtWaitLookup {
    const normalizedPath = path?.startsWith('$.') ? path.slice(2) : path ?? '';
    if (!normalizedPath) {
        return { exists: true, value: root };
    }
    let current: CrdtWaitValue | undefined = root;
    for (const segment of normalizedPath.split('.').filter(Boolean)) {
        if (current === undefined || current === null) {
            return { exists: false };
        }
        if ((isWaitArray(current) || typeof current === 'string') && segment === 'length') {
            current = current.length;
            continue;
        }
        if (isWaitArray(current)) {
            const index = Number(segment);
            if (!Number.isInteger(index) || index < 0 || index >= current.length) {
                return { exists: false };
            }
            current = current[index];
            continue;
        }
        if (typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segment)) {
            return { exists: false };
        }
        current = current[segment];
    }
    return { exists: true, value: current };
}

function sameValue(left: CrdtWaitValue | undefined, right: CrdtWaitValue | undefined): boolean {
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    }
    catch {
        return Object.is(left, right);
    }
}

function contains(value: CrdtWaitValue | undefined, expected: CrdtWaitValue | undefined): boolean {
    if (value !== undefined && isWaitArray(value)) {
        return value.some((item) => sameValue(item, expected));
    }
    if (typeof value === 'string') {
        return value.includes(String(expected));
    }
    if (value && typeof value === 'object') {
        if (typeof expected === 'string') {
            try {
                return JSON.stringify(value).includes(expected);
            }
            catch {
                return String(value).includes(expected);
            }
        }
        return Object.values(value).some((item) => sameValue(item, expected));
    }
    return String(value).includes(String(expected));
}

export function matchesBlackBoxRallarCrdtWaitCondition(
    condition: BlackBoxRallarCrdtWaitCondition,
    value: RallarCrdtJsonValue,
    health: RallarCrdtDocumentHealth
): boolean {
    const lookup = lookupPath(condition.source === 'value' ? value : health, condition.path);
    switch (condition.operator) {
        case 'equals':
            return lookup.exists && sameValue(lookup.value, condition.expected);
        case 'notEquals':
            return !lookup.exists || !sameValue(lookup.value, condition.expected);
        case 'contains':
            return lookup.exists && contains(lookup.value, condition.expected);
        case 'exists':
            return condition.expected === undefined ? lookup.exists : lookup.exists === Boolean(condition.expected);
        case 'gte':
            return lookup.exists && typeof lookup.value === 'number' && typeof condition.expected === 'number' &&
                lookup.value >= condition.expected;
        case 'lte':
            return lookup.exists && typeof lookup.value === 'number' && typeof condition.expected === 'number' &&
                lookup.value <= condition.expected;
    }
}
