import type {
    GroupLifecycleTransitionOperation,
    GroupMutationCommand,
    GroupMutationFacts,
    GroupMutationRead
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import type { GroupLifecyclePolicyRead } from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import {
    type RuntimeStateGuardedBatch,
    type RuntimeStateGuardedBatchEffect,
    type RuntimeStateGuardedBatchEffectResult,
    type RuntimeStateGuardedBatchGuard,
    type RuntimeStateGuardedBatchGuardResult,
    type RuntimeStateGuardedBatchResult
} from '@shared-server/runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { validateRuntimeStateGuardedBatchResult } from '@shared-server/runtime-state/guarded-batch/validate-runtime-state-guarded-batch-result.ts';
import { validateRuntimeStateGuardedBatch } from '@shared-server/runtime-state/guarded-batch/validate-runtime-state-guarded-batch.ts';
import type { RuntimeStateReadBatchSelection, RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntryValue } from '@shared-server/runtime-state/runtime-state-json-store.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike,
    RuntimeStateOptimisticTransactionRepositoryLike
} from '@shared-server/runtime-state/runtime-state-repository.ts';
import { TestGroupStateEventStore } from '@shared-test/shared-server/test-group-state-event-store.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { AuditStamp, Group, GroupEvent, GroupMember, GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { createTestGroup } from '../../../../create-test-group.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

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

export function storedEntry<T>(key: string, value: T): RuntimeStateEntryValue<T> {
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

export interface GroupAuthorityReadOptions {
    readonly policy?: 'absent' | 'corrupt' | 'optimistic' | 'managed' | 'server-auto';
    readonly actorPrincipalId?: string;
    readonly actorIsMember?: boolean;
    readonly activeMemberPrincipalIds?: readonly string[];
}

export function createGroupAuthorityRead(
    groupOverrides: Partial<Group>,
    options: GroupAuthorityReadOptions = {}
): GroupMutationRead {
    const actorPrincipalId = options.actorPrincipalId ?? 'alice';
    const actorMember = createGroupAuthorityActorMember(actorPrincipalId);
    return {
        idempotency: null,
        group: storedEntry(groupStorageKey(), createTestGroup({ ...groupRef('pure-room'), ...groupOverrides })),
        expiredGroupEntry: null,
        actorMember: options.actorIsMember === false ? null : actorMember,
        targetMember: null,
        authorityMember: null,
        directorMember: null,
        actorMemberEntry: options.actorIsMember === false
            ? null
            : storedEntry(groupMemberStorageKey(actorPrincipalId), actorMember),
        targetMemberEntry: null,
        authorityMemberEntry: null,
        directorMemberEntry: null,
        targetPresence: null,
        expiredTargetPresenceEntry: null,
        targetAdmission: null,
        authorityAdmission: null,
        directorAdmission: null,
        authorityPresenceSessions: [],
        authorityPresenceSessionEntries: [],
        presenceSummary: null,
        lifecyclePolicy: toLifecyclePolicyRead(options.policy ?? 'absent'),
        activeMemberPrincipalIds: options.activeMemberPrincipalIds ??
            (options.actorIsMember === false ? [] : [actorPrincipalId]),
        connectTriggerLatch: null,
        plannedLayoutRow: null,
        acceptedLayoutRow: null
    };
}

export function transitionCommand(
    operation: GroupLifecycleTransitionOperation,
    actorPrincipalId = 'alice'
): Extract<GroupMutationCommand, { operation: GroupLifecycleTransitionOperation; }> {
    const identity = {
        aggregateRef: groupRef('pure-room'),
        commandId: 'lifecycle-command',
        requestId: 'lifecycle-command'
    };
    const input = {
        actorPrincipalId,
        actorSessionId: `${actorPrincipalId}-session`,
        reason: null,
        traceId: null,
        expectedFormationEpoch: null
    };
    switch (operation) {
        case 'reconfigureGroup':
            return { ...identity, operation, input: { ...input, landing: null } };
        case 'activateGroup':
            return { ...identity, operation, input: { ...input, observedRate: null, degraded: null, expectedLayout: null } };
        case 'failGroupFormation':
            return { ...identity, operation, input: { ...input, observedRate: 0, expectedLayout: null } };
        case 'connectGroup':
            return {
                ...identity,
                operation,
                input: {
                    ...input,
                    expectedFormationEpoch: 1,
                    expectedLayout: { groupRevision: 1, presenceRevision: 0, version: 1, state: 'active' },
                    connectTriggerGeneration: null
                }
            };
        default:
            return { ...identity, operation, input };
    }
}

export function createGroupAuthorityFacts(principalId = 'alice'): GroupMutationFacts {
    return {
        nowEpochMs: 2_000,
        expireAtEpochMs: 253_402_300_799_999,
        serviceId: 'group-service',
        eventId: 'event-1',
        commandHash: `sha256:${'a'.repeat(64)}`,
        attemptCount: 1,
        resolvedJoinCode: null,
        joinCodeVerifier: null,
        internalAuthority: 'none',
        authenticatedAuthority: {
            principalId,
            sessionId: `${principalId}-session`
        }
    };
}

export function createGroupAuthorityAuditStamp(atEpochMs: number, principalId: string): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId: 'seed'
    };
}

function createGroupAuthorityActorMember(principalId: string): GroupMember {
    const audit = createGroupAuthorityAuditStamp(1_000, principalId);
    return {
        ...groupRef('pure-room'),
        principalId,
        role: 'member' as const,
        status: 'active' as const,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null,
        joined: audit,
        updated: audit
    };
}

function toLifecyclePolicyRead(requested: NonNullable<GroupAuthorityReadOptions['policy']>): GroupLifecyclePolicyRead {
    if (requested === 'corrupt') {
        return { status: 'corrupt' as const, reason: 'stored policy is not an object' };
    }
    if (requested === 'absent') {
        return { status: 'absent' as const };
    }
    return {
        status: 'present' as const,
        policy: requested === 'server-auto'
            ? { ...resolveGroupLifecyclePolicyPreset('optimistic'), initiator: 'server-auto' as const }
            : resolveGroupLifecyclePolicyPreset(requested)
    };
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
    private batchReadBarrier: BatchReadBarrier | undefined;

    get activeTransactionDepth(): number {
        return this.transactionDepth;
    }

    forceNextConflict(target: 'guard' | string): void {
        this.forcedConflicts.push(target);
    }

    omitNextEffectResult(effectId: string): void {
        this.omittedEffectResults.push(effectId);
    }

    blockMatchingBatchReads(namespace: string, key: string, readers: number): void {
        this.batchReadBarrier = createBatchReadBarrier(namespace, key, readers);
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

    override async readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        this.recordRead();
        const selections = await super.readRuntimeStateBatch(selectors);
        const barrier = this.batchReadBarrier;
        if (
            barrier &&
            selectors.some(
                (selector) =>
                    selector.kind === 'key' &&
                    selector.namespace === barrier.namespace &&
                    selector.key === barrier.key
            )
        ) {
            await barrier.arrive();
            if (barrier.complete()) {
                this.batchReadBarrier = undefined;
            }
        }
        return selections;
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
        fn: (repository: RuntimeStateOptimisticTransactionRepositoryLike) => Promise<T>
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

    override async executeGuardedBatch(
        input: RuntimeStateGuardedBatch
    ): Promise<RuntimeStateGuardedBatchResult> {
        if (this.transactionDepth === 0) {
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

interface BatchReadBarrier {
    readonly namespace: string;
    readonly key: string;
    arrive(): Promise<void>;
    complete(): boolean;
}

function createBatchReadBarrier(
    namespace: string,
    key: string,
    readers: number
): BatchReadBarrier {
    let arrivals = 0;
    const released = Promise.withResolvers<void>();
    return {
        namespace,
        key,
        async arrive() {
            arrivals += 1;
            if (arrivals === readers) {
                released.resolve();
            }
            await released.promise;
        },
        complete: () => arrivals >= readers
    };
}

export class OrderedGroupEventStore extends TestGroupStateEventStore {
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
