import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { writeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { describe, expect, it, vi } from 'vitest';
import { createTestAuthSession, createTestGroupStateRuntime } from '../group-state-test-runtime.ts';
import { ApplyingGuardedBatchRepository, OrderedGroupEventStore } from './group-mutation-test-runtime.ts';

const SCOPE = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
} as const;

describe('GroupStateService guarded batch write boundary', () => {
    it('computes authoritative persistence and receipt before the ResourceInbox transaction', async () => {
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

        const ingress = await group.durable.captureMutationIngress(
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
            ...ingress,
            facts: { ...ingress.facts, attemptCount: 1 }
        };
        const read = await group.durable.read(command);
        const computed = group.durable.compute(command, read);
        expect(group.durable.validate(command, read, computed)).toEqual([]);
        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            throw new TypeError('Expected group write');
        }

        const guardedBatch = computed.persistence.guardedBatch;
        expect(guardedBatch.guard).toEqual({
            operation: 'update',
            namespace: 'group-state:groups',
            key: groupStateGroupStorageKey(computed.guard.value),
            expectedRevision: 0,
            value: JSON.stringify(computed.guard.value),
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        });
        expect(guardedBatch.effects.map(({ effectId }) => effectId)).toEqual(['receipt']);
        expect(computed.outboxWrites).toHaveLength(1);
        const outboxWrite = computed.outboxWrites[0];
        const outboxEntry = outboxWrite?.entry;
        expect(outboxEntry?.typeId).toBe('APP_OUTBOX');
        if (outboxWrite === undefined || outboxEntry === undefined) {
            throw new TypeError('Expected a computed group outbox entry');
        }
        const tampered = [
            {
                ...computed,
                persistence: {
                    ...computed.persistence,
                    guardedBatch: {
                        ...computed.persistence.guardedBatch,
                        guard: {
                            ...computed.persistence.guardedBatch.guard,
                            key: `${computed.persistence.guardedBatch.guard.key}:tampered`
                        }
                    }
                }
            },
            {
                ...computed,
                persistence: {
                    ...computed.persistence,
                    eventWrite: {
                        ...computed.persistence.eventWrite,
                        eventJson: '{"eventId":"tampered"}'
                    }
                }
            },
            {
                ...computed,
                outboxWrites: [{
                    ...outboxWrite,
                    entry: { ...outboxEntry, resource: '{"kind":"tampered"}' }
                }]
            },
            {
                ...computed,
                outboxWrites: [{ ...outboxWrite, createdAt: '2000-01-01T00:00:00.000Z' }]
            }
        ];
        for (const candidate of tampered) {
            expect(group.durable.validate(command, read, candidate)).not.toEqual([]);
        }

        const coordinatedTampering = {
            ...computed,
            persistence: {
                ...computed.persistence,
                guardedBatch: {
                    ...computed.persistence.guardedBatch,
                    guard: {
                        ...computed.persistence.guardedBatch.guard,
                        key: `${computed.persistence.guardedBatch.guard.key}:tampered`
                    }
                }
            },
            outboxWrites: [{ ...outboxWrite, createdAt: '2000-01-01T00:00:00.000Z' }]
        };
        expect(
            group.durable.validate(command, read, coordinatedTampering).map((issue) => issue.path)
        ).toEqual(expect.arrayContaining([
            'computed.persistence.guardedBatch.guard.key',
            'computed.outboxWrites.0.createdAt'
        ]));

        const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
            throw new Error('group serialization must finish during compute');
        });
        try {
            await expect(writeGroupMutation(conflictingSql(), computed)).rejects.toBeInstanceOf(
                RuntimeStateWriteConflictError
            );
        }
        finally {
            stringify.mockRestore();
        }
    });
});

function conflictingSql(): PSqlSql {
    const sql = (
        _stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ..._values: readonly PSqlParameter[]
    ): Promise<readonly object[]> | object => Promise.resolve([]);
    return sql as PSqlSql;
}
