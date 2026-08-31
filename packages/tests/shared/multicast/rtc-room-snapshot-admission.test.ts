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
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { planRtcRoomSnapshotAdmission } from '@shared/multicast/rtc-room-snapshot-admission.ts';

import { createTestGroup } from '../../create-test-group.ts';

const roomRef: GroupRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const route = { topicId: 'room.messages', contextId: 'room', resourceId: 'probe' };

describe('RTC room snapshot admission', () => {
    it('does not turn terminal expiry or duplicate rejection into a snapshot retry', () => {
        const message = createRoomMessage('multicast', 5);
        const expiredMessage = { ...message, constraints: { expiresAtMs: 10 } };
        const expiredPlan = planALMessageHandling(expiredMessage, { selfPeerId: 'receiver', fromPeerId: 'sender', nowMs: 100 });
        const duplicatePlan = planALMessageHandling(message, {
            selfPeerId: 'receiver',
            fromPeerId: 'sender',
            seenDedupKeys: new Set([message.id.msgId])
        });
        const expired = planRtcRoomSnapshotAdmission({
            message: expiredMessage,
            plan: expiredPlan,
            snapshot: undefined,
            fromPeerId: 'sender',
            nowMs: 100
        });
        const duplicate = planRtcRoomSnapshotAdmission({
            message,
            plan: duplicatePlan,
            snapshot: undefined,
            fromPeerId: 'sender',
            nowMs: 100
        });
        expect(expired.nack.reason).toBe('expired');
        expect(duplicate.nack.enabled).toBe(false);
        expect(duplicate.localDelivery.enabled).toBe(false);
        expect(duplicate.forwarding.enabled).toBe(false);
    });

    it.each(['multicast', 'broadcast'] as const)('rejects a %s against missing, old, expired, or wrong-scope snapshots', (mode) => {
        const message = createRoomMessage(mode, 5);
        const plan = createHandlingPlan(message);
        const current = createSnapshot(5);
        const invalidSnapshots = [
            undefined,
            createSnapshot(4),
            { ...current, group: { ...current.group, applicationId: 'other-app' } },
            { ...current, group: { ...current.group, workspaceId: 'other-workspace' } },
            { ...current, group: { ...current.group, groupId: 'other-room' } },
            { ...current, group: { ...current.group, expiresAtEpochMs: 100 } }
        ];
        for (const snapshot of invalidSnapshots) {
            const rejected = planRtcRoomSnapshotAdmission({ message, plan, snapshot, fromPeerId: 'sender', nowMs: 100 });
            expect(rejected.dropReason).toBe('not-yet-in-sync');
            expect(rejected.localDelivery).toEqual({ enabled: false, persist: false, deferred: false });
            expect(rejected.forwarding).toEqual({ enabled: false, persist: false, nextHopPeerIds: [] });
            expect(rejected.ack.enabled).toBe(false);
            expect(rejected.repair.enabled).toBe(false);
            expect(rejected.nack).toEqual({
                enabled: true,
                toPeerId: 'sender',
                reason: 'not-yet-in-sync',
                missingSeqs: []
            });
        }
    });

    it.each(['multicast', 'broadcast'] as const)('preserves valid %s delivery and forwarding at equal or newer versions', (mode) => {
        const message = createRoomMessage(mode, 5);
        const plan = createHandlingPlan(message);
        for (const version of [5, 6]) {
            const admitted = planRtcRoomSnapshotAdmission({
                message,
                plan,
                snapshot: createSnapshot(version),
                fromPeerId: 'sender',
                nowMs: 100
            });
            expect(admitted.dropReason).toBeUndefined();
            expect(admitted.localDelivery.enabled).toBe(true);
            expect(admitted.forwarding.nextHopPeerIds).toEqual(['downstream']);
            expect(admitted.nack.enabled).toBe(false);
        }
    });

    it('does not require a snapshot for unversioned room messages or originating plans', () => {
        const unversioned = createRoomMessage('multicast', undefined);
        const versioned = createRoomMessage('multicast', 5);
        expect(
            planRtcRoomSnapshotAdmission({
                message: unversioned,
                plan: createHandlingPlan(unversioned),
                snapshot: undefined,
                fromPeerId: 'sender',
                nowMs: 100
            }).localDelivery.enabled
        ).toBe(true);
        expect(
            planRtcRoomSnapshotAdmission({
                message: versioned,
                plan: createHandlingPlan(versioned),
                snapshot: undefined,
                fromPeerId: undefined,
                nowMs: 100
            }).forwarding.nextHopPeerIds
        ).toEqual(['downstream']);
    });

    it('fails closed for a versioned room broadcast without a scoped identity', () => {
        const message = newALBroadcastMessage('sender', route, 'room', 'probe.v1', {}, { minSnapshotVersion: 5 });
        const plan = createHandlingPlan(message);
        expect(
            planRtcRoomSnapshotAdmission({ message, plan, snapshot: createSnapshot(6), fromPeerId: 'sender', nowMs: 100 })
                .dropReason
        ).toBe('not-yet-in-sync');
    });
});

function createRoomMessage(mode: 'multicast' | 'broadcast', minSnapshotVersion: number | undefined): ALMessage {
    return mode === 'multicast'
        ? newALMulticastMessage('sender', route, roomRef, 'probe.v1', {}, { minSnapshotVersion })
        : newALBroadcastMessage('sender', route, 'room', 'probe.v1', {}, { groupRef: roomRef, minSnapshotVersion });
}

function createHandlingPlan(message: ALMessage) {
    return planALMessageHandling(message, {
        selfPeerId: 'receiver',
        fromPeerId: 'sender',
        groupMemberPeerIds: ['sender', 'receiver', 'downstream'],
        connectedPeerIds: ['sender', 'downstream'],
        overlayNeighborPeerIds: ['downstream']
    });
}

function createSnapshot(snapshotVersion: number): GroupSnapshot {
    return {
        group: createTestGroup({ ...roomRef, snapshotVersion }),
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        members: [],
        activeSessions: [],
        memberCount: 0,
        onlineMemberCount: 0
    };
}
