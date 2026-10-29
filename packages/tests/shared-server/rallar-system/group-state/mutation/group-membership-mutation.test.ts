import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import type { GroupMutationDescriptor } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { toGroupMutationAttemptFacts } from '@shared-server/rallar-system/group-state/mutation/to-group-mutation-attempt-facts.ts';
import { PUBLICATION_GRANTS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { groupStatePublicationGrantStorageKey } from '@shared-server/rallar-system/group-state/persistence/publication/group-publication-grant-storage-key.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { GroupPublicationGrant } from '@shared/api/group-publication/group-publication-grants.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { describe, expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createTestAuthSession, createTestGroupStateService } from '../group-state-test-runtime.ts';

import { groupRef, SCOPE } from './group-mutation-test-runtime.ts';

class GroupBarrierRepository extends FakeRuntimeStateRepository {}

function createService(runtimeRepository: GroupBarrierRepository, nowEpochMs: number) {
    let id = 0;
    return createTestGroupStateService({
        runtimeRepository,
        now: () => nowEpochMs,
        randomId: () => `id-${nowEpochMs}-${++id}`,
        serviceId: 'group-service'
    });
}

async function seedOpenGroup(
    runtime: GroupBarrierRepository,
    groupId: string,
    maxMembers = 10
): Promise<void> {
    await createService(runtime, 1_000).createGroup(SCOPE, {
        groupId,
        displayName: groupId,
        kind: 'room',
        joinMode: 'open',
        maxMembers,
        createdByPrincipalId: 'alice',
        requestId: `seed-${groupId}`
    });
}

async function requireSnapshot(runtime: GroupBarrierRepository, groupId: string) {
    const snapshot = await createTestGroupStateRepository(runtime).readSnapshot(groupRef(groupId));
    if (!snapshot) {
        throw new Error(`Missing group snapshot: ${groupId}`);
    }
    return snapshot;
}

async function memberStatus(
    runtime: GroupBarrierRepository,
    groupId: string,
    principalId: string
): Promise<string | undefined> {
    const snapshot = await requireSnapshot(runtime, groupId);
    return snapshot.members.find((member) => member.principalId === principalId)?.status;
}

describe('group membership mutation computation', () => {
    it('does not fabricate join authority for invites or direct terminal governance', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'nullable-join-room');
        const service = createService(runtime, 2_000);
        await service.upsertMember(SCOPE, 'nullable-join-room', 'bob', {
            status: 'invited',
            actorPrincipalId: 'alice',
            requestId: 'invite-without-join'
        });
        await service.banGroupMember(SCOPE, 'nullable-join-room', 'carol', {
            actorPrincipalId: 'alice',
            requestId: 'direct-ban-without-join'
        });

        const snapshot = await requireSnapshot(runtime, 'nullable-join-room');
        expect(snapshot.members.find((member) => member.principalId === 'bob')).toMatchObject({
            status: 'invited',
            joined: null
        });
        expect(snapshot.members.find((member) => member.principalId === 'carol')).toMatchObject({
            status: 'banned',
            joined: null
        });
    });

    it('keeps a banned member from self-leaving out of the ban and rejoining', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'ban-escape-room');
        const service = createService(runtime, 2_000);
        await service.joinGroup(SCOPE, 'ban-escape-room', {
            actorPrincipalId: 'bob',
            requestId: 'join-bob'
        });
        await service.banGroupMember(SCOPE, 'ban-escape-room', 'bob', {
            actorPrincipalId: 'alice',
            requestId: 'ban-bob'
        });

        // 'left' clears the ban stamp, so accepting this self upsert would let the
        // ban be shed and the open group rejoined.
        await expect(
            service.upsertMember(SCOPE, 'ban-escape-room', 'bob', {
                status: 'left',
                actorPrincipalId: 'bob',
                requestId: 'self-left-bob'
            })
        ).rejects.toMatchObject({ denial: { code: 'member-banned' } });
        await expect(
            service.joinGroup(SCOPE, 'ban-escape-room', {
                actorPrincipalId: 'bob',
                requestId: 'rejoin-bob'
            })
        ).rejects.toMatchObject({ denial: { code: 'member-banned' } });

        const banned = (await requireSnapshot(runtime, 'ban-escape-room')).members.find(
            (member) => member.principalId === 'bob'
        );
        expect(banned).toMatchObject({ status: 'banned' });
        expect(banned?.banned).not.toBeNull();
    });

    it('keeps a removed member from self-leaving out of the removal', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'removal-escape-room');
        const service = createService(runtime, 2_000);
        await service.joinGroup(SCOPE, 'removal-escape-room', {
            actorPrincipalId: 'bob',
            requestId: 'join-bob'
        });
        await service.removeGroupMember(SCOPE, 'removal-escape-room', 'bob', {
            actorPrincipalId: 'alice',
            requestId: 'remove-bob'
        });

        await expect(
            service.upsertMember(SCOPE, 'removal-escape-room', 'bob', {
                status: 'left',
                actorPrincipalId: 'bob',
                requestId: 'self-left-bob'
            })
        ).rejects.toMatchObject({ denial: { code: 'member-removed' } });
        expect(await memberStatus(runtime, 'removal-escape-room', 'bob')).toBe('removed');
    });

    it('leaves unban as the one way back from a ban', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'unban-room');
        const service = createService(runtime, 2_000);
        await service.joinGroup(SCOPE, 'unban-room', {
            actorPrincipalId: 'bob',
            requestId: 'join-bob'
        });
        await service.banGroupMember(SCOPE, 'unban-room', 'bob', {
            actorPrincipalId: 'alice',
            requestId: 'ban-bob'
        });
        await service.unbanGroupMember(SCOPE, 'unban-room', 'bob', {
            actorPrincipalId: 'alice',
            requestId: 'unban-bob'
        });
        expect(await memberStatus(runtime, 'unban-room', 'bob')).toBe('left');

        await service.joinGroup(SCOPE, 'unban-room', {
            actorPrincipalId: 'bob',
            requestId: 'rejoin-bob'
        });
        expect(await memberStatus(runtime, 'unban-room', 'bob')).toBe('active');
    });

    it('still lets an ordinary member leave and rejoin', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'ordinary-leave-room');
        const service = createService(runtime, 2_000);
        await service.joinGroup(SCOPE, 'ordinary-leave-room', {
            actorPrincipalId: 'bob',
            requestId: 'join-bob'
        });

        await service.upsertMember(SCOPE, 'ordinary-leave-room', 'bob', {
            status: 'left',
            actorPrincipalId: 'bob',
            requestId: 'leave-bob'
        });
        expect(await memberStatus(runtime, 'ordinary-leave-room', 'bob')).toBe('left');

        await service.joinGroup(SCOPE, 'ordinary-leave-room', {
            actorPrincipalId: 'bob',
            requestId: 'rejoin-bob'
        });
        expect(await memberStatus(runtime, 'ordinary-leave-room', 'bob')).toBe('active');
    });

    it('leave adds the target grant delete with its expectedRevision', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'grant-leave-room');
        await joinBob(runtime, 'grant-leave-room');
        const grant = await writeGrantRow(runtime, 'grant-leave-room', 'bob');
        const revision = await grantRevision(runtime, grant);

        const { computed } = await computeMutation(runtime, 'bob', upsertDescriptor('grant-leave-room', 'bob', 'left'));

        expect(computed.outcome === 'write' && computed.publicationGrantEffects).toEqual([
            { operation: 'delete', value: grant, expectedRevision: revision }
        ]);
        expect(computed.outcome === 'write' && grantBatchEffects(computed)).toEqual([
            expect.objectContaining({
                operation: 'delete',
                key: groupStatePublicationGrantStorageKey(grant, 'bob'),
                expectedRevision: revision
            })
        ]);
    });

    it('a ban of a member with no grant row adds no grant effect', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'grant-ban-room');
        await joinBob(runtime, 'grant-ban-room');

        const { computed } = await computeMutation(
            runtime,
            'alice',
            mutationDescriptor({
                operation: 'banGroupMember',
                scope: SCOPE,
                groupId: 'grant-ban-room',
                targetPrincipalId: 'bob',
                request: { actorPrincipalId: 'alice', requestId: 'ban-bob-without-grant-0001' }
            })
        );

        expect(computed.outcome).toBe('write');
        expect(computed.outcome === 'write' && computed.publicationGrantEffects).toEqual([]);
        expect(computed.outcome === 'write' && grantBatchEffects(computed)).toEqual([]);
    });

    it('validate refuses a computed leave whose grant delete was dropped', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'grant-drop-room');
        await joinBob(runtime, 'grant-drop-room');
        await writeGrantRow(runtime, 'grant-drop-room', 'bob');
        const { service, command, read, computed } = await computeMutation(
            runtime,
            'bob',
            upsertDescriptor('grant-drop-room', 'bob', 'left')
        );
        if (computed.outcome !== 'write') {
            throw new Error(`Expected a leave write, received ${computed.outcome}`);
        }
        const batch = computed.persistence.guardedBatch;
        const dropped = {
            ...computed,
            publicationGrantEffects: [],
            persistence: {
                ...computed.persistence,
                guardedBatch: {
                    ...batch,
                    effects: batch.effects.filter((effect) => effect.namespace !== PUBLICATION_GRANTS_NAMESPACE),
                    effectSqlDescriptors: batch.effectSqlDescriptors.filter((effect) => effect.namespace !== PUBLICATION_GRANTS_NAMESPACE)
                }
            }
        };

        expect(service.validate(command, read, computed)).toEqual([]);
        expect(service.validate(command, read, dropped)).not.toEqual([]);
    });
});

async function joinBob(runtime: GroupBarrierRepository, groupId: string): Promise<void> {
    await createService(runtime, 2_000).joinGroup(SCOPE, groupId, {
        actorPrincipalId: 'bob',
        requestId: `join-bob-${groupId}`
    });
}

function upsertDescriptor(groupId: string, principalId: string, status: 'left'): GroupMutationDescriptor {
    return mutationDescriptor({
        operation: 'upsertMember',
        scope: SCOPE,
        groupId,
        targetPrincipalId: principalId,
        request: { status, actorPrincipalId: principalId, requestId: `upsert-${principalId}-${status}-0001` }
    });
}

async function writeGrantRow(
    runtime: GroupBarrierRepository,
    groupId: string,
    principalId: string
): Promise<GroupPublicationGrant> {
    const grant: GroupPublicationGrant = {
        ...groupRef(groupId),
        principalId,
        topics: { 'room.feed': { publish: true, subscribe: true } },
        updated: {
            atEpochMs: 1_500,
            actor: { kind: 'principal', principalId: 'alice' },
            reason: null,
            traceId: null,
            requestId: `grant-${principalId}-${groupId}`
        }
    };
    await runtime.upsert(
        PUBLICATION_GRANTS_NAMESPACE,
        groupStatePublicationGrantStorageKey(grant, principalId),
        JSON.stringify(grant),
        NEVER_EXPIRE_AT_TIMESTAMP
    );
    return grant;
}

async function grantRevision(runtime: GroupBarrierRepository, grant: GroupPublicationGrant): Promise<number> {
    const entry = await runtime.findEntry(
        PUBLICATION_GRANTS_NAMESPACE,
        groupStatePublicationGrantStorageKey(grant, grant.principalId)
    );
    if (!entry) {
        throw new Error('Grant row is missing');
    }
    return entry.revision;
}

async function computeMutation(
    runtime: GroupBarrierRepository,
    principalId: string,
    descriptor: GroupMutationDescriptor
) {
    const service = createService(runtime, 3_000);
    const session = createTestAuthSession(principalId);
    await new AuthSessionRepository(runtime).putSession(session);
    const ingress = await service.captureMutationIngress(descriptor, session);
    const command = {
        ...ingress,
        facts: toGroupMutationAttemptFacts({
            ingressFacts: ingress.facts,
            attemptCount: 1,
            laneNowEpochMs: 3_000,
            traceId: 'trace-group-membership-grant-effects'
        })
    };
    const read = await service.read(command);
    return { service, command, read, computed: service.compute(command, read) };
}

function grantBatchEffects(
    computed: Readonly<{ persistence: Readonly<{ guardedBatch: Readonly<{ effects: readonly Readonly<{ namespace: string; }>[]; }>; }>; }>
) {
    return computed.persistence.guardedBatch.effects.filter((effect) => effect.namespace === PUBLICATION_GRANTS_NAMESPACE);
}
