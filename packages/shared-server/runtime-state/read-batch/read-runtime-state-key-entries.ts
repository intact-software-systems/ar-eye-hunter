import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../runtime-state-repository.ts';

/** One key reads its row alone; several share the repository's batch read, one selector per key, in the order asked. */
export async function readRuntimeStateKeyEntries(
    repository: Pick<RuntimeStateRepositoryLike, 'findEntry' | 'readRuntimeStateBatch'>,
    namespace: string,
    keys: readonly string[]
): Promise<readonly (RuntimeStateEntry | undefined)[]> {
    if (keys.length === 1) {
        return [await repository.findEntry(namespace, keys[0]!)];
    }
    const selections = await repository.readRuntimeStateBatch(
        keys.map((key, index) => ({ selectorId: String(index), kind: 'key', namespace, key }))
    );
    const entries = new Map(selections.map((selection) => [selection.selectorId, selection.entries[0]]));
    return keys.map((_key, index) => entries.get(String(index)));
}
