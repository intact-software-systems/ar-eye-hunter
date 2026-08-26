// deno-lint-ignore-file require-await
import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
    RuntimeStateEntry,
    RuntimeStateEntryPageOptions
} from '@shared-server/runtime-state/runtime-state-repository.ts';

import * as RuntimeStateTestSupport from '../shared-server/runtime-state/test-support/fake-runtime-state-repository.ts';

export class FakeRuntimeStateRepository extends RuntimeStateTestSupport.FakeRuntimeStateRepository {
    readonly conditionalWrites: Array<
        Readonly<{
            operation: 'insert' | 'replace' | 'delete';
            namespace: string;
            key: string;
            expectedRevision: number | null;
        }>
    > = [];
    readonly findEntriesByPrefixCalls: Array<Readonly<{ namespace: string; keyPrefix: string; }>> = [];
    readonly findEntriesByPrefixPageCalls: Array<
        Readonly<{
            namespace: string;
            keyPrefix: string;
            afterKey?: string;
            limit: number;
        }>
    > = [];
    conflictNextConditionalWrite = false;
    errorNextConditionalWrite: Error | undefined;
    conflictCount = 0;

    override async findEntriesByPrefix(
        namespace: string,
        keyPrefix: string
    ): Promise<readonly RuntimeStateEntry[]> {
        this.findEntriesByPrefixCalls.push({ namespace, keyPrefix });
        return await super.findEntriesByPrefix(namespace, keyPrefix);
    }

    override async findEntriesByPrefixPage(
        namespace: string,
        keyPrefix: string,
        options: RuntimeStateEntryPageOptions
    ): Promise<readonly RuntimeStateEntry[]> {
        this.findEntriesByPrefixPageCalls.push({
            namespace,
            keyPrefix,
            afterKey: options.afterKey,
            limit: options.limit
        });
        const entries = await super.findEntriesByPrefix(namespace, keyPrefix);
        return entries
            .filter((entry) =>
                options.afterKey === undefined ||
                entry.key.localeCompare(options.afterKey) > 0
            )
            .slice(0, options.limit);
    }

    override async insertIfAbsent(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        this.conditionalWrites.push({
            operation: 'insert',
            namespace,
            key,
            expectedRevision: null
        });
        if (this.errorNextConditionalWrite) {
            const error = this.errorNextConditionalWrite;
            this.errorNextConditionalWrite = undefined;
            throw error;
        }
        if (this.conflictNextConditionalWrite) {
            this.conflictNextConditionalWrite = false;
            this.conflictCount += 1;
            return { status: 'conflict' };
        }
        return await super.insertIfAbsent(namespace, key, value, expireAtTimestamp);
    }

    override async upsertIfRevision(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        this.conditionalWrites.push({
            operation: 'replace',
            namespace,
            key,
            expectedRevision
        });
        return await super.upsertIfRevision(
            namespace,
            key,
            value,
            expireAtTimestamp,
            expectedRevision
        );
    }

    override async deleteIfRevision(
        namespace: string,
        key: string,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        this.conditionalWrites.push({
            operation: 'delete',
            namespace,
            key,
            expectedRevision
        });
        return await super.deleteIfRevision(namespace, key, expectedRevision);
    }
}
