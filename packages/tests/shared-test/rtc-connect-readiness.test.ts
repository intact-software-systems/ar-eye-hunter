import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { RallarWsStatus } from '@shared-web/browser/rallar-realtime-facade.ts';
import type {
    RallarRoomTransportStatus,
    RallarRtcRoomTransportStatus
} from '@shared-web/browser/rallar-rtc-facade.ts';

import { waitForRtcConnectReadiness } from '../../../packages/shared-test/rallar-bb-test/browser/rtc-connect-readiness.ts';

const OPEN_WS_STATUS: RallarWsStatus = {
    connectState: 'connected',
    readyState: 'open',
    isOpen: true,
    reconnecting: false,
    reconnectEnabled: true,
    reconnectAttempts: 0,
    maxReconnectAttempts: 5,
    reconnectExhausted: false
};

function createRoomStatus(rtc: RallarRtcRoomTransportStatus): RallarRoomTransportStatus {
    return { ws: OPEN_WS_STATUS, rtc };
}

const ROOM_WITH_PEER_BEING_REPLACED = createRoomStatus({
    desired: true,
    mode: 'eager',
    state: 'connecting',
    desiredPeerIds: ['bob'],
    knownPeerIds: ['bob'],
    activePeerIds: [],
    readyPeerIds: [],
    failedPeerIds: [],
    peers: [],
    laneId: 'lane-1'
});

const ROOM_WITH_REPLACEMENT_STILL_PENDING = createRoomStatus({
    ...ROOM_WITH_PEER_BEING_REPLACED.rtc,
    state: 'degraded'
});

const ROOM_READY = createRoomStatus({
    desired: true,
    mode: 'eager',
    state: 'open',
    acceptedLayoutIdentity: { groupRevision: 7, presenceRevision: 1, version: 1, state: 'active' },
    desiredPeerIds: ['bob'],
    knownPeerIds: ['bob'],
    activePeerIds: ['bob'],
    readyPeerIds: ['bob'],
    failedPeerIds: [],
    peers: [],
    laneId: 'lane-1'
});

function createRtcRoomRuntime(waitForRoom: () => Promise<RallarRoomTransportStatus>) {
    return {
        refreshRoom: vi.fn().mockResolvedValue(undefined),
        waitForRoom: vi.fn(waitForRoom),
        health: vi.fn().mockResolvedValue({})
    };
}

describe('waitForRtcConnectReadiness for the room transport', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('retries a room wait that ends on a peer being replaced until a later attempt is ready', async () => {
        let call = 0;
        const runtime = createRtcRoomRuntime(async () => {
            call += 1;
            return call === 1 ? ROOM_WITH_PEER_BEING_REPLACED : ROOM_READY;
        });

        const result = await waitForRtcConnectReadiness({
            runtime,
            transport: 'messages.rtc',
            options: { minReadyPeers: 1, timeoutMs: 5_000, intervalMs: 5 }
        });

        expect(runtime.waitForRoom).toHaveBeenCalledTimes(2);
        expect(result.ready).toBe(true);
        expect(result.readyPeerIds).toEqual(['bob']);
        expect(result.room).toBe(ROOM_READY);
    });

    it('stops retrying once the deadline passes between attempts and returns the last not-ready result', async () => {
        const now = vi.spyOn(Date, 'now');
        let virtualNow = 1_000;
        now.mockImplementation(() => virtualNow);

        const rooms = [ROOM_WITH_PEER_BEING_REPLACED, ROOM_WITH_REPLACEMENT_STILL_PENDING];
        let call = 0;
        const runtime = createRtcRoomRuntime(async () => {
            const room = rooms[call];
            call += 1;
            if (call === 1) {
                virtualNow = 1_010;
            }
            else {
                // The deadline (startedAtEpochMs 1_000 + timeoutMs 5_000) has now passed.
                virtualNow = 6_001;
            }
            return room;
        });

        const resultPromise = waitForRtcConnectReadiness({
            runtime,
            transport: 'messages.rtc',
            options: { minReadyPeers: 1, timeoutMs: 5_000, intervalMs: 5 }
        });

        let settledEarly = false;
        resultPromise.then(() => {
            settledEarly = call < 2;
        });

        await new Promise((resolve) => setTimeout(resolve, 20));

        const result = await resultPromise;

        expect(settledEarly).toBe(false);
        expect(runtime.waitForRoom).toHaveBeenCalledTimes(2);
        expect(result.ready).toBe(false);
        expect(result.room).toBe(ROOM_WITH_REPLACEMENT_STILL_PENDING);
    });
});
