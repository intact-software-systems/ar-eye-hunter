import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { readGroupMutation } from '@shared-server/rallar-system/group-state/mutation/read/read-group-mutation.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import {
    groupStateGroupStorageKey,
    groupStateIdempotencyStorageKey,
    groupStateMemberStorageKey,
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey
} from '@shared-server/rallar-system/group-state/persistence/group-state-storage-keys.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { describe, expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';
import { ReadBatchFakeRuntimeStateRepository } from '../../read-batch-fake-runtime-state-repository.ts';
import { createTestGroupStateService } from '../group-state-test-runtime.ts';

const SCOPE: StateScope = {
    applicationId: 'batch-read-app',
    workspaceId: 'batch-read-workspace'
};

describe('GroupStateService mutation exact reads', () => {
    it('batches the known membership mutation read slots', async () => {
        const { runtime, service } = await createSeededService('membership');
        const ref = { ...SCOPE, groupId: 'membership' };
        runtime.readBatchCalls.length = 0;

        await service.upsertMember(SCOPE, ref.groupId, 'bob', {
            role: 'member',
            status: 'active',
            actorPrincipalId: 'owner',
            requestId: 'membership-request'
        });

        expect(mutationReadCalls(runtime)).toEqual([
            [
                {
                    selectorId: 'group',
                    kind: 'key',
                    namespace: 'group-state:groups',
                    key: groupStateGroupStorageKey(ref)
                },
                {
                    selectorId: 'presence-summary',
                    kind: 'key',
                    namespace: 'group-state:presence-summaries',
                    key: groupStateGroupStorageKey(ref)
                },
                {
                    selectorId: 'idempotency:0',
                    kind: 'key',
                    namespace: 'group-state:idempotent',
                    key: groupStateIdempotencyStorageKey(ref, 'membership-request')
                },
                {
                    selectorId: 'member:0',
                    kind: 'key',
                    namespace: 'group-state:members',
                    key: groupStateMemberStorageKey({ ...ref, principalId: 'owner' })
                },
                {
                    selectorId: 'member:1',
                    kind: 'key',
                    namespace: 'group-state:members',
                    key: groupStateMemberStorageKey({ ...ref, principalId: 'bob' })
                },
                {
                    selectorId: 'admission:0',
                    kind: 'key',
                    namespace: 'group-state:presence-admissions',
                    key: groupStatePresenceAdmissionStorageKey({
                        ...ref,
                        principalId: 'bob'
                    })
                }
            ]
        ]);
    });

    it('batches the known group-config mutation read slots', async () => {
        const { runtime, service } = await createSeededService('config');
        const ref = { ...SCOPE, groupId: 'config' };
        runtime.readBatchCalls.length = 0;

        await service.updateGroup(SCOPE, ref.groupId, {
            metadata: { source: 'batch-read' },
            actorPrincipalId: 'owner',
            requestId: 'config-request'
        });

        expect(mutationReadCalls(runtime)).toEqual([
            [
                {
                    selectorId: 'group',
                    kind: 'key',
                    namespace: 'group-state:groups',
                    key: groupStateGroupStorageKey(ref)
                },
                {
                    selectorId: 'presence-summary',
                    kind: 'key',
                    namespace: 'group-state:presence-summaries',
                    key: groupStateGroupStorageKey(ref)
                },
                {
                    selectorId: 'idempotency:0',
                    kind: 'key',
                    namespace: 'group-state:idempotent',
                    key: groupStateIdempotencyStorageKey(ref, 'config-request')
                },
                {
                    selectorId: 'member:0',
                    kind: 'key',
                    namespace: 'group-state:members',
                    key: groupStateMemberStorageKey({ ...ref, principalId: 'owner' })
                },
                {
                    selectorId: 'admission:0',
                    kind: 'key',
                    namespace: 'group-state:presence-admissions',
                    key: groupStatePresenceAdmissionStorageKey({
                        ...ref,
                        principalId: 'owner'
                    })
                }
            ]
        ]);
    });

    it('batches the known presence mutation read slots', async () => {
        const { runtime, service } = await createSeededService('presence');
        const ref = { ...SCOPE, groupId: 'presence' };
        runtime.readBatchCalls.length = 0;

        await service.connectPresenceSession(SCOPE, ref.groupId, 'presence-session', {
            principalId: 'owner',
            generationId: 'presence-generation',
            expiresAtEpochMs: 20_000,
            actorPrincipalId: 'owner',
            requestId: 'presence-request'
        });

        expect(mutationReadCalls(runtime)).toEqual([
            [
                {
                    selectorId: 'group',
                    kind: 'key',
                    namespace: 'group-state:groups',
                    key: groupStateGroupStorageKey(ref)
                },
                {
                    selectorId: 'presence-summary',
                    kind: 'key',
                    namespace: 'group-state:presence-summaries',
                    key: groupStateGroupStorageKey(ref)
                },
                {
                    selectorId: 'idempotency:0',
                    kind: 'key',
                    namespace: 'group-state:idempotent',
                    key: groupStateIdempotencyStorageKey(ref, 'presence-request')
                },
                {
                    selectorId: 'member:0',
                    kind: 'key',
                    namespace: 'group-state:members',
                    key: groupStateMemberStorageKey({ ...ref, principalId: 'owner' })
                },
                {
                    selectorId: 'presence:0',
                    kind: 'key',
                    namespace: 'group-state:sessions',
                    key: groupStatePresenceSessionStorageKey({
                        ...ref,
                        sessionId: 'presence-session'
                    })
                },
                {
                    selectorId: 'admission:0',
                    kind: 'key',
                    namespace: 'group-state:presence-admissions',
                    key: groupStatePresenceAdmissionStorageKey({
                        ...ref,
                        principalId: 'owner'
                    })
                }
            ]
        ]);
    });

    it('keeps an expired batch authority read observational', async () => {
        const { runtime: seeded } = await createSeededService('expiry-replacement');
        const runtime = seeded as ExpiryReplacementReadBatchRuntime;
        const ref = { ...SCOPE, groupId: 'expiry-replacement' };
        const groupKey = groupStateGroupStorageKey(ref);
        const group = await runtime.findEntry('group-state:groups', groupKey);
        if (!group) {
            throw new Error('Expected seeded group entry');
        }
        await runtime.upsert('group-state:groups', groupKey, group.value, Date.now() - 1);
        runtime.readBatchCalls.length = 0;
        runtime.beforeConditionalWrite = async (operation, namespace, key) => {
            if (
                runtime.replacementVisible ||
                operation !== 'deleteIfRevision' ||
                namespace !== 'group-state:groups' ||
                key !== groupKey
            ) {
                return;
            }
            await runtime.upsert(namespace, key, group.value, group.expireAtTimestamp);
            runtime.replacementVisible = true;
        };
        const requestId = 'expiry-replacement-request';
        const command = updateCommand(ref, requestId);

        const observed = await readGroupMutation(createTestGroupStateRepository(runtime), command);
        const expected = await readGroupMutation(
            createTestGroupStateRepository(cloneRuntime(runtime)),
            command
        );

        expect(observed).toEqual(expected);
        expect(runtime.replacementVisible).toBe(false);
        expect(mutationReadCalls(runtime)).toHaveLength(1);
        expect(runtime.postReplacementFinds).toEqual([]);
    });
});

class ExpiryReplacementReadBatchRuntime extends ReadBatchFakeRuntimeStateRepository {
    replacementVisible = false;
    readonly postReplacementFinds: Array<
        Readonly<{
            namespace: string;
            key: string;
        }>
    > = [];

    override findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        if (this.replacementVisible) {
            this.postReplacementFinds.push({ namespace, key });
        }
        return super.findEntry(namespace, key);
    }
}

interface SeededGroupStateService {
    readonly runtime: ReadBatchFakeRuntimeStateRepository | ExpiryReplacementReadBatchRuntime;
    readonly service: ReturnType<typeof createTestGroupStateService>;
}

async function createSeededService(groupId: string): Promise<SeededGroupStateService> {
    const runtime = groupId === 'expiry-replacement'
        ? new ExpiryReplacementReadBatchRuntime()
        : new ReadBatchFakeRuntimeStateRepository();
    let generatedId = 0;
    const service = createTestGroupStateService({
        runtimeRepository: runtime,
        now: () => 1_000,
        randomId: () => `batch-read-id-${++generatedId}`,
        serviceId: 'batch-read-service'
    });
    await service.createGroup(SCOPE, {
        groupId,
        displayName: groupId,
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: 'owner',
        requestId: `seed-${groupId}`
    });
    return { runtime, service };
}

function updateCommand(
    aggregateRef: Readonly<StateScope & { groupId: string; }>,
    requestId: string
): Extract<GroupMutationCommand, { operation: 'updateGroup'; }> {
    return {
        operation: 'updateGroup',
        aggregateRef,
        commandId: requestId,
        requestId,
        input: {
            slug: null,
            displayName: null,
            description: null,
            kind: null,
            status: null,
            joinMode: null,
            maxMembers: null,
            maxSessionsPerMember: null,
            metadata: { source: 'expiry-fallback' },
            expiresAtEpochMs: null,
            emptySinceEpochMs: null,
            purgeAfterEpochMs: null,
            actorPrincipalId: 'owner',
            actorSessionId: null,
            reason: null,
            traceId: null
        }
    };
}

function cloneRuntime(source: FakeRuntimeStateRepository): FakeRuntimeStateRepository {
    const clone = new FakeRuntimeStateRepository();
    for (const [key, entry] of source.data) {
        clone.data.set(key, { ...entry });
    }
    return clone;
}

function mutationReadCalls(runtime: ReadBatchFakeRuntimeStateRepository) {
    return runtime.readBatchCalls.filter((selectors) => selectors.some((selector) => selector.selectorId.startsWith('idempotency:')));
}
