import type { RuntimeStateReadBatchSelection, RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import { validateRuntimeStateReadBatchResult } from '@shared-server/runtime-state/read-batch/validate-runtime-state-read-batch-result.ts';
import { validateRuntimeStateReadBatchSelectors } from '@shared-server/runtime-state/read-batch/validate-runtime-state-read-batch-selectors.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

export class ReadBatchFakeRuntimeStateRepository extends FakeRuntimeStateRepository {
    readonly readBatchCalls: RuntimeStateReadBatchSelector[][] = [];
    readonly wholeNamespaceReads: string[] = [];

    override async findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        this.wholeNamespaceReads.push(namespace);
        return await super.findAllEntries(namespace);
    }

    override async readRuntimeStateBatch(
        input: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        const selectors = validateRuntimeStateReadBatchSelectors(input);
        this.readBatchCalls.push(selectors.map((selector) => ({ ...selector })));
        return validateRuntimeStateReadBatchResult(
            selectors,
            await super.readRuntimeStateBatch(selectors)
        );
    }
}
