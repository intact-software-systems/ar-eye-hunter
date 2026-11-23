import type { RoomClockMutation } from '@shared/api/group-deadlines/room-clock.ts';
import { writeAppOutboxInsert } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { decodeViewInvalidationMessage } from '@shared/api/views/view-invalidation.ts';
import { expect, it } from 'vitest';
import { GroupBarrierRepository } from '../group-barrier-repository.ts';
import { createService, seedOpenGroup } from '../presence/group-presence-test-runtime.ts';
import {
    commitMutation, createRetentionDatabaseFixture, prepareMutation, requireMutationWrite, RETENTION_REF, seedRetentionRoom
} from '../retention/group-retention-database-fixture.ts';
import { SCOPE } from './group-mutation-test-runtime.ts';
import { computeDescriptorMutation, requireWrite } from './group-publication-grant-test-runtime.ts';

it('targets redacted updates to durable members without presence and drops a banned member from the next revision', async () => {
    const runtime = new GroupBarrierRepository();
    const groupId = 'court';
    const nowEpochMs = Date.now();
    await seedOpenGroup(runtime, groupId);
    const service = createService({ runtimeRepository: runtime, nowEpochMs, attemptCount: 1, injectedRandomId: undefined, timing: undefined });
    const actor = { actorPrincipalId: 'alice', actorSessionId: 'alice-session' };
    await service.connectPresenceSession(SCOPE, groupId, actor.actorSessionId, {
        ...actor, principalId: 'alice', generationId: 'presence', connectionGenerationId: 'socket', publicationKey: null, requestId: 'connect'
    });
    await service.appointDirector(SCOPE, groupId, { ...actor, requestId: 'director' });
    await service.joinGroup(SCOPE, groupId, { actorPrincipalId: 'bob', requestId: 'join' });
    const publish = {
        operation: 'publish-schedule', name: 'match', expectedDirectorEpoch: 1, expectedRevision: 0,
        phases: [{ phase: 'private-phase', startsAtEpochMs: nowEpochMs + 1000 }]
    } as const;
    const pause = mutationDescriptor({ operation: 'updateGroup', scope: SCOPE, groupId, request: {
        ...actor, requestId: 'pause', roomClock: { operation: 'pause-program', name: 'match', expectedDirectorEpoch: 1, expectedRevision: 1 }
    } });
    const ban = mutationDescriptor({ operation: 'banGroupMember', scope: SCOPE, groupId, targetPrincipalId: 'bob', request: { ...actor, requestId: 'ban' } });
    async function notices(descriptor: typeof pause) {
        const { computed } = await computeDescriptorMutation({ runtime, actorPrincipalId: 'alice', descriptor, nowEpochMs });
        return requireWrite(computed).outboxWrites.map(write => decodePersistedALMessage(write.entry.resource))
            .filter(message => message.payload.typeId === AppTopics.viewInvalidated).map(decodeViewInvalidationMessage);
    }
    const access = { version: 1, resource: 'room-access', scope: SCOPE, groupId, principalId: 'bob', changeId: expect.any(String) };
    expect(await notices(ban)).toEqual([access]);
    async function applyClock(roomClock: RoomClockMutation) {
        const request = { ...actor, requestId: crypto.randomUUID(), roomClock };
        const descriptor = mutationDescriptor({ operation: 'updateGroup', scope: SCOPE, groupId, request });
        const result = await notices(descriptor);
        await service.updateGroup(SCOPE, groupId, request);
        return result;
    }
    function programNotices(name: string) {
        return ['alice', 'bob'].map(principalId => ({
            version: 1, resource: 'room-program', scope: SCOPE, groupId, name, principalId, changeId: expect.any(String)
        }));
    }
    expect(await applyClock(publish)).toEqual(programNotices('match'));
    const phase = { name: 'score', expectedDirectorEpoch: 1 };
    expect(await applyClock({ ...phase, operation: 'advance-phase', phase: 'halftime', durationMs: 10000, expectedRevision: 0 })).toEqual(programNotices('score'));
    expect(await applyClock({ ...phase, operation: 'pause', expectedRevision: 1 })).toEqual(programNotices('score'));
    expect(await applyClock({ ...phase, operation: 'extend-phase', durationMs: 5000, expectedRevision: 2 })).toEqual(programNotices('score'));
    expect(await applyClock({ ...phase, operation: 'resume', expectedRevision: 3 })).toEqual(programNotices('score'));
    expect(await applyClock({ ...phase, name: 'timer', operation: 'start', durationMs: 10000, expectedRevision: 0 })).toEqual([]);
    expect(await notices(pause)).toEqual(programNotices('match'));
    await service.banGroupMember(SCOPE, groupId, 'bob', { ...actor, requestId: 'ban' });
    expect(await notices(pause)).toEqual([programNotices('match')[0]]);
});

it('rolls back a ban and its receipt when the private access notice cannot commit', async () => {
    const fixture = await createRetentionDatabaseFixture();
    try {
        await seedRetentionRoom(fixture);
        const { groupId } = RETENTION_REF;
        const authority = { actorPrincipalId: 'owner', actorSessionId: fixture.owner.sessionId };
        const grant = await prepareMutation(fixture, mutationDescriptor({
            operation: 'upsertMember', groupId, scope: RETENTION_REF, targetPrincipalId: 'bob',
            request: { ...authority, status: 'active', requestId: 'grant' }
        }));
        await commitMutation(fixture, requireMutationWrite(grant.computed));
        const before = await fixture.repository.readSnapshot(RETENTION_REF);
        const events = await fixture.repository.listEvents(RETENTION_REF);
        const { computed } = await prepareMutation(fixture, mutationDescriptor({
            operation: 'banGroupMember', groupId, scope: RETENTION_REF, targetPrincipalId: 'bob',
            request: { ...authority, requestId: 'ban' }
        }));
        const write = requireMutationWrite(computed);
        const notice = write.outboxWrites.find(row => row.entry.key.topicId === AppTopics.viewInvalidated);
        if (!notice) throw new Error('Missing private revocation notice');
        await fixture.storage.sql.begin(tx => writeAppOutboxInsert(tx, notice));
        await expect(commitMutation(fixture, write)).rejects.toMatchObject({ code: 'resource-inbox-invariant-corruption' });
        expect(await fixture.repository.readSnapshot(RETENTION_REF)).toEqual(before);
        expect(await fixture.repository.listEvents(RETENTION_REF)).toEqual(events);
        expect(await fixture.repository.findIdempotentGroupMutationReceipt(RETENTION_REF, 'ban')).toBeUndefined();
    } finally {
        await fixture.storage.close();
    }
});
