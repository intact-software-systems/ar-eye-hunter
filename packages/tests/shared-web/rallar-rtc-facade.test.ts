import { describe, expect, it, vi } from 'vitest';
import { createRallarRtcFacade } from '@shared-web/browser/rallar-rtc-facade.ts';
import type {
    RallarRoomTransportStatus,
    RallarRtcDiagnostics,
    RallarRtcLifecycleListener,
    RallarRtcPeerStatus,
    RallarRtcRecoveryResult,
    RallarRtcRoomLaneWaitResult,
    RallarRtcStatus,
    RallarRtcStatusListener,
    RallarRtcWaitForOpenResult,
} from '@shared-web/browser/rallar.ts';

describe('Rallar RTC facade factory', () => {
    it('delegates RTC methods through injected operations', async () => {
        const peer = {
            peerId: 'peer-1',
            connection: {
                hasLocalDescription: true,
                hasRemoteDescription: true,
                reconnectAttempts: 0,
                reconnecting: false,
                disconnectPending: false,
                makingOffer: false,
                ignoreOffer: false,
                iceCandidateQueueSize: 0,
                remoteStreamIds: [],
            },
            lanes: [],
            isActive: true,
            hasNoReconnectableLanes: false,
            isRoutable: true,
            readyLaneIds: ['lane-1'],
        } satisfies RallarRtcPeerStatus;
        const status = {
            sessionId: 'session-1',
            laneId: 'lane-1',
            knownPeerIds: ['peer-1'],
            activePeerIds: ['peer-1'],
            peerIdsWithNoReconnectableLanes: [],
            readyPeerIds: ['peer-1'],
            peers: [peer],
        } satisfies RallarRtcStatus;
        const roomStatus = {
            roomId: 'room-1',
            rtc: {
                desired: true,
                mode: 'warm',
                state: 'open',
                desiredPeerIds: ['peer-1'],
                knownPeerIds: ['peer-1'],
                activePeerIds: ['peer-1'],
                readyPeerIds: ['peer-1'],
                failedPeerIds: [],
                laneId: 'lane-1',
            },
        } as RallarRoomTransportStatus;
        const laneResult = {
            transport: 'rtc',
            status: 'open',
            peerId: 'peer-1',
            laneId: 'lane-1',
            rtcStatus: status,
            peer,
        } satisfies RallarRtcWaitForOpenResult;
        const roomLaneResult = {
            transport: 'rtc',
            roomId: 'room-1',
            laneId: 'lane-1',
            status: 'open',
            rtcStatus: status,
            ready: [laneResult],
            notReady: [],
        } satisfies RallarRtcRoomLaneWaitResult;
        const diagnostics = {
            sessionId: 'session-1',
            generatedAtEpochMs: 123,
            peerCount: 1,
            connectedPeerCount: 1,
            relayPeerCount: 0,
            peers: [],
        } satisfies RallarRtcDiagnostics;
        const recovery = {
            peerId: 'peer-1',
            action: 'reconnect',
            status: 'started',
            rtcStatus: status,
        } satisfies RallarRtcRecoveryResult;
        const unsubscribeStatus = vi.fn();
        const unsubscribeLifecycle = vi.fn();
        const statusListener = vi.fn() as RallarRtcStatusListener;
        const lifecycleListener = vi.fn() as RallarRtcLifecycleListener;
        const operations = {
            status: vi.fn(() => status),
            roomStatus: vi.fn(() => roomStatus),
            openRoom: vi.fn(async () => roomStatus),
            waitForRoom: vi.fn(async () => roomStatus),
            onStatus: vi.fn(() => unsubscribeStatus),
            onLifecycle: vi.fn(() => unsubscribeLifecycle),
            waitForLane: vi.fn(async () => laneResult),
            waitForOpen: vi.fn(async () => laneResult),
            waitForRoomLane: vi.fn(async () => roomLaneResult),
            peer: vi.fn(() => peer),
            knownPeerIds: vi.fn(() => ['peer-1']),
            activePeerIds: vi.fn(() => ['peer-1']),
            peerIdsWithNoReconnectableLanes: vi.fn(() => []),
            readyPeerIds: vi.fn(() => ['peer-1']),
            diagnostics: vi.fn(async () => diagnostics),
            restartIce: vi.fn(async () => recovery),
            reconnectPeer: vi.fn(async () => recovery),
        };

        const facade = createRallarRtcFacade(operations);

        expect(facade.status()).toBe(status);
        expect(facade.roomStatus('room-1')).toBe(roomStatus);
        await expect(facade.openRoom('room-1')).resolves.toBe(roomStatus);
        await expect(facade.waitForRoom('room-1')).resolves.toBe(roomStatus);
        expect(facade.onStatus(statusListener)).toBe(unsubscribeStatus);
        expect(facade.onLifecycle(lifecycleListener)).toBe(unsubscribeLifecycle);
        await expect(
            facade.waitForLane('peer-1', 'lane-1'),
        ).resolves.toBe(laneResult);
        await expect(facade.waitForOpen('peer-1')).resolves.toBe(laneResult);
        await expect(
            facade.waitForRoomLane('room-1', 'lane-1'),
        ).resolves.toBe(roomLaneResult);
        expect(facade.peer('peer-1')).toBe(peer);
        expect(facade.knownPeerIds()).toEqual(['peer-1']);
        expect(facade.activePeerIds()).toEqual(['peer-1']);
        expect(facade.peerIdsWithNoReconnectableLanes()).toEqual([]);
        expect(facade.readyPeerIds()).toEqual(['peer-1']);
        await expect(facade.diagnostics()).resolves.toBe(diagnostics);
        await expect(facade.restartIce('peer-1')).resolves.toBe(recovery);
        await expect(facade.reconnectPeer('peer-1')).resolves.toBe(recovery);

        expect(operations.status).toHaveBeenCalledWith({});
        expect(operations.roomStatus).toHaveBeenCalledWith('room-1', {});
        expect(operations.openRoom).toHaveBeenCalledWith('room-1', {});
        expect(operations.waitForRoom).toHaveBeenCalledWith('room-1', {});
        expect(operations.onStatus).toHaveBeenCalledWith(statusListener, {});
        expect(operations.onLifecycle).toHaveBeenCalledWith(
            lifecycleListener,
            {},
        );
        expect(operations.waitForLane).toHaveBeenCalledWith(
            'peer-1',
            'lane-1',
            {},
        );
        expect(operations.waitForOpen).toHaveBeenCalledWith('peer-1', {});
        expect(operations.waitForRoomLane).toHaveBeenCalledWith(
            'room-1',
            'lane-1',
            {},
        );
        expect(operations.peer).toHaveBeenCalledWith('peer-1', {});
        expect(operations.readyPeerIds).toHaveBeenCalledWith(undefined);
        expect(operations.diagnostics).toHaveBeenCalledWith({});
        expect(operations.restartIce).toHaveBeenCalledWith('peer-1');
        expect(operations.reconnectPeer).toHaveBeenCalledWith('peer-1', {});
    });
});
