import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { BlackBoxRallarRoomWaitOptions } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import type { RallarWsStatus } from '@shared-web/browser/rallar-realtime-facade.ts';
import type {
    RallarRoomTransportStatus,
    RallarRtcRoomTransportStatus
} from '@shared-web/browser/rallar-rtc-facade.ts';

import {
    decodeRtcReadyPeerIds,
    waitForRtcConnectReadiness
} from '../../../packages/shared-test/rallar-bb-test/browser/rtc-connect-readiness.ts';

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
        vi.useRealTimers();
    });

    it('decodes only string peer IDs from canonical lane health for send placeholders', () => {
        expect(decodeRtcReadyPeerIds({ rtcStatus: { readyPeerIds: ['bob', 42, null, 'charlie'] } }))
            .toEqual(['bob', 'charlie']);
        expect(decodeRtcReadyPeerIds({ readyPeerIds: ['unscoped-peer'] })).toEqual([]);
    });

    it.each(['realtime', 'messages.rtc'] as const)(
        'keeps %s readiness pending while two open lanes have no authorized room target',
        async (transport) => {
            vi.useFakeTimers();
            const readyRoom = createRoomStatus({
                ...ROOM_READY.rtc,
                desiredPeerIds: ['bob', 'charlie'],
                knownPeerIds: ['bob', 'charlie'],
                activePeerIds: ['bob', 'charlie'],
                readyPeerIds: ['bob', 'charlie']
            });
            const room = Promise.withResolvers<RallarRoomTransportStatus>();
            const runtime = {
                refreshRoom: async () => undefined,
                health: async () => ({ rtcStatus: { readyPeerIds: ['bob', 'charlie'] } }),
                waitForRoom: async () => await room.promise
            };
            const pending = waitForRtcConnectReadiness({
                runtime,
                transport,
                options: { minReadyPeers: 2, timeoutMs: 100, intervalMs: 1 }
            });
            let settled = false;
            void pending.then(() => {
                settled = true;
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(settled).toBe(false);

            room.resolve(readyRoom);
            const result = await pending;
            expect(result.ready).toBe(true);
            expect(result.readyPeerIds).toEqual(['bob', 'charlie']);
            expect(result.room).toEqual(readyRoom);
        }
    );

    it.each(['realtime', 'messages.rtc'] as const)(
        'rejects unavailable room authority for %s even when global health has two ready peers',
        async (transport) => {
            vi.useFakeTimers();
            const unavailableRooms = [
                createRoomStatus({ ...ROOM_WITH_PEER_BEING_REPLACED.rtc, state: 'idle', desiredPeerIds: [] }),
                createRoomStatus({ ...ROOM_WITH_PEER_BEING_REPLACED.rtc, state: 'open', readyPeerIds: ['bob', 'charlie'] }),
                createRoomStatus({ ...ROOM_READY.rtc, state: 'degraded', readyPeerIds: ['bob', 'charlie'] }),
                ROOM_READY
            ];
            for (const room of unavailableRooms) {
                const runtime = {
                    refreshRoom: async () => undefined,
                    health: async () => ({ rtcStatus: { readyPeerIds: ['bob', 'charlie'] } }),
                    waitForRoom: async () => room
                };
                const pending = waitForRtcConnectReadiness({
                    runtime,
                    transport,
                    options: { minReadyPeers: 2, timeoutMs: 20, intervalMs: 1 }
                });
                await vi.advanceTimersByTimeAsync(20);
                const result = await pending;
                expect(result.ready).toBe(false);
                expect(result.room).toEqual(room);
                expect(result.waitedMs).toBeLessThanOrEqual(20);
            }
        }
    );

    it.each(['realtime', 'messages.rtc'] as const)(
        'bounds a pending %s room wait by the original readiness deadline',
        async (transport) => {
            vi.useFakeTimers();
            const runtime = {
                refreshRoom: async () => undefined,
                health: async () => ({ rtcStatus: { readyPeerIds: ['bob', 'charlie'] } }),
                waitForRoom: async () => await new Promise<RallarRoomTransportStatus>(() => undefined)
            };
            const pending = waitForRtcConnectReadiness({
                runtime,
                transport,
                options: { minReadyPeers: 2, timeoutMs: 20, intervalMs: 1 }
            });
            await vi.advanceTimersByTimeAsync(20);
            expect(await pending).toMatchObject({ ready: false, waitedMs: 20, readyPeerIds: [] });
        }
    );

    it.each(['realtime', 'messages.rtc'] as const)(
        'cancels a pending %s room wait without consuming its readiness budget',
        async (transport) => {
            vi.useFakeTimers();
            const startedAt = Date.now();
            const controller = new AbortController();
            const runtime = {
                refreshRoom: async () => undefined,
                health: async () => ({ rtcStatus: { readyPeerIds: ['bob', 'charlie'] } }),
                waitForRoom: async () => await new Promise<RallarRoomTransportStatus>(() => undefined)
            };
            const pending = waitForRtcConnectReadiness({
                runtime,
                transport,
                parentSignal: controller.signal,
                options: { minReadyPeers: 2, timeoutMs: 5_000, intervalMs: 1 }
            });
            const cancelled = expect(pending).rejects.toMatchObject({
                name: 'RALLAR_BLACK_BOX_ABORTED',
                message: 'distributed run cancelled'
            });
            await vi.advanceTimersByTimeAsync(10);
            controller.abort('distributed run cancelled');
            await cancelled;
            expect(Date.now() - startedAt).toBe(10);
        }
    );

    it('refreshes realtime room authority at most once a second while bounded room waits remain unready', async () => {
        vi.useFakeTimers();
        const refreshTimes: number[] = [];
        const runtime = {
            refreshRoom: async () => {
                refreshTimes.push(Date.now());
            },
            health: async () => ({ rtcStatus: { readyPeerIds: ['bob', 'charlie'] } }),
            waitForRoom: async (options: BlackBoxRallarRoomWaitOptions) => {
                if (refreshTimes.length === 1) {
                    await new Promise((resolve) => setTimeout(resolve, options.timeoutMs));
                    return ROOM_WITH_PEER_BEING_REPLACED;
                }
                return ROOM_READY;
            }
        };
        const pending = waitForRtcConnectReadiness({
            runtime,
            transport: 'realtime',
            options: { minReadyPeers: 1, timeoutMs: 1_500, intervalMs: 10 }
        });
        await vi.advanceTimersByTimeAsync(999);
        expect(refreshTimes).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(11);
        expect(await pending).toMatchObject({ ready: true, readyPeerIds: ['bob'], roomRefreshAttempts: 2 });
        expect(refreshTimes).toHaveLength(2);
        expect(refreshTimes[1]).toBeGreaterThanOrEqual((refreshTimes[0] ?? 0) + 1_000);
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

    it('refreshes the room at connect only when the store holds no snapshot for it', async () => {
        const runtime = createRtcRoomRuntime(async () => ROOM_READY);

        await waitForRtcConnectReadiness({
            runtime,
            transport: 'messages.rtc',
            options: { minReadyPeers: 1, timeoutMs: 5_000, intervalMs: 5 }
        });

        expect(runtime.refreshRoom.mock.calls[0]?.[0]).toMatchObject({ refresh: 'when-absent' });
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
