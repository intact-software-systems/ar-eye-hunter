import type { RuntimeStateEntry } from '../runtime-state-repository.ts';
import type { RuntimeStateReadBatchSelection, RuntimeStateReadBatchSelector } from './runtime-state-read-batch.ts';
import { validateRuntimeStateReadBatchResult } from './validate-runtime-state-read-batch-result.ts';
import { validateRuntimeStateReadBatchSelectors } from './validate-runtime-state-read-batch-selectors.ts';

export interface RuntimeStateNamespacedEntry {
    readonly namespace: string;
    readonly entry: RuntimeStateEntry;
}

export function selectRuntimeStateReadBatch(
    entries: readonly RuntimeStateNamespacedEntry[],
    input: readonly RuntimeStateReadBatchSelector[]
): readonly RuntimeStateReadBatchSelection[] {
    const selectors = validateRuntimeStateReadBatchSelectors(input);
    const snapshot = entries.map(({ namespace, entry }) => ({
        namespace,
        entry: { ...entry }
    }));
    const selections = selectors.map((selector) => ({
        selectorId: selector.selectorId,
        entries: selector.kind === 'key'
            ? snapshot
                .filter(({ namespace, entry }) => namespace === selector.namespace && entry.key === selector.key)
                .map(({ entry }) => entry)
            : snapshot
                .filter(({ namespace, entry }) =>
                    namespace === selector.namespace &&
                    entry.key.startsWith(selector.keyPrefix)
                )
                .map(({ entry }) => entry)
                .sort((left, right) => compareUtf8(left.key, right.key))
    }));
    return validateRuntimeStateReadBatchResult(selectors, selections);
}

function compareUtf8(left: string, right: string): number {
    const encoder = new TextEncoder();
    const leftBytes = encoder.encode(left);
    const rightBytes = encoder.encode(right);
    const length = Math.min(leftBytes.length, rightBytes.length);
    for (let index = 0; index < length; index += 1) {
        const difference = leftBytes[index] - rightBytes[index];
        if (difference !== 0) {
            return difference;
        }
    }
    return leftBytes.length - rightBytes.length;
}
