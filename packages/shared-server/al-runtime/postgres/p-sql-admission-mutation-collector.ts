import { computeRuntimeStateGuardedBatchWrite } from '@shared-server/runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type {
    RuntimeStateGuardedBatchGuard,
    RuntimeStateGuardedBatchWrite
} from '@shared-server/runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { validateRuntimeStateGuardedBatch } from '@shared-server/runtime-state/guarded-batch/validate-runtime-state-guarded-batch.ts';
import {
    requireConditionalWrite,
    RuntimeStateWriteConflictError
} from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike,
    RuntimeStateOptimisticTransactionRepositoryLike
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

/** One statement of a commit's state rows: a conditional row alone, or a guarded batch of a fence and the rows on it. */
export type PSqlAdmissionStateWrite =
    | Readonly<{ kind: 'row'; row: RuntimeStateGuardedBatchGuard; }>
    | Readonly<{ kind: 'batch'; batch: RuntimeStateGuardedBatchWrite; }>;

export namespace PSqlAdmissionMutationCollector {
    export interface Dependencies {
        /** Serves prefix lists; point reads go through `readEntry`. */
        readonly repository: RuntimeStateOptimisticTransactionalRepositoryLike;
        readonly readEntry: (key: string) => Promise<RuntimeStateEntry | undefined>;
        readonly namespace: string;
        readonly nowEpochMs: () => number;
    }

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
    private readonly readEntry: (key: string) => Promise<RuntimeStateEntry | undefined>;
    private readonly namespace: string;
    private readonly nowEpochMs: () => number;

    constructor(dependencies: PSqlAdmissionMutationCollector.Dependencies) {
        this.repository = dependencies.repository;
        this.readEntry = dependencies.readEntry;
        this.namespace = dependencies.namespace;
        this.nowEpochMs = dependencies.nowEpochMs;
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

    /**
     * Every touched row as the commit's statements, in order: every fence but the last as its own conditional write, in
     * key order, then the last fence with every other row written only on it. Each fence is a compare-and-set, so a moved
     * one rolls the commit back, and every commit takes the fences it shares in one order. A commit that names no fence
     * is fenced on its first row in key order, the row a write one row at a time wrote first.
     */
    computeStateWrites(fenceKeys: ReadonlySet<string>): readonly PSqlAdmissionStateWrite[] {
        const rows = this.mutations();
        const fences = rows.filter((row) => fenceKeys.has(row.key));
        if (fences.length < fenceKeys.size) {
            throw new TypeError('The fence of an admission commit writes no row');
        }
        const guards = fences.length > 0 ? fences : rows.slice(0, 1);
        const guard = guards.at(-1);
        if (guard === undefined) {
            return [];
        }
        const leading = guards.slice(0, -1).map((row) => ({ kind: 'row', row }) as const);
        const effects = rows.filter((row) => !guards.includes(row));
        if (effects.length === 0) {
            return [...leading, { kind: 'row', row: guard }];
        }
        const batch = validateRuntimeStateGuardedBatch({
            guard,
            effects: effects.map((row) => ({ ...row, effectId: row.key }))
        });
        return [...leading, { kind: 'batch', batch: computeRuntimeStateGuardedBatchWrite(batch) }];
    }

    /** Every touched row in key order, as the conditional write its observation calls for. */
    private mutations(): readonly RuntimeStateGuardedBatchGuard[] {
        const nowEpochMs = this.nowEpochMs();
        return [...this.observations.entries()]
            .sort(([left], [right]) => compareCodePoints(left, right))
            .flatMap(([key, observation]) => {
                const row = observation.touched
                    ? toPSqlAdmissionStateRow({ namespace: this.namespace, key, observation, nowEpochMs })
                    : undefined;
                return row === undefined ? [] : [row];
            });
    }

    private async readObservation(key: string): Promise<PSqlAdmissionMutationCollector.Observation> {
        const existing = this.observations.get(key);
        if (existing) {
            return existing;
        }
        const entry = await this.readEntry(key);
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
}

/** Key order by code point, as `collate "C"` orders keys: no locale moves a fence's place. */
function compareCodePoints(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/** A stale fence or row rolls the transaction back as a conflict. */
export async function writePSqlAdmissionState(
    transaction: RuntimeStateOptimisticTransactionRepositoryLike,
    computed: PSqlAdmissionStateWrite
): Promise<void> {
    if (computed.kind === 'batch') {
        const result = await transaction.writeGuardedBatch(computed.batch);
        if (result.guard.status !== 'applied' || result.effects.some((effect) => effect.status !== 'applied')) {
            throw new RuntimeStateWriteConflictError();
        }
        return;
    }
    const { row } = computed;
    switch (row.operation) {
        case 'insert':
            requireConditionalWrite(
                await transaction.insertIfAbsent({
                    namespace: row.namespace,
                    key: row.key,
                    value: row.value,
                    expireAtTimestamp: row.expireAtTimestamp
                })
            );
            return;
        case 'update':
            requireConditionalWrite(
                await transaction.upsertIfRevision(
                    {
                        namespace: row.namespace,
                        key: row.key,
                        value: row.value,
                        expireAtTimestamp: row.expireAtTimestamp,
                        expectedRevision: row.expectedRevision
                    }
                )
            );
            return;
        case 'delete':
            requireConditionalWrite(await transaction.deleteIfRevision(row.namespace, row.key, row.expectedRevision));
            return;
    }
}

interface ToPSqlAdmissionStateRowInput {
    readonly namespace: string;
    readonly key: string;
    readonly observation: PSqlAdmissionMutationCollector.Observation;
    readonly nowEpochMs: number;
}

/** The conditional write of one touched row; a removed or expired row that was never stored needs none. */
function toPSqlAdmissionStateRow(input: ToPSqlAdmissionStateRowInput): RuntimeStateGuardedBatchGuard | undefined {
    const { namespace, key, observation } = input;
    if (observation.value === undefined || observation.expireAtEpochMs <= input.nowEpochMs) {
        return observation.entry
            ? { operation: 'delete', namespace, key, expectedRevision: observation.entry.revision }
            : undefined;
    }
    const stored = {
        namespace,
        key,
        value: JSON.stringify(observation.value),
        expireAtTimestamp: observation.expireAtEpochMs
    };
    return observation.entry
        ? { ...stored, operation: 'update', expectedRevision: observation.entry.revision }
        : { ...stored, operation: 'insert' };
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
