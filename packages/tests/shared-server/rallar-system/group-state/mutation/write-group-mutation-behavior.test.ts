import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
// dprint-ignore
import {
    describe,
    expect,
    it
} from 'vitest';
import { createTestAuthSession, createTestGroupStateRuntime } from '../group-state-test-runtime.ts';
import { ApplyingGuardedBatchRepository, OrderedGroupEventStore } from './group-mutation-test-runtime.ts';

const SCOPE = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
} as const;

describe('GroupStateService guarded batch write boundary', () => {
    it('computes policy persistence values and rejects changed bytes before write', async () => {
        const group = createTestGroupStateRuntime({
            runtimeRepository: new ApplyingGuardedBatchRepository(),
            now: () => 1_000,
            serviceId: 'policy-write-boundary'
        });
        const authority = createTestAuthSession('alice');
        await group.service.createGroup(SCOPE, {
            groupId: 'policy-owner-identity',
            displayName: 'Owner identity',
            kind: 'room',
            createdByPrincipalId: 'alice',
            requestId: 'policy-owner-create'
        });
        const lifecyclePolicy = resolveGroupLifecyclePolicyPreset('managed');
        const prepared = await group.durable.prepareMutation(
            mutationDescriptor({
                operation: 'createGroup',
                scope: SCOPE,
                groupId: 'policy-write',
                request: {
                    groupId: 'policy-write',
                    displayName: 'Policy write',
                    kind: 'room',
                    createdByPrincipalId: 'alice',
                    requestId: 'policy-create',
                    lifecyclePolicy
                }
            }),
            authority
        );
        const command = { ...prepared, facts: { ...prepared.facts, attemptCount: 1 } };
        const read = await group.durable.read(command);
        const computed = group.durable.compute(command, read);
        if (computed.outcome !== 'write' || computed.lifecyclePolicyWrite === null) {
            throw new TypeError('Expected policy write computation');
        }

        expect(group.durable.validate(command, read, computed)).toEqual([]);
        expect(computed.lifecyclePolicyWrite).toEqual({
            key: groupStateGroupStorageKey(command.command.aggregateRef),
            value: JSON.stringify({ groupRef: command.command.aggregateRef, policy: lifecyclePolicy }),
            expireAtIsoTimestamp: '9999-12-31T23:59:59.999Z'
        });
        for (const alteration of [{ value: '{}' }, { key: 'other-group' }, { expireAtIsoTimestamp: '1970-01-01T00:00:00.000Z' }]) {
            const candidate = { ...computed, lifecyclePolicyWrite: { ...computed.lifecyclePolicyWrite, ...alteration } };
            expect(group.durable.validate(command, read, candidate).length).toBeGreaterThan(0);
        }
    });

    it('keeps authoritative state and receipt in the guarded batch and outbox writes separate', async () => {
        const runtime = new ApplyingGuardedBatchRepository();
        const eventStore = new OrderedGroupEventStore(runtime);
        const authority = createTestAuthSession('alice');
        const group = createTestGroupStateRuntime({
            runtimeRepository: runtime,
            groupStateEventStoreFor: () => eventStore,
            now: () => 1_000,
            serviceId: 'write-boundary-service'
        });
        await group.service.createGroup(SCOPE, {
            groupId: 'write-boundary',
            displayName: 'Write boundary',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: authority.clientId,
            requestId: 'write-boundary-create'
        });

        const prepared = await group.durable.prepareMutation(
            mutationDescriptor({
                operation: 'updateGroup',
                scope: SCOPE,
                groupId: 'write-boundary',
                request: {
                    displayName: 'Updated through AppInbox',
                    actorPrincipalId: authority.clientId,
                    requestId: 'write-boundary-update'
                }
            }),
            authority
        );
        const command = {
            ...prepared,
            facts: { ...prepared.facts, attemptCount: 1 }
        };
        const read = await group.durable.read(command);
        const computed = group.durable.compute(command, read);
        expect(group.durable.validate(command, read, computed)).toEqual([]);
        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            throw new TypeError('Expected group write');
        }

        const materialized = computed.guardedBatch.batch;
        expect(materialized.guard).toEqual({
            operation: 'update',
            namespace: 'group-state:groups',
            key: groupStateGroupStorageKey(computed.guard.value),
            expectedRevision: 0,
            value: JSON.stringify(computed.guard.value),
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        });
        expect(materialized.effects.map(({ effectId }) => effectId)).toEqual(['receipt']);
        expect(typeof computed.guardedBatch.guardJson).toBe('string');
        expect(typeof computed.guardedBatch.effectsJson).toBe('string');
        const altered = {
            ...computed,
            guardedBatch: { ...computed.guardedBatch, effectsJson: '[]' }
        };
        expect(group.durable.validate(command, read, altered).length).toBeGreaterThan(0);
        expect(computed.outboxWrites).toHaveLength(1);
        expect(computed.outboxWrites[0]?.entry.typeId).toBe('APP_OUTBOX');
    });
});
