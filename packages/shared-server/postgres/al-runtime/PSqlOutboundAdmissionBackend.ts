import type {
    ALOutboundAdmissionBackend,
    ALOutboundAdmissionWriteContext,
} from '@shared/alm/ALOutboundAdmissionStore.ts';
import type {
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import { PSqlAdmissionMutationCollector } from './PSqlAdmissionMutationCollector.ts';

export class PSqlOutboundAdmissionBackend implements ALOutboundAdmissionBackend {
    constructor(
        private readonly repository: RuntimeStateOptimisticTransactionalRepositoryLike,
        private readonly namespace: string,
    ) {}

    async ready(): Promise<void> {}

    async get<V>(key: string): Promise<V | undefined> {
        return await new PSqlAdmissionMutationCollector(
            this.repository,
            this.namespace,
        ).get<V>(key);
    }

    async list<V>(prefix: string): Promise<readonly Readonly<{ key: string; value: V }>[]> {
        return await new PSqlAdmissionMutationCollector(
            this.repository,
            this.namespace,
        ).list<V>(prefix);
    }

    async write<T>(fn: (tx: ALOutboundAdmissionWriteContext) => Promise<T>): Promise<T> {
        const collector = new PSqlAdmissionMutationCollector(
            this.repository,
            this.namespace,
        );
        const result = await fn({
            get: async (key) => await collector.get(key),
            list: async (prefix) => await collector.list(prefix),
            set: async (key, value, expireAtTimestamp) => {
                await collector.set(key, value, expireAtTimestamp);
            },
            remove: async (key) => await collector.remove(key),
        });
        await collector.apply(collector.mutations());
        return result;
    }
}
