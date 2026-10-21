import type { RuntimeStateEntry } from '../runtime-state-repository.ts';
import { compareRuntimeStateKeys } from './compare-runtime-state-keys.ts';
import { isRuntimeStateReadBatchKeySelected } from './is-runtime-state-read-batch-key-selected.ts';
import type { RuntimeStateReadBatchSelection, RuntimeStateReadBatchSelector } from './runtime-state-read-batch.ts';

/**
 * The one check of a store's typed result against the selectors it already validated: one selection per selector in
 * caller order, each entry inside its selector, keys unique and in C order. Readers of the result trust it.
 */
export function assertRuntimeStateReadBatchResult(
    selectors: readonly RuntimeStateReadBatchSelector[],
    selections: readonly RuntimeStateReadBatchSelection[]
): readonly RuntimeStateReadBatchSelection[] {
    if (selections.length !== selectors.length) {
        throw invalidReadBatch(`results expected ${selectors.length} selections, received ${selections.length}`);
    }
    selectors.forEach((selector, index) => {
        const label = `result ${index}`;
        if (selections[index].selectorId !== selector.selectorId) {
            throw invalidReadBatch(`${label} does not preserve caller order`);
        }
        assertSelectionEntries(selector, selections[index].entries, label);
    });
    return selections;
}

function assertSelectionEntries(
    selector: RuntimeStateReadBatchSelector,
    entries: readonly RuntimeStateEntry[],
    label: string
): void {
    if (selector.kind === 'key' && entries.length > 1) {
        throw invalidReadBatch(`${label} exact key returned multiple entries`);
    }
    if (entries.some((entry) => !isRuntimeStateReadBatchKeySelected(selector, entry.key))) {
        throw invalidReadBatch(
            selector.kind === 'key'
                ? `${label} exact key does not match`
                : `${label} entry does not match ${selector.kind}`
        );
    }
    for (let index = 1; index < entries.length; index += 1) {
        if (compareRuntimeStateKeys(entries[index - 1].key, entries[index].key) >= 0) {
            throw invalidReadBatch(`${label} entries are not uniquely ordered`);
        }
    }
}

function invalidReadBatch(reason: string): Error {
    return new Error(`Invalid runtime state read batch: ${reason}`);
}
