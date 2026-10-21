import type { JsonWireObject, JsonWireValue } from '../../rallar-system/protocol/json-wire-identity.ts';
import type { RuntimeStateEntry } from '../runtime-state-repository.ts';
import { compareRuntimeStateKeys } from './compare-runtime-state-keys.ts';
import { isRuntimeStateReadBatchKeySelected } from './is-runtime-state-read-batch-key-selected.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector,
    RuntimeStateStoredValueFields
} from './runtime-state-read-batch.ts';
import { validateRuntimeStateReadBatchResult } from './validate-runtime-state-read-batch-result.ts';
import { validateRuntimeStateReadBatchSelectors } from './validate-runtime-state-read-batch-selectors.ts';

export interface RuntimeStateNamespacedEntry {
    readonly namespace: string;
    readonly entry: RuntimeStateEntry;
}

/** An in-memory store's batch read, selecting and filtering rows exactly as the Postgres statement does. */
export function selectRuntimeStateReadBatch(
    entries: readonly RuntimeStateNamespacedEntry[],
    input: readonly RuntimeStateReadBatchSelector[]
): readonly RuntimeStateReadBatchSelection[] {
    const selectors = validateRuntimeStateReadBatchSelectors(input);
    const snapshot = entries.map(({ namespace, entry }) => ({
        namespace,
        entry: { ...entry }
    }));
    const selections = selectors.map((selector) => {
        const selected = snapshot
            .filter(({ namespace, entry }) =>
                namespace === selector.namespace &&
                isRuntimeStateReadBatchKeySelected(selector, entry.key) &&
                isRuntimeStateReadBatchRowSelected(selector, entry)
            )
            .map(({ entry }) => entry)
            .sort((left, right) => compareRuntimeStateKeys(left.key, right.key));
        return { selectorId: selector.selectorId, entries: selected };
    });
    return validateRuntimeStateReadBatchResult(selectors, selections);
}

function isRuntimeStateReadBatchRowSelected(
    selector: RuntimeStateReadBatchSelector,
    entry: RuntimeStateEntry
): boolean {
    switch (selector.kind) {
        case 'prefix-containing':
            return isStoredValueContaining(entry.value, selector.storedValueContains);
        case 'prefix-expiring-after':
            return entry.expireAtTimestamp > selector.expiringAfterTimestamp;
        default:
            return true;
    }
}

/** Postgres `store_value::jsonb @> fields` for scalar fields: the stored object holds each field with an equal value. */
function isStoredValueContaining(storedValue: string, fields: RuntimeStateStoredValueFields): boolean {
    const stored: JsonWireValue = JSON.parse(storedValue);
    return isJsonWireObject(stored) &&
        Object.entries(fields).every(([name, value]) => Object.hasOwn(stored, name) && stored[name] === value);
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
