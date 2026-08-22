import { InMemoryGroupStateEventStore } from '@shared-server/rallar-system/repositories/StateEventStore.ts';
import {
    validateRuntimeStateGuardedBatch,
    validateRuntimeStateGuardedBatchResult,
    type RuntimeStateGuardedBatch,
    type RuntimeStateGuardedBatchEffect,
    type RuntimeStateGuardedBatchEffectResult,
    type RuntimeStateGuardedBatchGuard,
    type RuntimeStateGuardedBatchGuardResult,
    type RuntimeStateGuardedBatchResult
} from '@shared-server/runtime-state/RuntimeStateGuardedBatch.ts';
import type { RuntimeStateEntry, RuntimeStateOptimisticTransactionalRepositoryLike } from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import type { GroupEvent, GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';

export const SCOPE: StateScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
};

export function storagePart(name: string, value?: string): string {
    return `${name}=${encodeURIComponent(value ?? '_')}`;
}

export function groupStorageKey(): string {
    return [
        storagePart('app', 'app-1'),
        storagePart('ws', 'workspace-1'),
        storagePart('group', 'pure-room')
    ].join(':');
}

export function groupMemberStorageKey(principalId: string): string {
    return `${groupStorageKey()}:${storagePart('member', principalId)}`;
}

export function groupSessionStorageKey(sessionId: string): string {
    return `${groupStorageKey()}:${storagePart('session', sessionId)}`;
}

export function storedEntry<T>(key: string, value: T) {
    return {
        entry: {
            key,
            value: JSON.stringify(value),
            expireAtTimestamp: Number.MAX_SAFE_INTEGER,
            updatedTimestamp: new Date(0).toISOString(),
            revision: 0
        },
        value
    };
}

export function presenceFor(
    principalId: string,
    sessionId: string,
    generationId: string
): GroupPresenceSession {
    return {
        ...groupRef('pure-room'),
        principalId,
        sessionId,
        generationId,
        generationVersion: 1_000,
        connectedAtEpochMs: 1_000,
        lastHeartbeatAtEpochMs: 1_000,
        expiresAtEpochMs: 10_000,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

export function groupRef(groupId: string): GroupRef {
    return { ...SCOPE, groupId };
}

export class ApplyingGuardedBatchRepository extends FakeRuntimeStateRepository {
    readonly batches: RuntimeStateGuardedBatch[] = [];
    readonly transactionOrder: string[] = [];
    readonly readCountsBeforeBatch: number[] = [];
    beginCount = 0;
    insideTransactionReadCount = 0;
    private transactionDepth = 0;
    private outsideTransactionReadCount = 0;
    private readonly forcedConflicts: string[] = [];
    private readonly omittedEffectResults: string[] = [];

    get activeTransactionDepth(): number {
        return this.transactionDepth;
    }

    get runtimeStateGuardedBatchCapability(): true | false {
        return this.transactionDepth > 0;
    }

    forceNextConflict(target: 'guard' | string): void {
        this.forcedConflicts.push(target);
    }

    omitNextEffectResult(effectId: string): void {
        this.omittedEffectResults.push(effectId);
    }

    resetObservations(): void {
        this.batches.length = 0;
        this.transactionOrder.length = 0;
        this.readCountsBeforeBatch.length = 0;
        this.beginCount = 0;
        this.insideTransactionReadCount = 0;
    }

    override async findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        this.recordRead();
        return await super.findEntry(namespace, key);
    }

    override async findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        this.recordRead();
        return await super.findAllEntries(namespace);
    }

    override async findEntriesByPrefix(
        namespace: string,
        keyPrefix: string
    ): Promise<readonly RuntimeStateEntry[]> {
        this.recordRead();
        return await super.findEntriesByPrefix(namespace, keyPrefix);
    }

    override async findEntriesByKeys(
        namespace: string,
        keys: readonly string[]
    ): Promise<readonly RuntimeStateEntry[]> {
        this.recordRead();
        return await super.findEntriesByKeys(namespace, keys);
    }

    override async begin<T>(
        fn: (repository: RuntimeStateOptimisticTransactionalRepositoryLike) => Promise<T>
    ): Promise<T> {
        this.beginCount += 1;
        const result = await super.begin(async () => {
            this.transactionDepth += 1;
            try {
                return await fn(this);
            }
            finally {
                this.transactionDepth -= 1;
            }
        });
        this.transactionOrder.push('commit');
        return result;
    }

    async executeGuardedBatch(
        input: RuntimeStateGuardedBatch
    ): Promise<RuntimeStateGuardedBatchResult> {
        if (!this.runtimeStateGuardedBatchCapability) {
            throw new Error('Guarded batch requires an active transaction');
        }
        const batch = validateRuntimeStateGuardedBatch(input);
        this.batches.push(batch);
        this.readCountsBeforeBatch.push(this.outsideTransactionReadCount);
        this.transactionOrder.push('batch');
        const guard = this.consume(this.forcedConflicts, 'guard')
            ? forcedGuardConflict(batch.guard)
            : await applyGuard(this, batch.guard);
        if (guard.status === 'conflict') {
            return validateRuntimeStateGuardedBatchResult(batch, {
                guard,
                effects: batch.effects.map((effect) => ({
                    status: 'skipped',
                    effectId: effect.effectId,
                    operation: effect.operation,
                    namespace: effect.namespace,
                    key: effect.key,
                    reason: 'guard-conflict'
                }))
            });
        }
        const effects: RuntimeStateGuardedBatchEffectResult[] = [];
        let omittedResult = false;
        for (const effect of batch.effects) {
            const result = this.consume(this.forcedConflicts, effect.effectId)
                ? forcedEffectConflict(effect)
                : await applyEffect(this, effect);
            if (this.consume(this.omittedEffectResults, effect.effectId)) {
                omittedResult = true;
            }
            else {
                effects.push(result);
            }
        }
        const result = { guard, effects };
        return omittedResult
            ? (result as RuntimeStateGuardedBatchResult)
            : validateRuntimeStateGuardedBatchResult(batch, result);
    }

    private consume(targets: string[], target: string): boolean {
        const index = targets.indexOf(target);
        if (index < 0) {
            return false;
        }
        targets.splice(index, 1);
        return true;
    }

    private recordRead(): void {
        if (this.transactionDepth === 0) {
            this.outsideTransactionReadCount += 1;
        }
        else {
            this.insideTransactionReadCount += 1;
        }
    }
}

export class OrderedGroupEventStore extends InMemoryGroupStateEventStore {
    private readonly runtime: ApplyingGuardedBatchRepository;

    constructor(runtime: ApplyingGuardedBatchRepository) {
        super();
        this.runtime = runtime;
    }

    override async appendGroupEvent(event: GroupEvent): Promise<void> {
        if (this.runtime.activeTransactionDepth !== 1) {
            throw new Error('Group event append must stay inside the transaction');
        }
        this.runtime.transactionOrder.push('event');
        await super.appendGroupEvent(event);
    }
}

function forcedGuardConflict(
    guard: RuntimeStateGuardedBatchGuard
): RuntimeStateGuardedBatchGuardResult {
    return {
        status: 'conflict',
        operation: guard.operation,
        namespace: guard.namespace,
        key: guard.key,
        reason: 'condition-not-met'
    };
}

function forcedEffectConflict(
    effect: RuntimeStateGuardedBatchEffect
): RuntimeStateGuardedBatchEffectResult {
    if (effect.operation === 'put') {
        throw new Error('Guarded batch put effects cannot conflict');
    }
    return {
        status: 'conflict',
        effectId: effect.effectId,
        operation: effect.operation,
        namespace: effect.namespace,
        key: effect.key,
        reason: 'condition-not-met'
    };
}

async function applyGuard(
    repository: FakeRuntimeStateRepository,
    guard: RuntimeStateGuardedBatchGuard
): Promise<RuntimeStateGuardedBatchGuardResult> {
    const result = guard.operation === 'insert'
        ? await repository.insertIfAbsent(
            guard.namespace,
            guard.key,
            guard.value,
            guard.expireAtTimestamp
        )
        : guard.operation === 'update'
        ? await repository.upsertIfRevision(
            guard.namespace,
            guard.key,
            guard.value,
            guard.expireAtTimestamp,
            guard.expectedRevision
        )
        : await repository.deleteIfRevision(guard.namespace, guard.key, guard.expectedRevision);
    if (result.status === 'conflict') {
        return forcedGuardConflict(guard);
    }
    if (guard.operation === 'delete') {
        return {
            status: 'applied',
            operation: guard.operation,
            namespace: guard.namespace,
            key: guard.key,
            matchedRevision: guard.expectedRevision
        };
    }
    if (!('revision' in result) || typeof result.revision !== 'number') {
        throw new Error('Guarded write result is missing its revision');
    }
    return {
        status: 'applied',
        operation: guard.operation,
        namespace: guard.namespace,
        key: guard.key,
        resultingRevision: result.revision
    };
}

async function applyEffect(
    repository: FakeRuntimeStateRepository,
    effect: RuntimeStateGuardedBatchEffect
): Promise<RuntimeStateGuardedBatchEffectResult> {
    if (effect.operation === 'put') {
        await repository.upsert(effect.namespace, effect.key, effect.value, effect.expireAtTimestamp);
        const stored = await repository.findEntry(effect.namespace, effect.key);
        if (!stored) {
            throw new Error('Guarded member put result is missing');
        }
        return appliedPutResult(effect, stored);
    }
    const result = effect.operation === 'insert'
        ? await repository.insertIfAbsent(
            effect.namespace,
            effect.key,
            effect.value,
            effect.expireAtTimestamp
        )
        : effect.operation === 'update'
        ? await repository.upsertIfRevision(
            effect.namespace,
            effect.key,
            effect.value,
            effect.expireAtTimestamp,
            effect.expectedRevision
        )
        : await repository.deleteIfRevision(effect.namespace, effect.key, effect.expectedRevision);
    if (result.status === 'conflict') {
        return forcedEffectConflict(effect);
    }
    if (effect.operation === 'delete') {
        return {
            status: 'applied',
            effectId: effect.effectId,
            operation: effect.operation,
            namespace: effect.namespace,
            key: effect.key,
            matchedRevision: effect.expectedRevision
        };
    }
    if (!('revision' in result) || typeof result.revision !== 'number') {
        throw new Error('Guarded effect result is missing its revision');
    }
    return {
        status: 'applied',
        effectId: effect.effectId,
        operation: effect.operation,
        namespace: effect.namespace,
        key: effect.key,
        resultingRevision: result.revision
    };
}

function appliedPutResult(
    effect: Extract<RuntimeStateGuardedBatchEffect, { operation: 'put'; }>,
    stored: RuntimeStateEntry
): RuntimeStateGuardedBatchEffectResult {
    return {
        status: 'applied',
        effectId: effect.effectId,
        operation: effect.operation,
        namespace: effect.namespace,
        key: effect.key,
        resultingRevision: stored.revision
    };
}
