import {
    describe,
    expect,
    it
} from 'vitest';

import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { shouldRetryALInboundDelivery } from '@shared/alm/inbound/al-inbound-effect-intent.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type {
    RtcPublicationAdmitted,
    RtcPublicationRefusal,
    RtcPublicationRefusalCode
} from '@shared/multicast/publication/compute-rtc-publication-admission.ts';
import { isRtcRoomSnapshotRefreshReason } from '@shared/multicast/room-authority/is-rtc-room-snapshot-refresh-reason.ts';
import { RTC_ROOM_LAYOUT_PROMOTION_AWAITED_REASON } from '@shared/multicast/room-authority/resolve-rtc-room-edge-denial.ts';
import type { RtcRoomLayoutChanges } from '@shared/multicast/room-authority/resolve-rtc-room-routing-edges.ts';
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
const noLayoutChanges: RtcRoomLayoutChanges = { transitions: [], replacedLayoutOverlapMs: 15_000, planned: null };

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
            layoutChanges: noLayoutChanges,
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
            layoutChanges: noLayoutChanges,
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
            layoutChanges: noLayoutChanges,
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
            layoutChanges: noLayoutChanges,
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
            layoutChanges: noLayoutChanges,
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
            layoutChanges: noLayoutChanges,
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
            layoutChanges: noLayoutChanges,
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
            layoutChanges: noLayoutChanges,
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
    /** A receiver admits the replaced layout for the whole overlap but forwards over it only for the first half. */
    const forwardingInsideMs = replacedAtEpochMs + overlapMs / 2 - 1;
    const promoted: OverlayInfo = { ...overlay(), overlayVersion: 2 };
    const replaced: OverlayInfo = { ...overlay(), nextHopSessionIds: ['previous', 'downstream'] };

    function promotionSnapshot(): GroupSnapshot {
        return createGroupSnapshotFixture({
            ...roomRef,
            sessionIds: ['origin', 'relay', 'receiver', 'downstream', 'previous', 'stranger', 'older']
        });
    }

    function promotionLayoutChanges(overrides: Partial<OverlayLayoutTransition> = {}, replacedLayoutOverlapMs = overlapMs): RtcRoomLayoutChanges {
        return {
            transitions: [{ replaced, replacedBy: toOverlayLayoutIdentity(promoted), replacedAtEpochMs, ...overrides }],
            replacedLayoutOverlapMs,
            planned: null
        };
    }

    function relayedInput(overrides: Partial<RtcRoomSnapshotAdmissionInput> = {}): RtcRoomSnapshotAdmissionInput {
        return {
            message,
            snapshot: promotionSnapshot(),
            overlay: promoted,
            layoutChanges: promotionLayoutChanges(),
            selfPeerId: 'receiver',
            fromPeerId: 'previous',
            recipientPeerId: undefined,
            nowMs: insideMs,
            ...overrides
        };
    }

    /** The replaced layout's neighbours a copy relayed at `nowMs` by the accepted neighbour `relay` would also be forwarded to. */
    function readPreviousForwardingPeerIds(input: RtcRoomSnapshotAdmissionInput, nowMs: number): readonly string[] | undefined {
        const admission = computeRtcRoomSnapshotAdmission({ ...input, fromPeerId: 'relay', nowMs });
        expect(admission.kind).toBe('authorized');
        return admission.kind === 'authorized' ? admission.previousForwarding?.neighborPeerIds : undefined;
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
        // Nor does this receiver forward to it: the replaced layout's forwarding set holds only authorized neighbours.
        expect(readPreviousForwardingPeerIds(input, forwardingInsideMs)).toEqual(['downstream']);
    });

    // 'stranger' is a live member that neighbours this receiver only in the layout it holds planned.
    const planned: OverlayInfo = { ...promoted, overlayVersion: 3, nextHopSessionIds: ['stranger', 'relay'] };
    const withPlanned = { ...promotionLayoutChanges(), planned };

    it('answers a frame relayed by a planned-layout neighbour as pending, with its own reason, instead of unauthorized', () => {
        const input = relayedInput({ fromPeerId: 'stranger', layoutChanges: withPlanned });

        expect(computeRtcRoomSnapshotAdmission(input)).toEqual({
            kind: 'pending',
            reason: RTC_ROOM_LAYOUT_PROMOTION_AWAITED_REASON
        });
        const plan = planRelayed(input);
        expect(plan).toMatchObject({
            dropReasonCode: 'not-yet-in-sync',
            dropReason: `not-yet-in-sync: ${RTC_ROOM_LAYOUT_PROMOTION_AWAITED_REASON}`,
            localDelivery: { enabled: false },
            forwarding: { enabled: false, nextHopPeerIds: [] },
            nack: { enabled: true, toPeerId: 'stranger', reason: 'not-yet-in-sync' }
        });
        // The receiver lacks the layout, not the room snapshot: no room refresh follows this drop.
        expect(isRtcRoomSnapshotRefreshReason(plan.dropReason!)).toBe(false);
        expect(isRtcRoomSnapshotRefreshReason('not-yet-in-sync: Awaiting the required room snapshot version')).toBe(true);
    });

    it('refuses at once a planned-layout neighbour that is not authorized in the room now', () => {
        const current = promotionSnapshot();
        const removed = {
            ...current,
            activeSessions: current.activeSessions.filter((session) => session.sessionId !== 'stranger'),
            members: current.members.filter((member) => member.principalId !== 'stranger')
        };
        // Removed: no session and no member, so the rule awaits nobody and the edge is refused. Expelled: the member's
        // own denial outranks the edge's.
        for (
            const { snapshot, cause } of [
                { snapshot: removed, cause: 'edge-unavailable' },
                { snapshot: withMember(current, 'stranger', 'removed'), cause: 'authority-rejected' }
            ]
        ) {
            const input = relayedInput({ fromPeerId: 'stranger', layoutChanges: withPlanned, snapshot });
            expect(computeRtcRoomSnapshotAdmission(input)).toMatchObject({ kind: 'unauthorized', cause });
            expect(planRelayed(input)).toMatchObject({ dropReasonCode: 'unauthorized', localDelivery: { enabled: false }, nack: { enabled: false } });
        }
    });

    // The retry decision on a plan alone, not a stored, re-parented forward end to end: a plan against a parent that
    // is now only a planned-layout neighbour is one the inbound runtime retries, as any not-yet-in-sync plan is, where
    // a plan against an unauthorized parent is not retried.
    it('a relayed plan against an awaited parent is one the inbound runtime retries, and one against an unauthorized parent is not', () => {
        expect(shouldRetryALInboundDelivery(planRelayed(relayedInput({ fromPeerId: 'stranger', layoutChanges: withPlanned }))))
            .toBe(true);
        expect(shouldRetryALInboundDelivery(planRelayed(relayedInput({ fromPeerId: 'stranger' })))).toBe(false);
    });

    it('a copy both awaited and behind the room floor is answered as awaiting the layout\'s promotion, so no room refresh follows', () => {
        const floored = {
            ...message,
            targets: { ...message.targets!, minSnapshotVersion: promotionSnapshot().group.snapshotVersion + 1 }
        } as typeof message;
        const input = relayedInput({ message: floored, fromPeerId: 'stranger', layoutChanges: withPlanned });

        expect(computeRtcRoomSnapshotAdmission({ ...input, layoutChanges: promotionLayoutChanges(), fromPeerId: 'relay' }))
            .toMatchObject({ kind: 'pending', reason: 'Awaiting the required room snapshot version' });
        expect(computeRtcRoomSnapshotAdmission(input)).toMatchObject({ kind: 'pending', reason: RTC_ROOM_LAYOUT_PROMOTION_AWAITED_REASON });
        expect(isRtcRoomSnapshotRefreshReason(planRelayed(input).dropReason!)).toBe(false);
    });

    it('refuses an expelled member that was a neighbour of the replaced layout, inside the overlap', () => {
        const current = promotionSnapshot();
        const input = relayedInput({ snapshot: withMember(current, 'previous', 'removed') });

        expect(computeRtcRoomSnapshotAdmission(input)).toMatchObject({ kind: 'unauthorized', cause: 'authority-rejected' });
        expect(planRelayed(input)).toMatchObject({ dropReasonCode: 'unauthorized', localDelivery: { enabled: false }, nack: { enabled: false } });
        expect(readPreviousForwardingPeerIds(input, forwardingInsideMs)).toEqual(['downstream']);
    });

    it('refuses a previous neighbour whose session is present but whose membership is inactive now', () => {
        const current = promotionSnapshot();
        const left = withMember(current, 'previous', 'left');

        expect(computeRtcRoomSnapshotAdmission(relayedInput({ snapshot: left }))).toMatchObject({ kind: 'unauthorized', cause: 'authority-rejected' });
        expect(planRelayed(relayedInput({ snapshot: left }))).toMatchObject({ dropReasonCode: 'unauthorized', nack: { enabled: false } });
    });

    it('refuses a previous neighbour whose session is present but who has no member row', () => {
        const input = relayedInput({ snapshot: withMember(promotionSnapshot(), 'previous', 'absent') });

        // The hop's own peer check only awaits a member row; the rule's authorized-now filter is what refuses the edge.
        expect(computeRtcRoomSnapshotAdmission(input)).toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
        expect(planRelayed(input)).toMatchObject({ dropReasonCode: 'unauthorized', nack: { enabled: false } });
    });

    it('refuses a previous neighbour when now is before the replacement instant', () => {
        for (const nowMs of [replacedAtEpochMs - 1, replacedAtEpochMs - 10 * overlapMs]) {
            expect(computeRtcRoomSnapshotAdmission(relayedInput({ nowMs }))).toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
        }
    });

    it('admits a frame relayed by a live member that was this receiver\'s neighbour in the replaced layout, inside the overlap', () => {
        for (const nowMs of [replacedAtEpochMs, insideMs]) {
            const admission = computeRtcRoomSnapshotAdmission(relayedInput({ nowMs }));
            expect(admission).toMatchObject({ kind: 'authorized', deliversLocally: true });
        }
        expect(planRelayed(relayedInput())).toMatchObject({ dropReasonCode: undefined, localDelivery: { enabled: true } });
        expect(readPreviousForwardingPeerIds(relayedInput(), forwardingInsideMs)).toEqual(['previous', 'downstream']);
    });

    it('authorizes a previous neighbour\'s frame in the second half of the overlap and forwards over no replaced edge', () => {
        for (const nowMs of [replacedAtEpochMs + overlapMs / 2, insideMs]) {
            const admission = computeRtcRoomSnapshotAdmission(relayedInput({ nowMs }));
            expect(admission).toMatchObject({ kind: 'authorized', deliversLocally: true, previousForwarding: null });
        }
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
        const layoutChanges = promotionLayoutChanges({}, 0);
        expect(computeRtcRoomSnapshotAdmission(relayedInput({ layoutChanges, nowMs: replacedAtEpochMs })))
            .toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
    });

    it('refuses a relay from a neighbour of the replaced layout once a newer layout is accepted', () => {
        const newer = { ...promoted, overlayVersion: 3 };
        expect(computeRtcRoomSnapshotAdmission(relayedInput({ overlay: newer })))
            .toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
    });

    it('refuses a previous neighbour of another room\'s replaced layout', () => {
        const foreign = { ...replaced, groupRef: { ...roomRef, groupId: 'other-room' } };
        expect(computeRtcRoomSnapshotAdmission(relayedInput({ layoutChanges: promotionLayoutChanges({ replaced: foreign }) })))
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

    // 'older' neighboured this receiver only in the layout `replaced` replaced one second before `promoted` replaced it.
    const older: OverlayInfo = { ...overlay(), overlayVersion: 0, nextHopSessionIds: ['older', 'downstream'] };
    const olderReplacedAtEpochMs = replacedAtEpochMs - 1_000;

    function twoPromotionLayoutChanges(): RtcRoomLayoutChanges {
        const newest = promotionLayoutChanges().transitions[0]!;
        const olderTransition = { replaced: older, replacedBy: toOverlayLayoutIdentity(replaced), replacedAtEpochMs: olderReplacedAtEpochMs };
        return { ...promotionLayoutChanges(), transitions: [newest, olderTransition] };
    }

    it('admits a relay that is a neighbour only in a layout two promotions old, inside that layout\'s own window', () => {
        for (const nowMs of [replacedAtEpochMs, olderReplacedAtEpochMs + overlapMs - 1]) {
            const input = relayedInput({ fromPeerId: 'older', layoutChanges: twoPromotionLayoutChanges(), nowMs });
            expect(computeRtcRoomSnapshotAdmission(input)).toMatchObject({ kind: 'authorized', deliversLocally: true });
        }
    });

    it('refuses it after that layout\'s window, while the more recent replaced layout is still admitted', () => {
        const nowMs = olderReplacedAtEpochMs + overlapMs;
        expect(computeRtcRoomSnapshotAdmission(relayedInput({ fromPeerId: 'older', layoutChanges: twoPromotionLayoutChanges(), nowMs })))
            .toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
        expect(computeRtcRoomSnapshotAdmission(relayedInput({ fromPeerId: 'previous', layoutChanges: twoPromotionLayoutChanges(), nowMs })))
            .toMatchObject({ kind: 'authorized' });
    });

    it('refuses at once a removed and an expelled member that an older layout names', () => {
        const current = promotionSnapshot();
        const removed = {
            ...current,
            activeSessions: current.activeSessions.filter((session) => session.sessionId !== 'older'),
            members: current.members.filter((member) => member.principalId !== 'older')
        };
        for (
            const { snapshot: roomNow, cause } of [
                { snapshot: removed, cause: 'edge-unavailable' },
                { snapshot: withMember(current, 'older', 'removed'), cause: 'authority-rejected' }
            ]
        ) {
            const input = relayedInput({ fromPeerId: 'older', layoutChanges: twoPromotionLayoutChanges(), snapshot: roomNow, nowMs: replacedAtEpochMs });
            expect(computeRtcRoomSnapshotAdmission(input)).toMatchObject({ kind: 'unauthorized', cause });
        }
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
        layoutChanges: noLayoutChanges,
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
        const origin = { layoutChanges: noLayoutChanges, selfPeerId: 'origin', fromPeerId: undefined, recipientPeerId: undefined, overlay: undefined, nowMs };
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
