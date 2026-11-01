import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GROUP_SESSION_RESERVATIONS_NAMESPACE } from '@shared-server/rallar-system/group-state/schedule/group-session-reservation-storage.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { describe, expect, it } from 'vitest';

import { computeGroupMoveAdmission } from '@shared-server/rallar-system/group-state/move/compute-group-move-admission.ts';
import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { readGroupMutation } from '@shared-server/rallar-system/group-state/mutation/read/read-group-mutation.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createTestGroupStateService } from '../group-state-test-runtime.ts';
import { createGroupAuthorityFacts, groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';

async function createDestination(maxMembers: number, maxSessionsPerMember: number | null = null, scheduled = false) {
    const runtime = new FakeRuntimeStateRepository();
    const service = createTestGroupStateService({ runtimeRepository: runtime, now: () => 1_000, serviceId: 'move-test', randomId: () => 'move-test-id' });
    await service.createGroup(SCOPE, {
        groupId: 'pure-room',
        displayName: 'Destination',
        kind: 'room',
        joinMode: 'open',
        maxMembers,
        ...(scheduled ? { scheduledStartAtEpochMs: 31_000, retention: { mode: 'temporary' as const } } : {}),
        ...(maxSessionsPerMember === null ? {} : { maxSessionsPerMember }),
        createdByPrincipalId: 'alice',
        requestId: 'create-destination'
    });
    const repository = createTestGroupStateRepository(runtime);
    return { service, repository, runtime };
}

async function readJoin(
    repository: ReturnType<typeof createTestGroupStateRepository>,
    principalId: string,
    sessionId = `${principalId}-session`
) {
    const command: Extract<GroupMutationCommand, { operation: 'joinGroup' | 'acceptGroupInvite'; }> = {
        operation: 'joinGroup',
        aggregateRef: groupRef('pure-room'),
        targetPrincipalId: principalId,
        commandId: `move-admit-${principalId}`,
        requestId: `move-admit-${principalId}`,
        input: {
            actorPrincipalId: principalId,
            actorSessionId: sessionId,
            participation: 'player',
            inviteToken: null,
            joinCode: null,
            reason: null
        }
    };
    const { read } = await readGroupMutation(repository, command, null);
    return {
        command,
        read: { ...read, targetAdmission: await repository.findPresenceAdmissionEntry({ ...groupRef('pure-room'), principalId }) ?? null },
        facts: {
            ...createGroupAuthorityFacts(principalId),
            eventId: `move-event-${principalId}`,
            authenticatedAuthority: { principalId, sessionId }
        }
    };
}

describe('group move admission', () => {
    it('rejects two sessions of one principal when destination session capacity is one', async () => {
        const { repository } = await createDestination(3, 1);
        const first = await readJoin(repository, 'bob', 'bob-first');
        const second = await readJoin(repository, 'bob', 'bob-second');
        expect(computeGroupMoveAdmission({ participants: [first, second] })).toMatchObject({
            status: 'denied',
            principalId: 'bob',
            code: 'member-session-limit-reached'
        });
    });

    it('retries when one principal changes destination session admission between cohort reads', async () => {
        const { service, repository } = await createDestination(3, 3);
        await service.joinGroup(SCOPE, 'pure-room', { actorPrincipalId: 'bob', requestId: 'bob-joins' });
        const first = await readJoin(repository, 'bob', 'bob-first');
        await service.connectPresenceSession(SCOPE, 'pure-room', 'bob-other', {
            principalId: 'bob',
            actorPrincipalId: 'bob',
            actorSessionId: 'bob-other',
            generationId: 'bob-other-generation',
            connectionGenerationId: 'bob-other-ws',
            requestId: 'bob-other-connect',
            expiresAtEpochMs: 60000
        });
        const second = await readJoin(repository, 'bob', 'bob-second');
        expect(computeGroupMoveAdmission({ participants: [first, second] })).toEqual({ status: 'conflict' });
    });

    it('rejects an invalid second session authority even when its principal was already counted', async () => {
        const { repository } = await createDestination(2);
        const first = await readJoin(repository, 'bob', 'bob-first');
        const second = await readJoin(repository, 'bob', 'bob-second');
        const forged = {
            ...second,
            facts: { ...second.facts, authenticatedAuthority: { principalId: 'carol', sessionId: 'carol-session' } }
        };

        expect(() => computeGroupMoveAdmission({ participants: [first, forged] })).toThrow();
    });

    it('refuses a spectator join instead of moving a player under a different role', async () => {
        const { repository } = await createDestination(3);
        const participant = await readJoin(repository, 'bob');
        const spectator = {
            ...participant,
            command: { ...participant.command, input: { ...participant.command.input, participation: 'spectator' as const } }
        };

        expect(() => computeGroupMoveAdmission({ participants: [spectator] })).toThrow();
    });

    it('requires a fresh read when the destination changed between participant reads', async () => {
        const { service, repository } = await createDestination(3);
        const bob = await readJoin(repository, 'bob');
        await service.joinGroup(SCOPE, 'pure-room', { actorPrincipalId: 'dave', requestId: 'dave-joins' });
        const carol = await readJoin(repository, 'carol');

        expect(computeGroupMoveAdmission({ participants: [bob, carol] })).toEqual({ status: 'conflict' });
    });

    it('returns no writes when the whole cohort cannot fit', async () => {
        const { repository } = await createDestination(2);
        const before = await repository.readSnapshot(groupRef('pure-room'));
        const participants = await Promise.all([readJoin(repository, 'bob'), readJoin(repository, 'carol')]);

        const result = computeGroupMoveAdmission({ participants });

        expect(result).toMatchObject({ status: 'denied', principalId: 'carol', code: 'group-full' });
        expect(result).not.toHaveProperty('mutations');
        expect(await repository.readSnapshot(groupRef('pure-room'))).toEqual(before);
    });

    it('computes both admissions without writing before the transaction', async () => {
        const { repository } = await createDestination(3);
        const participants = await Promise.all([readJoin(repository, 'bob'), readJoin(repository, 'carol')]);

        const result = computeGroupMoveAdmission({ participants });

        expect(result.status).toBe('admitted');
        if (result.status !== 'admitted') {
            throw new Error('Expected the whole cohort to fit');
        }
        expect(result.mutations.flatMap((mutation) => mutation.members.map((member) => member.principalId)))
            .toEqual(['bob', 'carol']);
        expect(result.mutations.at(-1)?.guard.value).toMatchObject({ activeMemberCount: 3 });
        expect((await repository.readSnapshot(groupRef('pure-room')))?.members.map((member) => member.principalId))
            .toEqual(['alice']);
    });

    it('consumes both reserved seats with sequential private CAS revisions in one staged cohort', async () => {
        const { repository, runtime } = await createDestination(3, null, true);
        const ref = groupRef('pure-room');
        await runtime.upsert(
            GROUP_SESSION_RESERVATIONS_NAMESPACE,
            groupStateGroupStorageKey(ref),
            JSON.stringify({ ...ref, scheduleRevision: 1, principalIds: ['bob', 'carol'] }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );
        const reserved = await repository.findSessionReservationsEntry(ref);
        const participants = await Promise.all([readJoin(repository, 'bob'), readJoin(repository, 'carol')]);
        const result = computeGroupMoveAdmission({ participants });
        expect(result.status).toBe('admitted');
        if (result.status !== 'admitted' || reserved === undefined) {
            throw new Error('Expected reserved cohort admission');
        }
        expect(result.mutations.map((mutation) => mutation.sessionReservationWrite)).toEqual([
            { value: { ...ref, scheduleRevision: 1, principalIds: ['carol'] }, expectedRevision: reserved.entry.revision },
            { value: { ...ref, scheduleRevision: 1, principalIds: [] }, expectedRevision: reserved.entry.revision + 1 }
        ]);
        expect(result.mutations.map((mutation) => mutation.sessionIntentEffect?.operation)).toEqual(['insert', 'insert']);
        expect((await repository.findSessionReservationsEntry(ref))?.value.principalIds).toEqual(['bob', 'carol']);
    });

    it('does not charge another player place for an existing member', async () => {
        const { repository } = await createDestination(2);
        const participants = await Promise.all([readJoin(repository, 'alice'), readJoin(repository, 'bob')]);

        const result = computeGroupMoveAdmission({ participants });

        expect(result.status).toBe('admitted');
        if (result.status !== 'admitted') {
            throw new Error('Expected the existing member and entrant to fit');
        }
        expect(result.mutations.flatMap((mutation) => mutation.members.map((member) => member.principalId)))
            .toEqual(['bob']);
    });

    it('charges one membership place for two consenting sessions of the same principal', async () => {
        const { repository } = await createDestination(2);
        const participants = await Promise.all([
            readJoin(repository, 'bob', 'bob-first'),
            readJoin(repository, 'bob', 'bob-second')
        ]);

        const result = computeGroupMoveAdmission({ participants });

        expect(result.status).toBe('admitted');
        if (result.status !== 'admitted') {
            throw new Error('Expected one principal to consume one place');
        }
        expect(result.mutations).toHaveLength(1);
        expect(result.mutations[0].guard.value).toMatchObject({ activeMemberCount: 2 });
    });

    it('keeps the entire cohort out when one principal is banned', async () => {
        const { service, repository } = await createDestination(3);
        await service.banGroupMember(SCOPE, 'pure-room', 'carol', {
            actorPrincipalId: 'alice',
            requestId: 'ban-carol'
        });
        const participants = await Promise.all([readJoin(repository, 'bob'), readJoin(repository, 'carol')]);

        expect(computeGroupMoveAdmission({ participants }))
            .toMatchObject({ status: 'denied', principalId: 'carol', code: 'member-banned' });
        const snapshot = await repository.readSnapshot(groupRef('pure-room'));
        expect(snapshot?.members.find((member) => member.principalId === 'bob')).toBeUndefined();
        expect(snapshot?.members.find((member) => member.principalId === 'carol')?.status).toBe('banned');
    });
});
