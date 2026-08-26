import type { RuntimeStateReadBatchSelection, RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import { validateRuntimeStateReadBatchResult } from '@shared-server/runtime-state/read-batch/validate-runtime-state-read-batch-result.ts';
import { validateRuntimeStateReadBatchSelectors } from '@shared-server/runtime-state/read-batch/validate-runtime-state-read-batch-selectors.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

export class ReadBatchFakeRuntimeStateRepository extends FakeRuntimeStateRepository {
    readonly readBatchCalls: RuntimeStateReadBatchSelector[][] = [];

    async readRuntimeStateBatch(
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
