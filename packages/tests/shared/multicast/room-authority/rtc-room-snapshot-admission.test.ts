import {
    describe,
    expect,
    it
} from 'vitest';

import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type {
    RtcPublicationAdmitted,
    RtcPublicationRefusal,
    RtcPublicationRefusalCode
} from '@shared/multicast/publication/compute-rtc-publication-admission.ts';
import type { RtcRoomLayoutHistory } from '@shared/multicast/room-authority/resolve-rtc-room-routing-edges.ts';
import {
    computeRtcRoomSnapshotAdmission,
    toRtcPublicationHandlingPlan,
    toRtcRoomSnapshotHandlingPlan,
    type RtcRoomSnapshotAdmissionInput
} from '@shared/multicast/room-authority/rtc-room-snapshot-admission.ts';
import type { OverlayLayoutTransition } from '@shared/repository/overlay-layout-transition.ts';
import { toOverlayLayoutIdentity } from '@shared/repository/to-overlay-layout-identity.ts';
import { Either } from '@shared/resilience/Either.ts';

import { createGroupSnapshotFixture } from '../../../shared-web/authoritative-group-fixtures.ts';

const roomRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const message = newALMulticastMessage('origin', { topicId: 'room.chat', contextId: 'room', resourceId: 'message' }, roomRef, 'chat.v1', {});
const nowMs = 100;
const noLayoutHistory: RtcRoomLayoutHistory = { transition: null, replacedLayoutOverlapMs: 15_000 };

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
        nextHopsBySessionId: undefined,
        degreeLimit: 2,
        overlayVersion: 1,
        createdByClientId: 'owner',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1
    };
}

describe('RTC room authority', () => {
    it('requires evidence for no-floor messages, then permits an active direct room recipient without topology', () => {
        const input = {
            message,
            layoutHistory: noLayoutHistory,
            selfPeerId: 'receiver',
            fromPeerId: 'origin',
            recipientPeerId: undefined,
            nowMs,
            overlay: undefined
        };
        expect(computeRtcRoomSnapshotAdmission({ ...input, snapshot: undefined }).kind).toBe('pending');
        expect(computeRtcRoomSnapshotAdmission({ ...input, snapshot: snapshot() }).kind).toBe('authorized');
    });

    it('authorizes a different immediate relay only from a matching active server topology', () => {
        const input = {
            message,
            layoutHistory: noLayoutHistory,
            selfPeerId: 'receiver',
            fromPeerId: 'relay',
            recipientPeerId: undefined,
            nowMs,
            snapshot: snapshot()
        };
        expect(computeRtcRoomSnapshotAdmission({ ...input, overlay: overlay() }).kind).toBe('authorized');
        expect(computeRtcRoomSnapshotAdmission({ ...input, overlay: undefined }).kind).toBe('pending');
        expect(computeRtcRoomSnapshotAdmission({ ...input, overlay: { ...overlay(), provenance: 'bootstrap' } }).kind).toBe('pending');
        expect(computeRtcRoomSnapshotAdmission({ ...input, overlay: { ...overlay(), nextHopSessionIds: ['downstream'] } }).kind).toBe('unauthorized');
        expect(computeRtcRoomSnapshotAdmission({ ...input, overlay: { ...overlay(), state: 'removed' } }).kind).toBe('unauthorized');
    });

    it('checks room scope and expiry before snapshot catch-up', () => {
        const current = snapshot();
        const versioned = { ...message, targets: { mode: 'multicast' as const, groupRef: roomRef, minSnapshotVersion: current.group.snapshotVersion + 1 } };
        const input = {
            message: versioned,
            layoutHistory: noLayoutHistory,
            selfPeerId: 'receiver',
            fromPeerId: 'origin',
            recipientPeerId: undefined,
            overlay: undefined,
            nowMs
        };
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
        const input = {
            message,
            layoutHistory: noLayoutHistory,
            selfPeerId: 'receiver',
            fromPeerId: 'origin',
            recipientPeerId: undefined,
            overlay: undefined,
            nowMs
        };
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
            layoutHistory: noLayoutHistory,
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
        const input = {
            message,
            layoutHistory: noLayoutHistory,
            selfPeerId: 'receiver',
            fromPeerId: 'relay',
            recipientPeerId: undefined,
            overlay: overlay(),
            nowMs,
            snapshot: current
        };
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
        const input = {
            message: frozen,
            layoutHistory: noLayoutHistory,
            selfPeerId: 'relay',
            fromPeerId: 'origin',
            recipientPeerId: undefined,
            overlay: overlay(),
            nowMs
        };
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
            layoutHistory: noLayoutHistory,
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

/**
 * The receiver's accepted layout `promoted` replaced `replaced`, which parented it on `previous`. A live member that
 * was its neighbour in `replaced` is admitted as a relay for the session's overlap; nothing else is.
 */
describe('a receiver\'s previous neighbours across a layout promotion', () => {
    const overlapMs = 15_000;
    const replacedAtEpochMs = 1_000;
    const insideMs = replacedAtEpochMs + overlapMs - 1;
    const promoted: OverlayInfo = { ...overlay(), overlayVersion: 2 };
    const replaced: OverlayInfo = { ...overlay(), nextHopSessionIds: ['previous', 'downstream'] };

    function promotionSnapshot(): GroupSnapshot {
        return createGroupSnapshotFixture({ ...roomRef, sessionIds: ['origin', 'relay', 'receiver', 'downstream', 'previous', 'stranger'] });
    }

    function promotionHistory(overrides: Partial<OverlayLayoutTransition> = {}, replacedLayoutOverlapMs = overlapMs): RtcRoomLayoutHistory {
        return {
            transition: { replaced, replacedBy: toOverlayLayoutIdentity(promoted), replacedAtEpochMs, ...overrides },
            replacedLayoutOverlapMs
        };
    }

    function relayedInput(overrides: Partial<RtcRoomSnapshotAdmissionInput> = {}): RtcRoomSnapshotAdmissionInput {
        return {
            message,
            snapshot: promotionSnapshot(),
            overlay: promoted,
            layoutHistory: promotionHistory(),
            selfPeerId: 'receiver',
            fromPeerId: 'previous',
            recipientPeerId: undefined,
            nowMs: insideMs,
            ...overrides
        };
    }

    function planRelayed(input: RtcRoomSnapshotAdmissionInput) {
        const base = planALMessageHandling(input.message, {
            nowMs: input.nowMs,
            selfPeerId: input.selfPeerId,
            fromPeerId: input.fromPeerId,
            connectedPeerIds: ['previous', 'relay', 'downstream'],
            groupMemberPeerIds: ['origin', 'relay', 'receiver', 'downstream', 'previous', 'stranger'],
            overlayNeighborPeerIds: ['relay', 'downstream']
        });
        return toRtcRoomSnapshotHandlingPlan(base, computeRtcRoomSnapshotAdmission(input), input.fromPeerId);
    }

    it('refuses a removed member that was a neighbour of the replaced layout, inside the overlap', () => {
        const current = promotionSnapshot();
        const removed = {
            ...current,
            activeSessions: current.activeSessions.filter((session) => session.sessionId !== 'previous'),
            members: current.members.filter((member) => member.principalId !== 'previous')
        };
        const input = relayedInput({ snapshot: removed });

        // Unauthorized, never pending: a pending verdict would NACK the removed member and refresh the room.
        expect(computeRtcRoomSnapshotAdmission(input)).toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
        expect(planRelayed(input)).toMatchObject({
            dropReasonCode: 'unauthorized',
            localDelivery: { enabled: false },
            forwarding: { enabled: false, nextHopPeerIds: [] },
            nack: { enabled: false }
        });
    });

    it('refuses an expelled member that was a neighbour of the replaced layout, inside the overlap', () => {
        const current = promotionSnapshot();
        const expelled = withMember(current, 'previous', 'removed');
        const withoutSession = { ...expelled, activeSessions: expelled.activeSessions.filter((session) => session.sessionId !== 'previous') };
        const input = relayedInput({ snapshot: withoutSession });

        expect(computeRtcRoomSnapshotAdmission(input)).toMatchObject({ kind: 'unauthorized' });
        expect(planRelayed(input)).toMatchObject({ dropReasonCode: 'unauthorized', localDelivery: { enabled: false }, nack: { enabled: false } });
    });

    it('refuses a previous neighbour whose session is present but whose membership is inactive now', () => {
        const current = promotionSnapshot();
        const left = withMember(current, 'previous', 'left');

        expect(computeRtcRoomSnapshotAdmission(relayedInput({ snapshot: left }))).toMatchObject({ kind: 'unauthorized' });
        expect(planRelayed(relayedInput({ snapshot: left }))).toMatchObject({ dropReasonCode: 'unauthorized', nack: { enabled: false } });
    });

    it('admits a frame relayed by a live member that was this receiver\'s neighbour in the replaced layout, inside the overlap', () => {
        for (const nowMs of [replacedAtEpochMs, insideMs]) {
            const admission = computeRtcRoomSnapshotAdmission(relayedInput({ nowMs }));
            expect(admission).toMatchObject({ kind: 'authorized', deliversLocally: true });
        }
        expect(planRelayed(relayedInput())).toMatchObject({ dropReasonCode: undefined, localDelivery: { enabled: true } });
    });

    it('refuses that member\'s relay once the session\'s overlap has ended', () => {
        expect(computeRtcRoomSnapshotAdmission(relayedInput({ nowMs: replacedAtEpochMs + overlapMs + 1 })))
            .toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
    });

    it('at the overlap\'s exact end instant the previous neighbour is refused', () => {
        expect(computeRtcRoomSnapshotAdmission(relayedInput({ nowMs: replacedAtEpochMs + overlapMs })))
            .toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
    });

    it('refuses it at once when the session\'s overlap is zero', () => {
        const layoutHistory = promotionHistory({}, 0);
        expect(computeRtcRoomSnapshotAdmission(relayedInput({ layoutHistory, nowMs: replacedAtEpochMs })))
            .toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
    });

    it('refuses a relay from a neighbour of the replaced layout once a newer layout is accepted', () => {
        const newer = { ...promoted, overlayVersion: 3 };
        expect(computeRtcRoomSnapshotAdmission(relayedInput({ overlay: newer })))
            .toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
    });

    it('refuses a previous neighbour of another room\'s replaced layout', () => {
        const foreign = { ...replaced, groupRef: { ...roomRef, groupId: 'other-room' } };
        expect(computeRtcRoomSnapshotAdmission(relayedInput({ layoutHistory: promotionHistory({ replaced: foreign }) })))
            .toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
    });

    it('still refuses a member that was never this receiver\'s neighbour', () => {
        expect(computeRtcRoomSnapshotAdmission(relayedInput({ fromPeerId: 'stranger' })))
            .toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
    });

    it('a frame from a previous neighbour that targets another immediate recipient is still refused', () => {
        const misdirected = { ...message, forwarding: { ...message.forwarding, nextHopPeerIds: ['downstream'] } };
        expect(computeRtcRoomSnapshotAdmission(relayedInput({ message: misdirected }))).toEqual({
            kind: 'unauthorized',
            cause: 'authority-rejected',
            reason: 'RTC transport copy targets another immediate recipient'
        });
    });

    it('lets an origin send a copy to a previous neighbour only inside the overlap', () => {
        const toPrevious = relayedInput({ selfPeerId: 'origin', fromPeerId: undefined, recipientPeerId: 'previous' });
        expect(computeRtcRoomSnapshotAdmission(toPrevious).kind).toBe('authorized');
        expect(computeRtcRoomSnapshotAdmission({ ...toPrevious, nowMs: replacedAtEpochMs + overlapMs }))
            .toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
    });

    it('keeps the sender\'s roster fence unchanged inside the overlap', () => {
        const current = promotionSnapshot();
        const fencedOrigin = withSenderMember(current, 'left');
        expect(computeRtcRoomSnapshotAdmission(relayedInput({ message: stampedMessage(1, 1), snapshot: fencedOrigin }))).toEqual({
            kind: 'unauthorized',
            cause: 'membership-fenced',
            reason: 'Room sender is not an active member of the room roster'
        });
    });
});

describe('the room roster fence at RTC ingress', () => {
    const receiverInput = {
        layoutHistory: noLayoutHistory,
        selfPeerId: 'receiver',
        fromPeerId: 'origin',
        recipientPeerId: undefined,
        overlay: undefined,
        nowMs
    };

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
        const origin = { layoutHistory: noLayoutHistory, selfPeerId: 'origin', fromPeerId: undefined, recipientPeerId: undefined, overlay: undefined, nowMs };
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
    return withMember(current, 'origin', status);
}

function withMember(current: GroupSnapshot, principalId: string, status: 'left' | 'removed' | 'absent'): GroupSnapshot {
    const members = current.members.flatMap((member) => {
        if (member.principalId !== principalId || member.status !== 'active') {
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

describe('a granted publication\'s admission on its room plan', () => {
    const plan = planALMessageHandling(message, {
        nowMs,
        selfPeerId: 'relay',
        fromPeerId: 'origin',
        connectedPeerIds: ['origin', 'receiver', 'downstream'],
        groupMemberPeerIds: ['origin', 'relay', 'receiver', 'downstream'],
        overlayNeighborPeerIds: ['downstream']
    });

    it.each<RtcPublicationRefusalCode>(['unknown-key', 'authority-ahead'])(
        'drops %s as not yet in sync, the code after the head the room refresh reads, and NACKs its hop',
        (code) => {
            const refused = toRtcPublicationHandlingPlan(plan, Either.ofLeft({ code }), 'origin');

            expect(refused).toMatchObject({
                dropReason: `not-yet-in-sync: ${code}`,
                dropReasonCode: 'not-yet-in-sync',
                localDelivery: { enabled: false },
                forwarding: { enabled: false, nextHopPeerIds: [] },
                nack: { enabled: true, toPeerId: 'origin', reason: 'not-yet-in-sync' }
            });
        }
    );

    it.each<RtcPublicationRefusalCode>([
        'no-authority',
        'missing-proof',
        'unbound-target',
        'invalid-signature',
        'no-publish-grant'
    ])('drops %s as unauthorized with no NACK and no forward', (code) => {
        const refused = toRtcPublicationHandlingPlan(plan, Either.ofLeft({ code }), 'origin');

        expect(refused).toMatchObject({
            dropReason: `unauthorized: ${code}`,
            dropReasonCode: 'unauthorized',
            localDelivery: { enabled: false },
            forwarding: { enabled: false, nextHopPeerIds: [] },
            ack: { enabled: false },
            nack: { enabled: false }
        });
    });

    it('keeps the expiry drop the ALM policy owns', () => {
        const expired = { ...plan, dropReason: 'expired', dropReasonCode: 'expired' as const };

        expect(toRtcPublicationHandlingPlan(expired, Either.ofLeft({ code: 'invalid-signature' }), 'origin'))
            .toBe(expired);
    });

    it('forwards an admitted frame over the tree, delivering it only when admitted for delivery', () => {
        const forwardOnly = toRtcPublicationHandlingPlan(plan, Either.ofRight({ delivery: 'forward-only' }), 'origin');
        const delivered = toRtcPublicationHandlingPlan(plan, Either.ofRight({ delivery: 'deliver' }), 'origin');

        expect(plan.localDelivery.enabled).toBe(true);
        expect([forwardOnly.localDelivery.enabled, forwardOnly.forwarding.nextHopPeerIds]).toEqual([false, ['downstream']]);
        expect(delivered).toBe(plan);
    });

    describe('at a frozen recipient that is not subscribed', () => {
        const receipted = planALMessageHandling(
            newALMulticastMessage('origin', { topicId: 'room.chat', contextId: 'room', resourceId: 'receipted' }, roomRef, 'chat.v1', {}, {
                ack: 'receiver',
                ttlMs: 30_000
            }),
            {
                nowMs,
                selfPeerId: 'relay',
                fromPeerId: 'origin',
                connectedPeerIds: ['origin', 'receiver', 'downstream'],
                groupMemberPeerIds: ['origin', 'relay', 'receiver', 'downstream'],
                overlayNeighborPeerIds: ['downstream']
            }
        );
        const notSubscribed = Either.ofRight<RtcPublicationRefusal, RtcPublicationAdmitted>({ delivery: 'forward-not-subscribed' });

        it('forwards, delivers nothing, answers its hop not-subscribed, and keeps its ACK, which ends its hop', () => {
            const answered = toRtcPublicationHandlingPlan(receipted, notSubscribed, 'origin');

            expect(receipted.ack).toMatchObject({ enabled: true, algo: 'receiver', deferred: true, toPeerId: 'origin' });
            expect(answered).toMatchObject({
                dropReason: undefined,
                localDelivery: { enabled: false, deferred: false },
                forwarding: { enabled: true, nextHopPeerIds: ['downstream'] },
                ack: { enabled: true, algo: 'receiver', deferred: true, toPeerId: 'origin' },
                nack: { enabled: true, toPeerId: 'origin', reason: 'not-subscribed', missingRanges: [] }
            });
        });

        it('answers a witnessed ordered copy not-subscribed and keeps its ACK: a witness holds no gap back', () => {
            const ordered = newALMulticastMessage('origin', { topicId: 'room.chat', contextId: 'room', resourceId: 'witnessed' }, roomRef, 'chat.v1', {}, {
                ack: 'receiver',
                reliability: 'at-least-once',
                ttlMs: 30_000,
                orderingKey: 'room-track',
                seq: 2
            });
            const witnessed = planALMessageHandling(ordered, {
                nowMs,
                selfPeerId: 'leaf',
                fromPeerId: 'origin',
                connectedPeerIds: ['origin'],
                groupMemberPeerIds: ['origin', 'leaf'],
                orderingObservation: {
                    status: 'witnessed',
                    trackKey: 'room-track',
                    seq: 2,
                    expectedSeq: 3,
                    lastContiguousSeq: 2,
                    missingRanges: [],
                    releasableSeqs: []
                }
            });

            const answered = toRtcPublicationHandlingPlan(witnessed, notSubscribed, 'origin');

            expect([witnessed.localDelivery.deferred, witnessed.nack.enabled]).toEqual([false, false]);
            expect(answered).toMatchObject({
                localDelivery: { enabled: false, deferred: false },
                ack: { enabled: true, algo: 'receiver', toPeerId: 'origin' },
                nack: { enabled: true, toPeerId: 'origin', reason: 'not-subscribed', missingRanges: [] }
            });
        });

        it('only forwards a frame no receipt counts recipients of, answering nothing', () => {
            const answered = toRtcPublicationHandlingPlan(plan, notSubscribed, 'origin');

            expect(answered).toEqual(toRtcPublicationHandlingPlan(plan, Either.ofRight({ delivery: 'forward-only' }), 'origin'));
            expect(answered.nack.enabled).toBe(false);
        });

        it('answers a duplicate copy not-subscribed again, and keeps the NACK of a plan that drops with its own', () => {
            const duplicate = { ...receipted, dropReason: 'duplicate', dropReasonCode: 'duplicate' as const };
            const overloaded = {
                ...receipted,
                dropReason: 'overloaded',
                dropReasonCode: 'overloaded' as const,
                nack: { enabled: true, toPeerId: 'origin', reason: 'overloaded' as const, missingRanges: [] }
            };

            expect(toRtcPublicationHandlingPlan(duplicate, notSubscribed, 'origin').nack.reason).toBe('not-subscribed');
            expect(toRtcPublicationHandlingPlan(overloaded, notSubscribed, 'origin').nack).toEqual(overloaded.nack);
        });
    });
});
