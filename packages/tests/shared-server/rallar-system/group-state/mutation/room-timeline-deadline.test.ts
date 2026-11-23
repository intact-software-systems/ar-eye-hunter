import { computeRoomTimelineDeadlines, toTimelineSettlementCommand } from '@shared-server/rallar-system/group-state/schedule/room-timeline-deadline.ts';
import { ROOM_CLOCKS_METADATA_KEY } from '@shared/api/group-deadlines/room-clock.ts';
import { describe, expect, it } from 'vitest';
import { createTestGroup } from '../../../../create-test-group.ts';

import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { readRoomTimeline } from '@shared/api/group-deadlines/room-timeline.ts';
import { decodeViewInvalidationMessage } from '@shared/api/views/view-invalidation.ts';
import {
    commitMutation,
    createRetentionDatabaseFixture,
    requireMutationWrite,
    RETENTION_REF,
    retryMutation,
    seedRetentionRoom
} from '../retention/group-retention-database-fixture.ts';

describe('automatic timeline deadline publication', () => {
    const clock = {
        name: 'game',
        phase: 'warmup',
        startedAtRevision: 1,
        startedAtEpochMs: 100,
        startedBy: 'director',
        revision: 1,
        status: 'running',
        endsAtEpochMs: 200,
        successor: { phase: 'play', durationMs: 400 }
    };
    const group = createTestGroup({ kind: 'room', metadata: { [ROOM_CLOCKS_METADATA_KEY]: [clock] } });
    const input = { before: null, after: group, createdAtEpochMs: 100, serviceId: 'api', traceId: 'start' };

    it('persists a wake for the revised deadline, suppressing unchanged and paused clocks', () => {
        const original = computeRoomTimelineDeadlines(input);
        expect(original.map((row) => Number(row.entry.dequeueAudit.nextTs?.epochMilliseconds))).toEqual([200]);
        expect(computeRoomTimelineDeadlines({ ...input, before: group })).toEqual([]);
        // The original delivery may already have settled as obsolete while the room was archived.
        const reactivated = computeRoomTimelineDeadlines({
            ...input,
            before: { ...group, status: 'archived', archived: group.updated, deleted: null },
            after: { ...group, snapshotVersion: group.snapshotVersion + 2 }
        });
        expect(reactivated[0].entry.key).not.toEqual(original[0].entry.key);
        const revised = { ...group, metadata: { [ROOM_CLOCKS_METADATA_KEY]: [{ ...clock, revision: 2, endsAtEpochMs: 400 }] } };
        const extended = computeRoomTimelineDeadlines({ ...input, before: group, after: revised });
        expect(extended.map((row) => Number(row.entry.dequeueAudit.nextTs?.epochMilliseconds))).toEqual([400]);
        expect(extended[0].entry.key).not.toEqual(original[0].entry.key);
        const { endsAtEpochMs, ...rest } = clock;
        const paused = {
            ...group,
            metadata: { [ROOM_CLOCKS_METADATA_KEY]: [{ ...rest, revision: 3, status: 'paused', pausedAtEpochMs: 125, remainingMs: endsAtEpochMs - 125 }] }
        };
        expect(computeRoomTimelineDeadlines({ ...input, before: revised, after: paused })).toEqual([]);
    });
});

it('fences obsolete deliveries and commits one scheduled occurrence and one private notice for competing workers', async () => {
    const fixture = await createRetentionDatabaseFixture();
    try {
        await seedRetentionRoom(fixture);
        const group = (await fixture.repository.findGroupEntry(RETENTION_REF))!.value;
        const boundary = fixture.nowEpochMs + 1000;
        const predecessor = {
            name: 'game',
            phase: 'warmup',
            revision: 2,
            startedAtRevision: 1,
            status: 'running',
            startedBy: 'director',
            startedAtEpochMs: boundary - 1000,
            endsAtEpochMs: boundary,
            successor: { phase: 'play', durationMs: 30000 }
        };
        await fixture.repository.putGroup({ ...group, metadata: { [ROOM_CLOCKS_METADATA_KEY]: [predecessor] } });
        const fence = {
            roomRef: RETENTION_REF,
            publishedAtGroupRevision: group.snapshotVersion,
            name: predecessor.name,
            revision: predecessor.revision,
            groupCreatedAtEpochMs: group.created.atEpochMs,
            dueAtEpochMs: boundary
        };
        fixture.nowEpochMs = boundary + 2000;
        for (const stale of [{ ...fence, revision: 1 }, { ...fence, groupCreatedAtEpochMs: 0 }, { ...fence, dueAtEpochMs: boundary - 100 }]) {
            const ingress = await fixture.mutations.captureTimelineDeadlineMutationIngress(toTimelineSettlementCommand(stale), fixture.nowEpochMs);
            const mutation = await retryMutation(fixture, ingress);
            if (mutation.outcome === 'write') {
                await commitMutation(fixture, mutation);
            }
            const stored = (await fixture.repository.findGroupEntry(RETENTION_REF))!.value;
            expect(readRoomTimeline(stored.metadata, 'game')).toEqual(predecessor);
        }
        const ingress = await fixture.mutations.captureTimelineDeadlineMutationIngress(toTimelineSettlementCommand(fence), boundary);
        const storedBeforeSettlement = (await fixture.repository.findGroupEntry(RETENTION_REF))!.value;
        for (const expiresAtEpochMs of [boundary - 1, boundary + 100]) {
            await fixture.repository.putGroup({ ...storedBeforeSettlement, expiresAtEpochMs });
            expect((await retryMutation(fixture, ingress)).outcome).toBe('no-op');
        }
        await fixture.repository.putGroup({ ...storedBeforeSettlement, expiresAtEpochMs: boundary + 5000 });
        const candidates = await Promise.all([retryMutation(fixture, ingress), retryMutation(fixture, ingress)]);
        const winner = requireMutationWrite(candidates[0]);
        expect(winner.event?.occurredAtEpochMs).toBe(fixture.nowEpochMs);
        const notices = winner.outboxWrites.map((row) => decodePersistedALMessage(row.entry.resource))
            .filter((message) => message.payload.typeId === AppTopics.viewInvalidated);
        expect(notices.map(message => message.id.ts)).toEqual([fixture.nowEpochMs]);
        expect(notices.map(decodeViewInvalidationMessage)).toMatchObject([{ resource: 'room-program', name: 'game', principalId: 'owner' }]);
        await commitMutation(fixture, winner);
        await expect(commitMutation(fixture, requireMutationWrite(candidates[1]))).rejects.toThrow();
        expect((await retryMutation(fixture, ingress)).outcome).toBe('replay');
        const current = (await fixture.repository.findGroupEntry(RETENTION_REF))!.value;
        expect(readRoomTimeline(current.metadata, 'game')).toEqual({
            name: 'game',
            phase: 'play',
            revision: 3,
            startedAtRevision: 3,
            startedBy: 'automatic',
            status: 'running',
            startedAtEpochMs: boundary,
            endsAtEpochMs: boundary + 30000,
            successor: null
        });
        await fixture.repository.removeGroup(RETENTION_REF);
        const obsolete = await fixture.mutations.captureTimelineDeadlineMutationIngress(
            toTimelineSettlementCommand({ ...fence, publishedAtGroupRevision: fence.publishedAtGroupRevision + 10 }),
            fixture.nowEpochMs
        );
        expect(await retryMutation(fixture, obsolete)).toMatchObject({ outcome: 'rejected', rejectionCode: 'group-mutation-rejected' });
    }
    finally {
        await fixture.storage.close();
    }
});
