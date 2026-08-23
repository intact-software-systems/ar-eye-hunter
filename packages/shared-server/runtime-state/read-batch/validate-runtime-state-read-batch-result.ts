import { type JsonWireObject, type JsonWireValue } from '../../rallar-system/protocol/json-wire-identity.ts';
import type { RuntimeStateEntry } from '../runtime-state-repository.ts';
import type { RuntimeStateReadBatchSelection, RuntimeStateReadBatchSelector } from './runtime-state-read-batch.ts';
import { validateRuntimeStateReadBatchSelectors } from './validate-runtime-state-read-batch-selectors.ts';

export function validateRuntimeStateReadBatchResult(
    expectedSelectors: readonly RuntimeStateReadBatchSelector[],
    input: JsonWireValue | readonly RuntimeStateReadBatchSelection[]
): readonly RuntimeStateReadBatchSelection[] {
    const selectors = validateRuntimeStateReadBatchSelectors(expectedSelectors);
    const results = requireDenseArray(input, 'results');
    if (results.length !== selectors.length) {
        throw invalidReadBatch(
            `results expected ${selectors.length} selections, received ${results.length}`
        );
    }

    return selectors.map((selector, index) => {
        const label = `result ${index}`;
        const result = requireRecord(results[index], label);
        requireExactKeys(result, ['selectorId', 'entries'], label);
        if (result.selectorId !== selector.selectorId) {
            throw invalidReadBatch(`${label} does not preserve caller order`);
        }
        const entries = requireDenseArray(result.entries, `${label} entries`)
            .map((entry, entryIndex) => validateEntry(entry, `${label} entry ${entryIndex}`));
        validateSelectionEntries(selector, entries, label);
        return { selectorId: selector.selectorId, entries };
    });
}

function validateSelectionEntries(
    selector: RuntimeStateReadBatchSelector,
    entries: readonly RuntimeStateEntry[],
    label: string
): void {
    if (selector.kind === 'key') {
        if (entries.length > 1) {
            throw invalidReadBatch(`${label} exact key returned multiple entries`);
        }
        if (entries[0] !== undefined && entries[0].key !== selector.key) {
            throw invalidReadBatch(`${label} exact key does not match`);
        }
    }
    else {
        for (const entry of entries) {
            if (!entry.key.startsWith(selector.keyPrefix)) {
                throw invalidReadBatch(`${label} entry does not match prefix`);
            }
        }
    }

    for (let index = 1; index < entries.length; index += 1) {
        if (compareUtf8(entries[index - 1].key, entries[index].key) >= 0) {
            throw invalidReadBatch(`${label} entries are not uniquely ordered`);
        }
    }
}

function validateEntry(
    input: JsonWireValue | RuntimeStateReadBatchSelection,
    label: string
): RuntimeStateEntry {
    const entry = requireRecord(input, label);
    requireExactKeys(
        entry,
        [
            'key',
            'value',
            'expireAtTimestamp',
            'updatedTimestamp',
            'revision'
        ],
        label
    );
    const updatedTimestamp = requireNonEmptyString(
        entry.updatedTimestamp,
        `${label} updated timestamp`
    );
    const parsedUpdatedTimestamp = Date.parse(updatedTimestamp);
    if (!Number.isFinite(parsedUpdatedTimestamp)) {
        throw invalidReadBatch(`${label} updated timestamp is invalid`);
    }
    const expireAtTimestamp = entry.expireAtTimestamp;
    if (
        typeof expireAtTimestamp !== 'number' ||
        !Number.isSafeInteger(expireAtTimestamp)
    ) {
        throw invalidReadBatch(`${label} expiry is invalid`);
    }
    const revision = entry.revision;
    if (
        typeof revision !== 'number' ||
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        Object.is(revision, -0)
    ) {
        throw invalidReadBatch(`${label} revision is invalid`);
    }
    return {
        key: requireNonEmptyString(entry.key, `${label} key`),
        value: requireString(entry.value, `${label} value`),
        expireAtTimestamp,
        updatedTimestamp: new Date(parsedUpdatedTimestamp).toISOString(),
        revision
    };
}

function requireDenseArray(
    input: JsonWireValue | readonly RuntimeStateReadBatchSelection[] | undefined,
    label: string
): readonly (JsonWireValue | RuntimeStateReadBatchSelection)[] {
    if (!Array.isArray(input)) {
        throw invalidReadBatch(`${label} must be an array`);
    }
    for (let index = 0; index < input.length; index += 1) {
        if (!Object.hasOwn(input, index)) {
            throw invalidReadBatch(`${label} must be dense`);
        }
    }
    return input;
}

function requireRecord(
    input: JsonWireValue | RuntimeStateReadBatchSelection | undefined,
    label: string
): JsonWireObject {
    if (!isJsonWireObject(input)) {
        throw invalidReadBatch(`${label} must be an object`);
    }
    return input;
}

function requireExactKeys(
    input: JsonWireObject,
    expected: readonly string[],
    label: string
): void {
    const actual = Object.keys(input).sort();
    const sortedExpected = [...expected].sort();
    if (
        actual.length !== sortedExpected.length ||
        actual.some((key, index) => key !== sortedExpected[index])
    ) {
        throw invalidReadBatch(`${label} fields are invalid`);
    }
}

function requireNonEmptyString(input: JsonWireValue | undefined, label: string): string {
    const value = requireString(input, label);
    if (value.length === 0) {
        throw invalidReadBatch(`${label} must not be empty`);
    }
    return value;
}

function requireString(input: JsonWireValue | undefined, label: string): string {
    if (typeof input !== 'string') {
        throw invalidReadBatch(`${label} must be a string`);
    }
    return input;
}

function compareUtf8(left: string, right: string): number {
    const encoder = new TextEncoder();
    const leftBytes = encoder.encode(left);
    const rightBytes = encoder.encode(right);
    const length = Math.min(leftBytes.length, rightBytes.length);
    for (let index = 0; index < length; index += 1) {
        if (leftBytes[index] !== rightBytes[index]) {
            return leftBytes[index] - rightBytes[index];
        }
    }
    return leftBytes.length - rightBytes.length;
}

function isJsonWireObject(
    value: JsonWireValue | RuntimeStateReadBatchSelection | undefined
): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidReadBatch(reason: string): Error {
    return new Error(`Invalid runtime state read batch: ${reason}`);
}
