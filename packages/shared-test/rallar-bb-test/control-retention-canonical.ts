export const CONTROL_RETENTION_PLAN_LIMITS = Object.freeze({
    candidates: 1_000,
    collectionItems: 100_000,
    canonicalDepth: 64,
    canonicalNodes: 100_000,
    stringCharacters: 1024 * 1024,
    canonicalUtf8Bytes: 8 * 1024 * 1024,
});

export type ControlRetentionPlanLimit = keyof typeof CONTROL_RETENTION_PLAN_LIMITS;

export class ControlRetentionPlanLimitError extends Error {
    override readonly name = 'ControlRetentionPlanLimitError';

    readonly limit: ControlRetentionPlanLimit;
    readonly maximum: number;

    constructor(
        limit: ControlRetentionPlanLimit,
        maximum: number,
    ) {
        super(`Control retention plan exceeded the ${limit} bound of ${maximum}.`);
        this.limit = limit;
        this.maximum = maximum;
    }
}

export function controlRetentionLimitError(
    limit: ControlRetentionPlanLimit,
): ControlRetentionPlanLimitError {
    return new ControlRetentionPlanLimitError(
        limit,
        CONTROL_RETENTION_PLAN_LIMITS[limit],
    );
}

export function boundedControlRetentionArray<T>(
    value: readonly T[],
    label: string,
): readonly T[] {
    if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
    if (value.length > CONTROL_RETENTION_PLAN_LIMITS.collectionItems) {
        throw controlRetentionLimitError('collectionItems');
    }
    return value;
}

export function assertControlRetentionString(
    value: unknown,
    label: string,
): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} must be a non-empty string.`);
    }
    assertStringBound(value);
}

export function canonicalControlRetentionJson(value: unknown): string {
    const state: CanonicalState = {
        nodes: 0,
        seen: new Set<object>(),
        utf8Bytes: 0,
        chunks: [],
        encoder: new TextEncoder(),
    };
    writeCanonicalJson(value, 0, state);
    return state.chunks.join('');
}

type CanonicalState = {
    nodes: number;
    seen: Set<object>;
    utf8Bytes: number;
    chunks: string[];
    encoder: TextEncoder;
};

function writeCanonicalJson(
    value: unknown,
    depth: number,
    state: CanonicalState,
): void {
    if (depth > CONTROL_RETENTION_PLAN_LIMITS.canonicalDepth) {
        throw controlRetentionLimitError('canonicalDepth');
    }
    state.nodes += 1;
    if (state.nodes > CONTROL_RETENTION_PLAN_LIMITS.canonicalNodes) {
        throw controlRetentionLimitError('canonicalNodes');
    }
    if (value === null || typeof value === 'boolean') {
        appendCanonical(JSON.stringify(value), state);
        return;
    }
    if (typeof value === 'string') {
        assertStringBound(value);
        appendCanonical(JSON.stringify(value), state);
        return;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new TypeError('Canonical retention numbers must be finite.');
        appendCanonical(JSON.stringify(value), state);
        return;
    }
    if (!value || typeof value !== 'object') {
        throw new TypeError('Canonical retention state must be JSON-compatible.');
    }
    if (state.seen.has(value)) throw new TypeError('Canonical retention state must not be cyclic.');
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Canonical retention objects must be plain records.');
    }
    state.seen.add(value);
    if (Array.isArray(value)) {
        appendCanonical('[', state);
        for (let index = 0; index < value.length; index += 1) {
            if (index > 0) appendCanonical(',', state);
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (!descriptor || !('value' in descriptor)) {
                throw new TypeError('Canonical retention arrays must be dense data arrays.');
            }
            writeCanonicalJson(descriptor.value, depth + 1, state);
        }
        appendCanonical(']', state);
    } else {
        if (Object.getOwnPropertySymbols(value).length > 0) {
            throw new TypeError('Canonical retention records must not use symbol keys.');
        }
        appendCanonical('{', state);
        let written = 0;
        const keys = Object.keys(value);
        state.nodes += keys.length;
        if (state.nodes > CONTROL_RETENTION_PLAN_LIMITS.canonicalNodes) {
            throw controlRetentionLimitError('canonicalNodes');
        }
        for (const key of keys.sort(compareText)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !('value' in descriptor)) {
                throw new TypeError('Canonical retention records must use data properties.');
            }
            if (descriptor.value === undefined) continue;
            assertStringBound(key);
            if (written > 0) appendCanonical(',', state);
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
    if (state.utf8Bytes > CONTROL_RETENTION_PLAN_LIMITS.canonicalUtf8Bytes) {
        throw controlRetentionLimitError('canonicalUtf8Bytes');
    }
    state.chunks.push(value);
}

function assertStringBound(value: string): void {
    if (value.length > CONTROL_RETENTION_PLAN_LIMITS.stringCharacters) {
        throw controlRetentionLimitError('stringCharacters');
    }
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
