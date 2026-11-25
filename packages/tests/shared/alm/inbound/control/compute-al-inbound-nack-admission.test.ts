import { describe, expect, it } from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    parseALControlMessage,
    type ALAckPayload,
    type ALNackPayload,
    type ALPendingAckSnapshot
} from '@shared/al-contracts/al-control.ts';
import { AL_GAP_NACK_RELAY_HOP_LIMIT, AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import type { ALRelayedNackReason } from '@shared/alm/delivery/is-al-relayed-nack-reason.ts';
import {
    computeALInboundNackAdmission,
    computeALInboundUnheldGapNackAdmission,
    computeALInboundUnreceiptedGapNackAdmission,
    toALInboundNackCommitBundle,
    type ALInboundGapNackRoute,
    type ALInboundNackAdmissionCandidate,
    type ALInboundUnreceiptedGapNackAdmissionRead
} from '@shared/alm/inbound/control/compute-al-inbound-nack-admission.ts';
import {
    validateALInboundNackAdmission,
    validateALInboundUnheldGapNackAdmission,
    validateALInboundUnreceiptedGapNackAdmission
} from '@shared/alm/inbound/control/validate-al-inbound-nack-admission.ts';
import type { SignatureProof } from '@shared/signature/signature-proof.ts';

import { toTestALAckPayload, toTestALNackPayload, toTestSignatureProof } from '../../../../al-control-test-payloads.ts';

const NOW_MS = 1_800_000_000_000;
/** The child's own time, which the relay forwards unchanged. */
const CHILD_OBSERVED_AT_MS = NOW_MS - 7;
const RETENTION = normalizeALRuntimeStoreRetention();

/** A relay waiting on its child `child` for the frozen recipients `child` and `leaf`, toward its parent `parent`. */
const ROW: ALPendingAckSnapshot = {
    toPeerId: 'parent',
    status: 'subtree-complete',
    localReady: true,
    expectedFromPeerIds: ['child'],
    ackedFromPeerIds: [],
    upwardAudiencePeerIds: ['child', 'leaf'],
    outsideAudiencePeerIds: [],
    expireAtTimestamp: NOW_MS + 60_000,
    carrier: 'rtc'
};

/** The relay's room: the sender is no layout child, and the relay's current upstream peer is `new-parent`. */
const NEW_UPSTREAM: ALInboundGapNackRoute = { isLayoutChild: false, upstreamPeerId: 'new-parent', relayHops: AL_GAP_NACK_RELAY_HOP_LIMIT };

/** What a relay grants a gap NACK in a room of three sessions: one fewer. */
const THREE_SESSION_GRANT = 2;

const NO_RELAY_HOP_LEFT = { code: 'unauthorized', message: 'Inbound gap NACK has no relay hop left' } as const;

const SPEAKS_FOR_RELAY = { code: 'unauthorized', message: 'Inbound gap NACK speaks for this relay itself' } as const;

const GAP_ORDERING = {
    orderingKey: 'feed:origin:1',
    expectedSeq: 2,
    missingRanges: [{ from: 2, to: 3 }]
} as const;

interface NackArrival {
    readonly reason: ALRelayedNackReason;
    readonly fromPeerId?: string;
    readonly logicalRecipientPeerId?: string;
    readonly originPeerId?: string;
    readonly ordering?: Partial<Pick<ALNackPayload, 'orderingKey' | 'expectedSeq' | 'missingRanges'>>;
    readonly proof?: SignatureProof | null;
    /** Absent, every relay hop a leaf grants. */
    readonly relayHopsLeft?: number;
}

function toChildNack(arrival: NackArrival): ALNackPayload & Readonly<{ reason: ALRelayedNackReason; }> {
    return {
        msgId: 'subject',
        fromPeerId: arrival.fromPeerId ?? 'child',
        toPeerId: 'relay',
        logicalRecipientPeerId: arrival.logicalRecipientPeerId ?? 'leaf',
        originPeerId: arrival.originPeerId ?? 'origin',
        reason: arrival.reason,
        observedAtEpochMs: CHILD_OBSERVED_AT_MS,
        proof: arrival.proof ?? null,
        ...(arrival.ordering ?? (arrival.reason === 'gap' ? GAP_ORDERING : {})),
        ...(arrival.reason === 'gap' ? { gapRequestNumber: 1, relayHopsLeft: arrival.relayHopsLeft ?? AL_GAP_NACK_RELAY_HOP_LIMIT } : {})
    };
}

/** `nack` as this relay forwards it to `toPeerId`: in its own name, one relay hop lower. */
function toRelayedNack(nack: ALNackPayload, toPeerId: string): ALNackPayload {
    return { ...nack, fromPeerId: 'relay', toPeerId, relayHopsLeft: nack.relayHopsLeft! - 1 };
}

function computeArrival(
    arrival: NackArrival,
    row: ALPendingAckSnapshot = ROW,
    acks: readonly ALAckPayload[] = [],
    nacks: readonly ALNackPayload[] = []
): ALInboundNackAdmissionCandidate {
    return computeALInboundNackAdmission({
        namespace: 'relay',
        nack: toChildNack(arrival),
        controlOwners: { ambiguous: false, values: [{ peerId: 'child', senderId: 'origin' }] },
        owner: {
            msgId: 'subject',
            senderId: 'origin',
            source: { kind: 'rtc-peer', peerId: 'parent' },
            supersedenceKey: null,
            deliveredLocally: false,
            originAuthenticated: false
        },
        pending: row,
        acks,
        nacks,
        gapRoute: undefined,
        nowMs: NOW_MS,
        controlMsgId: 'forwarded',
        traceId: 'trace-relayed-nack'
    }, RETENTION);
}

function toUpwardControls(candidate: ALInboundNackAdmissionCandidate) {
    return candidate.upwardEffects.map((effect) => effect.payload.kind === 'send-control' ? parseALControlMessage(effect.payload.msg) : undefined);
}

function toConfirmation(logicalRecipientPeerId: string, proof: SignatureProof | null = null): ALAckPayload {
    const confirmation = toTestALAckPayload({
        ackedMsgId: 'subject',
        fromPeerId: 'child',
        toPeerId: 'relay',
        originPeerId: 'origin',
        logicalRecipientPeerId,
        carrier: 'rtc',
        status: 'delivered',
        observedAtEpochMs: NOW_MS
    });
    return { ...confirmation, proof };
}

describe('a child\'s gap NACK at a relay (S4ii-R3)', () => {
    it('forwards the child\'s gap NACK toward the parent with its ordering hints and its own time, writing no row', () => {
        const candidate = computeArrival({ reason: 'gap' });

        expect(validateALInboundNackAdmission(candidate)).toEqual([]);
        expect(candidate.pending).toBeUndefined();
        expect(toALInboundNackCommitBundle(candidate).mutations).toEqual([]);
        expect(toUpwardControls(candidate)).toEqual([{ type: 'nack', payload: toRelayedNack(toChildNack({ reason: 'gap' }), 'parent') }]);
    });

    it('refuses a NACK that names another origin', () => {
        expect(validateALInboundNackAdmission(computeArrival({ reason: 'gap', originPeerId: 'other' })))
            .toEqual([{ code: 'unauthorized', message: 'Inbound NACK names another origin than the message it answers' }]);
    });

    it('refuses a gap NACK from a child the row does not wait on', () => {
        expect(validateALInboundNackAdmission(computeArrival({ reason: 'gap', fromPeerId: 'stranger' })))
            .toEqual([{ code: 'unauthorized', message: 'Inbound NACK sender has no pending obligation' }]);
    });

    it('passes a gap NACK a layout child the row does not wait on relayed for a recipient below it to its current upstream peer (6d)', () => {
        const arrival = { reason: 'gap', fromPeerId: 'layout-child' } as const;
        const candidate = computeALInboundNackAdmission(
            { ...computeArrival(arrival).read, gapRoute: { ...NEW_UPSTREAM, isLayoutChild: true } },
            RETENTION
        );

        expect(validateALInboundNackAdmission(candidate)).toEqual([]);
        expect(toALInboundNackCommitBundle(candidate).mutations).toEqual([]);
        expect(toUpwardControls(candidate)).toEqual([{ type: 'nack', payload: toRelayedNack(toChildNack(arrival), 'new-parent') }]);
    });

    it('passes the gap NACK a child the row waits on relayed to its current upstream peer, though the row\'s parent is still there (6d)', () => {
        const candidate = computeALInboundNackAdmission({ ...computeArrival({ reason: 'gap' }).read, gapRoute: NEW_UPSTREAM }, RETENTION);

        expect(validateALInboundNackAdmission(candidate)).toEqual([]);
        expect(toUpwardControls(candidate)).toEqual([{ type: 'nack', payload: toRelayedNack(toChildNack({ reason: 'gap' }), 'new-parent') }]);
    });

    it('passes a child\'s gap NACK to the row\'s parent when no upstream peer resolves', () => {
        const gapRoute = { ...NEW_UPSTREAM, upstreamPeerId: undefined };
        const candidate = computeALInboundNackAdmission({ ...computeArrival({ reason: 'gap' }).read, gapRoute }, RETENTION);

        expect(validateALInboundNackAdmission(candidate)).toEqual([]);
        expect(toUpwardControls(candidate)).toEqual([{ type: 'nack', payload: toRelayedNack(toChildNack({ reason: 'gap' }), 'parent') }]);
    });

    it('passes a gap NACK with one relay hop left on with none, refuses one with none left, and refuses one that speaks for this relay (ruling 20)', () => {
        const lastHop = computeArrival({ reason: 'gap', relayHopsLeft: 1 });
        const spent = computeArrival({ reason: 'gap', relayHopsLeft: 0 });
        const ownReport = computeArrival(
            { reason: 'gap', logicalRecipientPeerId: 'relay' },
            { ...ROW, upwardAudiencePeerIds: ['child', 'leaf', 'relay'] }
        );

        expect(validateALInboundNackAdmission(lastHop)).toEqual([]);
        expect(toUpwardControls(lastHop)).toEqual([{ type: 'nack', payload: toRelayedNack(toChildNack({ reason: 'gap', relayHopsLeft: 1 }), 'parent') }]);
        expect(toUpwardControls(lastHop)[0]?.payload).toMatchObject({ relayHopsLeft: 0 });
        expect(validateALInboundNackAdmission(spent)).toEqual([NO_RELAY_HOP_LEFT]);
        expect(validateALInboundNackAdmission(ownReport)).toEqual([SPEAKS_FOR_RELAY]);
    });

    it('refuses a gap NACK with hops left whose relay grants it none', () => {
        const candidate = computeALInboundNackAdmission(
            { ...computeArrival({ reason: 'gap', relayHopsLeft: 3 }).read, gapRoute: { ...NEW_UPSTREAM, relayHops: 0 } },
            RETENTION
        );

        expect(validateALInboundNackAdmission(candidate)).toEqual([NO_RELAY_HOP_LEFT]);
    });

    it('clamps a hostile child\'s 255 relay hops to its own grant in a room of three sessions', () => {
        const route = { ...NEW_UPSTREAM, relayHops: THREE_SESSION_GRANT };
        const candidate = computeALInboundNackAdmission(
            { ...computeArrival({ reason: 'gap', relayHopsLeft: 255 }).read, gapRoute: route },
            RETENTION
        );

        expect(toUpwardControls(candidate)[0]?.payload).toMatchObject({ toPeerId: 'new-parent', relayHopsLeft: 1 });
    });

    it('refuses a gap NACK for a recipient whose confirmation the relay already forwarded', () => {
        const candidate = computeArrival({ reason: 'gap' }, ROW, [toConfirmation('leaf')]);

        expect(validateALInboundNackAdmission(candidate)).toEqual([{
            code: 'unauthorized',
            message: 'Inbound NACK names a recipient whose confirmation was already forwarded'
        }]);
    });

    it('forwards a gap NACK for a recipient the row lists outside when no stored control recorded it', () => {
        const candidate = computeArrival({ reason: 'gap' }, { ...ROW, outsideAudiencePeerIds: ['leaf'] });

        expect(validateALInboundNackAdmission(candidate)).toEqual([]);
        expect(toUpwardControls(candidate)).toEqual([{ type: 'nack', payload: toRelayedNack(toChildNack({ reason: 'gap' }), 'parent') }]);
    });

    it.each(
        [
            ['its missing ranges', { orderingKey: GAP_ORDERING.orderingKey, expectedSeq: GAP_ORDERING.expectedSeq }],
            ['its ordering key', { expectedSeq: GAP_ORDERING.expectedSeq, missingRanges: GAP_ORDERING.missingRanges }],
            ['its expected sequence', { orderingKey: GAP_ORDERING.orderingKey, missingRanges: GAP_ORDERING.missingRanges }]
        ] as const
    )('refuses a gap NACK without %s as malformed', (_missing, ordering) => {
        const candidate = computeArrival({ reason: 'gap', ordering });

        expect(validateALInboundNackAdmission(candidate)).toEqual([{
            code: 'malformed',
            message: 'Inbound gap NACK carries no ordering hints to forward'
        }]);
    });

    it('records a not-subscribed recipient outside and forwards the child\'s NACK without ordering hints', () => {
        const candidate = computeArrival({ reason: 'not-subscribed' });

        expect(validateALInboundNackAdmission(candidate)).toEqual([]);
        expect(candidate.pending).toEqual({ kind: 'pending', value: { ...ROW, outsideAudiencePeerIds: ['leaf'] } });
        expect(toUpwardControls(candidate)).toEqual([{
            type: 'nack',
            payload: { ...toChildNack({ reason: 'not-subscribed' }), fromPeerId: 'relay', toPeerId: 'parent' }
        }]);
    });

    it('stores an outside-audience NACK in the nacks history, bounded by collectionEntries, and writes no row for a gap NACK', () => {
        const limit = AL_MESSAGE_RESOURCE_LIMITS.collectionEntries;
        const stored = Array.from({ length: limit }, (_, index) =>
            toTestALNackPayload({
                msgId: 'subject',
                fromPeerId: 'child',
                toPeerId: 'relay',
                originPeerId: 'origin',
                logicalRecipientPeerId: `earlier-${index}`,
                reason: 'not-subscribed'
            }));
        const outside = computeArrival({ reason: 'before-entry' }, ROW, [], stored);
        const gap = computeArrival({ reason: 'gap' }, ROW, [], stored);

        const nacksRow = toALInboundNackCommitBundle(outside).mutations.find((mutation) => mutation.kind === 'set-control-nacks');
        expect(nacksRow).toEqual({
            kind: 'set-control-nacks',
            msgId: 'subject',
            senderId: 'origin',
            value: { kind: 'nacks', values: [...stored.slice(1), toChildNack({ reason: 'before-entry' })] },
            expireAtTimestamp: NOW_MS + RETENTION.controlHistoryTtlMs
        });
        expect(toALInboundNackCommitBundle(gap).mutations).toEqual([]);
    });

    it('refuses a NACK only against a same statement: a second statement about a recipient recorded outside is forwarded', () => {
        const stored = toChildNack({ reason: 'not-subscribed', proof: toTestSignatureProof(1) });
        const candidate = computeArrival(
            { reason: 'not-subscribed', proof: toTestSignatureProof(2) },
            { ...ROW, outsideAudiencePeerIds: ['leaf'] },
            [],
            [stored]
        );

        expect(validateALInboundNackAdmission(candidate)).toEqual([]);
    });

    it('records a recipient outside once when a second distinct statement names it', () => {
        const stored = toChildNack({ reason: 'not-subscribed', proof: toTestSignatureProof(1) });
        const candidate = computeArrival(
            { reason: 'not-subscribed', proof: toTestSignatureProof(2) },
            { ...ROW, outsideAudiencePeerIds: ['leaf'] },
            [],
            [stored]
        );

        expect(candidate.pending?.value.outsideAudiencePeerIds).toEqual(['leaf']);
        expect(candidate.nacks?.values).toHaveLength(2);
        expect(toUpwardControls(candidate).filter((control) => control?.type === 'nack')).toHaveLength(1);
    });

    it('refuses a NACK after a confirmation only when the confirmation is the same statement', () => {
        const unsigned = computeArrival({ reason: 'not-subscribed' }, ROW, [toConfirmation('leaf')]);
        const confirmed = [toConfirmation('leaf', toTestSignatureProof(1))];
        // One proof cannot sign an ACK and a NACK, so a NACK under the confirmation's proof is another statement.
        const sharedProof = computeArrival({ reason: 'not-subscribed', proof: toTestSignatureProof(1) }, ROW, confirmed);
        const distinct = computeArrival({ reason: 'not-subscribed', proof: toTestSignatureProof(2) }, ROW, confirmed);

        expect(validateALInboundNackAdmission(unsigned)).toEqual([{
            code: 'unauthorized',
            message: 'Inbound NACK names a recipient whose confirmation was already forwarded'
        }]);
        expect(validateALInboundNackAdmission(sharedProof)).toEqual([]);
        expect(validateALInboundNackAdmission(distinct)).toEqual([]);
    });

    it('admits a distinct statement about a recipient already recorded outside when the outside list is full', () => {
        const full = ['leaf', ...Array.from({ length: AL_MESSAGE_RESOURCE_LIMITS.collectionEntries - 1 }, (_, index) => `outside-${index}`)];
        const stored = toChildNack({ reason: 'not-subscribed', proof: toTestSignatureProof(1) });
        const candidate = computeArrival(
            { reason: 'not-subscribed', proof: toTestSignatureProof(2) },
            { ...ROW, outsideAudiencePeerIds: full },
            [],
            [stored]
        );

        expect(validateALInboundNackAdmission(candidate)).toEqual([]);
    });

    it('refuses a NACK for a new recipient when the outside list is full', () => {
        const full = Array.from({ length: AL_MESSAGE_RESOURCE_LIMITS.collectionEntries }, (_, index) => `outside-${index}`);
        const candidate = computeArrival({ reason: 'not-subscribed' }, { ...ROW, outsideAudiencePeerIds: full });

        expect(validateALInboundNackAdmission(candidate)).toEqual([{
            code: 'unauthorized',
            message: 'Inbound NACK candidate exceeds persistence limits'
        }]);
    });
});

describe('a child\'s gap NACK at a relay that keeps no row for a message asking for no receipt (6c)', () => {
    const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' } as const;

    /** The message `origin` sent with no receipt on the track `feed` at seq 3, frozen to `targets`' audience. */
    function toUnreceiptedMessage(targets: ALMessage['targets']): ALMessage {
        const message = newALMulticastMessage({
            createdAtEpochMs: NOW_MS,
            senderId: 'origin',
            route: { topicId: 'room.feed', resourceId: 'subject', contextId: ROOM.groupId },
            groupRef: ROOM,
            typeId: 'room.feed.v1',
            resource: {},
            options: { ttlMs: 60_000, reliability: 'at-least-once', ack: 'none' }
        });
        return { ...message, id: { ...message.id, msgId: 'subject' }, targets, ordering: { orderingKey: 'feed', epoch: 1, seq: 3 } };
    }

    const FROZEN = { mode: 'multicast', groupRef: ROOM, recipientPeerIds: ['child', 'leaf'], snapshotVersion: 1 } as const;

    function readUnreceipted(
        arrival: NackArrival,
        targets: ALMessage['targets'] = FROZEN
    ): ALInboundUnreceiptedGapNackAdmissionRead {
        const msg = toUnreceiptedMessage(targets);
        const nack = toChildNack({ ...arrival, ordering: arrival.ordering ?? { ...GAP_ORDERING, orderingKey: toALOrderingTrackKey(msg) } });
        return {
            namespace: 'relay',
            nack: { ...nack, reason: 'gap' },
            msg,
            owner: {
                msgId: 'subject',
                senderId: 'origin',
                source: { kind: 'rtc-peer', peerId: 'parent' },
                supersedenceKey: null,
                deliveredLocally: false,
                originAuthenticated: false
            },
            arrivalPeerId: 'parent',
            route: { isLayoutChild: false, upstreamPeerId: undefined, relayHops: AL_GAP_NACK_RELAY_HOP_LIMIT },
            childPeerIds: ['child'],
            nowMs: NOW_MS,
            controlMsgId: 'forwarded',
            traceId: 'trace-relayed-nack'
        };
    }

    it('forwards the child\'s own gap NACK toward the parent, writing no row', () => {
        const read = readUnreceipted({ reason: 'gap', logicalRecipientPeerId: 'child' });
        const candidate = computeALInboundUnreceiptedGapNackAdmission(read, RETENTION);

        expect(validateALInboundUnreceiptedGapNackAdmission(read)).toEqual([]);
        expect(toALInboundNackCommitBundle(candidate).mutations).toEqual([]);
        expect(toUpwardControls(candidate)).toEqual([{ type: 'nack', payload: toRelayedNack(read.nack, 'parent') }]);
    });

    it.each(['child', 'leaf'])(
        'forwards a gap NACK for %s to the relay\'s current upstream peer, though the peer the message arrived from is still there (6d)',
        (recipient) => {
            const read = { ...readUnreceipted({ reason: 'gap', logicalRecipientPeerId: recipient }), route: NEW_UPSTREAM };
            const candidate = computeALInboundUnreceiptedGapNackAdmission(read, RETENTION);

            expect(validateALInboundUnreceiptedGapNackAdmission(read)).toEqual([]);
            expect(toUpwardControls(candidate)).toEqual([{ type: 'nack', payload: toRelayedNack(read.nack, 'new-parent') }]);
        }
    );

    it('forwards the own gap NACK of a peer the accepted layout names its child, though the copy\'s plan does not (6d)', () => {
        const route = { ...NEW_UPSTREAM, isLayoutChild: true };
        const read = { ...readUnreceipted({ reason: 'gap', fromPeerId: 'leaf', logicalRecipientPeerId: 'leaf' }), route };
        const candidate = computeALInboundUnreceiptedGapNackAdmission(read, RETENTION);

        expect(validateALInboundUnreceiptedGapNackAdmission(read)).toEqual([]);
        expect(toUpwardControls(candidate)).toEqual([{ type: 'nack', payload: toRelayedNack(read.nack, 'new-parent') }]);
    });

    it('refuses a gap NACK with no relay hop left, and one that speaks for this relay (ruling 20)', () => {
        const spent = readUnreceipted({ reason: 'gap', relayHopsLeft: 0 });
        const ownReport = readUnreceipted(
            { reason: 'gap', logicalRecipientPeerId: 'relay' },
            { ...FROZEN, recipientPeerIds: ['child', 'leaf', 'relay'] }
        );

        expect(validateALInboundUnreceiptedGapNackAdmission(spent)).toEqual([NO_RELAY_HOP_LEFT]);
        expect(validateALInboundUnreceiptedGapNackAdmission(ownReport)).toEqual([SPEAKS_FOR_RELAY]);
    });

    it('clamps a hostile child\'s 255 relay hops to its own grant in a room of three sessions', () => {
        const read = readUnreceipted({ reason: 'gap', logicalRecipientPeerId: 'child', relayHopsLeft: 255 });
        const candidate = computeALInboundUnreceiptedGapNackAdmission(
            { ...read, route: { ...read.route, relayHops: THREE_SESSION_GRANT } },
            RETENTION
        );

        expect(toUpwardControls(candidate)[0]?.payload).toMatchObject({ toPeerId: 'parent', relayHopsLeft: 1 });
    });

    it('refuses a gap NACK with hops left whose relay grants it none', () => {
        const read = readUnreceipted({ reason: 'gap', logicalRecipientPeerId: 'child', relayHopsLeft: 3 });

        expect(validateALInboundUnreceiptedGapNackAdmission({ ...read, route: { ...read.route, relayHops: 0 } })).toEqual([NO_RELAY_HOP_LEFT]);
    });

    it('forwards a child\'s gap NACK for a recipient of the frozen audience below it', () => {
        expect(validateALInboundUnreceiptedGapNackAdmission(readUnreceipted({ reason: 'gap', logicalRecipientPeerId: 'leaf' }))).toEqual([]);
    });

    it('refuses a gap NACK naming a recipient outside the frozen audience', () => {
        expect(validateALInboundUnreceiptedGapNackAdmission(readUnreceipted({ reason: 'gap', logicalRecipientPeerId: 'stranger' })))
            .toEqual([{ code: 'unauthorized', message: 'Inbound NACK names no recipient of the frozen audience' }]);
    });

    it('refuses a gap NACK from the peer the message arrived from', () => {
        expect(validateALInboundUnreceiptedGapNackAdmission(readUnreceipted({ reason: 'gap', fromPeerId: 'parent', logicalRecipientPeerId: 'leaf' })))
            .toEqual([
                { code: 'unauthorized', message: 'Inbound NACK comes from the peer the message arrived from' },
                { code: 'unauthorized', message: 'Inbound NACK comes from no child this relay forwards the message to' }
            ]);
    });

    it.each(
        [
            ['a frozen audience', FROZEN],
            ['no frozen audience', { mode: 'broadcast', scope: 'room', groupRef: ROOM } as const]
        ] as const
    )('refuses, under %s, the own gap NACK of a peer this relay forwards the message to no copy of', (_name, targets) => {
        const read = readUnreceipted({ reason: 'gap', fromPeerId: 'leaf', logicalRecipientPeerId: 'leaf' }, targets);

        expect(validateALInboundUnreceiptedGapNackAdmission(read))
            .toEqual([{ code: 'unauthorized', message: 'Inbound NACK comes from no child this relay forwards the message to' }]);
    });

    it('forwards a child\'s own gap NACK and one it relayed for a recipient below it, for a message that froze no audience', () => {
        const broadcast = { mode: 'broadcast', scope: 'room', groupRef: ROOM } as const;

        expect(validateALInboundUnreceiptedGapNackAdmission(readUnreceipted({ reason: 'gap', logicalRecipientPeerId: 'child' }, broadcast))).toEqual([]);
        expect(validateALInboundUnreceiptedGapNackAdmission(readUnreceipted({ reason: 'gap', logicalRecipientPeerId: 'leaf' }, broadcast))).toEqual([]);
    });

    it('refuses a gap NACK naming another track than the message\'s', () => {
        expect(
            validateALInboundUnreceiptedGapNackAdmission(
                readUnreceipted({ reason: 'gap', logicalRecipientPeerId: 'child', ordering: { ...GAP_ORDERING, orderingKey: 'other:origin:1' } })
            )
        )
            .toEqual([{ code: 'unauthorized', message: 'Inbound NACK names a track the message is not on' }]);
    });

    it('refuses a gap NACK without its ordering hints as malformed', () => {
        const read = readUnreceipted({ reason: 'gap', logicalRecipientPeerId: 'child' });

        expect(validateALInboundUnreceiptedGapNackAdmission({ ...read, nack: { ...read.nack, expectedSeq: undefined } }))
            .toEqual([{ code: 'malformed', message: 'Inbound gap NACK carries no ordering hints to forward' }]);
    });
});

describe('a child\'s gap NACK at a relay that holds nothing of the message (6d)', () => {
    const unheldRead = (arrival: Omit<NackArrival, 'reason'> = {}) => ({
        namespace: 'relay',
        nack: { ...toChildNack({ reason: 'gap', logicalRecipientPeerId: 'child', ...arrival }), reason: 'gap' as const },
        parent: { kind: 'rtc-peer' as const, peerId: 'parent' },
        relayHops: AL_GAP_NACK_RELAY_HOP_LIMIT,
        nowMs: NOW_MS,
        controlMsgId: 'forwarded',
        traceId: 'trace-relayed-nack'
    });

    it('forwards the child\'s gap NACK to the parent its layout names, observing no owner row and writing none', () => {
        const read = unheldRead();
        const candidate = computeALInboundUnheldGapNackAdmission(read, RETENTION);
        const bundle = toALInboundNackCommitBundle(candidate);

        expect(validateALInboundUnheldGapNackAdmission(read)).toEqual([]);
        expect(bundle.mutations).toEqual([]);
        expect(bundle.observations.messageOwner).toBeUndefined();
        expect(toUpwardControls(candidate)).toEqual([{ type: 'nack', payload: toRelayedNack(read.nack, 'parent') }]);
    });

    it('forwards a NACK a child relayed for a recipient below it, as the origin judges whom it speaks for (ruling 20)', () => {
        const read = unheldRead({ logicalRecipientPeerId: 'leaf' });

        expect(validateALInboundUnheldGapNackAdmission(read)).toEqual([]);
        expect(toUpwardControls(computeALInboundUnheldGapNackAdmission(read, RETENTION)))
            .toEqual([{ type: 'nack', payload: toRelayedNack(read.nack, 'parent') }]);
    });

    it('clamps a hostile child\'s 255 relay hops to the grant of the room its layout names it in, of three sessions', () => {
        const read = { ...unheldRead({ relayHopsLeft: 255 }), relayHops: THREE_SESSION_GRANT };

        expect(toUpwardControls(computeALInboundUnheldGapNackAdmission(read, RETENTION))[0]?.payload)
            .toMatchObject({ toPeerId: 'parent', relayHopsLeft: 1 });
    });

    it('refuses a gap NACK with hops left whose relay grants it none', () => {
        expect(validateALInboundUnheldGapNackAdmission({ ...unheldRead({ relayHopsLeft: 3 }), relayHops: 0 })).toEqual([NO_RELAY_HOP_LEFT]);
    });

    it('refuses a NACK without its ordering hints, one with no relay hop left, and one that speaks for this relay', () => {
        expect(validateALInboundUnheldGapNackAdmission(unheldRead({ ordering: {} })))
            .toEqual([{ code: 'malformed', message: 'Inbound gap NACK carries no ordering hints to forward' }]);
        expect(validateALInboundUnheldGapNackAdmission(unheldRead({ relayHopsLeft: 0 }))).toEqual([NO_RELAY_HOP_LEFT]);
        expect(validateALInboundUnheldGapNackAdmission(unheldRead({ logicalRecipientPeerId: 'relay' }))).toEqual([SPEAKS_FOR_RELAY]);
    });
});
