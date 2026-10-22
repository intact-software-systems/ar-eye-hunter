/** The bounds of one canonical JSON encoding; each owner names its own set. */
export interface CanonicalJsonLimits {
    readonly canonicalDepth: number;
    readonly canonicalNodes: number;
    readonly stringCharacters: number;
    readonly canonicalUtf8Bytes: number;
}

export type CanonicalJsonLimit = keyof CanonicalJsonLimits;

/** One owner's canonical bounds and the error it throws when the encoding breaches one of them. */
export interface CanonicalJsonBudget {
    readonly limits: CanonicalJsonLimits;
    readonly toLimitError: (limit: CanonicalJsonLimit) => Error;
}

export const CONTROL_RETENTION_PLAN_LIMITS = Object.freeze({
    candidates: 1_000,
    collectionItems: 100_000,
    canonicalDepth: 64,
    canonicalNodes: 100_000,
    stringCharacters: 1024 * 1024,
    canonicalUtf8Bytes: 8 * 1024 * 1024
});

export type ControlRetentionPlanLimit = keyof typeof CONTROL_RETENTION_PLAN_LIMITS;

export class ControlRetentionPlanLimitError extends Error {
    override readonly name = 'ControlRetentionPlanLimitError';

    readonly limit: ControlRetentionPlanLimit;
    readonly maximum: number;

    constructor(
        limit: ControlRetentionPlanLimit,
        maximum: number
    ) {
        super(`Control retention plan exceeded the ${limit} bound of ${maximum}.`);
        this.limit = limit;
        this.maximum = maximum;
    }
}

export function controlRetentionLimitError(
    limit: ControlRetentionPlanLimit
): ControlRetentionPlanLimitError {
    return new ControlRetentionPlanLimitError(
        limit,
        CONTROL_RETENTION_PLAN_LIMITS[limit]
    );
}

const CONTROL_RETENTION_CANONICAL_BUDGET: CanonicalJsonBudget = Object.freeze({
    limits: CONTROL_RETENTION_PLAN_LIMITS,
    toLimitError: controlRetentionLimitError
});

export function boundedControlRetentionArray<T>(
    value: readonly T[],
    label: string
): readonly T[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${label} must be an array.`);
    }
    if (value.length > CONTROL_RETENTION_PLAN_LIMITS.collectionItems) {
        throw controlRetentionLimitError('collectionItems');
    }
    return value;
}

export function assertControlRetentionString(
    value: unknown,
    label: string
): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} must be a non-empty string.`);
    }
    assertWithinBudget(value.length, 'stringCharacters', CONTROL_RETENTION_CANONICAL_BUDGET);
}

export function canonicalControlRetentionJson<Value>(value: Value): string {
    return toCanonicalJson(value, CONTROL_RETENTION_CANONICAL_BUDGET);
}

/** Sorted-key JSON without whitespace; the first breached bound throws its owner's error before more is read. */
export function toCanonicalJson<Value>(value: Value, budget: CanonicalJsonBudget): string {
    const state: CanonicalState = {
        budget,
        nodes: 0,
        seen: new Set<object>(),
        utf8Bytes: 0,
        chunks: [],
        encoder: new TextEncoder()
    };
    writeCanonicalJson(value, 0, state);
    return state.chunks.join('');
}

interface CanonicalState {
    readonly budget: CanonicalJsonBudget;
    nodes: number;
    seen: Set<object>;
    utf8Bytes: number;
    chunks: string[];
    encoder: TextEncoder;
}

function writeCanonicalJson<Value>(
    value: Value,
    depth: number,
    state: CanonicalState
): void {
    assertWithinBudget(depth, 'canonicalDepth', state.budget);
    state.nodes += 1;
    assertWithinBudget(state.nodes, 'canonicalNodes', state.budget);
    if (value === null || typeof value === 'boolean') {
        appendCanonical(JSON.stringify(value), state);
        return;
    }
    if (typeof value === 'string') {
        assertWithinBudget(value.length, 'stringCharacters', state.budget);
        appendCanonical(JSON.stringify(value), state);
        return;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new TypeError('Canonical JSON numbers must be finite.');
        }
        appendCanonical(JSON.stringify(value), state);
        return;
    }
    if (!value || typeof value !== 'object') {
        throw new TypeError('Canonical JSON values must be JSON-compatible.');
    }
    if (state.seen.has(value)) {
        throw new TypeError('Canonical JSON values must not be cyclic.');
    }
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Canonical JSON objects must be plain records.');
    }
    state.seen.add(value);
    if (Array.isArray(value)) {
        appendCanonical('[', state);
        for (let index = 0; index < value.length; index += 1) {
            if (index > 0) {
                appendCanonical(',', state);
            }
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (!descriptor || !('value' in descriptor)) {
                throw new TypeError('Canonical JSON arrays must be dense data arrays.');
            }
            writeCanonicalJson(descriptor.value, depth + 1, state);
        }
        appendCanonical(']', state);
    }
    else {
        if (Object.getOwnPropertySymbols(value).length > 0) {
            throw new TypeError('Canonical JSON records must not use symbol keys.');
        }
        appendCanonical('{', state);
        let written = 0;
        const keys = Object.keys(value);
        state.nodes += keys.length;
        assertWithinBudget(state.nodes, 'canonicalNodes', state.budget);
        for (const key of keys.sort(compareText)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !('value' in descriptor)) {
                throw new TypeError('Canonical JSON records must use data properties.');
            }
            if (descriptor.value === undefined) {
                continue;
            }
            assertWithinBudget(key.length, 'stringCharacters', state.budget);
            if (written > 0) {
                appendCanonical(',', state);
            }
            appendCanonical(`${JSON.stringify(key)}:`, state);
            writeCanonicalJson(descriptor.value, depth + 1, state);
            written += 1;
        }
        appendCanonical('}', state);
    }
    state.seen.delete(value);
}

function appendCanonical(value: string, state: CanonicalState): void {
    state.utf8Bytes += state.encoder.encode(value).byteLength;
    assertWithinBudget(state.utf8Bytes, 'canonicalUtf8Bytes', state.budget);
    state.chunks.push(value);
}

function assertWithinBudget(amount: number, limit: CanonicalJsonLimit, budget: CanonicalJsonBudget): void {
    if (amount > budget.limits[limit]) {
        throw budget.toLimitError(limit);
    }
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
