import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundPendingAckSnapshot } from '@shared/alm/al-runtime-state-stores.ts';
import { AL_RECEIPT_RECORD_WINDOW_MS } from '@shared/alm/receipt-record/validate-al-receipt-record-opening.ts';
import {
    toWsQueueBoxServerOwnReceiptOpening,
    type WsQueueBoxServerOwnReceiptOpeningInput
} from '@shared/services/ws-queue-box-server/receipt/to-ws-queue-box-server-own-receipt-opening.ts';

const SERVER = 'server';
const MSG = 'delta-1';
const TRACE = 'trace-own-receipt-opening';
const NOW = 1_800_000_000_000;
const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
/** The row a first dequeue writes: its window is one ACK timeout from now, and no attempt is charged. */
const PENDING: ALOutboundPendingAckSnapshot = {
    msgId: MSG,
    mode: 'receiver',
    expectedPeerIds: ['a', 'b'],
    ackedPeerIds: [],
    outsideAudiencePeerIds: [],
    timeoutMs: 2_000,
    maxAttempts: 3,
    attempts: 0,
    deadlineAtMs: NOW + 2_000
};

function publication(overrides: { readonly senderId?: string; readonly expiresAtMs?: number; } = {}): ALMessage {
    return {
        id: { v: 4, msgId: MSG, ts: NOW, senderId: overrides.senderId ?? SERVER, traceId: TRACE },
        route: { topicId: 'group-state.delta', resourceId: 'resource', contextId: ROOM.groupId },
        targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM },
        constraints: overrides.expiresAtMs === undefined ? undefined : { expiresAtMs: overrides.expiresAtMs },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'delta.v1', contentType: 'application/json', resource: '{}' }
    };
}

function input(overrides: Partial<WsQueueBoxServerOwnReceiptOpeningInput> = {}): WsQueueBoxServerOwnReceiptOpeningInput {
    return { message: publication(), pending: PENDING, serverPeerId: SERVER, nowMs: NOW, ...overrides };
}

describe('the head of a server publication', () => {
    it('expects the pending row\'s recipients and ends half a window before the row\'s budget', () => {
        // Half a window early: a head that ended with the row's budget left the row's own exhaustion to decide it.
        expect(toWsQueueBoxServerOwnReceiptOpening(input())).toEqual({
            originPeerId: SERVER,
            msgId: MSG,
            traceId: TRACE,
            expectedRecipientPeerIds: ['a', 'b'],
            neverSentRecipientPeerIds: [],
            snapshotVersion: 0,
            deadlineAtMs: NOW + 7_000
        });
    });

    it('is exact against a row whose windows have moved', () => {
        // Pins a head opened at a later window reading the full budget again from that window, past the row's end.
        const moved = { ...PENDING, attempts: 2, deadlineAtMs: NOW + 2_000 };

        expect(toWsQueueBoxServerOwnReceiptOpening(input({ pending: moved }))?.deadlineAtMs).toBe(NOW + 3_000);
    });

    it('never outlives the message\'s own expiry, nor the record\'s window', () => {
        // Pins a head waiting for recipients past the message's life, or past what the record keeps.
        const longRow = { ...PENDING, timeoutMs: AL_RECEIPT_RECORD_WINDOW_MS, deadlineAtMs: NOW + AL_RECEIPT_RECORD_WINDOW_MS };

        expect([
            toWsQueueBoxServerOwnReceiptOpening(input({ message: publication({ expiresAtMs: NOW + 4_000 }) }))?.deadlineAtMs,
            toWsQueueBoxServerOwnReceiptOpening(input({ pending: longRow }))?.deadlineAtMs
        ]).toEqual([NOW + 4_000, NOW + AL_RECEIPT_RECORD_WINDOW_MS]);
    });

    it('gives a publication with no retry half its one window', () => {
        // Pins a publication with no retry getting no window at all, its head ending before its one ACK could land.
        expect(toWsQueueBoxServerOwnReceiptOpening(input({ pending: { ...PENDING, maxAttempts: 0 } }))?.deadlineAtMs)
            .toBe(NOW + 1_000);
    });

    it('opens nothing for another peer\'s message, a hop row or an empty audience', () => {
        // Pins a head opened for a client's send under the server's terms, for a row no recipient counts, or for nobody.
        expect([
            toWsQueueBoxServerOwnReceiptOpening(input({ message: publication({ senderId: 'a' }) })),
            toWsQueueBoxServerOwnReceiptOpening(input({ pending: { ...PENDING, mode: 'hop' } })),
            toWsQueueBoxServerOwnReceiptOpening(input({ pending: { ...PENDING, expectedPeerIds: [] } }))
        ]).toEqual([undefined, undefined, undefined]);
    });
});
