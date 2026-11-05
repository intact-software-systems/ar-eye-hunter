import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../runtime-state-repository.ts';
import type { RuntimeStateReadBatchKeySelector } from './runtime-state-read-batch.ts';

/** Exact keys from one snapshot, in the order asked; any other answer from the repository is an invariant failure. */
export async function readRuntimeStateKeySelections(
    repository: Pick<RuntimeStateRepositoryLike, 'readRuntimeStateBatch'>,
    selectors: readonly RuntimeStateReadBatchKeySelector[]
): Promise<readonly (RuntimeStateEntry | undefined)[]> {
    const selections = await repository.readRuntimeStateBatch(selectors);
    if (selections.length !== selectors.length) {
        throw new TypeError('Runtime-state key read omitted a selector');
    }
    return selections.map((selection, index) => {
        const selector = selectors[index];
        if (
            selection.selectorId !== selector.selectorId || selection.entries.length > 1 ||
            selection.entries.some((entry) => entry.key !== selector.key)
        ) {
            throw new TypeError('Runtime-state key read returned another key');
        }
        return selection.entries[0];
    });
}
