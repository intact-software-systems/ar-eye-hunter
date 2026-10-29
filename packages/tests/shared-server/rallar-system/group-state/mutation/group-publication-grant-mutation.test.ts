import { PUBLICATION_GRANTS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { GROUP_PRESENCE_SUMMARY_TOPIC } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { describe, expect, it } from 'vitest';

import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { createService } from '../presence/group-presence-test-runtime.ts';
import { SCOPE } from './group-mutation-test-runtime.ts';
import {
    applyPublicationMutation,
    computePublicationMutation,
    GRANT_ROOM,
    readGrantRow,
    requireWrite,
    seedGrantRoom,
    toTopicGrants,
    writeGrantRow,
    type PublicationDescriptorInput
} from './group-publication-grant-test-runtime.ts';

const BOB_PUBLISH: PublicationDescriptorInput = {
    operation: 'grantGroupPublication',
    actorPrincipalId: 'alice',
    targetPrincipalId: 'bob',
    topicId: 'room.feed',
    publish: true,
    subscribe: false,
    requestId: 'grant-bob-feed-publish'
};

async function seededRoom(): Promise<GroupBarrierRepository> {
    const runtime = new GroupBarrierRepository();
    await seedGrantRoom(runtime);
    return runtime;
}

async function expectPolicyDenial(
    runtime: GroupBarrierRepository,
    input: PublicationDescriptorInput,
    code: string,
    nowEpochMs?: number
): Promise<void> {
    const { computed } = await computePublicationMutation(runtime, input, nowEpochMs);
    expect(computed, `${input.actorPrincipalId} → ${input.targetPrincipalId}`).toMatchObject({
        outcome: 'rejected',
        rejectionCode: 'group-policy-denied',
        policyDenial: { code }
    });
}

describe('group publication grant mutation', () => {
    it('grant adds the named permissions and bumps snapshotVersion only', async () => {
        const runtime = await seededRoom();
        const { read, computed } = await computePublicationMutation(runtime, BOB_PUBLISH);
        const write = requireWrite(computed);
        const before = read.group?.value;
        const revision = read.group?.entry.revision;

        expect(write.guard).toMatchObject({
            kind: 'group',
            operation: 'update',
            expectedRevision: revision,
            value: {
                snapshotVersion: (before?.snapshotVersion ?? 0) + 1,
                rosterVersion: before?.rosterVersion,
                metadataVersion: before?.metadataVersion
            }
        });
        expect(write.persistence.guardedBatch.guard).toMatchObject({
            namespace: 'group-state:groups',
            operation: 'update',
            expectedRevision: revision
        });
        expect(write.persistence.guardedBatch.effects.map((effect) => [effect.effectId, effect.operation])).toEqual([
            ['publication-grant:bob', 'insert'],
            ['receipt', 'insert']
        ]);
        expect(write.publicationGrantEffects).toEqual([
            {
                operation: 'insert',
                value: expect.objectContaining({ principalId: 'bob', topics: { 'room.feed': { publish: true, subscribe: false } } })
            }
        ]);
        expect(write.event).toMatchObject({
            eventType: 'publication-grant-changed',
            snapshotVersion: (before?.snapshotVersion ?? 0) + 1,
            actor: { principalId: 'alice' },
            payload: { principalId: 'bob', topicId: 'room.feed', permissions: { publish: true, subscribe: false } }
        });
        expect(write.outboxWrites.map((outbox) => outbox.entry.key.topicId)).toEqual([GROUP_PRESENCE_SUMMARY_TOPIC]);
    });

    it('a second grant adding subscribe keeps publish', async () => {
        const runtime = await seededRoom();
        await applyPublicationMutation(runtime, BOB_PUBLISH);
        const { read, computed } = await computePublicationMutation(runtime, {
            ...BOB_PUBLISH,
            publish: false,
            subscribe: true,
            requestId: 'grant-bob-feed-subscribe'
        });

        expect(requireWrite(computed).publicationGrantEffects).toEqual([
            {
                operation: 'update',
                expectedRevision: read.targetPublicationGrant?.entry.revision,
                value: expect.objectContaining({ topics: { 'room.feed': { publish: true, subscribe: true } } })
            }
        ]);
        expect(requireWrite(computed).event.payload).toEqual({
            principalId: 'bob',
            topicId: 'room.feed',
            permissions: { publish: true, subscribe: true }
        });
    });

    it('revoke subscribe only keeps publish', async () => {
        const runtime = await seededRoom();
        await writeGrantRow(runtime, 'bob', { 'room.feed': { publish: true, subscribe: true } });
        await applyPublicationMutation(runtime, {
            ...BOB_PUBLISH,
            operation: 'revokeGroupPublication',
            publish: false,
            subscribe: true,
            requestId: 'revoke-bob-feed-subscribe'
        });

        expect((await readGrantRow(runtime, 'bob'))?.topics).toEqual({
            'room.feed': { publish: true, subscribe: false }
        });
    });

    it('revoke of the last permission of the last topic deletes the row', async () => {
        const runtime = await seededRoom();
        await applyPublicationMutation(runtime, BOB_PUBLISH);
        const revoke = { ...BOB_PUBLISH, operation: 'revokeGroupPublication', requestId: 'revoke-bob-feed' } as const;
        const { read, computed } = await computePublicationMutation(runtime, revoke);

        expect(requireWrite(computed).publicationGrantEffects).toEqual([
            {
                operation: 'delete',
                expectedRevision: read.targetPublicationGrant?.entry.revision,
                value: read.targetPublicationGrant?.value
            }
        ]);
        expect(requireWrite(computed).event.payload).toEqual({
            principalId: 'bob',
            topicId: 'room.feed',
            permissions: { publish: false, subscribe: false }
        });
        await applyPublicationMutation(runtime, revoke);
        expect(await readGrantRow(runtime, 'bob')).toBeUndefined();
    });

    it('revoke of one topic keeps the others', async () => {
        const runtime = await seededRoom();
        await writeGrantRow(runtime, 'bob', {
            'room.feed': { publish: true, subscribe: false },
            'room.chat': { publish: false, subscribe: true }
        });
        await applyPublicationMutation(runtime, {
            ...BOB_PUBLISH,
            operation: 'revokeGroupPublication',
            requestId: 'revoke-bob-feed'
        });

        expect((await readGrantRow(runtime, 'bob'))?.topics).toEqual({
            'room.chat': { publish: false, subscribe: true }
        });
    });

    it('an unchanged grant is a no-op', async () => {
        const runtime = await seededRoom();
        await applyPublicationMutation(runtime, BOB_PUBLISH);
        const { read, computed } = await computePublicationMutation(runtime, {
            ...BOB_PUBLISH,
            requestId: 'grant-bob-feed-publish-again'
        });

        expect(computed).toMatchObject({
            outcome: 'no-op',
            receipt: { outcome: 'no-op', eventId: null, snapshotVersion: read.group?.value.snapshotVersion }
        });
    });

    it('revoke of an absent grant is a no-op', async () => {
        const runtime = await seededRoom();
        const { computed } = await computePublicationMutation(runtime, {
            ...BOB_PUBLISH,
            operation: 'revokeGroupPublication',
            requestId: 'revoke-bob-absent'
        });

        expect(computed).toMatchObject({ outcome: 'no-op', receipt: { outcome: 'no-op', eventId: null } });
    });

    it('the 65th topic is refused capacity; the 64th and a new permission on an existing topic at 64 are applied', async () => {
        const runtime = await seededRoom();
        await writeGrantRow(runtime, 'bob', toTopicGrants(63));
        const sixtyFourth = await computePublicationMutation(runtime, { ...BOB_PUBLISH, requestId: 'grant-bob-64th' });
        expect(Object.keys(requireWrite(sixtyFourth.computed).publicationGrantEffects[0]?.value.topics ?? {})).toHaveLength(64);

        await writeGrantRow(runtime, 'bob', toTopicGrants(64));
        const { computed } = await computePublicationMutation(runtime, { ...BOB_PUBLISH, requestId: 'grant-bob-65th' });
        expect(computed).toMatchObject({
            outcome: 'rejected',
            rejectionCode: 'group-policy-denied',
            policyDenial: { code: 'capacity', details: { limit: 'topics-per-principal', max: 64 } }
        });
        const existing = await computePublicationMutation(runtime, {
            ...BOB_PUBLISH,
            topicId: 'room.topic-00',
            publish: false,
            subscribe: true,
            requestId: 'grant-bob-existing-at-64'
        });
        expect(requireWrite(existing.computed).publicationGrantEffects[0]?.value.topics['room.topic-00']).toEqual({
            publish: true,
            subscribe: true
        });
    });

    it('an admin targeting an admin, an admin targeting itself and a member self-granting are forbidden-role', async () => {
        const runtime = await seededRoom();
        await expectPolicyDenial(runtime, { ...BOB_PUBLISH, actorPrincipalId: 'carol', targetPrincipalId: 'dave' }, 'forbidden-role');
        await expectPolicyDenial(runtime, { ...BOB_PUBLISH, actorPrincipalId: 'carol', targetPrincipalId: 'carol' }, 'forbidden-role');
        await expectPolicyDenial(runtime, { ...BOB_PUBLISH, actorPrincipalId: 'bob', targetPrincipalId: 'bob' }, 'forbidden-role');
        await expectPolicyDenial(runtime, { ...BOB_PUBLISH, actorPrincipalId: 'erin', targetPrincipalId: 'bob' }, 'forbidden-role');
    });

    it('an owner self-grant is applied', async () => {
        const runtime = await seededRoom();
        await applyPublicationMutation(runtime, { ...BOB_PUBLISH, targetPrincipalId: 'alice', requestId: 'grant-alice-self' });

        expect((await readGrantRow(runtime, 'alice'))?.topics).toEqual({ 'room.feed': { publish: true, subscribe: false } });
    });

    it('a left or invited target is member-not-active', async () => {
        const runtime = await seededRoom();
        await expectPolicyDenial(runtime, { ...BOB_PUBLISH, targetPrincipalId: 'lee' }, 'member-not-active');
        await expectPolicyDenial(runtime, { ...BOB_PUBLISH, targetPrincipalId: 'ivy' }, 'member-not-active');
        await expectPolicyDenial(runtime, { ...BOB_PUBLISH, targetPrincipalId: 'nobody' }, 'member-not-active');
    });

    it('spectator publish is forbidden-role and spectator subscribe is applied', async () => {
        const runtime = await seededRoom();
        await expectPolicyDenial(runtime, { ...BOB_PUBLISH, targetPrincipalId: 'sam', publish: true, subscribe: true }, 'forbidden-role');
        await applyPublicationMutation(runtime, {
            ...BOB_PUBLISH,
            targetPrincipalId: 'sam',
            publish: false,
            subscribe: true,
            requestId: 'grant-sam-subscribe'
        });

        expect((await readGrantRow(runtime, 'sam'))?.topics).toEqual({ 'room.feed': { publish: false, subscribe: true } });
    });

    it('an archived, deleted or expired group denies group-archived, group-deleted, group-not-active', async () => {
        for (const status of ['archived', 'deleted'] as const) {
            const runtime = await seededRoom();
            await createService(runtime, 2_000).updateGroup(SCOPE, GRANT_ROOM, {
                status,
                actorPrincipalId: 'alice',
                requestId: `set-${status}`
            });
            await expectPolicyDenial(runtime, BOB_PUBLISH, `group-${status}`);
        }
        const expiring = new GroupBarrierRepository();
        await seedGrantRoom(expiring, 2_500);
        await expectPolicyDenial(expiring, BOB_PUBLISH, 'group-not-active', 3_000);
    });

    it('validate refuses a computed grant whose permissions were altered', async () => {
        const runtime = await seededRoom();
        const { service, command, read, computed } = await computePublicationMutation(runtime, BOB_PUBLISH);
        const write = requireWrite(computed);
        const grant = write.publicationGrantEffects[0];
        if (grant === undefined || grant.operation !== 'insert') {
            throw new Error('Expected the grant insert');
        }
        const altered = {
            ...write,
            publicationGrantEffects: [{
                ...grant,
                value: { ...grant.value, topics: { 'room.feed': { publish: true, subscribe: true } } }
            }]
        };

        expect(service.validate(command, read, computed)).toEqual([]);
        expect(service.validate(command, read, altered)).not.toEqual([]);
        expect(write.persistence.guardedBatch.effects.filter((effect) => effect.namespace === PUBLICATION_GRANTS_NAMESPACE)).toHaveLength(1);
    });
});
