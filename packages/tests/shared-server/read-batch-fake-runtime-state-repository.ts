import type { RuntimeStateReadBatchSelection, RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/RuntimeStateReadBatch.ts';
import { validateRuntimeStateReadBatchResult, validateRuntimeStateReadBatchSelectors } from '@shared-server/runtime-state/RuntimeStateReadBatch.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

export class ReadBatchFakeRuntimeStateRepository extends FakeRuntimeStateRepository {
    readonly runtimeStateReadBatchCapability = true as const;
    readonly runtimeStateReadBatchConsistency = 'single-database-snapshot' as const;
    readonly readBatchCalls: RuntimeStateReadBatchSelector[][] = [];

    async readRuntimeStateBatch(
        input: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        const selectors = validateRuntimeStateReadBatchSelectors(input);
        this.readBatchCalls.push(selectors.map((selector) => ({ ...selector })));
        const snapshot = [...this.data].map(([compositeKey, entry]) => {
            const separator = compositeKey.indexOf('::');
            if (separator < 1) {
                throw new TypeError('Fake runtime-state key is invalid');
            }
            return {
                namespace: compositeKey.slice(0, separator),
                entry: { ...entry }
            };
        });
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
