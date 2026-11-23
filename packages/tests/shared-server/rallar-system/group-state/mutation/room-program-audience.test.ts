import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { decodeViewInvalidationMessage } from '@shared/api/views/view-invalidation.ts';
import { expect, it } from 'vitest';
import { GroupBarrierRepository } from '../group-barrier-repository.ts';
import { createService, seedOpenGroup } from '../presence/group-presence-test-runtime.ts';
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
    await service.updateGroup(SCOPE, groupId, { ...actor, requestId: 'publish', roomClock: {
        operation: 'publish-schedule', name: 'match', expectedDirectorEpoch: 1, expectedRevision: 0,
        phases: [{ phase: 'private-phase', startsAtEpochMs: nowEpochMs + 1000 }]
    } });
    const pause = mutationDescriptor({ operation: 'updateGroup', scope: SCOPE, groupId, request: {
        ...actor, requestId: 'pause', roomClock: { operation: 'pause-program', name: 'match', expectedDirectorEpoch: 1, expectedRevision: 1 }
    } });
    const ban = mutationDescriptor({ operation: 'banGroupMember', scope: SCOPE, groupId, targetPrincipalId: 'bob', request: { ...actor, requestId: 'ban' } });
    async function notices(descriptor: typeof pause) {
        const { computed } = await computeDescriptorMutation({ runtime, actorPrincipalId: 'alice', descriptor, nowEpochMs });
        return requireWrite(computed).outboxWrites.map(write => decodePersistedALMessage(write.entry.resource))
            .filter(message => message.payload.typeId === AppTopics.viewInvalidated).map(decodeViewInvalidationMessage);
    }
    const notice = { version: 1, resource: 'room-program', scope: SCOPE, groupId, changeId: expect.any(String) };
    expect(await notices(pause)).toEqual([
        { ...notice, principalId: 'alice', reason: 'program-changed' },
        { ...notice, principalId: 'bob', reason: 'program-changed' }
    ]);
    expect(await notices(ban)).toEqual([{ ...notice, principalId: 'bob', reason: 'access-changed' }]);
    await service.banGroupMember(SCOPE, groupId, 'bob', { ...actor, requestId: 'ban' });
    expect(await notices(pause)).toEqual([{ ...notice, principalId: 'alice', reason: 'program-changed' }]);
});
