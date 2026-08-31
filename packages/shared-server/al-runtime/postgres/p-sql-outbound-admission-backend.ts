import type {
    RuntimeStateOptimisticTransactionalRepositoryLike
} from '@shared-server/runtime-state/runtime-state-repository.ts';
import type {
    ALAdmissionBackend,
    ALAdmissionBackendEntry,
    ALAdmissionWriteContext
} from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionDecoder } from '@shared/alm/al-admission-decoder.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';

import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import { PSqlAdmissionMutationCollector } from './p-sql-admission-mutation-collector.ts';

export class PSqlOutboundAdmissionBackend implements ALAdmissionBackend {
    private readonly repository: RuntimeStateOptimisticTransactionalRepositoryLike;
    private readonly namespace: string;

    constructor(
        repository: RuntimeStateOptimisticTransactionalRepositoryLike,
        namespace: string
    ) {
        this.repository = repository;
        this.namespace = namespace;
    }

    async ready(): Promise<void> {}

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        return await new PSqlAdmissionMutationCollector(
            this.repository,
            this.namespace,
            Date.now
        ).read(key, decode);
    }

    async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        return await new PSqlAdmissionMutationCollector(
            this.repository,
            this.namespace,
            Date.now
        ).list(prefix, decode);
    }

    async write<T>(fn: (tx: ALAdmissionWriteContext) => Promise<T>): Promise<T> {
        const collector = new PSqlAdmissionMutationCollector(
            this.repository,
            this.namespace,
            Date.now
        );
        const result = await fn(collector);
        try {
            await collector.apply(collector.mutations());
        }
        catch (error) {
            if (error instanceof RuntimeStateWriteConflictError) {
                throw new ALAdmissionBackendConflictError(
                    'Outbound admission apply conflict',
                    { cause: error }
                );
            }
            throw error;
        }
        return result;
    }
}
