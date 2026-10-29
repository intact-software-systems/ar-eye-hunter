import {
    describe,
    expect,
    it
} from 'vitest';

import { AUTH_SESSIONS_BY_SESSION_NAMESPACE, authSessionKey } from '@shared-server/rallar-system/auth/persistence/auth-storage-keys.ts';
import type { GroupStateWritten } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import {
    readGroupMutation,
    readGroupMutationWithSnapshot
} from '@shared-server/rallar-system/group-state/mutation/read/read-group-mutation.ts';
import { readSequentialGroupMutation } from '@shared-server/rallar-system/group-state/mutation/read/read-sequential-group-mutation.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { PUBLICATION_GRANTS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { groupStateIdempotencyStorageKey } from '@shared-server/rallar-system/group-state/persistence/idempotency/group-idempotency-storage-key.ts';
import { groupStateMemberStorageKey } from '@shared-server/rallar-system/group-state/persistence/membership/group-membership-storage-key.ts';
import {
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey
} from '@shared-server/rallar-system/group-state/persistence/presence/group-presence-storage-keys.ts';
import { groupStatePublicationGrantStorageKey } from '@shared-server/rallar-system/group-state/persistence/publication/group-publication-grant-storage-key.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { ReadBatchFakeRuntimeStateRepository } from '../../../runtime-state/test-support/read-batch-fake-runtime-state-repository.ts';
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
                    selectorId: 'members',
                    kind: 'prefix',
                    namespace: 'group-state:members',
                    keyPrefix: groupStateGroupStorageKey(ref) + ':'
                },
                {
                    selectorId: 'presence-summary',
                    kind: 'key',
                    namespace: 'group-state:presence-summaries',
                    key: groupStateGroupStorageKey(ref)
                },
                {
                    selectorId: 'presence-sessions',
                    kind: 'prefix',
                    namespace: 'group-state:sessions',
                    keyPrefix: groupStateGroupStorageKey(ref) + ':'
                },
                {
                    selectorId: 'publication-grants',
                    kind: 'prefix',
                    namespace: 'group-state:publication-grants',
                    keyPrefix: groupStateGroupStorageKey(ref) + ':'
                },
                {
                    selectorId: 'lifecycle-policy',
                    kind: 'key',
                    namespace: 'group-state:lifecycle-policies',
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
                },
                {
                    selectorId: 'auth-session',
                    kind: 'key',
                    namespace: AUTH_SESSIONS_BY_SESSION_NAMESPACE,
                    key: authSessionKey('owner-session')
                }
            ]
        ]);
    });

    it('reads a join\'s session, policy, decision rows and result snapshot in one batch', async () => {
        const { runtime } = await createSeededService('join');
        const ref = { ...SCOPE, groupId: 'join' };
        const repository = createTestGroupStateRepository(runtime);
        runtime.readBatchCalls.length = 0;

        const { read, currentSnapshot, authSession } = await readGroupMutationWithSnapshot(
            repository,
            joinCommand(ref, 'bob'),
            'bob-session'
        );

        expect(mutationReadCalls(runtime).map((selectors) => selectors.map((selector) => selector.selectorId)))
            .toEqual([[
                'group',
                'members',
                'presence-summary',
                'presence-sessions',
                'publication-grants',
                'lifecycle-policy',
                'idempotency:0',
                'member:0',
                'admission:0',
                'auth-session'
            ]]);
        expect(runtime.readBatchCalls).toHaveLength(1);
        expect(authSession).toEqual({ status: 'read', session: undefined });
        expect(read.lifecyclePolicy?.status).toBe('present');
        expect(currentSnapshot?.group).toEqual((await repository.readSnapshot(ref))?.group);
        expect(currentSnapshot?.members.map((member) => member.principalId)).toEqual(['owner']);
        expect(currentSnapshot?.causalRevision).toEqual({
            groupRevision: read.group?.value.snapshotVersion,
            presenceRevision: read.presenceSummary?.value.causalRevision.presenceRevision ?? 0
        });
    });

    it.each([
        ['join', 'plain', 'exact'],
        ['join', 'snapshot', 'exact'],
        ['update', 'plain', 'exact'],
        ['update', 'snapshot', 'exact'],
        ['join', 'plain', 'sequential'],
        ['join', 'snapshot', 'sequential'],
        ['update', 'plain', 'sequential'],
        ['update', 'snapshot', 'sequential']
    ])('retains complete member facts for %s %s %s reads without electorate IDs', async (kind, result, path) => {
        const { runtime, service } = await createSeededService('roster');
        const ref = { ...SCOPE, groupId: 'roster' };
        await service.updateGroup(SCOPE, ref.groupId, { maxSpectators: 1, actorPrincipalId: 'owner' });
        await service.upsertMember(SCOPE, ref.groupId, 'watcher', {
            role: 'spectator',
            status: 'active',
            actorPrincipalId: 'owner'
        });
        const repository = createTestGroupStateRepository(path === 'exact' ? runtime : cloneRuntime(runtime));
        const command = kind === 'join' ? joinCommand(ref, 'bob') : updateCommand(ref, 'roster-read');
        const observed = result === 'snapshot'
            ? await readGroupMutationWithSnapshot(repository, command, null)
            : await readGroupMutation(repository, command, null);
        expect(observed.read.activeMembers?.map(({ principalId, role }) => ({ principalId, role }))).toEqual([
            { principalId: 'owner', role: 'owner' },
            { principalId: 'watcher', role: 'spectator' }
        ]);
        expect(observed.read.activeMemberPrincipalIds).toBeNull();
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
                    selectorId: 'members',
                    kind: 'prefix',
                    namespace: 'group-state:members',
                    keyPrefix: groupStateGroupStorageKey(ref) + ':'
                },
                {
                    selectorId: 'presence-summary',
                    kind: 'key',
                    namespace: 'group-state:presence-summaries',
                    key: groupStateGroupStorageKey(ref)
                },
                {
                    selectorId: 'presence-sessions',
                    kind: 'prefix',
                    namespace: 'group-state:sessions',
                    keyPrefix: groupStateGroupStorageKey(ref) + ':'
                },
                {
                    selectorId: 'publication-grants',
                    kind: 'prefix',
                    namespace: 'group-state:publication-grants',
                    keyPrefix: groupStateGroupStorageKey(ref) + ':'
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
                },
                {
                    selectorId: 'auth-session',
                    kind: 'key',
                    namespace: AUTH_SESSIONS_BY_SESSION_NAMESPACE,
                    key: authSessionKey('owner-session')
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
            connectionGenerationId: 'presence-ws-generation',
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
                },
                {
                    selectorId: 'auth-session',
                    kind: 'key',
                    namespace: AUTH_SESSIONS_BY_SESSION_NAMESPACE,
                    key: authSessionKey('presence-session')
                }
            ]
        ]);
    });

    it('leave, remove and ban read the target grant row; join and role changes do not', async () => {
        const { runtime, service } = await createSeededService('grant-scope');
        const ref = { ...SCOPE, groupId: 'grant-scope' };
        const grantSelectorsOf = async (mutate: () => Promise<GroupStateWritten>) => {
            runtime.readBatchCalls.length = 0;
            await mutate();
            return mutationReadCalls(runtime).flat().filter((selector) => selector.kind === 'key' && selector.namespace === PUBLICATION_GRANTS_NAMESPACE);
        };
        const grantSelector = (principalId: string) => ({
            selectorId: 'grant:0',
            kind: 'key',
            namespace: PUBLICATION_GRANTS_NAMESPACE,
            key: groupStatePublicationGrantStorageKey(ref, principalId)
        });

        expect(await grantSelectorsOf(() => service.joinGroup(SCOPE, ref.groupId, { actorPrincipalId: 'bob' })))
            .toEqual([]);
        expect(
            await grantSelectorsOf(() => service.setGroupMemberRole(SCOPE, ref.groupId, 'bob', { role: 'admin', actorPrincipalId: 'owner' }))
        ).toEqual([]);
        expect(
            await grantSelectorsOf(() => service.upsertMember(SCOPE, ref.groupId, 'bob', { status: 'left', actorPrincipalId: 'bob' }))
        ).toEqual([grantSelector('bob')]);
        await service.joinGroup(SCOPE, ref.groupId, { actorPrincipalId: 'bob' });
        expect(
            await grantSelectorsOf(() => service.removeGroupMember(SCOPE, ref.groupId, 'bob', { actorPrincipalId: 'owner' }))
        ).toEqual([grantSelector('bob')]);
        await service.joinGroup(SCOPE, ref.groupId, { actorPrincipalId: 'carol' });
        expect(
            await grantSelectorsOf(() => service.banGroupMember(SCOPE, ref.groupId, 'carol', { actorPrincipalId: 'owner' }))
        ).toEqual([grantSelector('carol')]);
    });

    it('the sequential read loads the target grant row only for a departure', async () => {
        const { runtime, service } = await createSeededService('grant-sequential');
        const ref = { ...SCOPE, groupId: 'grant-sequential' };
        await service.joinGroup(SCOPE, ref.groupId, { actorPrincipalId: 'bob' });
        const grant = {
            ...ref,
            principalId: 'bob',
            topics: { 'room.feed': { publish: true, subscribe: false } },
            updated: { atEpochMs: 1_000, actor: { kind: 'principal', principalId: 'owner' }, reason: null, traceId: null, requestId: null }
        };
        await runtime.upsert(
            PUBLICATION_GRANTS_NAMESPACE,
            groupStatePublicationGrantStorageKey(ref, 'bob'),
            JSON.stringify(grant),
            Number.MAX_SAFE_INTEGER
        );
        const repository = createTestGroupStateRepository(runtime);

        const leave = await readSequentialGroupMutation({ repository, command: leaveCommand(ref, 'bob'), lifecyclePolicy: null });
        const join = await readSequentialGroupMutation({ repository, command: joinCommand(ref, 'bob'), lifecyclePolicy: null });

        expect(leave.targetPublicationGrant?.value).toEqual(grant);
        expect(join.targetPublicationGrant).toBeNull();
    });

    it('keeps an expired batch authority read observational', async () => {
        const { runtime: seeded } = await createSeededService('expiry-replacement');
        if (!(seeded instanceof ExpiryReplacementReadBatchRuntime)) {
            throw new Error('Expected the expiry replacement runtime');
        }
        const runtime = seeded;
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

        const observed = await readGroupMutation(createTestGroupStateRepository(runtime), command, null);
        const expected = await readGroupMutation(
            createTestGroupStateRepository(cloneRuntime(runtime)),
            command,
            null
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

function joinCommand(
    aggregateRef: Readonly<StateScope & { groupId: string; }>,
    principalId: string
): GroupMutationCommand {
    return {
        operation: 'joinGroup',
        aggregateRef,
        commandId: `join-${principalId}`,
        requestId: `join-${principalId}`,
        targetPrincipalId: principalId,
        input: {
            participation: null,
            inviteToken: null,
            joinCode: null,
            actorPrincipalId: principalId,
            actorSessionId: null,
            reason: null
        }
    };
}

function leaveCommand(
    aggregateRef: Readonly<StateScope & { groupId: string; }>,
    principalId: string
): GroupMutationCommand {
    return {
        operation: 'upsertMember',
        aggregateRef,
        commandId: `leave-${principalId}`,
        requestId: `leave-${principalId}`,
        targetPrincipalId: principalId,
        input: {
            role: null,
            status: 'left',
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            actorPrincipalId: principalId,
            actorSessionId: null,
            reason: null
        }
    };
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
            maxSpectators: null,
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
            reason: null
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
