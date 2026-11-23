import { describe, expect, it } from 'vitest';

import type { ALMessage, ALTargets } from '@shared/al-contracts/al-contract.ts';
import { AL_RECEIPT_RECORD_WINDOW_MS } from '@shared/alm/receipt-record/validate-al-receipt-record-opening.ts';
import {
    toWsQueueBoxServerCopyReceiptOpening,
    toWsQueueBoxServerFrozenAudience,
    toWsQueueBoxServerReceiptOpening,
    type WsQueueBoxServerCopyReceiptOpeningInput,
    type WsQueueBoxServerReceiptOpeningInput
} from '@shared/services/ws-queue-box-server/receipt/to-ws-queue-box-server-receipt-opening.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const NOW_MS = 1_800_000_000_000;
const ACK_TIMEOUT_MS = 2_000;
const OWN_DEADLINE_AT_MS = NOW_MS + 30_000;
const SNAPSHOT_VERSION = 7;
const ROOM_BROADCAST: ALTargets = { mode: 'broadcast', scope: 'room', groupRef: ROOM };

function message(targets: ALTargets, ts = NOW_MS): ALMessage {
    return {
        id: { v: 4, msgId: 'room-message-1', ts, senderId: 'a', traceId: 'trace-receipt-opening' },
        route: { topicId: 'room.notification', resourceId: 'resource', contextId: ROOM.groupId },
        targets,
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
    };
}

function admission(overrides: Partial<WsQueueBoxServerReceiptOpeningInput> = {}): WsQueueBoxServerReceiptOpeningInput {
    return {
        message: message(ROOM_BROADCAST),
        originPeerId: 'a',
        neverSentRecipientPeerIds: ['c'],
        roomAudience: { recipientPeerIds: ['a', 'b', 'c'], snapshotVersion: SNAPSHOT_VERSION },
        terms: { ownDeadlineAtMs: OWN_DEADLINE_AT_MS, ackTimeoutMs: ACK_TIMEOUT_MS },
        nowMs: NOW_MS,
        ...overrides
    };
}

function copy(overrides: Partial<WsQueueBoxServerCopyReceiptOpeningInput> = {}): WsQueueBoxServerCopyReceiptOpeningInput {
    return { ...admission(), ingressAudience: ['a', 'b', 'c', 'd'], ...overrides };
}

describe('the frozen audience a receipt expects', () => {
    it('is the unicast addressee alone when the room admitted it, and nobody when it did not or it is the origin', () => {
        // Pins D53: a unicast's receipt may not expect a session its room never admitted, nor wait on the origin.
        expect([
            toWsQueueBoxServerFrozenAudience(message({ mode: 'unicast', toPeerId: 'b' }), 'a', ['a', 'b', 'c']),
            toWsQueueBoxServerFrozenAudience(message({ mode: 'unicast', toPeerId: 'd' }), 'a', ['a', 'b', 'c']),
            toWsQueueBoxServerFrozenAudience(message({ mode: 'unicast', toPeerId: 'a' }), 'a', ['a', 'b', 'c'])
        ]).toEqual([['b'], [], []]);
    });

    it('keeps a frozen multicast audience verbatim but its origin, a session that left included', () => {
        // Pins Q12: a session that left after the origin froze the audience reads unconfirmed, not silently dropped.
        const frozen = message({
            mode: 'multicast',
            groupRef: ROOM,
            recipientPeerIds: ['a', 'b', 'left'],
            snapshotVersion: 3
        });
        expect(toWsQueueBoxServerFrozenAudience(frozen, 'a', ['a', 'b', 'c'])).toEqual(['b', 'left']);
    });

    it('is a broadcast\'s authorized sessions but its origin, its exceptions and those its recipient list leaves out', () => {
        // Pins that a receipt never waits on a session the broadcast itself excluded.
        const narrowed = message({ ...ROOM_BROADCAST, exceptPeerIds: ['c'], recipientPeerIds: ['a', 'b', 'c', 'e'] });
        expect(toWsQueueBoxServerFrozenAudience(narrowed, 'a', ['a', 'b', 'c', 'd', 'e'])).toEqual(['b', 'e']);
    });

    it('is every authorized session but its origin for a message with no targets or an unfrozen multicast', () => {
        // Pins the broadcast filter reaching a message that is not a broadcast: only the origin is left out.
        const untargeted: ALMessage = { ...message(ROOM_BROADCAST), targets: undefined };
        const unfrozen = message({ mode: 'multicast', groupRef: ROOM });
        expect([
            toWsQueueBoxServerFrozenAudience(untargeted, 'a', ['a', 'b', 'c']),
            toWsQueueBoxServerFrozenAudience(unfrozen, 'a', ['a', 'b', 'c'])
        ]).toEqual([['b', 'c'], ['b', 'c']]);
    });

    it('names an authorized session once', () => {
        // Pins that an audience listing a session twice does not make the receipt wait for two of its ACKs.
        expect(toWsQueueBoxServerFrozenAudience(message(ROOM_BROADCAST), 'a', ['b', 'c', 'b', 'a'])).toEqual(['b', 'c']);
    });
});

describe('the opening of an admitted send', () => {
    it('takes the message\'s own deadline', () => {
        // Pins the whole opening: identity, the frozen room audience, those never sent, the room's version.
        expect(toWsQueueBoxServerReceiptOpening(admission())).toEqual({
            msgId: 'room-message-1',
            originPeerId: 'a',
            traceId: 'trace-receipt-opening',
            expectedRecipientPeerIds: ['b', 'c'],
            neverSentRecipientPeerIds: ['c'],
            snapshotVersion: SNAPSHOT_VERSION,
            deadlineAtMs: OWN_DEADLINE_AT_MS
        });
    });

    it('takes its ACK timeout from now when the message names none', () => {
        // Pins that a message without its own deadline still gets a head that ends.
        const opening = toWsQueueBoxServerReceiptOpening(
            admission({ terms: { ownDeadlineAtMs: undefined, ackTimeoutMs: ACK_TIMEOUT_MS } })
        );
        expect(opening.deadlineAtMs).toBe(NOW_MS + ACK_TIMEOUT_MS);
    });

    it('never lies beyond the record\'s window', () => {
        // Pins that a client naming a far deadline cannot keep a head past the record's window.
        const opening = toWsQueueBoxServerReceiptOpening(
            admission({ terms: { ownDeadlineAtMs: NOW_MS + AL_RECEIPT_RECORD_WINDOW_MS + 1, ackTimeoutMs: ACK_TIMEOUT_MS } })
        );
        expect(opening.deadlineAtMs).toBe(NOW_MS + AL_RECEIPT_RECORD_WINDOW_MS);
    });
});

describe('the opening of a re-sent copy', () => {
    it('opens nothing without an admission row, without an own deadline, beyond the window, or as old as the window', () => {
        // Pins that a copy never reopens a head whose first one may have ended and expired.
        const noDeadline = { ownDeadlineAtMs: undefined, ackTimeoutMs: ACK_TIMEOUT_MS };
        const beyondWindow = { ownDeadlineAtMs: NOW_MS + AL_RECEIPT_RECORD_WINDOW_MS + 1, ackTimeoutMs: ACK_TIMEOUT_MS };
        expect([
            toWsQueueBoxServerCopyReceiptOpening(copy({ ingressAudience: undefined })),
            toWsQueueBoxServerCopyReceiptOpening(copy({ terms: noDeadline })),
            toWsQueueBoxServerCopyReceiptOpening(copy({ terms: beyondWindow })),
            toWsQueueBoxServerCopyReceiptOpening(
                copy({ message: message(ROOM_BROADCAST, NOW_MS - AL_RECEIPT_RECORD_WINDOW_MS) })
            )
        ]).toEqual([undefined, undefined, undefined, undefined]);
    });

    it('opens a copy whose own deadline lies exactly at the window\'s edge', () => {
        // Pins the guard refusing only a deadline beyond the window (`>`), as the record's own opening validator does: a
        // copy naming the edge itself opens its head there, not nothing.
        const atEdge = { ownDeadlineAtMs: NOW_MS + AL_RECEIPT_RECORD_WINDOW_MS, ackTimeoutMs: ACK_TIMEOUT_MS };
        expect(toWsQueueBoxServerCopyReceiptOpening(copy({ terms: atEdge }))?.deadlineAtMs)
            .toBe(NOW_MS + AL_RECEIPT_RECORD_WINDOW_MS);
    });

    it('opens nothing for a row that freezes to nobody', () => {
        // Pins that a copy whose admission held only its origin opens no head that could never complete.
        expect(toWsQueueBoxServerCopyReceiptOpening(copy({ ingressAudience: ['a'] }))).toBeUndefined();
    });

    it('expects the admission row\'s audience and records nobody never sent', () => {
        // Pins that the copy answers for the audience its admission committed, not the room's current one.
        expect(toWsQueueBoxServerCopyReceiptOpening(copy())).toEqual({
            msgId: 'room-message-1',
            originPeerId: 'a',
            traceId: 'trace-receipt-opening',
            expectedRecipientPeerIds: ['b', 'c', 'd'],
            neverSentRecipientPeerIds: [],
            snapshotVersion: SNAPSHOT_VERSION,
            deadlineAtMs: OWN_DEADLINE_AT_MS
        });
    });
});
