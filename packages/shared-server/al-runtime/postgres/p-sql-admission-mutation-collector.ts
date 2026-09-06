import { requireConditionalWrite } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike
} from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { ALAdmissionBackendEntry, ALAdmissionWriteContext } from '@shared/alm/al-admission-backend.ts';
import {
    ALAdmissionCorruptionError,
    decodeALAdmissionValue,
    type ALAdmissionDecoder
} from '@shared/alm/al-admission-decoder.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { decodeJsonWireValue, type JsonWireValue } from '../../rallar-system/protocol/json-wire-identity.ts';
import { readRuntimeStateEntriesByPrefix } from './read-runtime-state-entries-by-prefix.ts';

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

export namespace PSqlAdmissionMutationCollector {
    export interface Observation {
        readonly entry: RuntimeStateEntry | null;
        value: JsonWireValue | undefined;
        expireAtEpochMs: number;
        touched: boolean;
    }
}

export class PSqlAdmissionMutationCollector implements ALAdmissionWriteContext {
    private readonly observations = new Map<string, PSqlAdmissionMutationCollector.Observation>();

    private readonly repository: RuntimeStateOptimisticTransactionalRepositoryLike;
    private readonly namespace: string;
    private readonly nowEpochMs: () => number;

    constructor(
        repository: RuntimeStateOptimisticTransactionalRepositoryLike,
        namespace: string,
        nowEpochMs: () => number
    ) {
        this.repository = repository;
        this.namespace = namespace;
        this.nowEpochMs = nowEpochMs;
    }

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        const observation = await this.readObservation(key);
        if (observation.value === undefined) {
            return undefined;
        }
        const value = decodeALAdmissionValue(observation.value, key, decode);
        return observation.expireAtEpochMs <= this.nowEpochMs() ? undefined : value;
    }

    async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        for await (
            const entry of readRuntimeStateEntriesByPrefix(
                this.repository,
                this.namespace,
                prefix
            )
        ) {
            if (
                typeof entry !== 'object' || entry === null || typeof entry.key !== 'string' ||
                !entry.key.startsWith(prefix)
            ) {
                throw new ALAdmissionCorruptionError(
                    prefix,
                    new TypeError('Stored admission key is outside the requested prefix')
                );
            }
            const observation = toPSqlAdmissionObservation(entry, entry.key, this.nowEpochMs());
            if (!this.observations.has(entry.key)) {
                this.observations.set(entry.key, observation);
            }
        }

        const entries: ALAdmissionBackendEntry<V>[] = [];
        for (const [key, observation] of this.observations) {
            if (!key.startsWith(prefix) || observation.value === undefined) {
                continue;
            }
            const value = decodeALAdmissionValue(observation.value, key, decode);
            if (observation.expireAtEpochMs > this.nowEpochMs()) {
                entries.push({ key, value });
            }
        }
        return entries.sort((left, right) => left.key.localeCompare(right.key));
    }

    async set<V>(
        key: string,
        value: V,
        expireAtEpochMs = NEVER_EXPIRE_AT_TIMESTAMP
    ): Promise<void> {
        const observation = await this.readObservation(key);
        observation.value = encodeALAdmissionValue(value, key);
        observation.expireAtEpochMs = expireAtEpochMs;
        observation.touched = true;
    }

    async remove(key: string): Promise<void> {
        const observation = await this.readObservation(key);
        observation.value = undefined;
        observation.touched = true;
    }

    mutations(): readonly ALAdmissionMutation[] {
        const mutations: ALAdmissionMutation[] = [];
        for (
            const [key, observation] of [...this.observations.entries()]
                .sort(([left], [right]) => left.localeCompare(right))
        ) {
            if (!observation.touched) {
                continue;
            }
            if (observation.value === undefined || observation.expireAtEpochMs <= this.nowEpochMs()) {
                if (observation.entry) {
                    mutations.push({
                        kind: 'delete',
                        key,
                        expectedRevision: observation.entry.revision
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
                    expireAtEpochMs: observation.expireAtEpochMs
                });
                continue;
            }
            mutations.push({
                kind: 'replace',
                key,
                expectedRevision: observation.entry.revision,
                value,
                expireAtEpochMs: observation.expireAtEpochMs
            });
        }
        return mutations;
    }

    private async readObservation(key: string): Promise<PSqlAdmissionMutationCollector.Observation> {
        const existing = this.observations.get(key);
        if (existing) {
            return existing;
        }
        const entry = await this.repository.findEntry(this.namespace, key);
        const observation = entry !== undefined
            ? toPSqlAdmissionObservation(entry, key, this.nowEpochMs())
            : {
                entry: null,
                value: undefined,
                expireAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP,
                touched: false
            };
        this.observations.set(key, observation);
        return observation;
    }

    async writeMutations(
        transaction: RuntimeStateOptimisticTransactionalRepositoryLike,
        mutations: readonly ALAdmissionMutation[]
    ): Promise<void> {
        for (const mutation of mutations) {
            switch (mutation.kind) {
                case 'insert':
                    requireConditionalWrite(
                        await transaction.insertIfAbsent(
                            this.namespace,
                            mutation.key,
                            mutation.value,
                            mutation.expireAtEpochMs
                        )
                    );
                    break;
                case 'replace':
                    requireConditionalWrite(
                        await transaction.upsertIfRevision(
                            this.namespace,
                            mutation.key,
                            mutation.value,
                            mutation.expireAtEpochMs,
                            mutation.expectedRevision
                        )
                    );
                    break;
                case 'delete':
                    requireConditionalWrite(
                        await transaction.deleteIfRevision(
                            this.namespace,
                            mutation.key,
                            mutation.expectedRevision
                        )
                    );
                    break;
            }
        }
    }
}

function toPSqlAdmissionObservation(
    entry: RuntimeStateEntry,
    key: string,
    nowEpochMs: number
): PSqlAdmissionMutationCollector.Observation {
    try {
        if (
            entry.key !== key || typeof entry.value !== 'string' ||
            !Number.isSafeInteger(entry.revision) || entry.revision < 0 || Object.is(entry.revision, -0) ||
            !Number.isSafeInteger(entry.expireAtTimestamp) || entry.expireAtTimestamp < 0 ||
            Object.is(entry.expireAtTimestamp, -0) ||
            typeof entry.updatedTimestamp !== 'string' || !Number.isFinite(Date.parse(entry.updatedTimestamp))
        ) {
            throw new TypeError('Stored admission row does not match its complete runtime-state slot');
        }
        return {
            entry,
            value: decodeJsonWireValue(JSON.parse(entry.value), `Stored AL admission value for ${key}`),
            expireAtEpochMs: entry.expireAtTimestamp,
            touched: entry.expireAtTimestamp <= nowEpochMs
        };
    }
    catch (error) {
        throw new ALAdmissionCorruptionError(key, toError(error));
    }
}

function encodeALAdmissionValue<V>(value: V, key: string): JsonWireValue {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new TypeError(`AL admission value for ${key} is not JSON-serializable`);
    }
    return decodeJsonWireValue(
        JSON.parse(serialized),
        `AL admission value for ${key}`
    );
}
