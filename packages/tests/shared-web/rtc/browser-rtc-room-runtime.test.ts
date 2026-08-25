import type { StateCacheChangeListener } from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID } from '@shared/services/WebRtcConnectionService.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupSnapshot, mockGroupSnapshot, mockGroupSnapshots, readRtcWaitMocks, resetRtcWaitTestRuntime } from './browser-rtc-wait-test-runtime.ts';

const mocks = readRtcWaitMocks();

interface LaneOpenRequest {
    readonly peerId: string;
    readonly laneId: string;
    readonly timeoutMs: number | undefined;
}

describe('Rallar RTC room wait', () => {
    beforeEach(resetRtcWaitTestRuntime);

    it('waits for a room RTC lane and separates ready peers from not-ready peers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(
            createGroupSnapshot('room-1', [
                'session-1',
                'peer-ready',
                'peer-slow'
            ])
        );
        const laneOpenRequests: LaneOpenRequest[] = [];
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID, options) => {
                laneOpenRequests.push({
                    peerId,
                    laneId,
                    timeoutMs: options?.timeoutMs
                });
                if (peerId === 'peer-ready') {
                    return {
                        status: 'open',
                        peerId,
                        laneId
                    };
                }

                return {
                    status: 'timeout',
                    peerId,
                    laneId,
                    error: new Error('lane did not open')
                };
            }
        );
        const facade = createRallarFacade();

        await facade.connect();

        const result = await facade.rtc.waitForRoomLane(
            'room-1',
            'realtime',
            {
                connect: true,
                timeoutMs: 1_000
            }
        );

        expect(result).toMatchObject({
            transport: 'rtc',
            roomId: 'room-1',
            laneId: 'realtime',
            status: 'partial',
            readyPeerIds: ['peer-ready'],
            notReadyPeerIds: ['peer-slow'],
            missingPeerIds: [],
            extraPeerIds: [],
            observedCount: 1,
            expectedCount: 2,
            ready: [
                {
                    peerId: 'peer-ready',
                    laneId: 'realtime',
                    status: 'open'
                }
            ],
            notReady: [
                {
                    peerId: 'peer-slow',
                    laneId: 'realtime',
                    status: 'timeout'
                }
            ]
        });
        expect(laneOpenRequests).toEqual([
            {
                peerId: 'peer-ready',
                laneId: 'realtime',
                timeoutMs: 1_000
            },
            {
                peerId: 'peer-slow',
                laneId: 'realtime',
                timeoutMs: 1_000
            }
        ]);
    });

    it('waits for local room presence with min one for solo rooms', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1']));
        const facade = createRallarFacade();

        await facade.connect();

        await expect(
            facade.rooms.waitForPresence('room-1', {
                expect: { min: 1 },
                timeoutMs: 10
            })
        ).resolves.toMatchObject({
            status: 'ready',
            roomId: 'room-1',
            activeSessionIds: ['session-1'],
            observedCount: 1,
            expectedCount: 1,
            timedOut: false
        });
    });

    it('resolves room presence waits when later cache updates satisfy expectations', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        let onCacheChange: StateCacheChangeListener | undefined;
        mocks.onCacheChange.mockImplementation((listener) => {
            onCacheChange = listener;
            return vi.fn();
        });
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1']));
        const facade = createRallarFacade();

        await facade.connect();
        const wait = facade.rooms.waitForPresence('room-1', {
            expect: { exact: 2 },
            timeoutMs: 1_000
        });
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-a']));
        await onCacheChange?.({ clients: [], groups: [] });

        await expect(wait).resolves.toMatchObject({
            status: 'ready',
            roomId: 'room-1',
            activeSessionIds: ['session-1', 'peer-a'],
            observedCount: 2,
            expectedCount: 2,
            timedOut: false
        });
    });

    it('rechecks room presence after subscribing to avoid missing a ready cache update', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1']));
        mocks.onCacheChange.mockImplementation(() => {
            mockGroupSnapshot(createGroupSnapshot('room-1', [
                'session-1',
                'peer-a'
            ]));
            return vi.fn();
        });
        const facade = createRallarFacade();

        await facade.connect();

        await expect(
            facade.rooms.waitForPresence('room-1', {
                expect: { exact: 2 },
                timeoutMs: 1
            })
        ).resolves.toMatchObject({
            status: 'ready',
            roomId: 'room-1',
            activeSessionIds: ['session-1', 'peer-a'],
            observedCount: 2,
            expectedCount: 2,
            timedOut: false
        });
    });

    it('returns timeout when exact expected room RTC peers do not all open', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(
            createGroupSnapshot('room-1', [
                'session-1',
                'peer-ready',
                'peer-slow'
            ])
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => ({
                status: peerId === 'peer-ready' ? 'open' : 'timeout',
                peerId,
                laneId
            })
        );
        const facade = createRallarFacade();

        await facade.connect();

        await expect(
            facade.rtc.waitForRoomLane('room-1', 'realtime', {
                connect: true,
                expect: { exact: 2 },
                timeoutMs: 1_000
            })
        ).resolves.toMatchObject({
            transport: 'rtc',
            roomId: 'room-1',
            laneId: 'realtime',
            status: 'timeout',
            readyPeerIds: ['peer-ready'],
            notReadyPeerIds: ['peer-slow'],
            observedCount: 1,
            expectedCount: 2
        });
    });

    it('maps exhausted RTC lane attempts to failed with a stable reason', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-a']));
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValue({
            status: 'exhausted',
            peerId: 'peer-a',
            laneId: 'realtime',
            error: new Error('rtc-connect-attempt-budget-exhausted')
        });
        const facade = createRallarFacade();

        await facade.connect();

        await expect(
            facade.rtc.waitForRoomLane('room-1', 'realtime', {
                connect: true,
                timeoutMs: 1_000
            })
        ).resolves.toMatchObject({
            status: 'failed',
            notReady: [
                {
                    peerId: 'peer-a',
                    status: 'failed',
                    reason: 'rtc-connect-attempt-budget-exhausted'
                }
            ]
        });
    });

    it('reports over-capacity for strict expected room RTC peer ids', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(
            createGroupSnapshot('room-1', [
                'session-1',
                'peer-a',
                'peer-b'
            ])
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => ({
                status: 'open',
                peerId,
                laneId
            })
        );
        const facade = createRallarFacade();

        await facade.connect();

        await expect(
            facade.rtc.waitForRoomLane('room-1', 'realtime', {
                connect: true,
                expect: {
                    sessionIds: ['peer-a'],
                    allowExtras: false
                },
                timeoutMs: 1_000
            })
        ).resolves.toMatchObject({
            status: 'over-capacity',
            readyPeerIds: ['peer-a', 'peer-b'],
            missingPeerIds: [],
            extraPeerIds: ['peer-b'],
            observedCount: 2,
            expectedCount: 1
        });
    });

    it('returns empty for a room RTC lane when the current session is not in the room', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(
            createGroupSnapshot('room-1', [
                'peer-ready',
                'peer-slow'
            ])
        );
        const facade = createRallarFacade();
        const laneOpenPeerIds: string[] = [];
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => {
                laneOpenPeerIds.push(peerId);
                return { status: 'open', peerId, laneId };
            }
        );

        await facade.connect();
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockClear();

        await expect(
            facade.rtc.waitForRoomLane(
                'room-1',
                'realtime',
                {
                    connect: true,
                    timeoutMs: 1_000
                }
            )
        ).resolves.toMatchObject({
            transport: 'rtc',
            roomId: 'room-1',
            laneId: 'realtime',
            status: 'empty',
            readyPeerIds: [],
            notReadyPeerIds: [],
            observedCount: 0,
            ready: [],
            notReady: []
        });
        expect(laneOpenPeerIds).toEqual([]);
    });

    it('reports room RTC transport status without opening lanes', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(
            createGroupSnapshot('room-1', [
                'session-1',
                'peer-ready',
                'peer-slow'
            ])
        );
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue([
            'peer-ready',
            'peer-slow'
        ]);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue([
            'peer-ready',
            'peer-slow'
        ]);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([
            'peer-ready'
        ]);
        const laneOpenPeerIds: string[] = [];
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => {
                laneOpenPeerIds.push(peerId);
                return { status: 'open', peerId, laneId };
            }
        );

        const facade = createRallarFacade();
        await facade.connect();

        const status = facade.rtc.roomStatus('room-1', {
            laneId: 'realtime',
            minReadyPeers: 1
        });

        expect(status).toMatchObject({
            roomId: 'room-1',
            rtc: {
                mode: 'lazy',
                state: 'partial',
                desiredPeerIds: ['peer-ready', 'peer-slow'],
                knownPeerIds: ['peer-ready', 'peer-slow'],
                activePeerIds: ['peer-ready', 'peer-slow'],
                readyPeerIds: ['peer-ready'],
                laneId: 'realtime'
            }
        });
        expect(laneOpenPeerIds).toEqual([]);
    });

    it('opens a room RTC transport when mode is warm', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(
            createGroupSnapshot('room-1', [
                'session-1',
                'peer-ready',
                'peer-slow'
            ])
        );
        const laneOpenPeerIds: string[] = [];
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => {
                laneOpenPeerIds.push(peerId);
                return {
                    status: peerId === 'peer-ready' ? 'open' : 'timeout',
                    peerId,
                    laneId,
                    error: peerId === 'peer-ready' ? undefined : new Error('timeout')
                };
            }
        );
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([
            'peer-ready'
        ]);

        const facade = createRallarFacade();
        await facade.connect();

        const result = await facade.rtc.openRoom('room-1', {
            mode: 'warm',
            laneId: 'realtime',
            timeoutMs: 250,
            minReadyPeers: 1
        });

        expect(result.rtc.state).toBe('partial');
        expect(result.rtc.readyPeerIds).toEqual(['peer-ready']);
        expect(laneOpenPeerIds).toEqual(['peer-ready', 'peer-slow']);
    });

    it('waits for room RTC transport readiness with connect by default', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
        const laneOpenRequests: LaneOpenRequest[] = [];
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID, options) => {
                laneOpenRequests.push({ peerId, laneId, timeoutMs: options?.timeoutMs });
                return { status: 'open', peerId, laneId };
            }
        );
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue(['peer-1']);

        const facade = createRallarFacade();
        await facade.connect();

        const result = await facade.rtc.waitForRoom('room-1', {
            laneId: 'realtime',
            timeoutMs: 250
        });

        expect(result.rtc.state).toBe('open');
        expect(laneOpenRequests).toEqual([
            { peerId: 'peer-1', laneId: 'realtime', timeoutMs: 250 }
        ]);
    });

    it('returns empty for a room RTC lane when the room has no remote peers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1']));
        const facade = createRallarFacade();
        const laneOpenPeerIds: string[] = [];
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => {
                laneOpenPeerIds.push(peerId);
                return { status: 'open', peerId, laneId };
            }
        );

        await facade.connect();
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockClear();

        await expect(
            facade.rtc.waitForRoomLane(
                'room-1',
                'realtime',
                {
                    connect: true,
                    timeoutMs: 1_000
                }
            )
        ).resolves.toMatchObject({
            transport: 'rtc',
            roomId: 'room-1',
            laneId: 'realtime',
            status: 'empty',
            readyPeerIds: [],
            notReadyPeerIds: [],
            observedCount: 0,
            ready: [],
            notReady: []
        });
        expect(laneOpenPeerIds).toEqual([]);
    });

    it('returns not-connected room RTC lane results before Rallar is connected', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(
            createGroupSnapshot('room-1', [
                'session-1',
                'peer-a',
                'peer-b'
            ])
        );
        const facade = createRallarFacade();
        const laneOpenPeerIds: string[] = [];
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => {
                laneOpenPeerIds.push(peerId);
                return { status: 'open', peerId, laneId };
            }
        );

        await expect(
            facade.rtc.waitForRoomLane(
                'room-1',
                'realtime',
                {
                    connect: true,
                    timeoutMs: 1_000
                }
            )
        ).resolves.toMatchObject({
            transport: 'rtc',
            roomId: 'room-1',
            laneId: 'realtime',
            status: 'not-connected',
            ready: [],
            notReady: [
                {
                    peerId: 'peer-a',
                    status: 'not-connected'
                },
                {
                    peerId: 'peer-b',
                    status: 'not-connected'
                }
            ]
        });
        expect(laneOpenPeerIds).toEqual([]);
    });

    it('uses roomRef scope for room RTC lane waits', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const workspaceA = createGroupSnapshot(
            'shared-room',
            ['session-1', 'peer-a'],
            {
                workspaceId: 'workspace-a'
            }
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            ['session-1', 'peer-b'],
            {
                workspaceId: 'workspace-b'
            }
        );
        mockGroupSnapshots([workspaceA, workspaceB]);
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValue({
            status: 'open',
            peerId: 'peer-b',
            laneId: 'realtime'
        });
        const facade = createRallarFacade();

        await facade.connect();
        const result = await facade.rtc.waitForRoomLane(
            workspaceB.group,
            'realtime',
            {
                connect: true,
                timeoutMs: 1_000
            }
        );

        expect(result.ready.map((ready) => ready.peerId)).toEqual(['peer-b']);
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-b',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 1_000
                })
            );
    });
});
