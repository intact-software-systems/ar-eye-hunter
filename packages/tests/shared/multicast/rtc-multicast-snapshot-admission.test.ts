import {
    describe,
    expect,
    it
} from 'vitest';

import {
    newALBroadcastMessage,
    newALMulticastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { createDefaultALOutboundRuntimeResources } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/Resilience.ts';

import { createGroupSnapshotFixture } from '../../shared-web/authoritative-group-fixtures.ts';

const roomRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };

describe('RTC multicast snapshot admission at the cache boundary', () => {
    it.each(['multicast', 'broadcast'] as const)('rejects %s before a matching snapshot arrives', (mode) => {
        const manager = createDefaultSnapshotAdmissionManager(new LatestRepository());

        const plan = manager.planIncomingMessage(createRoomMessage(mode), 'peer-1');

        expect(plan.dropReason).toBe('not-yet-in-sync');
        expect(plan.localDelivery.enabled).toBe(false);
        expect(plan.forwarding.nextHopPeerIds).toEqual([]);
        expect(plan.ack.enabled).toBe(false);
        expect(plan.repair.enabled).toBe(false);
        expect(plan.nack).toMatchObject({ enabled: true, toPeerId: 'peer-1', reason: 'not-yet-in-sync' });
        manager.dispose();
    });

    it('replans the same inbound message after the exact snapshot catches up', () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const manager = createDefaultSnapshotAdmissionManager(groupCache);
        const message = createRoomMessage('multicast');
        const stale = createSnapshot();
        groupCache.accept('room-1', { ...stale, group: { ...stale.group, snapshotVersion: 1 } });

        expect(manager.planIncomingMessage(message, 'peer-1').dropReason).toBe('not-yet-in-sync');
        groupCache.accept('room-1', createSnapshot());

        const admitted = manager.planIncomingMessage(message, 'peer-1');
        expect(admitted.dropReason).toBeUndefined();
        expect(admitted.localDelivery.enabled).toBe(true);
        expect(admitted.nack.enabled).toBe(false);
        manager.dispose();
    });

    it.each(
        [
            { mode: 'multicast', deliversToNonmember: false },
            { mode: 'broadcast', deliversToNonmember: true }
        ] as const
    )('uses a current scoped snapshot without an overlay for $mode', ({ mode, deliversToNonmember }) => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        groupCache.accept('not-an-overlay-key', createSnapshot());
        const manager = createDefaultSnapshotAdmissionManager(groupCache);

        const plan = manager.planIncomingMessage(createRoomMessage(mode), 'peer-1');

        expect(plan.dropReason).toBeUndefined();
        expect(plan.localDelivery.enabled).toBe(true);
        const snapshot = createSnapshot();
        groupCache.accept('not-an-overlay-key', {
            ...snapshot,
            activeSessions: snapshot.activeSessions.filter((session) => session.sessionId !== 'self'),
            onlineMemberCount: 2
        });
        expect(manager.planIncomingMessage(createRoomMessage(mode), 'peer-1').localDelivery.enabled).toBe(deliversToNonmember);
        manager.dispose();
    });

    it('does not substitute another workspace snapshot sharing the room id', () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const wrongScope = createSnapshot();
        groupCache.accept('room-1', {
            ...wrongScope,
            group: { ...wrongScope.group, workspaceId: 'workspace-other' }
        });
        const manager = createDefaultSnapshotAdmissionManager(groupCache);

        expect(manager.planIncomingMessage(createRoomMessage('multicast'), 'peer-1').dropReason).toBe('not-yet-in-sync');
        manager.dispose();
    });

    it('does not forward a current room broadcast through an explicitly foreign overlay', () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const current = createSnapshot();
        const foreign: GroupSnapshot = { ...current, group: { ...current.group, workspaceId: 'workspace-other' } };
        groupCache.accept('room-1', current);
        groupCache.accept('foreign-overlay', foreign);
        const overlayCache = new LatestRepository<string, OverlayInfo>();
        overlayCache.accept('foreign-overlay', {
            sourceGroupStateCausalRevision: foreign.causalRevision,
            provenance: 'server',
            state: 'active',
            overlayId: 'foreign-overlay',
            groupRef: foreign.group,
            topology: 'tree',
            name: 'Other workspace',
            createdByClientId: 'owner',
            createdAtEpochMs: 1,
            nextHopSessionIds: ['peer-2'],
            degreeLimit: 1,
            overlayVersion: 1,
            updatedAtEpochMs: 1
        });
        const manager = createDefaultSnapshotAdmissionManager(groupCache, overlayCache);
        const message: ALMessage = { ...createRoomMessage('broadcast'), forwarding: { overlayId: 'foreign-overlay' } };

        const plan = manager.planIncomingMessage(message, 'peer-1');

        expect(plan.dropReason).toBeUndefined();
        expect(plan.localDelivery.enabled).toBe(true);
        expect(plan.forwarding).toMatchObject({ enabled: false, nextHopPeerIds: [] });
        manager.dispose();
    });

    it('does not revive an expired cache observation through peek', () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        groupCache.acceptAt({ key: 'room-1', value: createSnapshot(), nowEpochMs: 1, expireAtEpochMs: 2 });
        const manager = createDefaultSnapshotAdmissionManager(groupCache);

        expect(manager.planIncomingMessage(createRoomMessage('multicast'), 'peer-1').dropReason).toBe('not-yet-in-sync');
        manager.dispose();
    });

    it.each([
        { expiresAtEpochMs: 1_001, dropReason: undefined },
        { expiresAtEpochMs: 1_000, dropReason: 'not-yet-in-sync' },
        { expiresAtEpochMs: 999, dropReason: 'not-yet-in-sync' }
    ])('uses the outbound clock for snapshot expiry at $expiresAtEpochMs', ({ expiresAtEpochMs, dropReason }) => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const snapshot = createSnapshot();
        groupCache.accept('room-1', { ...snapshot, group: { ...snapshot.group, expiresAtEpochMs } });
        const manager = createDefaultSnapshotAdmissionManager(groupCache);

        expect(manager.planIncomingMessage(createRoomMessage('multicast'), 'peer-1').dropReason).toBe(dropReason);
        manager.dispose();
    });

    it('keeps unversioned and originating plans independent of inbound snapshot admission', () => {
        const manager = createDefaultSnapshotAdmissionManager(new LatestRepository());
        const versioned = createRoomMessage('multicast');
        const unversioned: ALMessage = { ...versioned, targets: { mode: 'multicast', groupRef: roomRef } };

        expect(manager.planIncomingMessage(unversioned, 'peer-1').dropReason).toBeUndefined();
        expect(manager.planIncomingMessage(versioned).dropReason).toBeUndefined();
        manager.dispose();
    });
});

function createDefaultSnapshotAdmissionManager(
    groupCache: LatestRepository<string, GroupSnapshot>,
    overlayCache = new LatestRepository<string, OverlayInfo>()
): WebRtcOverlayMulticastManager {
    return new WebRtcOverlayMulticastManager({
        outbox: new InMemoryQueueBox(new Map()),
        connectionService: {
            input: { sessionId: 'self' },
            readyPeerIdsForLane: () => ['peer-1', 'peer-2', 'outsider'],
            readPeer: () => undefined
        },
        groupCache,
        overlayCache,
        multicasterFactory: () => {
            throw new Error('Admission does not construct an outbound multicaster');
        },
        qosProvider: undefined,
        outboundDiagnostics: undefined,
        outboundRuntime: createDefaultALOutboundRuntimeResources({ nowMs: () => 1_000 }),
        circuitBreaker: toCircuitBreaker(),
        rateLimiter: toRateLimiter()
    });
}

function createRoomMessage(mode: 'multicast' | 'broadcast'): ALMessage {
    const route = { topicId: 'chat', contextId: 'room-1', resourceId: 'rtc-message' };
    if (mode === 'multicast') {
        return newALMulticastMessage('peer-1', route, roomRef, 'chat.message', { text: 'hello' }, { minSnapshotVersion: 2 });
    }
    return newALBroadcastMessage('peer-1', route, 'room', 'chat.message', { text: 'hello' }, {
        groupRef: roomRef,
        minSnapshotVersion: 2
    });
}

function createSnapshot(): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({ ...roomRef, sessionIds: ['self', 'peer-1', 'peer-2'] });
    return { ...snapshot, group: { ...snapshot.group, snapshotVersion: 2 } };
}
