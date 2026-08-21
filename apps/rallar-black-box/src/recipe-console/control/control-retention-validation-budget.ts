import {
    CONTROL_RETENTION_PLAN_LIMITS,
    ControlRetentionPlanLimitError,
    type ControlRetentionPlanLimit
} from '@shared-test/rallar-bb-test/control-retention.ts';

type ValidationBudget = {
    collectionItems: number;
    nodes: number;
    utf8Bytes: number;
    seen: Set<object>;
    encoder: TextEncoder;
};

export function assertControlRetentionResponseBudget(value: unknown): void {
    visit(value, 0, {
        collectionItems: 0,
        nodes: 0,
        utf8Bytes: 0,
        seen: new Set(),
        encoder: new TextEncoder()
    });
}

function visit(value: unknown, depth: number, budget: ValidationBudget): void {
    if (depth > CONTROL_RETENTION_PLAN_LIMITS.canonicalDepth) {
        limit('canonicalDepth');
    }
    budget.nodes += 1;
    assertMaximum(budget.nodes, 'canonicalNodes');
    if (value === null || typeof value === 'boolean') {
        append(JSON.stringify(value), budget);
        return;
    }
    if (typeof value === 'string') {
        assertString(value);
        append(JSON.stringify(value), budget);
        return;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new TypeError('Retention response numbers must be finite.');
        }
        append(JSON.stringify(value), budget);
        return;
    }
    if (!value || typeof value !== 'object') {
        throw new TypeError('Retention responses must be JSON-compatible.');
    }
    if (budget.seen.has(value)) {
        throw new TypeError('Retention responses must not be cyclic.');
    }
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Retention response records must be plain objects.');
    }
    budget.seen.add(value);
    if (Array.isArray(value)) {
        visitArray(value, depth, budget);
    }
    else {
        visitRecord(value as Record<string, unknown>, depth, budget);
    }
    budget.seen.delete(value);
}

function visitArray(
    value: readonly unknown[],
    depth: number,
    budget: ValidationBudget
): void {
    budget.collectionItems += value.length;
    assertMaximum(budget.collectionItems, 'collectionItems');
    if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError('Retention response arrays must be plain arrays.');
    }
    append('[', budget);
    for (let index = 0; index < value.length; index += 1) {
        if (index > 0) {
            append(',', budget);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) {
            throw new TypeError('Retention response arrays must be dense data arrays.');
        }
        visit(descriptor.value, depth + 1, budget);
    }
    append(']', budget);
}

function visitRecord(
    value: Record<string, unknown>,
    depth: number,
    budget: ValidationBudget
): void {
    if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError('Retention response records must not use symbol keys.');
    }
    const keys = Object.keys(value).sort();
    budget.nodes += keys.length;
    assertMaximum(budget.nodes, 'canonicalNodes');
    append('{', budget);
    let written = 0;
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) {
            throw new TypeError('Retention response records must use data fields.');
        }
        if (descriptor.value === undefined) {
            continue;
        }
        assertString(key);
        if (written > 0) {
            append(',', budget);
        }
        append(`${JSON.stringify(key)}:`, budget);
        visit(descriptor.value, depth + 1, budget);
        written += 1;
    }
    append('}', budget);
}

function assertString(value: string): void {
    if (value.length > CONTROL_RETENTION_PLAN_LIMITS.stringCharacters) {
        limit('stringCharacters');
    }
}

function append(value: string, budget: ValidationBudget): void {
    budget.utf8Bytes += budget.encoder.encode(value).byteLength;
    assertMaximum(budget.utf8Bytes, 'canonicalUtf8Bytes');
}

function assertMaximum(value: number, name: ControlRetentionPlanLimit): void {
    if (value > CONTROL_RETENTION_PLAN_LIMITS[name]) {
        limit(name);
    }
}

function limit(name: ControlRetentionPlanLimit): never {
    throw new ControlRetentionPlanLimitError(
        name,
        CONTROL_RETENTION_PLAN_LIMITS[name]
    );
}
