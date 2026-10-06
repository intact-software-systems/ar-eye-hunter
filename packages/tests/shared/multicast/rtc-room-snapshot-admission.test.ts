import {
    describe,
    expect,
    it
} from 'vitest';

import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
    computeRtcRoomSnapshotAdmission,
    toRtcRoomSnapshotHandlingPlan
} from '@shared/multicast/rtc-room-snapshot-admission.ts';

import { createGroupSnapshotFixture } from '../../shared-web/authoritative-group-fixtures.ts';

const roomRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const message = newALMulticastMessage('origin', { topicId: 'room.chat', contextId: 'room', resourceId: 'message' }, roomRef, 'chat.v1', {});
const nowMs = 100;

function snapshot(): GroupSnapshot {
    return createGroupSnapshotFixture({ ...roomRef, sessionIds: ['origin', 'relay', 'receiver', 'downstream'] });
}

function overlay(): OverlayInfo {
    return {
        overlayId: 'room',
        groupRef: roomRef,
        provenance: 'server',
        state: 'active',
        topology: 'tree',
        name: 'Room',
        sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 1 },
        nextHopSessionIds: ['relay', 'downstream'],
        degreeLimit: 2,
        overlayVersion: 1,
        createdByClientId: 'owner',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1
    };
}

describe('RTC room authority', () => {
    it('requires evidence for no-floor messages, then permits an active direct room recipient without topology', () => {
        const input = { message, selfPeerId: 'receiver', fromPeerId: 'origin', recipientPeerId: undefined, nowMs, overlay: undefined };
        expect(computeRtcRoomSnapshotAdmission({ ...input, snapshot: undefined }).kind).toBe('pending');
        expect(computeRtcRoomSnapshotAdmission({ ...input, snapshot: snapshot() }).kind).toBe('authorized');
    });

    it('authorizes a different immediate relay only from a matching active server topology', () => {
        const input = { message, selfPeerId: 'receiver', fromPeerId: 'relay', recipientPeerId: undefined, nowMs, snapshot: snapshot() };
        expect(computeRtcRoomSnapshotAdmission({ ...input, overlay: overlay() }).kind).toBe('authorized');
        expect(computeRtcRoomSnapshotAdmission({ ...input, overlay: undefined }).kind).toBe('pending');
        expect(computeRtcRoomSnapshotAdmission({ ...input, overlay: { ...overlay(), provenance: 'bootstrap' } }).kind).toBe('pending');
        expect(computeRtcRoomSnapshotAdmission({ ...input, overlay: { ...overlay(), nextHopSessionIds: ['downstream'] } }).kind).toBe('unauthorized');
        expect(computeRtcRoomSnapshotAdmission({ ...input, overlay: { ...overlay(), state: 'removed' } }).kind).toBe('unauthorized');
    });

    it('checks room scope and expiry before snapshot catch-up', () => {
        const current = snapshot();
        const versioned = { ...message, targets: { mode: 'multicast' as const, groupRef: roomRef, minSnapshotVersion: current.group.snapshotVersion + 1 } };
        const input = { message: versioned, selfPeerId: 'receiver', fromPeerId: 'origin', recipientPeerId: undefined, overlay: undefined, nowMs };
        expect(computeRtcRoomSnapshotAdmission({ ...input, snapshot: current }).kind).toBe('pending');
        expect(computeRtcRoomSnapshotAdmission({ ...input, snapshot: { ...current, group: { ...current.group, workspaceId: 'other' } } }).kind).toBe(
            'unauthorized'
        );
        expect(computeRtcRoomSnapshotAdmission({ ...input, snapshot: { ...current, group: { ...current.group, expiresAtEpochMs: nowMs } } }).kind).toBe(
            'unauthorized'
        );
    });

    it('rejects an expired session or inactive member even while a stale session row remains', () => {
        const current = snapshot();
        const input = { message, selfPeerId: 'receiver', fromPeerId: 'origin', recipientPeerId: undefined, overlay: undefined, nowMs };
        const expired = {
            ...current,
            activeSessions: current.activeSessions.map((session) => session.sessionId === 'origin' ? { ...session, expiresAtEpochMs: nowMs } : session)
        };
        expect(computeRtcRoomSnapshotAdmission({ ...input, snapshot: expired }).kind).toBe('unauthorized');
        const originSession = current.activeSessions.find((session) => session.sessionId === 'origin');
        if (!originSession) {
            throw new Error('The authority fixture must contain the original sender session');
        }
        const originPrincipal = originSession.principalId;
        const left = {
            ...current,
            members: current.members.map((member) =>
                member.principalId === originPrincipal && member.status === 'active' ? { ...member, status: 'left' as const, left: member.updated } : member
            )
        };
        expect(computeRtcRoomSnapshotAdmission({ ...input, snapshot: left })).toMatchObject({ kind: 'unauthorized', cause: 'membership-fenced' });
        expect(computeRtcRoomSnapshotAdmission({ ...input, snapshot: { ...current, members: [], activeSessions: [] } }).kind).toBe('pending');
    });

    it('identifies only a current missing server edge as unavailable while retaining unauthorized admission', () => {
        const current = snapshot();
        const input = {
            message,
            selfPeerId: 'origin',
            fromPeerId: undefined,
            recipientPeerId: 'receiver',
            nowMs,
            snapshot: current,
            overlay: overlay()
        };
        expect(computeRtcRoomSnapshotAdmission(input)).toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
        for (
            const rejectedOverlay of [
                { ...overlay(), state: 'removed' as const },
                { ...overlay(), groupRef: { ...roomRef, workspaceId: 'foreign' } }
            ]
        ) {
            expect(computeRtcRoomSnapshotAdmission({ ...input, overlay: rejectedOverlay })).toMatchObject({
                kind: 'unauthorized',
                cause: 'authority-rejected'
            });
        }
        const expired = {
            ...current,
            activeSessions: current.activeSessions.map((session) => session.sessionId === 'origin' ? { ...session, expiresAtEpochMs: nowMs } : session)
        };
        expect(computeRtcRoomSnapshotAdmission({ ...input, snapshot: expired })).toMatchObject({
            kind: 'unauthorized',
            cause: 'authority-rejected'
        });
        expect(computeRtcRoomSnapshotAdmission({ ...input, overlay: undefined }).kind).toBe('pending');
        expect(computeRtcRoomSnapshotAdmission({ ...input, overlay: { ...overlay(), provenance: 'bootstrap' } }).kind).toBe('pending');
    });

    it('plans a frozen authority observation without changing it', () => {
        const current = snapshot();
        const input = { message, selfPeerId: 'receiver', fromPeerId: 'relay', recipientPeerId: undefined, overlay: overlay(), nowMs, snapshot: current };
        freezeRoomObservation(input);
        const before = JSON.stringify(input);
        const admitted = computeRtcRoomSnapshotAdmission(input);
        expect(admitted.kind).toBe('authorized');
        expect(computeRtcRoomSnapshotAdmission(input)).toEqual(admitted);
        expect(JSON.stringify(input)).toBe(before);
    });

    it('forwards a frozen copy over the current tree but delivers it only inside the frozen audience', () => {
        const frozen = {
            ...message,
            targets: { mode: 'multicast' as const, groupRef: roomRef, recipientPeerIds: ['receiver'], snapshotVersion: 1 }
        };
        const input = { message: frozen, selfPeerId: 'relay', fromPeerId: 'origin', recipientPeerId: undefined, overlay: overlay(), nowMs };
        const admission = computeRtcRoomSnapshotAdmission({ ...input, snapshot: snapshot() });
        if (admission.kind !== 'authorized') {
            throw new Error('A frozen copy from the origin must be authorized in the room');
        }
        const plan = toRtcRoomSnapshotHandlingPlan(
            planALMessageHandling(frozen, {
                nowMs,
                selfPeerId: 'relay',
                fromPeerId: 'origin',
                connectedPeerIds: ['origin', 'receiver', 'downstream'],
                groupMemberPeerIds: admission.memberPeerIds,
                overlayNeighborPeerIds: admission.forwardingPeerIds
            }),
            admission,
            'origin'
        );

        // `relay` joined after the freeze: it is a hop of the current tree, never a logical recipient.
        expect(admission.memberPeerIds).toEqual(['origin', 'relay', 'receiver', 'downstream']);
        expect(admission.deliversLocally).toBe(false);
        expect(plan.localDelivery.enabled).toBe(false);
        expect(plan.forwarding.nextHopPeerIds).toEqual(['downstream']);
    });

    it('requires recipient membership and a permitted outgoing edge independent of diagnostics', () => {
        const input = {
            message,
            selfPeerId: 'receiver',
            fromPeerId: undefined,
            recipientPeerId: 'downstream',
            nowMs,
            snapshot: snapshot(),
            overlay: overlay()
        };
        expect(computeRtcRoomSnapshotAdmission(input).kind).toBe('authorized');
        expect(computeRtcRoomSnapshotAdmission({ ...input, recipientPeerId: 'relay' }).kind).toBe('authorized');
        expect(computeRtcRoomSnapshotAdmission({ ...input, recipientPeerId: 'origin' }).kind).toBe('unauthorized');
        for (const visitedPeerIds of [[], ['receiver'], ['origin', 'relay', 'receiver']]) {
            expect(
                computeRtcRoomSnapshotAdmission({
                    ...input,
                    message: { ...message, diagnostics: { visitedPeerIds } },
                    overlay: { ...overlay(), state: 'removed' }
                }).kind
            ).toBe('unauthorized');
        }
    });
});

describe('the room roster fence at RTC ingress', () => {
    const receiverInput = { selfPeerId: 'receiver', fromPeerId: 'origin', recipientPeerId: undefined, overlay: undefined, nowMs };

    it('holds a copy whose stamped roster the receiver has not reached, after the snapshot floor', () => {
        const held = rosterSnapshot(1);
        expect(computeRtcRoomSnapshotAdmission({ ...receiverInput, message: stampedMessage(1, 2), snapshot: held })).toEqual({
            kind: 'pending',
            reason: 'Awaiting the required room roster version'
        });
        expect(computeRtcRoomSnapshotAdmission({ ...receiverInput, message: stampedMessage(2, 2), snapshot: held })).toEqual({
            kind: 'pending',
            reason: 'Awaiting the required room snapshot version'
        });
    });

    it('does not judge the sender on a roster behind its stamp', () => {
        expect(computeRtcRoomSnapshotAdmission({
            ...receiverInput,
            message: stampedMessage(1, 2),
            snapshot: withSenderMember(rosterSnapshot(1), 'left')
        })).toEqual({ kind: 'pending', reason: 'Awaiting the required room roster version' });
    });

    it.each([
        { label: 'at the stamp', held: 2 },
        { label: 'beyond the stamp', held: 3 }
    ])('fences a sender whose member is not active $label', ({ held }) => {
        expect(computeRtcRoomSnapshotAdmission({
            ...receiverInput,
            message: stampedMessage(2, 2),
            snapshot: withSenderMember(rosterSnapshot(held), 'removed')
        })).toEqual({
            kind: 'unauthorized',
            cause: 'membership-fenced',
            reason: 'Room sender is not an active member of the room roster'
        });
    });

    it('fences a sender with no live session in a roster beyond its stamp, as an authoritative snapshot shows a removal', () => {
        expect(computeRtcRoomSnapshotAdmission({
            ...receiverInput,
            message: stampedMessage(2, 2),
            snapshot: withoutSenderSession(withSenderMember(rosterSnapshot(3), 'removed'))
        })).toEqual({
            kind: 'unauthorized',
            cause: 'membership-fenced',
            reason: 'Room sender has no live session in a roster beyond its stamp'
        });
    });

    it('awaits presence for a sender with no session at its own stamp, whose member is still active', () => {
        expect(computeRtcRoomSnapshotAdmission({
            ...receiverInput,
            message: stampedMessage(2, 2),
            snapshot: withoutSenderSession(rosterSnapshot(2))
        })).toEqual({ kind: 'pending', reason: 'Awaiting room session authority' });
    });

    it('fences an unstamped sender with no active member and awaits one with no session', () => {
        const unstamped = { ...receiverInput, message };
        expect(computeRtcRoomSnapshotAdmission({ ...unstamped, snapshot: withSenderMember(snapshot(), 'absent') }))
            .toMatchObject({ kind: 'unauthorized', cause: 'membership-fenced' });
        expect(computeRtcRoomSnapshotAdmission({ ...unstamped, snapshot: withoutSenderSession(snapshot()) }))
            .toEqual({ kind: 'pending', reason: 'Awaiting room session authority' });
    });

    it('ranks a fenced sender above a pending receiver session', () => {
        const current = withSenderMember(rosterSnapshot(2), 'left');
        const withoutSelf = { ...current, activeSessions: current.activeSessions.filter((session) => session.sessionId !== 'receiver') };
        expect(computeRtcRoomSnapshotAdmission({ ...receiverInput, message: stampedMessage(2, 2), snapshot: withoutSelf }))
            .toMatchObject({ kind: 'unauthorized', cause: 'membership-fenced' });
    });

    it('keeps an expired sender session and a refused relay edge ahead of the roster floor', () => {
        const behind = rosterSnapshot(1);
        const expired = {
            ...behind,
            activeSessions: behind.activeSessions.map((session) => session.sessionId === 'origin' ? { ...session, expiresAtEpochMs: nowMs } : session)
        };
        expect(computeRtcRoomSnapshotAdmission({ ...receiverInput, message: stampedMessage(1, 2), snapshot: expired }))
            .toMatchObject({ kind: 'unauthorized', cause: 'authority-rejected' });
        expect(computeRtcRoomSnapshotAdmission({
            ...receiverInput,
            fromPeerId: 'relay',
            overlay: { ...overlay(), nextHopSessionIds: ['downstream'] },
            message: stampedMessage(1, 2),
            snapshot: behind
        })).toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
    });

    it('keeps the origin verdicts: no roster floor and an inactive own member is unauthorized', () => {
        const origin = { selfPeerId: 'origin', fromPeerId: undefined, recipientPeerId: undefined, overlay: undefined, nowMs };
        expect(computeRtcRoomSnapshotAdmission({ ...origin, message: stampedMessage(1, 2), snapshot: rosterSnapshot(1) }).kind)
            .toBe('authorized');
        expect(computeRtcRoomSnapshotAdmission({
            ...origin,
            message: stampedMessage(1, 1),
            snapshot: withSenderMember(rosterSnapshot(1), 'left')
        })).toMatchObject({ kind: 'unauthorized', cause: 'authority-rejected' });
    });

    it('plans a fenced refusal as membership-fenced with a NACK to the immediate hop', () => {
        const fenced = { kind: 'unauthorized', cause: 'membership-fenced', reason: 'Room sender is not an active member of the room roster' } as const;
        const base = planALMessageHandling(message, { nowMs, selfPeerId: 'receiver', fromPeerId: 'origin' });
        const plan = toRtcRoomSnapshotHandlingPlan(base, fenced, 'origin');
        expect(plan).toMatchObject({
            dropReasonCode: 'membership-fenced',
            dropReason: 'membership-fenced: Room sender is not an active member of the room roster',
            localDelivery: { enabled: false },
            forwarding: { enabled: false, nextHopPeerIds: [] },
            nack: { enabled: true, toPeerId: 'origin', reason: 'membership-fenced', missingRanges: [] }
        });
        expect(toRtcRoomSnapshotHandlingPlan(base, fenced, undefined).nack.enabled).toBe(false);
    });

    it('keeps every other refusal silent and unauthorized', () => {
        const base = planALMessageHandling(message, { nowMs, selfPeerId: 'receiver', fromPeerId: 'origin' });
        const plan = toRtcRoomSnapshotHandlingPlan(
            base,
            { kind: 'unauthorized', cause: 'authority-rejected', reason: 'Room authority is inactive or expired' },
            'origin'
        );
        expect(plan).toMatchObject({ dropReasonCode: 'unauthorized', dropReason: 'unauthorized', nack: { enabled: false } });
    });
});

function stampedMessage(minSnapshotVersion: number, rosterVersion: number) {
    return newALMulticastMessage('origin', { topicId: 'room.chat', contextId: 'room', resourceId: 'message' }, roomRef, 'chat.v1', {}, {
        minSnapshotVersion,
        rosterVersion
    });
}

/** Within one group incarnation every roster change is also a snapshot change. */
function rosterSnapshot(rosterVersion: number): GroupSnapshot {
    const current = snapshot();
    return { ...current, group: { ...current.group, rosterVersion, snapshotVersion: rosterVersion } };
}

function withSenderMember(current: GroupSnapshot, status: 'left' | 'removed' | 'absent'): GroupSnapshot {
    const members = current.members.flatMap((member) => {
        if (member.principalId !== 'origin' || member.status !== 'active') {
            return [member];
        }
        if (status === 'absent') {
            return [];
        }
        return [status === 'left' ? { ...member, status, left: member.updated } : { ...member, status, removed: member.updated }];
    });
    return { ...current, members };
}

function withoutSenderSession(current: GroupSnapshot): GroupSnapshot {
    return { ...current, activeSessions: current.activeSessions.filter((session) => session.sessionId !== 'origin') };
}

function freezeRoomObservation(value: object): void {
    Object.freeze(value);
    for (const child of Object.values(value)) {
        if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) {
            freezeRoomObservation(child);
        }
    }
}
