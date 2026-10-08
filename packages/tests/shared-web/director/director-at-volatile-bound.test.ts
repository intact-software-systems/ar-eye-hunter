import { BrowserDirectorRelayTransport } from '@shared-web/browser/director/browser-director-relay-transport.ts';
import type { RallarDirectorStatus } from '@shared-web/browser/director/rallar-director-facade.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    AL_VOLATILE_SESSION_LIMITS,
    ALVolatileSessionBudget
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { toALVolatileSessionQosProvider } from '@shared/alm/volatile-budget/to-al-volatile-session-qos-provider.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOriginSnapshot, ORIGIN_ROOM } from '../../shared/multicast/rtc-origin-overlay-fixture.ts';
import {
    createRtcRelayOverlayFixture,
    type RtcRelayOverlayFixture
} from '../../shared/multicast/rtc-relay-overlay-fixture.ts';
import { createBrowserMessageSenderFixture } from '../messages/browser-message-sender-fixture.ts';

/** The session of the browser sender fixture, which is the director here. */
const DIRECTOR_PEER_ID = 'session-1';

const DIRECTOR_STATUS: RallarDirectorStatus = {
    roomRef: ORIGIN_ROOM,
    roomId: 'room',
    role: 'director',
    state: 'fresh',
    isDirector: true,
    isFresh: true,
    active: true,
    freshness: 'fresh',
    nowEpochMs: 0,
    appointment: {
        version: 1,
        mode: 'appointed-spa',
        sessionId: DIRECTOR_PEER_ID,
        principalId: 'principal',
        epoch: 1,
        appointedAtEpochMs: 0,
        heartbeatTtlMs: 5_000
    }
};

interface DirectorAtTheBound {
    readonly rtc: RtcRelayOverlayFixture;
    readonly transport: BrowserDirectorRelayTransport;
}

describe('a director at its volatile bound (D78)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('still acknowledges a client intent over RTC', async () => {
        const director = createDirectorAtTheBound();
        const intent = createClientIntent('intent-at-the-bound');

        await director.rtc.receive(intent, 'a');

        const controls = (await director.rtc.readSent('a')).map((control) => parseALControlMessage(control));
        expect(controls).toEqual([
            expect.objectContaining({
                type: 'ack',
                payload: expect.objectContaining({ ackedMsgId: intent.id.msgId, status: 'delivered' })
            })
        ]);
    });

    it('has its own heartbeat refused for capacity, on the RTC handle and without an RTC copy', async () => {
        const director = createDirectorAtTheBound();

        const result = await director.transport.sendRoomEnvelope({
            current: DIRECTOR_STATUS,
            topicId: 'room.director',
            typeId: 'room.director.heartbeat.v1',
            payload: { sessionId: DIRECTOR_PEER_ID },
            ack: undefined
        });

        expect(result.status).toBe('failed');
        expect(result.rtc?.lifecycle()).toMatchObject({
            state: 'rejected',
            evidence: { failure: { kind: 'refused', reason: 'capacity' } }
        });
        expect(await director.rtc.readSent('a')).toEqual([]);
    });
});

/** The director session at its bound: its RTC carrier is a real overlay manager, its WS carrier refuses for capacity. */
function createDirectorAtTheBound(): DirectorAtTheBound {
    const budget = new ALVolatileSessionBudget({ ...AL_VOLATILE_SESSION_LIMITS, maxAdmissions: 1 });
    budget.record({ msgId: 'received', bytes: 1, deadlineAtMs: Date.now() + 60_000, nowMs: Date.now(), trackKey: undefined });
    const rtc = createRtcRelayOverlayFixture({
        selfPeerId: DIRECTOR_PEER_ID,
        snapshot: createOriginSnapshot(['a', DIRECTOR_PEER_ID], 4),
        neighbourPeerIds: ['a'],
        overlayIds: ['room', toScopedOverlayId(ORIGIN_ROOM)],
        qosProvider: toALVolatileSessionQosProvider(undefined, budget, Date.now)
    });
    const fixture = createBrowserMessageSenderFixture();
    fixture.middleware.middleware.rtcRxStreamer.enqueueOutboxIfAbsent = async (message) => await rtc.enqueue(message);
    // The WS carrier shares the session budget, whose own admission refuses the same send.
    fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent = async (message) => toCapacityRefusal(message);
    const transport = new BrowserDirectorRelayTransport({
        messages: {
            rtc: { send: async (input) => await fixture.sender.sendRtc(input, undefined), onMessage: () => () => {} },
            ws: { send: async (input) => await fixture.sender.sendWs(input, undefined), onMessage: () => () => {} },
            channel: () => {
                throw new Error('A director heartbeat travels the lane sends.');
            },
            room: () => {
                throw new Error('A director heartbeat travels the lane sends.');
            }
        },
        readSession: () => fixture.middleware.session
    });
    return { rtc, transport };
}

function createClientIntent(resourceId: string): ALMessage {
    return newALUnicastMessage(
        'a',
        { topicId: 'room.director', resourceId, contextId: 'room' },
        DIRECTOR_PEER_ID,
        'room.director.intent.v1',
        { intent: resourceId },
        { groupRef: ORIGIN_ROOM, reliability: 'at-least-once', ack: 'receiver', ownership: 'shared', ttlMs: 30_000 }
    );
}

function toCapacityRefusal(message: ALMessage): ALOutboundEnqueueResult {
    const detail = 'The session volatile bound is full.';
    return {
        verdict: { kind: 'refused', reason: 'capacity', detail },
        message,
        entries: [],
        reason: detail,
        trackedReceiptAlgo: 'none'
    };
}
