import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import { requireConditionalWrite } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { readRuntimeStateEntriesByPrefix } from './runtime-state-prefix-reader.ts';

export type ALAdmissionMutation =
    | Readonly<{
        kind: 'insert';
        key: string;
        expected: 'absent';
        value: string;
        expireAtEpochMs: number;
    }>
    | Readonly<{
        kind: 'replace';
        key: string;
        expectedRevision: number;
        value: string;
        expireAtEpochMs: number;
    }>
    | Readonly<{
        kind: 'delete';
        key: string;
        expectedRevision: number;
    }>;

type Observation = {
    entry: RuntimeStateEntry | null;
    value: unknown;
    expireAtEpochMs: number;
    touched: boolean;
};

export class PSqlAdmissionMutationCollector {
    private readonly observations = new Map<string, Observation>();

    constructor(
        private readonly repository: RuntimeStateOptimisticTransactionalRepositoryLike,
        private readonly namespace: string,
        private readonly nowEpochMs: () => number = () => Date.now(),
    ) {}

    async get<V>(key: string): Promise<V | undefined> {
        return (await this.observe(key)).value as V | undefined;
    }

    async list<V>(prefix: string): Promise<readonly Readonly<{ key: string; value: V }>[]> {
        for await (const entry of readRuntimeStateEntriesByPrefix(
            this.repository,
            this.namespace,
            prefix,
        )) {
            if (!this.observations.has(entry.key)) {
                this.observations.set(entry.key, this.toObservation(entry));
            }
        }

        return [...this.observations.entries()]
            .filter(([key, observation]) =>
                key.startsWith(prefix) && observation.value !== undefined
            )
            .map(([key, observation]) => ({ key, value: observation.value as V }))
            .sort((left, right) => left.key.localeCompare(right.key));
    }

    async set<V>(
        key: string,
        value: V,
        expireAtEpochMs = NEVER_EXPIRE_AT_TIMESTAMP,
    ): Promise<void> {
        const observation = await this.observe(key);
        observation.value = value;
        observation.expireAtEpochMs = expireAtEpochMs;
        observation.touched = true;
    }

    async remove(key: string): Promise<void> {
        const observation = await this.observe(key);
        observation.value = undefined;
        observation.touched = true;
    }

    mutations(): readonly ALAdmissionMutation[] {
        const mutations: ALAdmissionMutation[] = [];
        for (const [key, observation] of [...this.observations.entries()]
            .sort(([left], [right]) => left.localeCompare(right))) {
            if (!observation.touched) continue;
            if (observation.value === undefined) {
                if (observation.entry) {
                    mutations.push({
                        kind: 'delete',
                        key,
                        expectedRevision: observation.entry.revision,
                    });
                }
                continue;
            }
            const value = JSON.stringify(observation.value);
            if (!observation.entry) {
                mutations.push({
                    kind: 'insert',
                    key,
                    expected: 'absent',
                    value,
                    expireAtEpochMs: observation.expireAtEpochMs,
                });
                continue;
            }
            mutations.push({
                kind: 'replace',
                key,
                expectedRevision: observation.entry.revision,
                value,
                expireAtEpochMs: observation.expireAtEpochMs,
            });
        }
        return mutations;
    }

    async apply(mutations: readonly ALAdmissionMutation[]): Promise<void> {
        await this.repository.begin(async (transaction) => {
            for (const mutation of mutations) {
                switch (mutation.kind) {
                    case 'insert':
                        requireConditionalWrite(await transaction.insertIfAbsent(
                            this.namespace,
                            mutation.key,
                            mutation.value,
                            mutation.expireAtEpochMs,
                        ));
                        break;
                    case 'replace':
                        requireConditionalWrite(await transaction.upsertIfRevision(
                            this.namespace,
                            mutation.key,
                            mutation.value,
                            mutation.expireAtEpochMs,
                            mutation.expectedRevision,
                        ));
                        break;
                    case 'delete':
                        requireConditionalWrite(await transaction.deleteIfRevision(
                            this.namespace,
                            mutation.key,
                            mutation.expectedRevision,
                        ));
                        break;
                }
            }
        });
    }

    private async observe(key: string): Promise<Observation> {
        const existing = this.observations.get(key);
        if (existing) return existing;
        const entry = await this.repository.findEntry(this.namespace, key);
        const observation = entry
            ? this.toObservation(entry)
            : {
                entry: null,
                value: undefined,
                expireAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP,
                touched: false,
            };
        this.observations.set(key, observation);
        return observation;
    }

    private toObservation(entry: RuntimeStateEntry): Observation {
        if (entry.expireAtTimestamp <= this.nowEpochMs()) {
            return {
                entry,
                value: undefined,
                expireAtEpochMs: entry.expireAtTimestamp,
                touched: true,
            };
        }
        return {
            entry,
            value: JSON.parse(entry.value) as unknown,
            expireAtEpochMs: entry.expireAtTimestamp,
            touched: false,
        };
    }
}
