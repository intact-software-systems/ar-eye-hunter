import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '@shared-server/runtime-state/RuntimeStateRepository.ts';

export async function tryExecuteRuntimeStateConditionalMutation(
    query: string,
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike | undefined,
    values: readonly unknown[],
): Promise<readonly Readonly<{ revision: number }>[] | undefined> {
    const isUpdate = query.includes('update runtime_state_store') &&
        query.includes('returning revision');
    const isDelete = query.includes('delete from runtime_state_store') &&
        query.includes('returning revision');
    if (!isUpdate && !isDelete) return undefined;
    if (!runtime) {
        throw new Error('Runtime-state SQL requires a transaction runtime');
    }
    if (isUpdate) {
        const [value, expireAt, namespace, key, expectedRevision] = values as [
            string,
            Date,
            string,
            string,
            number,
        ];
        const result = await runtime.upsertIfRevision(
            namespace,
            key,
            value,
            expireAt.getTime(),
            expectedRevision,
        );
        return result.status === 'applied' ? [{ revision: result.revision }] : [];
    }
    const [namespace, key, expectedRevision] = values as [string, string, number];
    const result = await runtime.deleteIfRevision(namespace, key, expectedRevision);
    return result.status === 'applied' ? [{ revision: expectedRevision }] : [];
}
