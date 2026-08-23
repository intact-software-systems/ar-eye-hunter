import type { RuntimeStateEntryValue } from '../runtime-state-json-store.ts';
import type { RuntimeStateEntry } from '../runtime-state-repository.ts';
import type { RuntimeStateReadBatchSelection, RuntimeStateReadBatchSelector } from './runtime-state-read-batch.ts';
import { validateRuntimeStateReadBatchResult } from './validate-runtime-state-read-batch-result.ts';

export type RuntimeStateReadBatchLiveSelection<T> = Readonly<{
    selectorId: string;
    entries: readonly RuntimeStateEntryValue<T>[];
    expiredEntries: readonly RuntimeStateEntry[];
}>;

export type RuntimeStateReadBatchLiveResult<T> =
    | Readonly<{
        status: 'stable';
        selections: readonly RuntimeStateReadBatchLiveSelection<T>[];
    }>
    | Readonly<{ status: 'changed'; }>;

export async function resolveRuntimeStateReadBatchLiveValues<T>(
    selectors: readonly RuntimeStateReadBatchSelector[],
    input: readonly RuntimeStateReadBatchSelection[],
    toLiveEntryValue: (
        namespace: string,
        entry: RuntimeStateEntry
    ) => Promise<RuntimeStateEntryValue<T> | undefined>
): Promise<RuntimeStateReadBatchLiveResult<T>> {
    const selections = validateRuntimeStateReadBatchResult(selectors, input);
    const resolved = await Promise.all(selections.map(async (selection, index) => {
        const entries: RuntimeStateEntryValue<T>[] = [];
        const expiredEntries: RuntimeStateEntry[] = [];
        for (const entry of selection.entries) {
            const live = await toLiveEntryValue(selectors[index].namespace, entry);
            if (live === undefined) {
                expiredEntries.push(entry);
                continue;
            }
            if (!sameRuntimeStateEntry(live.entry, entry)) {
                return undefined;
            }
            entries.push(live);
        }
        return { selectorId: selection.selectorId, entries, expiredEntries };
    }));
    if (resolved.some((selection) => selection === undefined)) {
        return { status: 'changed' };
    }
    return {
        status: 'stable',
        selections: resolved as readonly RuntimeStateReadBatchLiveSelection<T>[]
    };
}

function sameRuntimeStateEntry(
    left: RuntimeStateEntry,
    right: RuntimeStateEntry
): boolean {
    return left.key === right.key &&
        left.value === right.value &&
        left.expireAtTimestamp === right.expireAtTimestamp &&
        left.updatedTimestamp === right.updatedTimestamp &&
        left.revision === right.revision;
}
