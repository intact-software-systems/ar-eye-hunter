import { beforeEach, describe, expect, it, vi } from 'vitest';
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
        connectedPeerIds: vi.fn((): readonly string[] => []),
        knownPeerIds: vi.fn((): readonly string[] => []),
        activePeerIds: vi.fn((): readonly string[] => []),
        readyPeerIdsForLane: vi.fn((_laneId?: string): readonly string[] => []),
        connectToPeerIfAbsent: vi.fn((_peerId: string) =>
            Promise.resolve({
                left: {
                    kind: 'connect-failed',
                    peerId: _peerId,
                    error: new Error('connect not mocked'),
                },
            })
        ),
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
                stop: vi.fn(),
            },
            rtcRxStreamer: {
                enqueueOutboxIfAbsent: vi.fn(async () => ({
                    status: 'enqueued',
                    entries: [],
                })),
                onRemoteStreamDo: vi.fn(),
                removeOnRemoteStreamCallbackById: vi.fn(),
                stopLocalMedia: vi.fn(),
            },
            webRtcGroupManager: {},
            webRtcConnectionService,
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
                })),
                socket: {
                    close: vi.fn(),
                },
            },
        },
    } as unknown as ApiMiddleware;

    return {
        ctx,
        clearSession: vi.fn(),
        clearMiddleware: vi.fn(),
        hydrateStateCaches: vi.fn(() => Promise.resolve()),
        initMiddleware: vi.fn((_options?: unknown) => Promise.resolve(ctx)),
        isMiddlewareReady: vi.fn(() => false),
        joinStateGroup: vi.fn(
            (
                _roomId?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('join not mocked')),
        ),
        leaveStateGroup: vi.fn(
            (
                _roomId?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('leave not mocked')),
        ),
        loginToApi: vi.fn((_request?: unknown, _options?: unknown) =>
            Promise.resolve(session)
        ),
        logoutFromApi: vi.fn((_options?: unknown) =>
            Promise.resolve({ loggedOut: true })
        ),
        registerWithApi: vi.fn((_request?: unknown, _options?: unknown) =>
            Promise.resolve({
                clientId: 'client-new',
                username: 'new-user',
                registeredAtEpochMs: 1_000,
            })
        ),
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
        writeSession: vi.fn(),
    };
});

vi.mock('@shared-web/browser/app-context.ts', () => ({
    clearMiddleware: mocks.clearMiddleware,
    getMiddleware: vi.fn(() => mocks.ctx),
    initMiddleware: mocks.initMiddleware,
    isMiddlewareReady: mocks.isMiddlewareReady,
}));

vi.mock('@shared-web/browser/api-integration.ts', () => ({
    loginToApi: mocks.loginToApi,
    logoutFromApi: mocks.logoutFromApi,
    registerWithApi: mocks.registerWithApi,
}));

vi.mock('@shared-web/browser/api-workflows.ts', () => ({
    joinStateGroup: mocks.joinStateGroup,
    leaveStateGroup: mocks.leaveStateGroup,
    refreshStateSnapshots: mocks.refreshStateSnapshots,
}));

vi.mock('@shared-web/browser/data-caches.ts', () => ({
    hydrateStateCaches: mocks.hydrateStateCaches,
    onStateCacheChange: mocks.onStateCacheChange,
}));

vi.mock('@shared/api/auth.ts', () => ({
    clearSession: mocks.clearSession,
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: mocks.writeSession,
}));

vi.mock('@shared/repository/client-state-snapshots-repository.ts', () => ({
    findClientStateSnapshotByPrincipalId: mocks.clientRepositoryMissing,
    getAllClientStateSnapshots: mocks.clientRepositoryMissing,
}));

vi.mock('@shared/repository/group-state-snapshots-repository.ts', () => ({
    findFirstGroupStateSnapshotIdSessionIdIsIn: mocks.groupRepositoryMissing,
    findGroupStateSnapshotById: mocks.groupRepositoryMissing,
    getAllGroupStateSnapshots: mocks.groupRepositoryMissing,
}));

describe('Rallar operation options', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
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
        mocks.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
        mocks.initMiddleware.mockResolvedValue(mocks.ctx);
        mocks.isMiddlewareReady.mockReturnValue(false);
        mocks.joinStateGroup.mockRejectedValue(new Error('join not mocked'));
        mocks.leaveStateGroup.mockRejectedValue(new Error('leave not mocked'));
        mocks.webRtcConnectionService.connectedPeerIds.mockReturnValue([]);
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue([]);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue([]);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([]);
        mocks.webRtcConnectionService.connectToPeerIfAbsent.mockImplementation(
            (peerId: string) =>
                Promise.resolve({
                    left: {
                        kind: 'connect-failed',
                        peerId,
                        error: new Error('connect not mocked'),
                    },
                }),
        );
        mocks.webRtcConnectionService.onRtcPeerLifecycleDo.mockImplementation(() =>
            mocks.webRtcConnectionService
        );
        mocks.webRtcConnectionService.readPeer.mockReturnValue(undefined);
        mocks.webRtcConnectionService.removeRtcPeerLifecycleById.mockReturnValue(true);
        mocks.ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent.mockResolvedValue({
            status: 'enqueued',
            entries: [],
        });
        mocks.ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent.mockResolvedValue({
            status: 'enqueued',
            entries: [],
        });
        mocks.ctx.middleware.webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: mocks.ctx.session.sessionId,
            url: 'ws://localhost/ws',
            readyState: 'missing',
            isOpen: false,
            reconnecting: false,
        });
        mocks.registerWithApi.mockResolvedValue({
            clientId: 'client-new',
            username: 'new-user',
            registeredAtEpochMs: 1_000,
        });
    });

    it('returns empty state before cache repositories are configured', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();
        const roomListener = vi.fn();
        const peopleListener = vi.fn();

        expect(facade.rooms.state().rooms).toEqual([]);
        expect(facade.rooms.state().members).toEqual([]);
        expect(facade.people.state().people).toEqual([]);
        expect(facade.people.state().clients).toEqual([]);
        expect(facade.people.get('principal-1')).toBeUndefined();

        facade.rooms.onChange(roomListener);
        facade.people.onChange(peopleListener);

        expect(roomListener).toHaveBeenCalledWith(
            expect.objectContaining({ rooms: [], members: [] }),
        );
        expect(peopleListener).toHaveBeenCalledWith(
            expect.objectContaining({ people: [], clients: [] }),
        );
    });

    it('exposes empty RTC and WS diagnostics before connecting', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();

        expect(facade.rtc.status()).toEqual({
            sessionId: 'session-1',
            laneId: 'reliable',
            knownPeerIds: [],
            activePeerIds: [],
            connectedPeerIds: [],
            readyPeerIds: [],
            peers: [],
        });
        expect(facade.rtc.knownPeerIds()).toEqual([]);
        expect(facade.rtc.activePeerIds()).toEqual([]);
        expect(facade.rtc.readyPeerIds()).toEqual([]);
        expect(facade.ws.status()).toEqual({
            sessionId: 'session-1',
            connectState: 'idle',
            readyState: 'missing',
            isOpen: false,
            reconnecting: false,
        });
    });

    it('exposes read-only RTC peer and lane diagnostics', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const reliableHealth = createChannelHealth({
            peerId: 'peer-1',
            label: 'rtc-data-channel',
            state: 'Open',
            readyState: 'open',
        });
        const realtimeHealth = createChannelHealth({
            peerId: 'peer-1',
            label: 'rtc-realtime',
            state: 'Open',
            readyState: 'open',
        });
        const peer = {
            peerId: 'peer-1',
            connection: {
                status: {
                    state: 'Open',
                    pc: {
                        connectionState: 'connected',
                        iceConnectionState: 'connected',
                        signalingState: 'stable',
                    },
                    reconnectAttempts: 2,
                    reconnectTimer: undefined,
                    disconnectTimer: undefined,
                    makingOffer: false,
                    ignoreOffer: false,
                    iceCandidateQueue: [{}],
                    localStream: {
                        id: 'local-stream',
                    },
                    remoteStreams: new Map([['remote-stream', {}]]),
                },
            },
            channels: new Map([
                ['reliable', { readHealth: vi.fn(() => reliableHealth) }],
                ['realtime', { readHealth: vi.fn(() => realtimeHealth) }],
            ]),
        };
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.connectedPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();

        await facade.connect();

        expect(facade.rtc.knownPeerIds()).toEqual(['peer-1']);
        expect(facade.rtc.activePeerIds()).toEqual(['peer-1']);
        expect(facade.rtc.readyPeerIds('realtime')).toEqual(['peer-1']);
        expect(mocks.webRtcConnectionService.readyPeerIdsForLane)
            .toHaveBeenCalledWith('realtime');
        expect(facade.rtc.peer('peer-1', { laneId: 'realtime' }))
            .toMatchObject({
                peerId: 'peer-1',
                isActive: true,
                isConnectedPeer: true,
                isRoutable: true,
                readyLaneIds: ['reliable', 'realtime'],
                connection: {
                    state: 'Open',
                    connectionState: 'connected',
                    iceConnectionState: 'connected',
                    signalingState: 'stable',
                    reconnectAttempts: 2,
                    reconnecting: false,
                    disconnectPending: false,
                    iceCandidateQueueSize: 1,
                    localStreamId: 'local-stream',
                    remoteStreamIds: ['remote-stream'],
                },
                lanes: [
                    {
                        peerId: 'peer-1',
                        laneId: 'reliable',
                        channel: reliableHealth,
                        isOpen: true,
                        isReconnectable: false,
                    },
                    {
                        peerId: 'peer-1',
                        laneId: 'realtime',
                        channel: realtimeHealth,
                        isOpen: true,
                        isReconnectable: false,
                    },
                ],
            });
        expect(facade.rtc.status({ laneId: 'realtime' })).toMatchObject({
            sessionId: 'session-1',
            laneId: 'realtime',
            knownPeerIds: ['peer-1'],
            activePeerIds: ['peer-1'],
            connectedPeerIds: ['peer-1'],
            readyPeerIds: ['peer-1'],
            peers: [
                expect.objectContaining({
                    peerId: 'peer-1',
                }),
            ],
        });
    });

    it('exposes read-only WS diagnostics after connecting', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.ctx.middleware.webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: 'session-1',
            url: 'ws://localhost/ws',
            readyState: 'open',
            readyStateCode: 1,
            isOpen: true,
            reconnecting: true,
        });
        const facade = createRallarFacade();

        await facade.connect();

        expect(facade.ws.status()).toEqual({
            sessionId: 'session-1',
            url: 'ws://localhost/ws',
            connectState: 'connected',
            readyState: 'open',
            readyStateCode: 1,
            isOpen: true,
            reconnecting: true,
        });
    });

    it('passes signal and timeout options into connect and room refresh workflows', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const signal = new AbortController().signal;
        const scope = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        };

        await createRallarFacade().rooms.refresh({
            scope,
            signal,
            timeoutMs: 123,
        });

        expect(mocks.initMiddleware).toHaveBeenCalledWith({
            signal,
            timeoutMs: 123,
        });
        expect(mocks.refreshStateSnapshots).toHaveBeenCalledWith(scope, {
            command: {
                signal,
                timeoutMs: 123,
            },
        });
    });

    it('passes custom data-channel lanes into middleware connect', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const lanes = [
            {
                id: 'realtime',
                label: 'custom-realtime',
                init: {
                    ordered: false,
                    maxRetransmits: 0,
                },
                binaryType: 'arraybuffer' as const,
                flowControl: {
                    highWatermarkBytes: 4096,
                    lowWatermarkBytes: 1024,
                    overflow: 'drop-old' as const,
                    maxQueueItems: 4,
                },
            },
        ];

        await createRallarFacade().connect({
            dataChannelLanes: lanes,
        });

        expect(mocks.initMiddleware).toHaveBeenCalledWith({
            dataChannelLanes: lanes,
        });
    });

    it('keeps the legacy scope shorthand for refresh operations', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const scope = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        };

        await createRallarFacade().people.refresh(scope);

        expect(mocks.refreshStateSnapshots).toHaveBeenCalledWith(scope, {});
    });

    it('passes signal and timeout options into auth login', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const signal = new AbortController().signal;

        await createRallarFacade().auth.login(
            {
                username: 'principal-1',
                password: 'password-1',
            },
            {
                signal,
                timeoutMs: 123,
            },
        );

        expect(mocks.loginToApi.mock.calls[0]?.[0]).toEqual({
            username: 'principal-1',
            password: 'password-1',
        });
        const loginOptions = mocks.loginToApi.mock.calls[0]?.[1] as
            | { signal?: AbortSignal }
            | undefined;
        expect(loginOptions?.signal).toBeInstanceOf(AbortSignal);
    });

    it('passes an explicit admin session into auth registration', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const signal = new AbortController().signal;
        const adminSession = {
            ...mocks.ctx.session,
            clientId: 'admin',
            accessToken: 'admin-token',
            username: 'admin',
        };

        await createRallarFacade().auth.register(
            {
                username: 'new-user',
                password: 'password-1',
                displayName: 'New User',
            },
            {
                adminSession,
                signal,
                timeoutMs: 123,
            },
        );

        expect(mocks.registerWithApi.mock.calls[0]?.[0]).toEqual({
            username: 'new-user',
            password: 'password-1',
            displayName: 'New User',
        });
        const registerOptions = mocks.registerWithApi.mock.calls[0]?.[1] as
            | { signal?: AbortSignal; authSession?: unknown }
            | undefined;
        expect(registerOptions?.signal).toBeInstanceOf(AbortSignal);
        expect(registerOptions?.authSession).toBe(adminSession);
    });

    it('can register and then log in with the new user', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );

        await createRallarFacade().auth.registerAndLogin({
            username: 'new-user',
            password: 'password-1',
        });

        expect(mocks.registerWithApi).toHaveBeenCalledOnce();
        expect(mocks.loginToApi).toHaveBeenCalledWith(
            {
                username: 'new-user',
                password: 'password-1',
            },
            expect.any(Object),
        );
        expect(mocks.writeSession).toHaveBeenCalledWith(mocks.ctx.session);
    });

    it('revokes the backend session when logging out', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const signal = new AbortController().signal;

        await createRallarFacade().auth.logout({ signal, timeoutMs: 123 });

        expect(mocks.logoutFromApi).toHaveBeenCalledOnce();
        const logoutOptions = mocks.logoutFromApi.mock.calls[0]?.[0] as
            | { signal?: AbortSignal }
            | undefined;
        expect(logoutOptions?.signal).toBeInstanceOf(AbortSignal);
        expect(mocks.clearSession).toHaveBeenCalledOnce();
    });

    it('applies timeout options when waiting on an in-flight connect', async () => {
        vi.useFakeTimers();
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const deferred = createDeferred<ApiMiddleware>();
        mocks.initMiddleware.mockReturnValueOnce(deferred.promise);
        const facade = createRallarFacade();

        const primaryConnect = facade.connect();
        const timedConnect = facade.connect({ timeoutMs: 10 });
        const expectation = expect(timedConnect).rejects.toThrow(
            'Command timed out after 10 ms',
        );

        await vi.advanceTimersByTimeAsync(10);
        await expectation;

        deferred.resolve(mocks.ctx);
        await primaryConnect;
    });

    it('does not leave the current room when joining the next room fails', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.groupRepositoryMissing.mockImplementation((value?: unknown) => {
            if (value === 'session-1') {
                return 'old-room';
            }

            throw new Error(
                'Repository not found: shared.repository.group-state-snapshots',
            );
        });
        mocks.joinStateGroup.mockRejectedValueOnce(new Error('join failed'));

        await expect(createRallarFacade().rooms.join('new-room')).rejects.toThrow(
            'join failed',
        );

        expect(mocks.leaveStateGroup).not.toHaveBeenCalled();
    });

    it('sends realtime JSON over the requested peer lane', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const sendResult = {
            status: 'sent',
            bufferedAmount: 0,
        };
        const realtimeChannel = {
            waitUntilOpen: vi.fn(async () => true),
            sendJson: vi.fn(() => sendResult),
        };
        const peer = {
            peerId: 'peer-1',
            channels: new Map([['realtime', realtimeChannel]]),
        };
        mocks.webRtcConnectionService.connectToPeerIfAbsent.mockResolvedValueOnce({
            right: peer,
        });

        const result = await createRallarFacade().realtime.sendJson({
            peerIds: ['peer-1'],
            data: {
                x: 1,
            },
            key: 'player-1',
        });

        expect(mocks.webRtcConnectionService.connectToPeerIfAbsent)
            .toHaveBeenCalledWith('peer-1');
        expect(realtimeChannel.waitUntilOpen).toHaveBeenCalledWith(5_000);
        expect(realtimeChannel.sendJson).toHaveBeenCalledWith(
            {
                x: 1,
            },
            expect.objectContaining({
                key: 'player-1',
            }),
        );
        expect(result).toEqual([
            {
                peerId: 'peer-1',
                laneId: 'realtime',
                result: sendResult,
            },
        ]);
    });

    it('does not send realtime JSON before the requested lane opens', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const realtimeChannel = {
            waitUntilOpen: vi.fn(async () => false),
            sendJson: vi.fn(),
        };
        const peer = {
            peerId: 'peer-1',
            channels: new Map([['realtime', realtimeChannel]]),
        };
        mocks.webRtcConnectionService.connectToPeerIfAbsent.mockResolvedValueOnce({
            right: peer,
        });

        await expect(
            createRallarFacade().realtime.sendJson({
                peerIds: ['peer-1'],
                data: {
                    x: 1,
                },
                openTimeoutMs: 25,
            }),
        ).resolves.toEqual([
            {
                peerId: 'peer-1',
                laneId: 'realtime',
                result: {
                    status: 'closed',
                    reason: 'Realtime lane not connected',
                    bufferedAmount: 0,
                },
            },
        ]);

        expect(realtimeChannel.waitUntilOpen).toHaveBeenCalledWith(25);
        expect(realtimeChannel.sendJson).not.toHaveBeenCalled();
    });

    it('returns a closed realtime send result when the peer has no requested lane', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const peer = {
            peerId: 'peer-1',
            channels: new Map(),
        };
        mocks.webRtcConnectionService.connectToPeerIfAbsent.mockResolvedValueOnce({
            right: peer,
        });

        await expect(
            createRallarFacade().realtime.sendJson({
                peerIds: ['peer-1'],
                laneId: 'missing',
                data: {
                    x: 1,
                },
            }),
        ).resolves.toEqual([
            {
                peerId: 'peer-1',
                laneId: 'missing',
                result: {
                    status: 'closed',
                    reason: 'Realtime lane not connected',
                    bufferedAmount: 0,
                },
            },
        ]);
    });

    it('returns RTC send status with the message when multicast enqueue reports no entries', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent.mockResolvedValueOnce({
            status: 'no-route',
            entries: [],
            reason: 'Skipping RTC outbound dispatch without planned transport messages',
        });

        const result = await createRallarFacade().messages.rtc.send({
            roomId: 'room-1',
            typeId: 'chat.message.v1',
            resourceId: 'msg-quiet',
            payload: {
                text: 'quiet outcome',
            },
        });

        expect(mocks.ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent)
            .toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            transport: 'rtc',
            status: 'no-route',
            reason: 'Skipping RTC outbound dispatch without planned transport messages',
            entries: [],
            message: {
                id: {
                    senderId: 'session-1',
                },
                route: {
                    topicId: 'chat.message.v1',
                    resourceId: 'msg-quiet',
                    contextId: 'room-1',
                },
                targets: {
                    mode: 'multicast',
                    groupId: 'room-1',
                },
                forwarding: {
                    overlayId: 'room-1',
                },
            },
        });
    });

    it('returns WS send status with the message when WS enqueue completes', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent
            .mockResolvedValueOnce({
                status: 'sent-immediate',
                entries: [],
            });

        const result = await createRallarFacade().messages.ws.send({
            scope: 'all',
            typeId: 'chat.message.v1',
            resourceId: 'msg-ws',
            payload: {
                text: 'ws outcome',
            },
        });

        expect(mocks.ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent)
            .toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            transport: 'ws',
            status: 'sent-immediate',
            entries: [],
            message: {
                id: {
                    senderId: 'session-1',
                },
                route: {
                    topicId: 'chat.message.v1',
                    resourceId: 'msg-ws',
                    contextId: 'all',
                },
                targets: {
                    mode: 'broadcast',
                    scope: 'all',
                },
            },
        });
    });

    it('registers realtime JSON listeners on connected peers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        type RawCallback = {
            onMessage: (data: unknown, event: MessageEvent) => Promise<void>;
        };
        const rawCallbacks = new Map<string, RawCallback>();
        const realtimeChannel = {
            onRawMessageDo: vi.fn((id: string, callback: RawCallback) => {
                rawCallbacks.set(id, callback);
                return realtimeChannel;
            }),
            removeOnRawMessageCallbackById: vi.fn(),
        };
        const peer = {
            peerId: 'peer-1',
            channels: new Map([['realtime', realtimeChannel]]),
        };
        mocks.webRtcConnectionService.connectedPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const handler = vi.fn();
        const facade = createRallarFacade();

        facade.realtime.onJson('realtime', handler);
        await facade.connect();

        expect(realtimeChannel.onRawMessageDo).toHaveBeenCalledWith(
            'rallar:realtime:realtime',
            expect.objectContaining({
                onMessage: expect.any(Function),
            }),
        );

        const callback = rawCallbacks.get('rallar:realtime:realtime');
        await callback?.onMessage?.(
            JSON.stringify({
                x: 1,
            }),
            {
                data: JSON.stringify({
                    x: 1,
                }),
            } as MessageEvent,
        );

        expect(handler).toHaveBeenCalledWith(
            expect.objectContaining({
                peerId: 'peer-1',
                laneId: 'realtime',
                data: {
                    x: 1,
                },
            }),
        );
    });

    it('registers realtime binary listeners and normalizes typed arrays to ArrayBuffer', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        type RawCallback = {
            onMessage: (data: unknown, event: MessageEvent) => Promise<void>;
        };
        const rawCallbacks = new Map<string, RawCallback>();
        const realtimeChannel = {
            onRawMessageDo: vi.fn((id: string, callback: RawCallback) => {
                rawCallbacks.set(id, callback);
                return realtimeChannel;
            }),
            removeOnRawMessageCallbackById: vi.fn(),
        };
        const peer = {
            peerId: 'peer-1',
            channels: new Map([['realtime', realtimeChannel]]),
        };
        mocks.webRtcConnectionService.connectedPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const handler = vi.fn();
        const facade = createRallarFacade();

        facade.realtime.onBinary('realtime', handler);
        await facade.connect();

        const callback = rawCallbacks.get('rallar:realtime:realtime');
        await callback?.onMessage?.(
            new Uint8Array([1, 2, 3]),
            {
                data: new Uint8Array([1, 2, 3]),
            } as MessageEvent,
        );

        expect(handler).toHaveBeenCalledOnce();
        const message = handler.mock.calls[0]?.[0];
        expect(message).toMatchObject({
            peerId: 'peer-1',
            laneId: 'realtime',
        });
        expect(Array.from(new Uint8Array(message.data))).toEqual([1, 2, 3]);
    });

    it('exposes realtime lane health for connected peers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const health = {
            peerId: 'peer-1',
            label: 'rtc-realtime',
            state: 'Open',
            readyState: 'open',
            bufferedAmount: 12,
            queuedItemCount: 1,
            counters: {
                sent: 2,
                dropped: 1,
            },
        };
        const realtimeChannel = {
            readHealth: vi.fn(() => health),
        };
        const peer = {
            peerId: 'peer-1',
            channels: new Map([['realtime', realtimeChannel]]),
        };
        mocks.webRtcConnectionService.connectedPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();

        await facade.connect();

        expect(facade.realtime.health({ laneIds: ['realtime'] })).toEqual([
            {
                peerId: 'peer-1',
                laneId: 'realtime',
                channel: health,
            },
        ]);
    });
});

function createChannelHealth(
    input: Readonly<{
        peerId: string;
        label: string;
        state: string;
        readyState: RTCDataChannelState;
    }>,
) {
    return {
        peerId: input.peerId,
        label: input.label,
        state: input.state,
        role: 'Initiator',
        readyState: input.readyState,
        binaryType: 'arraybuffer' as const,
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        queuedItemCount: 0,
        rawCallbackCount: 0,
        messageCallbackCount: 0,
        lifecycleCallbackCount: 0,
        flowControl: {
            highWatermarkBytes: 64 * 1024,
            lowWatermarkBytes: 16 * 1024,
            overflow: 'drop-new' as const,
            maxQueueItems: 32,
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
            receivedBinary: 0,
        },
    };
}

function createDeferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });

    return { promise, resolve, reject };
}
