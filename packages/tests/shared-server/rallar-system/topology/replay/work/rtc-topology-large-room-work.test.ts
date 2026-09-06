import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import {
    computeCoalescedRtcTopologyGroupRevisionWork,
    type RtcTopologyCoalescedGroupRevisionInput
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import { readRtcTopologyWorkEnvelope } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-work-codec.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { AuditStamp, GroupSnapshot } from '@shared/api/group-types.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    isCanonicalRtcTopologyWorkEntry,
    readRtcTopologyWorkEntry,
    readRtcTopologyWorkMessage
} from '@shared/queuebox/rtc-topology-work-entry-contract.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { createTestGroup } from '../../../../../create-test-group.ts';

const GROUP_REF = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' } as const;
const CREATED_AT_MS = 1_800_000_000_000;
const EXPIRES_AT_MS = CREATED_AT_MS + 3_600_000;

describe('durable topology work for large rooms', () => {
    it.each([EntityStatus.RETRY, EntityStatus.COMPLETED])(
        'coalesces a 1500-member %s snapshot across servers while preserving its durable identity',
        (status) => {
            const first = computeCoalescedRtcTopologyGroupRevisionWork(createWorkInput(null));
            const previous = { ...first.entryWrite.entry, status };
            const next = computeCoalescedRtcTopologyGroupRevisionWork({
                ...createWorkInput(previous),
                senderId: 'server-2',
                requestedAtEpochMs: CREATED_AT_MS + 200,
                expireAtEpochMs: EXPIRES_AT_MS + 200
            }).entryWrite.entry;

            expect(next.audit).toEqual(previous.audit);
            expect(isCanonicalRtcTopologyWorkEntry(next)).toBe(true);
            const message: ALMessage = JSON.parse(next.resource);
            expect(message.id.ts).toBe(CREATED_AT_MS);
            expect(message.id.senderId).toBe('server-1');
            expect(message.constraints?.expiresAtMs).toBe(EXPIRES_AT_MS);
            expect(decodeALMessage(next.resource).left?.code).toBe('oversized');
        }
    );

    it('replays a large internal snapshot without treating it as a network packet', () => {
        const entry = computeCoalescedRtcTopologyGroupRevisionWork(createWorkInput(null)).entryWrite.entry;
        const message: ALMessage = JSON.parse(entry.resource);
        const work = readRtcTopologyWorkEnvelope(message, AppOutboxType.RTC_TOPOLOGY_RECOMPUTE);

        expect(work.data.groupSnapshot.memberCount).toBe(1500);
        expect(work.data.groupSnapshot.activeSessions.at(-1)?.principalId).toBe('member-1499');
        expect(isCanonicalRtcTopologyWorkEntry({ ...entry, status: EntityStatus.COMPLETED })).toBe(true);
    });

    it('dispatches large work through the existing outbox queue and completes the reservation', async () => {
        const input = createWorkInput(null);
        const entry = computeCoalescedRtcTopologyGroupRevisionWork({
            ...input,
            timing: { ...input.timing, window: { debounceMs: 0, maxWaitMs: 0 } }
        }).entryWrite.entry;
        const queue = new InMemoryQueueBox();
        const reader = new OutboxQueueReader(queue);
        const deliveredSnapshots: GroupSnapshot[] = [];
        reader.onOutboxMessageDo(AppOutboxType.RTC_TOPOLOGY_RECOMPUTE, {
            onMessage: async (message) => {
                const work = readRtcTopologyWorkEnvelope(message, AppOutboxType.RTC_TOPOLOGY_RECOMPUTE);
                deliveredSnapshots.push(work.data.groupSnapshot);
            }
        });
        await queue.enqueueIfAbsent(entry);
        const duration = Temporal.Duration.from({ seconds: 10 });
        await reader.dequeueOutbox(
            OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
            ResilienceDto.toResilienceDto(
                new CircuitBreakerPolicy(10, duration, duration, duration),
                1,
                10,
                1,
                1
            )
        );

        expect(deliveredSnapshots.map((snapshot) => snapshot.memberCount)).toEqual([1500]);
        expect((await queue.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
    });

    it('rejects wrong queue ownership, route, payload type and audit without relaxing wire decoding', () => {
        const entry = computeCoalescedRtcTopologyGroupRevisionWork(createWorkInput(null)).entryWrite.entry;
        const message = readRtcTopologyWorkEntry(entry);
        expect(() => readRtcTopologyWorkEntry({ ...entry, typeId: EnqueuedType.APP_INBOX })).toThrow(/queue identity/);
        expect(() => readRtcTopologyWorkEntry({ ...entry, key: { ...entry.key, resourceId: 'wrong-slot' } })).toThrow(/identity/);
        expect(() => readRtcTopologyWorkEntry({ ...entry, audit: { ...entry.audit, createdBy: 'other-server' } })).toThrow(/identity/);
        expect(() => readRtcTopologyWorkMessage({ ...message, payload: { ...message.payload, typeId: 'ordinary-message' } }))
            .toThrow(/scope/);
        expect(() => readRtcTopologyWorkMessage({ ...message, route: { ...message.route, topicId: 'ordinary-topic' } }))
            .toThrow(/scope/);
        expect(decodeALMessage(entry.resource).left?.code).toBe('oversized');
    });

    it('keeps internal payload and serialized-entry byte limits finite', () => {
        const entry = computeCoalescedRtcTopologyGroupRevisionWork(createWorkInput(null)).entryWrite.entry;
        const message = readRtcTopologyWorkEntry(entry);
        expect(() =>
            readRtcTopologyWorkMessage({
                ...message,
                payload: { ...message.payload, resource: JSON.stringify('x'.repeat(16 * 1024 * 1024)) }
            })
        ).toThrow(/payload exceeds/);
        expect(() => readRtcTopologyWorkEntry({ ...entry, resource: ' '.repeat(32 * 1024 * 1024 + 1) }))
            .toThrow(/envelope exceeds/);
    });
});

function createWorkInput(previousEntry: ResourceEntry | null): RtcTopologyCoalescedGroupRevisionInput {
    return {
        aggregateRef: GROUP_REF,
        groupSnapshot: createLargeGroupSnapshot(),
        requestedAtEpochMs: CREATED_AT_MS,
        expireAtEpochMs: EXPIRES_AT_MS,
        timing: { window: { debounceMs: 500, maxWaitMs: 2000 }, replanNotBeforeEpochMs: null },
        senderId: 'server-1',
        origin: 'automatic',
        previousEntry
    };
}

function createLargeGroupSnapshot(): GroupSnapshot {
    const audit: AuditStamp = {
        atEpochMs: CREATED_AT_MS,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
    const principalIds = Array.from({ length: 1500 }, (_, index) => `member-${index}`);
    return {
        causalRevision: { groupRevision: 4, presenceRevision: 3 },
        group: createTestGroup({
            ...GROUP_REF,
            ownerPrincipalId: 'member-0',
            activeMemberCount: 1500,
            formationElectorate: principalIds,
            snapshotVersion: 4,
            metadataVersion: 4,
            rosterVersion: 4,
            presenceVersion: 3,
            created: audit,
            updated: audit
        }),
        members: createMembers(principalIds, audit),
        activeSessions: createActiveSessions(principalIds),
        memberCount: 1500,
        onlineMemberCount: 1500
    };
}

function createMembers(principalIds: readonly string[], audit: AuditStamp): GroupSnapshot['members'] {
    return principalIds.map((principalId, index) => ({
        ...GROUP_REF,
        principalId,
        role: index === 0 ? 'owner' : 'member',
        status: 'active',
        joined: audit,
        updated: audit,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null
    }));
}

function createActiveSessions(principalIds: readonly string[]): GroupSnapshot['activeSessions'] {
    return principalIds.map((principalId) => ({
        ...GROUP_REF,
        principalId,
        sessionId: `session-${principalId}`,
        generationId: `generation-${principalId}`,
        generationVersion: 1,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null,
        connectedAtEpochMs: CREATED_AT_MS,
        lastHeartbeatAtEpochMs: CREATED_AT_MS,
        expiresAtEpochMs: EXPIRES_AT_MS
    }));
}
