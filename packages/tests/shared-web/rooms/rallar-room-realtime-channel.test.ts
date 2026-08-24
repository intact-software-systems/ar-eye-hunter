import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiMiddleware } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { Middleware } from '@shared-web/browser/middleware.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { QRtcDataChannel, RtcDataChannelHealth, RtcDataChannelSendResult } from '@shared/webrtc/QRtcDataChannel.ts';

import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

const mocks = await vi.hoisted(async () => {
    const { createApiMiddlewareTestDouble } = await import('../api-middleware-test-double.ts');

    const realtimeChannel = createRoomRealtimeChannelTestDouble();
    const ctx = createApiMiddlewareTestDouble();

    return {
        ctx,
        realtimeChannel,
        webRtcConnectionService: ctx.middleware.webRtcConnectionService,
        hydrateStateCaches: vi.fn(async (): Promise<void> => undefined),
        initMiddleware: vi.fn(async (): Promise<ApiMiddleware> => ctx),
        isMiddlewareReady: vi.fn(() => false),
        onStateCacheChange: vi.fn(() => vi.fn()),
        readSession: vi.fn((): AuthSession | undefined => ctx.session),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn(
            (_sessionId: string): GroupRef | undefined => {
                throw new Error('Repository not found: shared.repository.group-state-snapshots');
            }
        ),
        findGroupStateSnapshotByRef: vi.fn((_ref: GroupRef): GroupSnapshot | undefined => {
            throw new Error('Repository not found: shared.repository.group-state-snapshots');
        }),
        getAllGroupStateSnapshots: vi.fn((): GroupSnapshot[] => {
            throw new Error('Repository not found: shared.repository.group-state-snapshots');
        }),
        findClientStateSnapshotByPrincipalId: vi.fn(
            (_principalId: string): ClientSnapshot | undefined => {
                throw new Error('Repository not found: shared.repository.client-state-snapshots');
            }
        ),
        getAllClientStateSnapshots: vi.fn((): ClientSnapshot[] => {
            throw new Error('Repository not found: shared.repository.client-state-snapshots');
        })
    };
});

vi.mock(import('@shared-web/browser/middleware.ts'), () => ({
    initialiseMiddleware: async (): Promise<Middleware> => mocks.ctx.middleware
}));

vi.mock(import('@shared-web/browser/data-caches.ts'), () => ({
    hydrateStateCaches: mocks.hydrateStateCaches,
    onStateCacheChange: mocks.onStateCacheChange
}));

vi.mock(import('@shared/api/auth.ts'), () => ({
    clearSession: vi.fn(),
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: vi.fn()
}));

vi.mock(import('@shared/repository/client-state-snapshots-repository.ts'), () => ({
    findClientStateSnapshotByPrincipalId: mocks.findClientStateSnapshotByPrincipalId,
    getAllClientStateSnapshots: mocks.getAllClientStateSnapshots
}));

vi.mock(import('@shared/repository/group-state-snapshots-repository.ts'), () => ({
    findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.findFirstGroupStateSnapshotRefSessionIdIsIn,
    findGroupStateSnapshotByRef: mocks.findGroupStateSnapshotByRef,
    getAllGroupStateSnapshots: mocks.getAllGroupStateSnapshots
}));

describe('Rallar room realtime channel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.hydrateStateCaches.mockResolvedValue(undefined);
        mocks.initMiddleware.mockResolvedValue(mocks.ctx);
        mocks.isMiddlewareReady.mockReturnValue(false);
        mocks.readSession.mockReturnValue(mocks.ctx.session);
        mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockReturnValue(undefined);
        mocks.findGroupStateSnapshotByRef.mockReturnValue(undefined);
        mocks.getAllGroupStateSnapshots.mockReturnValue([]);
        mocks.findClientStateSnapshotByPrincipalId.mockReturnValue(undefined);
        mocks.getAllClientStateSnapshots.mockReturnValue([]);
        vi.mocked(mocks.realtimeChannel.sendJson).mockReturnValue({
            status: 'sent',
            bufferedAmount: 0
        });
        vi.mocked(mocks.webRtcConnectionService.knownPeerIds).mockReturnValue([]);
        vi.mocked(mocks.webRtcConnectionService.activePeerIds).mockReturnValue([]);
        vi.mocked(mocks.webRtcConnectionService.readyPeerIdsForLane).mockReturnValue([]);
        vi.mocked(mocks.webRtcConnectionService.ensurePeerLaneOpen).mockImplementation(
            async (peerId, laneId = 'motion') => ({
                status: 'open',
                peerId,
                laneId,
                channel: mocks.realtimeChannel
            })
        );
    });

    it('waits for a room lane and sends JSON only to ready room peers', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-ready', 'peer-slow']));
        vi.mocked(mocks.webRtcConnectionService.ensurePeerLaneOpen).mockImplementation(
            async (peerId, laneId = 'motion') => ({
                status: peerId === 'peer-ready' ? 'open' : 'timeout',
                peerId,
                laneId,
                channel: peerId === 'peer-ready' ? mocks.realtimeChannel : undefined,
                error: peerId === 'peer-ready' ? undefined : new Error('timeout')
            })
        );

        const result = await createRallarFacade()
            .realtime.room<{ x: number; }>({
                roomId: 'room-1',
                laneId: 'motion',
                waitTimeoutMs: 100,
                openTimeoutMs: 25
            })
            .send(
                { x: 1 },
                {
                    key: 'motion:peer-ready',
                    maxAgeMs: 120
                }
            );

        expect(result.status).toBe('partial');
        expect(result.peerIds).toEqual(['peer-ready']);
        expect(result.readiness?.status).toBe('partial');
        expect(mocks.realtimeChannel.sendJson).toHaveBeenCalledWith(
            { x: 1 },
            expect.objectContaining({
                key: 'motion:peer-ready',
                maxAgeMs: 120
            })
        );
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen).toHaveBeenCalledWith(
            'peer-ready',
            'motion',
            expect.objectContaining({ timeoutMs: 100 })
        );
    });

    it('does not send when a room lane has no ready peers after waiting', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-slow']));
        vi.mocked(mocks.webRtcConnectionService.ensurePeerLaneOpen).mockResolvedValue({
            status: 'timeout',
            peerId: 'peer-slow',
            laneId: 'motion',
            error: new Error('timeout')
        });

        const result = await createRallarFacade()
            .realtime.room<{ x: number; }>({
                roomId: 'room-1',
                laneId: 'motion',
                waitTimeoutMs: 100
            })
            .send({ x: 1 });

        expect(result.status).toBe('not-ready');
        expect(result.peerIds).toEqual([]);
        expect(result.readiness?.status).toBe('timeout');
        expect(mocks.realtimeChannel.sendJson).not.toHaveBeenCalled();
    });

    it('does not open or send room realtime for a room the current session has not joined', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mockGroupSnapshot(createGroupSnapshot('room-1', ['peer-ready']));

        const result = await createRallarFacade()
            .realtime.room<{ x: number; }>({
                roomId: 'room-1',
                laneId: 'motion',
                waitTimeoutMs: 100
            })
            .send({ x: 1 });

        expect(result.status).toBe('no-targets');
        expect(result.peerIds).toEqual([]);
        expect(result.desiredPeerIds).toEqual([]);
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen).not.toHaveBeenCalled();
        expect(mocks.realtimeChannel.sendJson).not.toHaveBeenCalled();
    });

    it('uses already-ready room peers without a readiness wait', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-ready']));
        vi.mocked(mocks.webRtcConnectionService.knownPeerIds).mockReturnValue(['peer-ready']);
        vi.mocked(mocks.webRtcConnectionService.activePeerIds).mockReturnValue(['peer-ready']);
        vi.mocked(mocks.webRtcConnectionService.readyPeerIdsForLane).mockReturnValue(['peer-ready']);

        const result = await createRallarFacade()
            .realtime.room<{ x: number; }>({
                roomId: 'room-1',
                laneId: 'motion',
                waitTimeoutMs: 100
            })
            .send({ x: 1 });

        expect(result.status).toBe('sent');
        expect(result.readiness).toBeUndefined();
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen).toHaveBeenCalledTimes(1);
        expect(mocks.realtimeChannel.sendJson).toHaveBeenCalledOnce();
    });
});

// `QRtcDataChannel` is a class with private send-queue state, so a lane double can only supply the
// members the room realtime path calls; every member below is still shape-checked against it.
function createRoomRealtimeChannelTestDouble(): QRtcDataChannel {
    return toRtcChannelTestDouble<QRtcDataChannel>({
        sendJson: vi.fn((): RtcDataChannelSendResult => ({ status: 'sent', bufferedAmount: 0 })),
        sendBinary: vi.fn((): RtcDataChannelSendResult => ({ status: 'sent', bufferedAmount: 0 })),
        readHealth: vi.fn((): RtcDataChannelHealth => ({
            peerId: 'peer-ready',
            label: 'realtime',
            role: 'none',
            readyState: 'open',
            bufferedAmount: 0,
            bufferedAmountLowThreshold: 16 * 1024,
            queuedItemCount: 0,
            rawCallbackCount: 0,
            messageCallbackCount: 0,
            lifecycleCallbackCount: 0,
            flowControl: {
                highWatermarkBytes: 64 * 1024,
                lowWatermarkBytes: 16 * 1024,
                overflow: 'drop-new',
                maxQueueItems: 32
            },
            counters: {
                sent: 0,
                queued: 0,
                dropped: 0,
                replaced: 0,
                closed: 0,
                flushed: 0,
                droppedOldest: 0,
                droppedStale: 0,
                receivedRaw: 0,
                receivedString: 0,
                receivedBinary: 0
            }
        }))
    });
}

function toRtcChannelTestDouble<TChannel>(members: Partial<TChannel>): TChannel {
    return members as TChannel;
}

function rejectGroupRepositoryReads(): void {
    const reject = (): never => {
        throw new Error('Repository not found: shared.repository.group-state-snapshots');
    };
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockImplementation(reject);
    mocks.findGroupStateSnapshotByRef.mockImplementation(reject);
    mocks.getAllGroupStateSnapshots.mockImplementation(reject);
}

function rejectClientRepositoryReads(): void {
    const reject = (): never => {
        throw new Error('Repository not found: shared.repository.client-state-snapshots');
    };
    mocks.findClientStateSnapshotByPrincipalId.mockImplementation(reject);
    mocks.getAllClientStateSnapshots.mockImplementation(reject);
}

function mockGroupSnapshot(snapshot: GroupSnapshot): void {
    mockGroupSnapshots([snapshot]);
}

function mockGroupSnapshots(snapshots: readonly GroupSnapshot[]): void {
    mocks.getAllGroupStateSnapshots.mockImplementation(() => [...snapshots]);
    mocks.findGroupStateSnapshotByRef.mockImplementation((roomRef) => snapshots.find((snapshot) => isSameGroupRef(snapshot.group, roomRef)));
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockImplementation(
        (sessionId) => snapshots.find((snapshot) => snapshot.activeSessions.some((active) => active.sessionId === sessionId))?.group
    );
}

function isSameGroupRef(left: GroupRef, right: GroupRef): boolean {
    return (
        left.groupId === right.groupId &&
        left.applicationId === right.applicationId &&
        (left.workspaceId ?? '') === (right.workspaceId ?? '')
    );
}

function createGroupSnapshot(groupId: string, sessionIds: readonly string[]): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';
    return createGroupSnapshotFixture({
        applicationId,
        workspaceId,
        groupId,
        sessionIds
    });
}
