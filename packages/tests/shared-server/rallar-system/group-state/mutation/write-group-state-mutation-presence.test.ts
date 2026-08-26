import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { describe, expect, it } from 'vitest';

import type { GroupMutationIdempotencyRecord } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { groupStateIdempotencyStorageKey } from '@shared-server/rallar-system/group-state/persistence/idempotency/group-idempotency-storage-key.ts';
import {
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey
} from '@shared-server/rallar-system/group-state/persistence/presence/group-presence-storage-keys.ts';
import { toSessionPurgeAfterEpochMs } from '@shared-server/rallar-system/presence/session-expiry.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { createTestGroupStateRuntime, createTestGroupStateService } from '../group-state-test-runtime.ts';
import { ApplyingGuardedBatchRepository, OrderedGroupEventStore } from './group-mutation-test-runtime.ts';

const SCOPE = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
} as const;

describe('GroupStateService guarded presence batch', () => {
    it('materializes exact connect and heartbeat bundles before their events', async () => {
        const runtime = new ApplyingGuardedBatchRepository();
        const eventStore = new OrderedGroupEventStore(runtime);
        const startedAtEpochMs = 1_900_000_000_000;
        let nowEpochMs = startedAtEpochMs;
        let generatedId = 0;
        const service = createTestGroupStateService({
            runtimeRepository: runtime,
            groupStateEventStoreFor: () => eventStore,
            now: () => nowEpochMs,
            randomId: () => `presence-batch-id-${++generatedId}`,
            serviceId: 'presence-batch-service'
        });
        const ref = groupRef('presence-update');
        await service.createGroup(SCOPE, {
            groupId: ref.groupId,
            displayName: 'Presence update',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'alice',
            requestId: 'presence-update-seed'
        });
        nowEpochMs = startedAtEpochMs + 1_000;
        const connectReceipt = await service.connectPresenceSessionReceipt(
            SCOPE,
            ref.groupId,
            'session-a',
            {
                principalId: 'alice',
                generationId: 'generation-a',
                expiresAtEpochMs: startedAtEpochMs + 20_000,
                requestId: 'presence-update-connect'
            }
        );
        const repository = createTestGroupStateRepository(runtime, eventStore);
        const connectedGroup = await repository.findGroup(ref);
        const admission = await repository.findPresenceAdmissionEntry({
            ...ref,
            principalId: 'alice'
        });
        const connectIdempotency = await repository.findIdempotentGroupMutationReceipt(
            ref,
            'presence-update-connect'
        );
        const connectEvent = eventStore.events.find(
            ({ eventId }) => eventId === connectReceipt.eventId
        );
        if (!connectedGroup || !admission || !connectIdempotency || !connectEvent) {
            throw new Error('Expected the complete presence connect bundle');
        }
        const connectedSession = {
            ...ref,
            sessionId: 'session-a',
            principalId: 'alice',
            generationId: 'generation-a',
            generationVersion: nowEpochMs,
            connectedAtEpochMs: nowEpochMs,
            lastHeartbeatAtEpochMs: nowEpochMs,
            expiresAtEpochMs: startedAtEpochMs + 20_000,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null
        } as const;

        expect(runtime.batches.at(-1)).toEqual({
            guard: {
                operation: 'insert',
                namespace: 'group-state:sessions',
                key: groupStatePresenceSessionStorageKey(connectedSession),
                value: JSON.stringify(connectedSession),
                expireAtTimestamp: toSessionPurgeAfterEpochMs(
                    connectedSession.expiresAtEpochMs,
                    connectedSession.disconnectedAtEpochMs
                )
            },
            effects: [
                {
                    effectId: 'presence-admission',
                    operation: 'insert',
                    namespace: 'group-state:presence-admissions',
                    key: groupStatePresenceAdmissionStorageKey({
                        ...ref,
                        principalId: 'alice'
                    }),
                    value: JSON.stringify(admission.value),
                    expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
                },
                exactReceiptEffect(ref, 'presence-update-connect', connectIdempotency)
            ]
        });

        runtime.resetObservations();
        eventStore.events.length = 0;
        nowEpochMs = startedAtEpochMs + 2_000;
        const heartbeatReceipt = await service.heartbeatPresenceSessionReceipt(
            SCOPE,
            ref.groupId,
            'session-a',
            {
                generationId: 'generation-a',
                actorPrincipalId: 'alice',
                lastHeartbeatAtEpochMs: nowEpochMs,
                expiresAtEpochMs: startedAtEpochMs + 30_000,
                requestId: 'presence-update-heartbeat'
            }
        );
        const presence = await repository.findPresenceEntry({
            ...ref,
            sessionId: 'session-a'
        });
        const heartbeatIdempotency = await repository.findIdempotentGroupMutationReceipt(
            ref,
            'presence-update-heartbeat'
        );
        const heartbeatEvent = eventStore.events.find(
            ({ eventId }) => eventId === heartbeatReceipt.eventId
        );
        if (!presence || !heartbeatIdempotency || !heartbeatEvent) {
            throw new Error('Expected the complete presence heartbeat bundle');
        }
        expect(runtime.batches).toEqual([
            {
                guard: {
                    operation: 'update',
                    namespace: 'group-state:sessions',
                    key: groupStatePresenceSessionStorageKey(presence.value),
                    expectedRevision: 0,
                    value: JSON.stringify(presence.value),
                    expireAtTimestamp: toSessionPurgeAfterEpochMs(
                        presence.value.expiresAtEpochMs,
                        presence.value.disconnectedAtEpochMs
                    )
                },
                effects: [exactReceiptEffect(ref, 'presence-update-heartbeat', heartbeatIdempotency)]
            }
        ]);
        expect(runtime.transactionOrder).toEqual(['batch', 'event', 'commit']);
        expect(eventStore.events).toEqual([heartbeatEvent]);
    });

    it('materializes an exact expiry delete guard and admission update', async () => {
        const runtime = new ApplyingGuardedBatchRepository();
        const eventStore = new OrderedGroupEventStore(runtime);
        let nowEpochMs = 1_900_000_000_000;
        let generatedId = 0;
        const groupRuntime = createTestGroupStateRuntime({
            runtimeRepository: runtime,
            groupStateEventStoreFor: () => eventStore,
            now: () => nowEpochMs,
            randomId: () => `expiry-batch-id-${++generatedId}`,
            serviceId: 'expiry-batch-service'
        });
        const ref = groupRef('presence-expiry');
        await groupRuntime.service.createGroup(SCOPE, {
            groupId: ref.groupId,
            displayName: 'Presence expiry',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'alice',
            requestId: 'presence-expiry-seed'
        });
        nowEpochMs += 2_000;
        await groupRuntime.service.connectPresenceSession(SCOPE, ref.groupId, 'expiry-session', {
            principalId: 'alice',
            generationId: 'expiry-generation',
            connectedAtEpochMs: nowEpochMs,
            lastHeartbeatAtEpochMs: nowEpochMs,
            expiresAtEpochMs: nowEpochMs + 500,
            requestId: 'presence-expiry-connect'
        });
        runtime.resetObservations();
        eventStore.events.length = 0;
        nowEpochMs += 1_000;

        const written = await groupRuntime.maintenance.expireExpiredPresenceSessions(nowEpochMs);
        const batch = runtime.batches[0];
        const repository = createTestGroupStateRepository(runtime, eventStore);
        const admission = await repository.findPresenceAdmissionEntry({
            ...ref,
            principalId: 'alice'
        });
        if (!batch || !admission) {
            throw new Error('Expected the complete presence expiry bundle');
        }

        expect(written).toHaveLength(1);
        expect(batch.guard).toEqual({
            operation: 'delete',
            namespace: 'group-state:sessions',
            key: groupStatePresenceSessionStorageKey({
                ...ref,
                sessionId: 'expiry-session'
            }),
            expectedRevision: 0
        });
        expect(batch.effects[0]).toEqual({
            effectId: 'presence-admission',
            operation: 'update',
            namespace: 'group-state:presence-admissions',
            key: groupStatePresenceAdmissionStorageKey({
                ...ref,
                principalId: 'alice'
            }),
            expectedRevision: 0,
            value: JSON.stringify(admission.value),
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        });
        expect(
            batch.effects.slice(1).map(({ effectId, operation, namespace }) => ({
                effectId,
                operation,
                namespace
            }))
        ).toEqual([
            {
                effectId: 'receipt',
                operation: 'insert',
                namespace: 'group-state:idempotent'
            }
        ]);
        expect(
            await repository.findPresenceSession({
                ...ref,
                sessionId: 'expiry-session'
            })
        ).toBeUndefined();
        expect(runtime.transactionOrder).toEqual(['batch', 'event', 'commit']);
        expect(eventStore.events).toHaveLength(1);
    });
});

function exactReceiptEffect(
    ref: GroupRef,
    requestId: string,
    value: GroupMutationIdempotencyRecord
) {
    return {
        effectId: 'receipt',
        operation: 'insert',
        namespace: 'group-state:idempotent',
        key: groupStateIdempotencyStorageKey(ref, requestId),
        value: JSON.stringify(value),
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    } as const;
}

function groupRef(groupId: string): GroupRef {
    return { ...SCOPE, groupId };
}
