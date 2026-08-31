import type {
    RuntimeStateOptimisticTransactionalRepositoryLike
} from '@shared-server/runtime-state/runtime-state-repository.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import type {
    ALAdmissionBackend,
    ALAdmissionWriteContext
} from '@shared/alm/al-admission-backend.ts';
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

    async get<V>(key: string): Promise<V | undefined> {
        return await new PSqlAdmissionMutationCollector(
            this.repository,
            this.namespace
        ).get<V>(key);
    }

    async list<V>(prefix: string): Promise<readonly Readonly<{ key: string; value: V; }>[]> {
        return await new PSqlAdmissionMutationCollector(
            this.repository,
            this.namespace
        ).list<V>(prefix);
    }

    async write<T>(fn: (tx: ALAdmissionWriteContext) => Promise<T>): Promise<T> {
        const collector = new PSqlAdmissionMutationCollector(
            this.repository,
            this.namespace
        );
        const result = await fn({
            get: async (key) => await collector.get(key),
            list: async (prefix) => await collector.list(prefix),
            set: async (key, value, expireAtTimestamp) => {
                await collector.set(key, value, expireAtTimestamp);
            },
            remove: async (key) => await collector.remove(key)
        });
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
