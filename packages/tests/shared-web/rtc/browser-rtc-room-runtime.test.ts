import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateCacheChangeListener } from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
    DEFAULT_RTC_DATA_CHANNEL_LANE_ID,
    type WebRtcConnectionService
} from '@shared/services/web-rtc-connection-service.ts';

import { createBrowserRtcPeerTestDouble } from './browser-rtc-peer-test-double.ts';
import {
    createAcceptedOverlay,
    createGroupSnapshot,
    mockAcceptedOverlay,
    mockGroupSnapshot,
    mockGroupSnapshots,
    mockOpenRtcLane,
    readRtcWaitMocks,
    resetRtcWaitTestRuntime
} from './browser-rtc-wait-test-runtime.ts';

const mocks = readRtcWaitMocks();

interface LaneOpenRequest {
    readonly peerId: string;
    readonly laneId: string;
    readonly timeoutMs: number | undefined;
}

function withPreviousAcceptedPresenceRevision(
    snapshot: GroupSnapshot
): GroupSnapshot {
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            acceptedLayoutIdentity: {
                groupRevision: snapshot.causalRevision.groupRevision,
                presenceRevision: snapshot.causalRevision.presenceRevision - 1,
                version: 1,
                state: 'active'
            }
        }
    };
}

describe('Rallar RTC room wait', () => {
    beforeEach(resetRtcWaitTestRuntime);

    it('waits for a room RTC lane and separates ready peers from not-ready peers', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mockGroupSnapshot(
            createGroupSnapshot('room-1', ['session-1', 'peer-ready', 'peer-slow'])
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
                    return await mockOpenRtcLane(peerId, laneId);
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

        const result = await facade.rtc.waitForRoomLane('room-1', 'realtime', {
            connect: true,
            timeoutMs: 1_000
        });

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
        expect(new Set(laneOpenRequests)).toEqual(
            new Set([
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
            ])
        );
    });

    it('waits for local room presence with min one for solo rooms', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
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
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
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
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1']));
        mocks.onCacheChange.mockImplementation(() => {
            mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-a']));
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
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mockGroupSnapshot(
            createGroupSnapshot('room-1', ['session-1', 'peer-ready', 'peer-slow'])
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) =>
                peerId === 'peer-ready'
                    ? await mockOpenRtcLane(peerId, laneId)
                    : { status: 'timeout', peerId, laneId }
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
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
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
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mockGroupSnapshot(
            createGroupSnapshot('room-1', ['session-1', 'peer-a', 'peer-b'])
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => await mockOpenRtcLane(peerId, laneId)
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
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mockGroupSnapshot(
            createGroupSnapshot('room-1', ['peer-ready', 'peer-slow'])
        );
        const facade = createRallarFacade();
        const laneOpenPeerIds: string[] = [];
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => {
                laneOpenPeerIds.push(peerId);
                return await mockOpenRtcLane(peerId, laneId);
            }
        );

        await facade.connect();
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockClear();

        await expect(
            facade.rtc.waitForRoomLane('room-1', 'realtime', {
                connect: true,
                timeoutMs: 1_000
            })
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
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mockGroupSnapshot(
            createGroupSnapshot('room-1', ['session-1', 'peer-ready', 'peer-slow'])
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
                return await mockOpenRtcLane(peerId, laneId);
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

    it('reports accepted-layout identity and reconnect progress only for accepted peers', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const snapshot = createGroupSnapshot('room-1', [
            'session-1',
            'peer-reconnecting',
            'active-session-not-in-layout'
        ]);
        mockGroupSnapshot(snapshot);
        mockAcceptedOverlay(snapshot, ['session-1', 'peer-reconnecting']);
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue([
            'peer-reconnecting',
            'active-session-not-in-layout'
        ]);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue([
            'peer-reconnecting',
            'active-session-not-in-layout'
        ]);
        const reconnectTimer = setTimeout(() => undefined, 60_000);
        mocks.webRtcConnectionService.readPeer.mockImplementation((peerId) =>
            createBrowserRtcPeerTestDouble({
                peerId,
                channels: [],
                status: {
                    reconnectAttempts: peerId === 'peer-reconnecting' ? 2 : 0,
                    reconnectTimer: peerId === 'peer-reconnecting' ? reconnectTimer : undefined
                }
            })
        );

        const facade = createRallarFacade();
        await facade.connect();
        const status = facade.rtc.roomStatus('room-1');
        clearTimeout(reconnectTimer);

        expect(status.rtc.acceptedLayoutIdentity).toEqual(
            snapshot.group.acceptedLayoutIdentity
        );
        expect(status.rtc.desiredPeerIds).toEqual(['peer-reconnecting']);
        expect(status.rtc.peers).toMatchObject([
            {
                peerId: 'peer-reconnecting',
                connection: {
                    reconnectAttempts: 2,
                    reconnecting: true
                }
            }
        ]);
    });

    it('keeps a joined room idle when no accepted layout exists', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const snapshot = createGroupSnapshot('room-1', ['session-1', 'peer-a']);
        mockGroupSnapshot(snapshot);
        mocks.findAcceptedOverlayById.mockReturnValue(undefined);

        const facade = createRallarFacade();
        await facade.connect();

        expect(facade.rtc.roomStatus('room-1').rtc).toMatchObject({
            state: 'idle',
            desiredPeerIds: [],
            peers: []
        });
        expect(
            facade.rtc.roomStatus('room-1').rtc.acceptedLayoutIdentity
        ).toBeUndefined();
    });

    it('reports an accepted edgeless room as open without inventing progress', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const snapshot = createGroupSnapshot('room-1', ['session-1']);
        mockGroupSnapshot(snapshot);

        const facade = createRallarFacade();
        await facade.connect();
        const status = (
            await facade.rtc.waitForRoom('room-1', {
                laneId: 'realtime',
                timeoutMs: 250
            })
        ).rtc;

        expect(status).toMatchObject({
            state: 'open',
            acceptedLayoutIdentity: snapshot.group.acceptedLayoutIdentity,
            desiredPeerIds: [],
            readyPeerIds: [],
            failedPeerIds: [],
            peers: []
        });
        expect(status).not.toHaveProperty('readinessFraction');
    });

    it('reports halted and never opens accepted peer lanes while transport is halted', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const base = createGroupSnapshot('room-1', ['session-1', 'peer-a']);
        const snapshot: GroupSnapshot = {
            ...base,
            group: { ...base.group, transportState: 'halted' }
        };
        mockGroupSnapshot(snapshot);
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(() => {
            throw new Error('Halted room readiness cannot open a peer lane.');
        });
        const facade = createRallarFacade();
        await facade.connect();

        const status = await facade.rtc.waitForRoom('room-1', {
            laneId: 'realtime',
            timeoutMs: 250
        });

        expect(status.rtc).toMatchObject({
            state: 'halted',
            desiredPeerIds: ['peer-a'],
            reason: 'Room RTC is halted by authoritative group state.'
        });
        expect(facade.rtc.roomStatus('room-1', { mode: 'off' }).rtc).toMatchObject({
            mode: 'off',
            state: 'halted',
            reason: 'Room RTC is halted by authoritative group state.'
        });
    });

    it('opens a room RTC transport when mode is warm', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mockGroupSnapshot(
            createGroupSnapshot('room-1', ['session-1', 'peer-ready', 'peer-slow'])
        );
        const laneOpenPeerIds: string[] = [];
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => {
                laneOpenPeerIds.push(peerId);
                return peerId === 'peer-ready'
                    ? await mockOpenRtcLane(peerId, laneId)
                    : { status: 'timeout', peerId, laneId, error: new Error('timeout') };
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
        expect(new Set(laneOpenPeerIds)).toEqual(
            new Set(['peer-ready', 'peer-slow'])
        );
    });

    it('waits for room RTC transport readiness with connect by default', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
        const laneOpenRequests: LaneOpenRequest[] = [];
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID, options) => {
                laneOpenRequests.push({
                    peerId,
                    laneId,
                    timeoutMs: options?.timeoutMs
                });
                return await mockOpenRtcLane(peerId, laneId);
            }
        );
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([
            'peer-1'
        ]);

        const facade = createRallarFacade();
        await facade.connect();

        const result = await facade.rtc.waitForRoom('room-1', {
            laneId: 'realtime',
            timeoutMs: 250
        });

        expect(result.rtc.state).toBe('open');
        expect(new Set(laneOpenRequests)).toEqual(
            new Set([{ peerId: 'peer-1', laneId: 'realtime', timeoutMs: 250 }])
        );
    });

    it('waits for accepted room authority that arrives after the public wait starts', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const snapshot = createGroupSnapshot('room-1', ['session-1', 'peer-1']);
        const cacheChangeListeners = new Set<StateCacheChangeListener>();
        mocks.onCacheChange.mockImplementation((listener) => {
            cacheChangeListeners.add(listener);
            return () => cacheChangeListeners.delete(listener);
        });
        mockGroupSnapshots([snapshot], []);
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => await mockOpenRtcLane(peerId, laneId)
        );
        const facade = createRallarFacade();
        await facade.connect();

        const readiness = facade.rtc.waitForRoom('room-1', {
            laneId: 'realtime',
            timeoutMs: 250
        });
        queueMicrotask(() => {
            mockAcceptedOverlay(snapshot, ['session-1', 'peer-1']);
            for (const listener of cacheChangeListeners) {
                void listener({ clients: [], groups: [snapshot] });
            }
        });

        await expect(readiness).resolves.toMatchObject({
            rtc: {
                state: 'open',
                acceptedLayoutIdentity: snapshot.group.acceptedLayoutIdentity,
                desiredPeerIds: ['peer-1'],
                readyPeerIds: ['peer-1']
            }
        });
        expect(
            mocks.webRtcConnectionService.ensurePeerLaneOpen
        ).toHaveBeenCalledWith(
            'peer-1',
            'realtime',
            expect.objectContaining({ timeoutMs: expect.any(Number) })
        );
    });

    it('observes desired peers that are created after a non-connecting room wait starts', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const snapshot = createGroupSnapshot('room-1', ['session-1', 'peer-1']);
        mockGroupSnapshot(snapshot);
        let rtcLifecycle: WebRtcConnectionService.PeerLifecycleCallback | undefined;
        mocks.webRtcConnectionService.onRtcPeerLifecycleDo.mockImplementation(
            (_id, callbacks) => {
                rtcLifecycle = callbacks;
                return mocks.webRtcConnectionService;
            }
        );
        const facade = createRallarFacade();
        await facade.connect();

        const readiness = facade.rtc.waitForRoom('room-1', {
            connect: false,
            laneId: 'realtime',
            timeoutMs: 250
        });
        expect(rtcLifecycle).toBeDefined();
        const opened = await mockOpenRtcLane('peer-1', 'realtime');
        if (!rtcLifecycle || !opened.peer) {
            throw new Error('Room readiness did not subscribe before the peer opened.');
        }
        rtcLifecycle.onCreated(opened.peer);

        await expect(readiness).resolves.toMatchObject({
            rtc: {
                state: 'open',
                acceptedLayoutIdentity: snapshot.group.acceptedLayoutIdentity,
                desiredPeerIds: ['peer-1'],
                readyPeerIds: ['peer-1']
            }
        });
    });

    it('observes a peer added to an accepted solo room when one ready peer is required', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const soloSnapshot = createGroupSnapshot('room-1', ['session-1']);
        const pairedSnapshot = createGroupSnapshot('room-1', [
            'session-1',
            'peer-1'
        ]);
        const snapshots = [soloSnapshot];
        const acceptedOverlays = [createAcceptedOverlay(soloSnapshot)];
        const cacheChangeListeners = new Set<StateCacheChangeListener>();
        mocks.onCacheChange.mockImplementation((listener) => {
            cacheChangeListeners.add(listener);
            return () => cacheChangeListeners.delete(listener);
        });
        mockGroupSnapshots(snapshots, acceptedOverlays);
        let rtcLifecycle: WebRtcConnectionService.PeerLifecycleCallback | undefined;
        mocks.webRtcConnectionService.onRtcPeerLifecycleDo.mockImplementation(
            (_id, callbacks) => {
                rtcLifecycle = callbacks;
                return mocks.webRtcConnectionService;
            }
        );
        const facade = createRallarFacade();
        await facade.connect();

        const readiness = facade.rtc.waitForRoom('room-1', {
            connect: false,
            laneId: 'realtime',
            minReadyPeers: 1,
            timeoutMs: 250
        });
        expect(rtcLifecycle).toBeDefined();
        const opened = await mockOpenRtcLane('peer-1', 'realtime');
        if (!rtcLifecycle || !opened.peer) {
            throw new Error('Room readiness did not subscribe before the peer joined.');
        }
        rtcLifecycle.onCreated(opened.peer);
        snapshots[0] = pairedSnapshot;
        acceptedOverlays[0] = createAcceptedOverlay(pairedSnapshot);
        for (const listener of cacheChangeListeners) {
            void listener({ clients: [], groups: [pairedSnapshot] });
        }

        await expect(readiness).resolves.toMatchObject({
            rtc: {
                state: 'open',
                acceptedLayoutIdentity: pairedSnapshot.group.acceptedLayoutIdentity,
                desiredPeerIds: ['peer-1'],
                readyPeerIds: ['peer-1']
            }
        });
    });

    it('connects a peer added to an accepted solo room when one ready peer is required', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const soloSnapshot = createGroupSnapshot('room-1', ['session-1']);
        const pairedSnapshot = createGroupSnapshot('room-1', [
            'session-1',
            'peer-1'
        ]);
        const snapshots = [soloSnapshot];
        const acceptedOverlays = [createAcceptedOverlay(soloSnapshot)];
        const cacheChangeListeners = new Set<StateCacheChangeListener>();
        mocks.onCacheChange.mockImplementation((listener) => {
            cacheChangeListeners.add(listener);
            return () => cacheChangeListeners.delete(listener);
        });
        mockGroupSnapshots(snapshots, acceptedOverlays);
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => await mockOpenRtcLane(peerId, laneId)
        );
        const facade = createRallarFacade();
        await facade.connect();

        const readiness = facade.rtc.waitForRoom('room-1', {
            connect: true,
            laneId: 'realtime',
            minReadyPeers: 1,
            timeoutMs: 250
        });
        queueMicrotask(() => {
            snapshots[0] = pairedSnapshot;
            acceptedOverlays[0] = createAcceptedOverlay(pairedSnapshot);
            for (const listener of cacheChangeListeners) {
                void listener({ clients: [], groups: [pairedSnapshot] });
            }
        });

        await expect(readiness).resolves.toMatchObject({
            rtc: {
                state: 'open',
                acceptedLayoutIdentity: pairedSnapshot.group.acceptedLayoutIdentity,
                desiredPeerIds: ['peer-1'],
                readyPeerIds: ['peer-1']
            }
        });
    });

    it('does not report open below the requested minimum after the accepted topology shrinks', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const initialSnapshot = createGroupSnapshot('room-1', [
            'session-1',
            'peer-a',
            'peer-b'
        ]);
        const shrunkenSnapshot = createGroupSnapshot('room-1', [
            'session-1',
            'peer-a'
        ]);
        const snapshots = [initialSnapshot];
        const acceptedOverlays = [createAcceptedOverlay(initialSnapshot)];
        mockGroupSnapshots(snapshots, acceptedOverlays);
        const deferredPeer = Promise.withResolvers<WebRtcConnectionService.PeerLaneOpenResult>();
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) =>
                peerId === 'peer-a'
                    ? await mockOpenRtcLane(peerId, laneId)
                    : await deferredPeer.promise
        );
        const facade = createRallarFacade();
        await facade.connect();

        const readiness = facade.rtc.waitForRoom('room-1', {
            connect: true,
            laneId: 'realtime',
            minReadyPeers: 2,
            timeoutMs: 250
        });
        await vi.waitFor(() => {
            expect(mocks.webRtcConnectionService.ensurePeerLaneOpen).toHaveBeenCalledTimes(2);
        });
        snapshots[0] = shrunkenSnapshot;
        acceptedOverlays[0] = createAcceptedOverlay(shrunkenSnapshot);
        deferredPeer.resolve(await mockOpenRtcLane('peer-b', 'realtime'));

        await expect(readiness).resolves.toMatchObject({
            rtc: {
                state: 'connecting',
                desiredPeerIds: ['peer-a'],
                readyPeerIds: ['peer-a']
            }
        });
    });

    it('keeps a non-connecting timeout terminal when RTC becomes ready during cleanup', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const snapshot = createGroupSnapshot('room-1', ['session-1', 'peer-1']);
        mockGroupSnapshot(snapshot);
        mocks.onCacheChange.mockImplementation(() => () => {
            mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([
                'peer-1'
            ]);
        });
        const facade = createRallarFacade();
        await facade.connect();
        vi.useFakeTimers();

        const readiness = facade.rtc.waitForRoom('room-1', {
            connect: false,
            laneId: 'realtime',
            timeoutMs: 1
        });
        await vi.advanceTimersByTimeAsync(1);

        await expect(readiness).resolves.toMatchObject({
            rtc: {
                state: 'idle',
                readyPeerIds: ['peer-1'],
                reason: 'Room RTC wait ended with timeout.'
            }
        });
    });

    it('keeps a non-connecting abort terminal when RTC becomes ready during cleanup', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const snapshot = createGroupSnapshot('room-1', ['session-1', 'peer-1']);
        mockGroupSnapshot(snapshot);
        mocks.onCacheChange.mockImplementation(() => () => {
            mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([
                'peer-1'
            ]);
        });
        const facade = createRallarFacade();
        await facade.connect();
        const controller = new AbortController();

        const readiness = facade.rtc.waitForRoom('room-1', {
            connect: false,
            laneId: 'realtime',
            signal: controller.signal,
            timeoutMs: 250
        });
        controller.abort();

        await expect(readiness).resolves.toMatchObject({
            rtc: {
                state: 'idle',
                readyPeerIds: ['peer-1'],
                reason: 'Room RTC wait ended with aborted.'
            }
        });
    });

    it('waits for an accepted layout that covers the current room presence revision', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const currentSnapshot = createGroupSnapshot('room-1', [
            'session-1',
            'peer-1',
            'peer-2'
        ]);
        const staleSnapshot = withPreviousAcceptedPresenceRevision(currentSnapshot);
        const snapshots = [staleSnapshot];
        const acceptedOverlays = [
            createAcceptedOverlay(staleSnapshot, ['session-1', 'peer-1'])
        ];
        const cacheChangeListeners = new Set<StateCacheChangeListener>();
        mocks.onCacheChange.mockImplementation((listener) => {
            cacheChangeListeners.add(listener);
            return () => cacheChangeListeners.delete(listener);
        });
        mockGroupSnapshots(snapshots, acceptedOverlays);
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => await mockOpenRtcLane(peerId, laneId)
        );
        const facade = createRallarFacade();
        await facade.connect();

        const readiness = facade.rtc.waitForRoom('room-1', {
            laneId: 'realtime',
            timeoutMs: 250
        });
        queueMicrotask(() => {
            snapshots[0] = currentSnapshot;
            acceptedOverlays[0] = createAcceptedOverlay(currentSnapshot, [
                'session-1',
                'peer-1',
                'peer-2'
            ]);
            for (const listener of cacheChangeListeners) {
                void listener({ clients: [], groups: [currentSnapshot] });
            }
        });

        await expect(readiness).resolves.toMatchObject({
            rtc: {
                state: 'open',
                acceptedLayoutIdentity: currentSnapshot.group.acceptedLayoutIdentity,
                desiredPeerIds: ['peer-1', 'peer-2'],
                readyPeerIds: ['peer-1', 'peer-2']
            }
        });
    });

    it('does not wait for room authority when RTC is not connected', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const snapshot = createGroupSnapshot('room-1', ['session-1', 'peer-1']);
        mockGroupSnapshots([snapshot], []);
        mocks.onCacheChange.mockImplementation(() => {
            throw new Error('A disconnected room wait must not subscribe to authority.');
        });
        const facade = createRallarFacade();

        await expect(
            facade.rtc.waitForRoom('room-1', {
                laneId: 'realtime',
                timeoutMs: 250
            })
        ).resolves.toMatchObject({
            rtc: {
                state: 'idle',
                acceptedLayoutIdentity: undefined,
                readyPeerIds: []
            }
        });
    });

    it('reports a stale accepted layout as timed out without opening a lane', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const currentSnapshot = createGroupSnapshot('room-1', [
            'session-1',
            'peer-1',
            'peer-2'
        ]);
        const staleSnapshot = withPreviousAcceptedPresenceRevision(currentSnapshot);
        mockGroupSnapshots(
            [staleSnapshot],
            [createAcceptedOverlay(staleSnapshot, ['session-1', 'peer-1'])]
        );
        await mockOpenRtcLane('peer-1', 'realtime');
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            () => {
                throw new Error('A timed-out authority wait must not open a lane.');
            }
        );
        const facade = createRallarFacade();
        await facade.connect();

        await expect(
            facade.rtc.waitForRoom('room-1', {
                laneId: 'realtime',
                timeoutMs: 0
            })
        ).resolves.toMatchObject({
            rtc: {
                state: 'idle',
                acceptedLayoutIdentity: staleSnapshot.group.acceptedLayoutIdentity,
                desiredPeerIds: ['peer-1'],
                readyPeerIds: ['peer-1'],
                reason: 'Room RTC wait ended with timeout.'
            }
        });
    });

    it('keeps an authority timeout terminal when the layout becomes current during cleanup', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const currentSnapshot = createGroupSnapshot('room-1', [
            'session-1',
            'peer-1'
        ]);
        const staleSnapshot = withPreviousAcceptedPresenceRevision(currentSnapshot);
        const snapshots = [staleSnapshot];
        const acceptedOverlays = [
            createAcceptedOverlay(staleSnapshot, ['session-1', 'peer-1'])
        ];
        mockGroupSnapshots(snapshots, acceptedOverlays);
        await mockOpenRtcLane('peer-1', 'realtime');
        mocks.onCacheChange.mockImplementation(() => () => {
            snapshots[0] = currentSnapshot;
            acceptedOverlays[0] = createAcceptedOverlay(currentSnapshot, [
                'session-1',
                'peer-1'
            ]);
        });
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            () => {
                throw new Error('A timed-out authority wait must not open a lane.');
            }
        );
        const facade = createRallarFacade();
        await facade.connect();
        vi.useFakeTimers();

        const readiness = facade.rtc.waitForRoom('room-1', {
            laneId: 'realtime',
            timeoutMs: 1
        });
        await vi.advanceTimersByTimeAsync(1);

        await expect(readiness).resolves.toMatchObject({
            rtc: {
                state: 'idle',
                acceptedLayoutIdentity: currentSnapshot.group.acceptedLayoutIdentity,
                desiredPeerIds: ['peer-1'],
                readyPeerIds: ['peer-1'],
                reason: 'Room RTC wait ended with timeout.'
            }
        });
    });

    it('reports a stale accepted layout as aborted without opening a lane', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const currentSnapshot = createGroupSnapshot('room-1', [
            'session-1',
            'peer-1',
            'peer-2'
        ]);
        const staleSnapshot = withPreviousAcceptedPresenceRevision(currentSnapshot);
        mockGroupSnapshots(
            [staleSnapshot],
            [createAcceptedOverlay(staleSnapshot, ['session-1', 'peer-1'])]
        );
        await mockOpenRtcLane('peer-1', 'realtime');
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            () => {
                throw new Error('An aborted authority wait must not open a lane.');
            }
        );
        const facade = createRallarFacade();
        await facade.connect();
        const controller = new AbortController();
        controller.abort();

        await expect(
            facade.rtc.waitForRoom('room-1', {
                laneId: 'realtime',
                signal: controller.signal,
                timeoutMs: 250
            })
        ).resolves.toMatchObject({
            rtc: {
                state: 'idle',
                acceptedLayoutIdentity: staleSnapshot.group.acceptedLayoutIdentity,
                desiredPeerIds: ['peer-1'],
                readyPeerIds: ['peer-1'],
                reason: 'Room RTC wait ended with aborted.'
            }
        });
    });

    it('returns empty for a room RTC lane when the room has no remote peers', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1']));
        const facade = createRallarFacade();
        const laneOpenPeerIds: string[] = [];
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => {
                laneOpenPeerIds.push(peerId);
                return await mockOpenRtcLane(peerId, laneId);
            }
        );

        await facade.connect();
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockClear();

        await expect(
            facade.rtc.waitForRoomLane('room-1', 'realtime', {
                connect: true,
                timeoutMs: 1_000
            })
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
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mockGroupSnapshot(
            createGroupSnapshot('room-1', ['session-1', 'peer-a', 'peer-b'])
        );
        const facade = createRallarFacade();
        const laneOpenPeerIds: string[] = [];
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => {
                laneOpenPeerIds.push(peerId);
                return await mockOpenRtcLane(peerId, laneId);
            }
        );

        await expect(
            facade.rtc.waitForRoomLane('room-1', 'realtime', {
                connect: true,
                timeoutMs: 1_000
            })
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
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
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
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => await mockOpenRtcLane(peerId, laneId)
        );
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
        expect(
            mocks.webRtcConnectionService.ensurePeerLaneOpen
        ).toHaveBeenCalledWith(
            'peer-b',
            'realtime',
            expect.objectContaining({
                timeoutMs: 1_000
            })
        );
    });
});
