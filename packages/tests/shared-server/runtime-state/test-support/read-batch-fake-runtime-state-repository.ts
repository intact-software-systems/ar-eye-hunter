import type { RuntimeStateReadBatchSelection, RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
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
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        this.readBatchCalls.push(selectors.map((selector) => ({ ...selector })));
        return await super.readRuntimeStateBatch(selectors);
    }
}
