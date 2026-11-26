import { describe, expect, it } from 'vitest';

import {
    EdgeOrderSendStreams,
    type EdgeOrderOpenSend
} from '@shared-web/browser/messages/edge-order/edge-order-send-streams.ts';
import type { EdgeOrderStamp } from '@shared-web/browser/messages/edge-order/edge-order-stamp.ts';
import {
    createInitialALDeliveryLifecycle,
    type ALDeliveryLifecycle,
    type ALDeliveryState
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import { EDGE_ORDER_TEST_MOVES, EDGE_ORDER_TEST_ROOM } from './edge-order-page-fixture.ts';

const NOW_MS = 1_000;
const DEADLINE_MS = 31_000;

interface ObservedSend {
    readonly send: EdgeOrderOpenSend;
    /** The lifecycle the send's handle reads from here on. */
    setState(state: ALDeliveryState): void;
}

function createStreams(): EdgeOrderSendStreams {
    let minted = 0;
    return new EdgeOrderSendStreams({ newStreamId: () => `stream-${minted += 1}`, maxStreams: 4 });
}

function toLifecycle(state: ALDeliveryState): ALDeliveryLifecycle {
    const submitted = createInitialALDeliveryLifecycle({
        msgId: 'msg-1',
        typeId: 'game.move',
        ackMode: 'receiver',
        receiptAlgo: 'receiver',
        expiresAtMs: DEADLINE_MS,
        submittedAtMs: NOW_MS
    });
    return { ...submitted, state };
}

function openSend(streams: EdgeOrderSendStreams): EdgeOrderOpenSend {
    const send = streams.openSend({
        order: 'edge',
        topicId: EDGE_ORDER_TEST_MOVES.topicId,
        typeId: EDGE_ORDER_TEST_MOVES.typeId,
        roomRef: EDGE_ORDER_TEST_ROOM
    });
    if (send === undefined) {
        throw new Error('An edge-ordered channel\'s send has a position.');
    }
    return send;
}

/** One send of the test channel, opened, stamped and observed as the message sender does it. */
function openObservedSend(streams: EdgeOrderSendStreams, state: ALDeliveryState = 'queued'): ObservedSend {
    const send = openSend(streams);
    let lifecycle = toLifecycle(state);
    send.stamp(NOW_MS);
    send.observe({ lifecycle: () => lifecycle });
    return {
        send,
        setState: (next) => {
            lifecycle = toLifecycle(next);
        }
    };
}

/** The stamp of a fourth send, after three sends of which the second ended as stated. */
function stampAfterSecondEnded(state: ALDeliveryState, nowMs = NOW_MS): EdgeOrderStamp {
    const streams = createStreams();
    openObservedSend(streams);
    const second = openObservedSend(streams);
    openObservedSend(streams);
    second.setState(state);
    return openSend(streams).stamp(nowMs);
}

describe('the page\'s edge-ordered send streams: what a send\'s lifecycle tells receivers', () => {
    it.each<ALDeliveryState>(['rejected', 'cancelled', 'expired'])('states a %s send as a hole', (state) => {
        expect(stampAfterSecondEnded(state)).toMatchObject({ position: 4, lowestOpenPosition: 1, holes: [[2, 2]] });
    });

    it('states an acknowledged send as neither open nor a hole: a recipient has it', () => {
        expect(stampAfterSecondEnded('acknowledged')).toMatchObject({ position: 4, lowestOpenPosition: 1, holes: [] });
    });

    it.each<ALDeliveryState>(['failed', 'unobservable'])(
        'keeps a %s send open until its deadline, since a copy can still arrive, and says it is over from then on',
        (state) => {
            expect(stampAfterSecondEnded(state, DEADLINE_MS - 1)).toMatchObject({ lowestOpenPosition: 1, holes: [] });
            // At the deadline all three earlier sends are over, so the lowest open position says it for all of them.
            expect(stampAfterSecondEnded(state, DEADLINE_MS)).toMatchObject({ lowestOpenPosition: 4, holes: [] });
        }
    );

    it('gives the position of a send whose handle was refused before any carrier took it to the next send', () => {
        const streams = createStreams();
        openObservedSend(streams);
        openObservedSend(streams, 'rejected');

        const next = openObservedSend(streams);

        expect(next.send.stamp(NOW_MS)).toMatchObject({ position: 2, holes: [] });
    });

    it('counts the streams it minted and what they still keep', () => {
        const streams = createStreams();
        const first = openObservedSend(streams);
        openObservedSend(streams);
        streams.openSend({ order: 'edge', topicId: 'room.chat', typeId: 'chat.line', roomRef: EDGE_ORDER_TEST_ROOM });

        expect(streams.readUsage(NOW_MS)).toEqual({ sendStreams: 2, openSends: 3 });
        first.setState('acknowledged');
        expect(streams.readUsage(NOW_MS)).toEqual({ sendStreams: 2, openSends: 2 });
        // The send that was never observed has no deadline yet, so it stays.
        expect(streams.readUsage(DEADLINE_MS)).toEqual({ sendStreams: 2, openSends: 1 });
    });
});
