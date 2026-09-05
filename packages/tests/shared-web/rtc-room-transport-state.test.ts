import { describe, expect, it } from 'vitest';

import { resolveRtcRoomTransportState } from '@shared-web/browser/rtc/rtc-room-transport-status.ts';

type TransportInput = Parameters<typeof resolveRtcRoomTransportState>[0];

const fullyReady: TransportInput = {
    mode: 'warm',
    hasAcceptedLayout: true,
    desiredPeerCount: 3,
    knownPeerCount: 3,
    activePeerCount: 3,
    readyPeerCount: 3,
    failedPeerCount: 0,
    minReadyPeers: 0
};

describe('resolveRtcRoomTransportState', () => {
    // Product decision 25: the transport valve is orthogonal to the stage, so
    // a halt is not a degraded or failed room -- it outranks every other
    // observation, including a room that is otherwise fully open.
    it('reports a halt ahead of every other observation', () => {
        expect(resolveRtcRoomTransportState({ ...fullyReady, transportState: 'halted' })).toBe('halted');
        expect(resolveRtcRoomTransportState({
            ...fullyReady,
            transportState: 'halted',
            mode: 'off',
            hasAcceptedLayout: false,
            readyPeerCount: 0,
            failedPeerCount: 3
        })).toBe('halted');
    });

    it('reports off ahead of everything but a halt', () => {
        expect(resolveRtcRoomTransportState({ ...fullyReady, mode: 'off' })).toBe('off');
    });

    // The member-progress scenario's "reports nothing while no layout exists".
    it('reports idle while no accepted layout exists, however many peers are ready', () => {
        expect(resolveRtcRoomTransportState({ ...fullyReady, hasAcceptedLayout: false })).toBe('idle');
    });

    it('reports open at full readiness and for an empty desired set', () => {
        expect(resolveRtcRoomTransportState(fullyReady)).toBe('open');
        expect(resolveRtcRoomTransportState({
            ...fullyReady,
            desiredPeerCount: 0,
            knownPeerCount: 0,
            activePeerCount: 0,
            readyPeerCount: 0
        })).toBe('open');
    });

    it('reports partial once a declared floor is met', () => {
        expect(resolveRtcRoomTransportState({
            ...fullyReady,
            readyPeerCount: 2,
            minReadyPeers: 2
        })).toBe('partial');
    });

    it('does not report partial without a declared floor', () => {
        expect(resolveRtcRoomTransportState({
            ...fullyReady,
            readyPeerCount: 2,
            minReadyPeers: 0
        })).toBe('connecting');
    });

    it('separates a degraded room from a failed one by whether anything is ready', () => {
        const exhausted = { ...fullyReady, readyPeerCount: 0, failedPeerCount: 3 };

        expect(resolveRtcRoomTransportState(exhausted)).toBe('failed');
        expect(resolveRtcRoomTransportState({ ...exhausted, readyPeerCount: 1, failedPeerCount: 2 }))
            .toBe('degraded');
    });

    it('treats a failed or timed-out wait as terminal even with peers still connecting', () => {
        const connecting = { ...fullyReady, readyPeerCount: 0, failedPeerCount: 0 };

        expect(resolveRtcRoomTransportState({ ...connecting, waitStatus: 'failed' })).toBe('failed');
        expect(resolveRtcRoomTransportState({ ...connecting, waitStatus: 'timeout' })).toBe('failed');
        expect(resolveRtcRoomTransportState({ ...connecting, readyPeerCount: 1, waitStatus: 'timeout' }))
            .toBe('degraded');
    });

    it('reports connecting while peers are known but none is ready yet', () => {
        expect(resolveRtcRoomTransportState({ ...fullyReady, readyPeerCount: 0 })).toBe('connecting');
    });

    // A layout naming peers none of which has been seen at all is not
    // "connecting" -- nothing is in flight to report progress on.
    it('reports idle when the layout names peers none of which is known', () => {
        expect(resolveRtcRoomTransportState({
            ...fullyReady,
            knownPeerCount: 0,
            activePeerCount: 0,
            readyPeerCount: 0
        })).toBe('idle');
    });
});
