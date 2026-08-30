import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarBrowserMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { AuthSession, OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
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
        hydrateStateCache: vi.fn(async (): Promise<void> => undefined),
        initialiseApiMiddleware: vi.fn(async (): Promise<ApiMiddleware> => ctx),
        onCacheChange: vi.fn(() => vi.fn()),
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
        findAcceptedOverlayById: vi.fn((_overlayId: string): OverlayInfo | undefined => {
            throw new Error('Repository not found: shared.repository.accepted-overlays');
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

vi.mock(import('@shared-web/browser/connection/initialise-browser-middleware.ts'), () => ({
    initialiseMiddleware: async (): Promise<RallarBrowserMiddleware> => mocks.ctx.middleware
}));

vi.mock(import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'), () => ({
    browserStateCacheLifecycle: {
        hydrate: mocks.hydrateStateCache,
        onChange: mocks.onCacheChange,
        initialise: vi.fn()
    }
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

vi.mock(import('@shared/repository/overlays-repository.ts'), async (importOriginal) => ({
    ...await importOriginal(),
    findAcceptedOverlayById: mocks.findAcceptedOverlayById
}));

describe('Rallar room realtime channel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.hydrateStateCache.mockResolvedValue(undefined);
        mocks.initialiseApiMiddleware.mockResolvedValue(mocks.ctx);
        mocks.readSession.mockReturnValue(mocks.ctx.session);
        mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockReturnValue(undefined);
        mocks.findGroupStateSnapshotByRef.mockReturnValue(undefined);
        mocks.getAllGroupStateSnapshots.mockReturnValue([]);
        mocks.findAcceptedOverlayById.mockReturnValue(undefined);
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
            async (peerId, laneId = 'motion') => {
                if (peerId === 'peer-ready') {
                    vi.mocked(mocks.webRtcConnectionService.readyPeerIdsForLane).mockReturnValue([
                        peerId
                    ]);
                }
                return {
                    status: peerId === 'peer-ready' ? 'open' : 'timeout',
                    peerId,
                    laneId,
                    channel: peerId === 'peer-ready' ? mocks.realtimeChannel : undefined,
                    error: peerId === 'peer-ready' ? undefined : new Error('timeout')
                };
            }
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

    it('does not send to a peer removed from the accepted layout during readiness wait', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-removed']));
        vi.mocked(mocks.webRtcConnectionService.ensurePeerLaneOpen).mockImplementation(
            async (peerId, laneId = 'motion') => {
                mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-current']));
                vi.mocked(mocks.webRtcConnectionService.readyPeerIdsForLane).mockReturnValue([
                    'peer-removed'
                ]);
                return {
                    status: 'open',
                    peerId,
                    laneId,
                    channel: mocks.realtimeChannel
                };
            }
        );
        vi.mocked(mocks.realtimeChannel.sendJson).mockImplementation(() => {
            throw new Error('A peer removed from the accepted layout cannot receive room traffic.');
        });

        const result = await createRallarFacade()
            .realtime.room<{ x: number; }>({ roomId: 'room-1', laneId: 'motion' })
            .send({ x: 1 });

        expect(result.status).toBe('not-ready');
        expect(result.peerIds).toEqual([]);
        expect(result.desiredPeerIds).toEqual(['peer-current']);
        expect(result.readiness?.readyPeerIds).toEqual(['peer-removed']);
        expect(result.transportStatus?.rtc.readyPeerIds).toEqual([]);
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
        vi.mocked(mocks.realtimeChannel.sendJson).mockImplementation(() => {
            throw new Error('A room lane without ready peers cannot send');
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
    });

    it('does not open or send room realtime for a room the current session has not joined', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mockGroupSnapshot(createGroupSnapshot('room-1', ['peer-ready']));
        vi.mocked(mocks.webRtcConnectionService.ensurePeerLaneOpen).mockImplementation(
            async (peerId) => {
                throw new Error(`An unjoined room cannot open ${peerId}`);
            }
        );
        vi.mocked(mocks.realtimeChannel.sendJson).mockImplementation(() => {
            throw new Error('An unjoined room cannot send');
        });

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
    });

    it('returns halted without waiting or sending while room transport is halted', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const base = createGroupSnapshot('room-1', ['session-1', 'peer-ready']);
        const snapshot = {
            ...base,
            group: { ...base.group, transportState: 'halted' as const }
        };
        mockGroupSnapshot(snapshot);
        vi.mocked(mocks.webRtcConnectionService.ensurePeerLaneOpen).mockImplementation(
            () => {
                throw new Error('Halted room realtime cannot open a peer lane.');
            }
        );
        vi.mocked(mocks.realtimeChannel.sendJson).mockImplementation(() => {
            throw new Error('Halted room realtime cannot send.');
        });

        const result = await createRallarFacade()
            .realtime.room<{ x: number; }>({ roomId: 'room-1', laneId: 'motion' })
            .send({ x: 1 });

        expect(result.status).toBe('halted');
        expect(result.desiredPeerIds).toEqual(['peer-ready']);
        expect(result.transportStatus?.rtc.state).toBe('halted');
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
    mocks.findAcceptedOverlayById.mockImplementation((overlayId) => {
        const snapshot = snapshots.find(
            (candidate) => toScopedOverlayId(candidate.group) === overlayId
        );
        return snapshot ? createAcceptedOverlay(snapshot) : undefined;
    });
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
    const snapshot = createGroupSnapshotFixture({
        applicationId,
        workspaceId,
        groupId,
        sessionIds
    });
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            acceptedLayoutIdentity: {
                ...snapshot.causalRevision,
                version: 1,
                state: 'active'
            }
        }
    };
}

function createAcceptedOverlay(snapshot: GroupSnapshot): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: snapshot.causalRevision,
        provenance: 'server',
        state: 'active',
        overlayId: toScopedOverlayId(snapshot.group),
        groupRef: snapshot.group,
        topology: 'tree',
        name: snapshot.group.displayName,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        nextHopSessionIds: snapshot.activeSessions.map(({ sessionId }) => sessionId),
        degreeLimit: 2,
        overlayVersion: 1,
        updatedAtEpochMs: 1
    };
}
