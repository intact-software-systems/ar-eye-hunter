import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';

const mocks = vi.hoisted(() => {
    const session = {
        clientId: 'principal-1',
        sessionId: 'session-1',
        username: 'principal-1',
        accessToken: 'token-1',
        expiresAtEpochMs: Date.now() + 60_000,
    };
    const webRtcConnectionService = {
        peerIdsWithNoReconnectableLanes: vi.fn((): readonly string[] => []),
        knownPeerIds: vi.fn((): readonly string[] => []),
        activePeerIds: vi.fn((): readonly string[] => []),
        readyPeerIdsForLane: vi.fn((_laneId?: string): readonly string[] => []),
        ensurePeerConnectionStarted: vi.fn((_peerId: string) => ({
            left: {
                kind: 'connect-failed',
                peerId: _peerId,
                error: new Error('connect not mocked'),
            },
        })),
        ensurePeerLaneOpen: vi.fn(async (peerId: string, laneId: string) => ({
            status: 'connect-failed',
            peerId,
            laneId,
            error: new Error('connect not mocked'),
        })),
        disconnectPeer: vi.fn(() => true),
        onRtcPeerLifecycleDo: vi.fn(),
        readPeer: vi.fn(),
        removeRtcPeerLifecycleById: vi.fn(() => true),
    };
    webRtcConnectionService.onRtcPeerLifecycleDo.mockImplementation(() =>
        webRtcConnectionService
    );
    const ctx = {
        session,
        authFetch: vi.fn(),
        middleware: {
            qboxEngine: {
                wake: vi.fn(),
                stop: vi.fn(),
            },
            rtcRxStreamer: {
                enqueueOutboxIfAbsent: vi.fn(async () => ({
                    status: 'enqueued',
                    entries: [],
                })),
                onInboxMessageDo: vi.fn(),
                removeInboxMessageCallback: vi.fn(() => true),
                stopAllHeartbeats: vi.fn(),
            },
            webRtcGroupManager: {},
            webRtcConnectionService,
            heartbeat: {
                stop: vi.fn(),
            },
            webSocketQueueBox: {
                enqueueOutboxIfAbsent: vi.fn(async () => ({
                    status: 'enqueued',
                    entries: [],
                })),
                readHealth: vi.fn(() => ({
                    sessionId: session.sessionId,
                    url: 'ws://localhost/ws',
                    readyState: 'missing',
                    isOpen: false,
                    reconnecting: false,
                    reconnectEnabled: false,
                    reconnectAttempts: 0,
                    maxReconnectAttempts: 12,
                    reconnectExhausted: false,
                })),
                close: vi.fn(),
                onAnyInboxMessageDo: vi.fn(),
                removeAnyInboxMessageCallback: vi.fn(() => true),
                socket: {
                    close: vi.fn(),
                    onWebsocketCallbacksDo: vi.fn(),
                    removeWebsocketCallbackById: vi.fn(() => true),
                },
            },
        },
    } as unknown as ApiMiddleware;

    return {
        ctx,
        hydrateStateCaches: vi.fn(() => Promise.resolve()),
        initMiddleware: vi.fn((_options?: unknown) => Promise.resolve(ctx)),
        isMiddlewareReady: vi.fn(() => false),
        onStateCacheChange: vi.fn(() => vi.fn()),
        readSession: vi.fn(() => session),
        refreshStateSnapshots: vi.fn((_scope?: unknown, _policies?: unknown) =>
            Promise.resolve({ clients: [], groups: [] })
        ),
        clientRepositoryMissing: vi.fn((_value?: unknown): unknown => {
            throw new Error(
                'Repository not found: shared.repository.client-state-snapshots',
            );
        }),
        groupRepositoryMissing: vi.fn((_value?: unknown): unknown => {
            throw new Error(
                'Repository not found: shared.repository.group-state-snapshots',
            );
        }),
        webRtcConnectionService,
    };
});

vi.mock('@shared-web/browser/app-context.ts', () => ({
    clearMiddleware: vi.fn(),
    getMiddleware: vi.fn(() => mocks.ctx),
    initMiddleware: mocks.initMiddleware,
    isMiddlewareReady: mocks.isMiddlewareReady,
}));

vi.mock('@shared-web/browser/api-workflows.ts', () => ({
    refreshStateSnapshots: mocks.refreshStateSnapshots,
}));

vi.mock('@shared-web/browser/data-caches.ts', () => ({
    hydrateStateCaches: mocks.hydrateStateCaches,
    onStateCacheChange: mocks.onStateCacheChange,
}));

vi.mock('@shared/api/auth.ts', () => ({
    clearSession: vi.fn(),
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: vi.fn(),
}));

vi.mock('@shared/repository/client-state-snapshots-repository.ts', () => ({
    findClientStateSnapshotByPrincipalId: mocks.clientRepositoryMissing,
    getAllClientStateSnapshots: mocks.clientRepositoryMissing,
}));

vi.mock('@shared/repository/group-state-snapshots-repository.ts', () => ({
    findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.groupRepositoryMissing,
    findGroupStateSnapshotByRef: mocks.groupRepositoryMissing,
    getAllGroupStateSnapshots: mocks.groupRepositoryMissing,
}));

describe('Rallar facade defaults compatibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.clientRepositoryMissing.mockImplementation(() => {
            throw new Error(
                'Repository not found: shared.repository.client-state-snapshots',
            );
        });
        mocks.groupRepositoryMissing.mockImplementation(() => {
            throw new Error(
                'Repository not found: shared.repository.group-state-snapshots',
            );
        });
        mocks.hydrateStateCaches.mockResolvedValue(undefined);
        mocks.initMiddleware.mockResolvedValue(mocks.ctx);
        mocks.isMiddlewareReady.mockReturnValue(false);
        mocks.readSession.mockReturnValue(mocks.ctx.session);
        mocks.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
        mocks.webRtcConnectionService.ensurePeerConnectionStarted.mockImplementation(
            (peerId: string) => ({
                left: {
                    kind: 'connect-failed',
                    peerId,
                    error: new Error('connect not mocked'),
                },
            }),
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId: string, laneId: string) => ({
                status: 'connect-failed',
                peerId,
                laneId,
                error: new Error('connect not mocked'),
            }),
        );
        mocks.webRtcConnectionService.onRtcPeerLifecycleDo.mockReturnValue(
            mocks.webRtcConnectionService,
        );
        mocks.ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent.mockResolvedValue({
            status: 'enqueued',
            entries: [],
        });
        mocks.ctx.middleware.rtcRxStreamer.onInboxMessageDo.mockReturnValue(
            mocks.ctx.middleware.rtcRxStreamer,
        );
        mocks.ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent.mockResolvedValue({
            status: 'enqueued',
            entries: [],
        });
        mocks.ctx.middleware.webSocketQueueBox.onAnyInboxMessageDo.mockReturnValue(
            mocks.ctx.middleware.webSocketQueueBox,
        );
        mocks.ctx.middleware.webSocketQueueBox.socket.onWebsocketCallbacksDo
            .mockReturnValue(mocks.ctx.middleware.webSocketQueueBox.socket);
    });

    it('uses facade defaults as the operation scope when no explicit scope is passed', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();

        facade.setDefaults({
            applicationId: 'default-app',
        });

        await facade.people.refresh();

        expect(facade.defaults()).toEqual({
            applicationId: 'default-app',
        });
        expect(mocks.refreshStateSnapshots).toHaveBeenCalledWith(
            {
                applicationId: 'default-app',
                workspaceId: 'default',
            },
            {},
        );
    });

    it('uses facade defaults to build RTC group refs from room id strings', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'game-app',
            workspaceId: 'arena-1',
        });

        const result = await facade.messages.rtc.send({
            roomId: 'match-1',
            typeId: 'game.input.v1',
            resourceId: 'input-1',
            payload: {
                x: 1,
            },
        });

        expect(result.message.targets).toMatchObject({
            mode: 'multicast',
            groupRef: {
                applicationId: 'game-app',
                workspaceId: 'arena-1',
                groupId: 'match-1',
            },
        });
        expect(result.message.targets).not.toHaveProperty('groupId');
    });

    it('uses facade room defaults for RTC and WS sends without per-call room ids', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'game-app',
            workspaceId: 'arena-1',
            room: {
                roomId: 'match-1',
            },
        });

        const rtcResult = await facade.messages.rtc.send({
            typeId: 'game.input.v1',
            resourceId: 'rtc-input-1',
            payload: {
                x: 1,
            },
        });
        const wsResult = await facade.messages.ws.send({
            typeId: 'game.event.v1',
            resourceId: 'ws-event-1',
            payload: {
                text: 'joined',
            },
        });

        expect(rtcResult.message.route).toMatchObject({
            contextId: 'match-1',
            resourceId: 'rtc-input-1',
        });
        expect(rtcResult.message.targets).toMatchObject({
            mode: 'multicast',
            groupRef: {
                applicationId: 'game-app',
                workspaceId: 'arena-1',
                groupId: 'match-1',
            },
        });
        expect(wsResult.message.route).toMatchObject({
            contextId: 'match-1',
            resourceId: 'ws-event-1',
        });
        expect(wsResult.message.targets).toMatchObject({
            mode: 'broadcast',
            scope: 'room',
        });
    });

    it('uses facade operation and RTC lane defaults for connect and workflows', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const lanes = [
            {
                id: 'gameplay',
                label: 'gameplay-data',
                init: {
                    ordered: false,
                    maxRetransmits: 0,
                },
            },
        ];
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'default-app',
            rtc: {
                dataChannelLanes: lanes,
            },
            operations: {
                timeoutMs: 321,
            },
        });

        await facade.people.refresh();

        expect(mocks.initMiddleware).toHaveBeenCalledWith({
            onAuthInvalid: expect.any(Function),
            scope: {
                applicationId: 'default-app',
                workspaceId: 'default',
            },
            timeoutMs: 321,
            dataChannelLanes: lanes,
        });
        expect(mocks.refreshStateSnapshots).toHaveBeenCalledWith(
            {
                applicationId: 'default-app',
                workspaceId: 'default',
            },
            {
                command: {
                    timeoutMs: 321,
                },
            },
        );
    });

    it('uses facade room and realtime defaults for realtime sends', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const sendResult = {
            status: 'sent',
            bufferedAmount: 0,
        };
        const gameplayChannel = {
            sendJson: vi.fn(() => sendResult),
        };
        mockGroupSnapshot(createGroupSnapshot('match-1', ['session-1', 'peer-1']));
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValueOnce({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'gameplay',
            channel: gameplayChannel,
        });
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            room: {
                roomId: 'match-1',
            },
            realtime: {
                laneId: 'gameplay',
                openTimeoutMs: 750,
            },
        });

        const result = await facade.realtime.sendJson({
            data: {
                x: 1,
            },
        });

        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'gameplay',
                expect.objectContaining({
                    timeoutMs: 750,
                }),
            );
        expect(gameplayChannel.sendJson).toHaveBeenCalledWith(
            {
                x: 1,
            },
            expect.any(Object),
        );
        expect(result).toEqual([
            {
                peerId: 'peer-1',
                laneId: 'gameplay',
                result: sendResult,
            },
        ]);
    });

    it('uses facade RTC wait defaults when waiting for a lane', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValueOnce({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'reliable',
        });
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'app-1',
            rtc: {
                connectOnWait: true,
                waitTimeoutMs: 333,
            },
        });

        await facade.connect();
        const result = await facade.rtc.waitForOpen('peer-1');

        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'reliable',
                expect.objectContaining({
                    timeoutMs: 333,
                }),
            );
        expect(result).toMatchObject({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'reliable',
        });
    });
});

function mockGroupSnapshot(snapshot: GroupSnapshot): void {
    mockGroupSnapshots([snapshot]);
}

function mockGroupSnapshots(snapshots: readonly GroupSnapshot[]): void {
    mocks.groupRepositoryMissing.mockImplementation((key?: unknown) => {
        if (key === undefined) {
            return [...snapshots];
        }

        if (isGroupRefLike(key)) {
            return snapshots.find((snapshot) =>
                snapshot.group.groupId === key.groupId &&
                snapshot.group.applicationId === key.applicationId &&
                (snapshot.group.workspaceId ?? '') === (key.workspaceId ?? '')
            );
        }

        return snapshots.find((snapshot) => key === snapshot.group.groupId);
    });
}

function isGroupRefLike(value: unknown): value is GroupSnapshot['group'] {
    return typeof value === 'object' &&
        value !== null &&
        typeof (value as { groupId?: unknown }).groupId === 'string' &&
        typeof (value as { applicationId?: unknown }).applicationId === 'string';
}

function createGroupSnapshot(
    groupId: string,
    sessionIds: readonly string[],
    scope: Readonly<{
        applicationId?: string;
        workspaceId?: string;
    }> = {},
): GroupSnapshot {
    const applicationId = scope.applicationId ?? 'app-1';
    const workspaceId = scope.workspaceId ?? 'workspace-1';
    return {
        group: {
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 0,
            rosterVersion: 1,
            presenceVersion: 1,
            created: {
                atEpochMs: 1,
                byPrincipalId: 'creator',
            },
            updated: {
                atEpochMs: 1,
                byPrincipalId: 'creator',
            },
        },
        members: sessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: 'member',
            status: 'active',
            joined: {
                atEpochMs: 1,
                byPrincipalId: 'creator',
            },
            updated: {
                atEpochMs: 1,
                byPrincipalId: 'creator',
            },
        })),
        activeSessions: sessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length,
    };
}
