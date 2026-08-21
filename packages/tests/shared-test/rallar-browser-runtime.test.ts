import type { BlackBoxRallarCloseDiagnostics } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/contracts.ts';
import type { RallarCrdtSyncOptions, RallarCrdtSyncResult } from '@shared/crdt/crdt-types.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const facade = vi.hoisted(() => {
    const session = {
        clientId: 'client-1',
        accessToken: 'access-token-1',
        username: 'alice',
        sessionId: 'session-1',
        expiresAtEpochMs: Date.now() + 60_000
    };
    const roomRefresh = vi.fn();
    return {
        session,
        roomRefresh,
        unsubscribeRealtime: vi.fn(),
        unsubscribeMessagesRtc: vi.fn(),
        unsubscribeMessagesWs: vi.fn(),
        rallar: {
            configure: vi.fn(),
            setDefaults: vi.fn(),
            auth: {
                restore: vi.fn(),
                login: vi.fn(),
                registerAndLogin: vi.fn(),
                logout: vi.fn()
            },
            connect: vi.fn(),
            rooms: {
                join: vi.fn(),
                leave: vi.fn(),
                refresh: vi.fn(),
                session: vi.fn(() => ({
                    refresh: roomRefresh
                }))
            },
            realtime: {
                onJson: vi.fn(),
                health: vi.fn(),
                sendJson: vi.fn()
            },
            rtc: {
                status: vi.fn(),
                diagnostics: vi.fn()
            },
            messages: {
                rtc: {
                    onMessage: vi.fn(),
                    send: vi.fn()
                },
                ws: {
                    onMessage: vi.fn(),
                    send: vi.fn()
                }
            },
            crdt: {
                open: vi.fn()
            },
            director: {
                appoint: vi.fn(),
                resign: vi.fn(),
                status: vi.fn(),
                createRelay: vi.fn()
            },
            disconnect: vi.fn(),
            status: vi.fn(),
            isConnected: vi.fn(),
            session: vi.fn()
        }
    };
});

vi.mock('@shared-web/browser/rallar.ts', () => ({
    createRallarFacade: vi.fn(() => facade.rallar),
    rallar: facade.rallar
}));

type Runtime = Readonly<{
    authenticate(config: {
        connection: string;
        actor?: string;
        roomId?: string;
        rallar: Record<string, unknown>;
    }): Promise<unknown>;
    connect(config: {
        connection: string;
        actor?: string;
        roomId?: string;
        roomRef?: {
            applicationId: string;
            workspaceId?: string;
            groupId: string;
        };
        rallar: Record<string, unknown>;
    }): Promise<unknown>;
    send(input: unknown): Promise<unknown>;
    sendWs(input: unknown): Promise<unknown>;
    refreshRoom(
        options: Readonly<{
            signal?: AbortSignal;
            timeoutMs: number;
        }>
    ): Promise<void>;
    director: {
        appoint(input: unknown): Promise<unknown>;
        resign(input: unknown): Promise<unknown>;
        status(input: unknown): Promise<unknown>;
        relayStart(input: unknown): Promise<unknown>;
        intent(input: unknown): Promise<unknown>;
        syncRequest(input: unknown): Promise<unknown>;
        relayStop(input: unknown): Promise<unknown>;
    };
    crdt: {
        open(input: unknown): Promise<unknown>;
        apply(input: unknown): Promise<unknown>;
        read(input: unknown): Promise<unknown>;
        sync(input: unknown): Promise<unknown>;
        health(input: unknown): Promise<unknown>;
        wait(input: unknown): Promise<unknown>;
        undo(input: unknown): Promise<unknown>;
        redo(input: unknown): Promise<unknown>;
        close(input: unknown): Promise<unknown>;
        destroy(input: unknown): Promise<unknown>;
    };
    close(): Promise<BlackBoxRallarCloseDiagnostics>;
    health(input?: unknown): Promise<unknown>;
}>;

type TestWindow =
    & Readonly<{
        __blackBoxRallar?: Runtime;
    }>
    & {
        __blackBoxRallarEmit?: (event: unknown) => void;
    };

const events: unknown[] = [];

function resetFacade(): void {
    vi.clearAllMocks();
    events.length = 0;
    facade.rallar.auth.restore.mockReturnValue(undefined);
    facade.rallar.setDefaults.mockReturnValue(undefined);
    facade.rallar.auth.login.mockResolvedValue(facade.session);
    facade.rallar.auth.registerAndLogin.mockResolvedValue(facade.session);
    facade.rallar.auth.logout.mockResolvedValue(undefined);
    facade.rallar.connect.mockResolvedValue(undefined);
    facade.rallar.rooms.join.mockResolvedValue({});
    facade.rallar.rooms.leave.mockResolvedValue({});
    facade.rallar.rooms.refresh.mockResolvedValue({});
    facade.rallar.rooms.session.mockReturnValue({
        refresh: facade.roomRefresh
    });
    facade.roomRefresh.mockResolvedValue({});
    facade.rallar.realtime.onJson.mockReturnValue(facade.unsubscribeRealtime);
    facade.rallar.messages.rtc.onMessage.mockReturnValue(facade.unsubscribeMessagesRtc);
    facade.rallar.messages.ws.onMessage.mockReturnValue(facade.unsubscribeMessagesWs);
    facade.rallar.realtime.health.mockReturnValue([]);
    facade.rallar.rtc.status.mockReturnValue({
        sessionId: 'session-1',
        laneId: 'realtime',
        knownPeerIds: [],
        activePeerIds: [],
        peerIdsWithNoReconnectableLanes: [],
        readyPeerIds: [],
        peers: []
    });
    facade.rallar.rtc.diagnostics.mockResolvedValue({
        sessionId: 'session-1',
        generatedAtEpochMs: 123,
        peerCount: 1,
        connectedPeerCount: 1,
        relayPeerCount: 0,
        peers: [{
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
                remoteStreamIds: []
            },
            connectionDiagnostics: {
                connectCallCount: 1,
                connectIgnoredCount: 0,
                resetCount: 0,
                closedPeerConnectionCount: 0,
                negotiationNeededCount: 0,
                negotiationSkippedCount: 0,
                offerCreatedCount: 1,
                inboundOfferCount: 0,
                inboundAnswerCount: 1,
                inboundIceCandidateCount: 0,
                staleAnswerIgnoredCount: 0,
                offerCollisionCount: 0,
                ignoredOfferCollisionCount: 0,
                politeOfferRollbackCount: 0,
                outboundOfferCount: 1,
                outboundAnswerCount: 0,
                outboundIceCandidateCount: 0,
                queuedIceCandidateCount: 0,
                addedIceCandidateCount: 0,
                flushedIceCandidateCount: 0,
                ignoredIceCandidateForIgnoredOfferCount: 0,
                reconnectAttemptCount: 0,
                reconnectTimerAlreadyActiveCount: 0,
                reconnectExhaustedCount: 0,
                iceRestartCount: 0,
                iceRestartSkippedConnectedCount: 0,
                disconnectTimerScheduledCount: 0,
                disconnectTimerAlreadyActiveCount: 0,
                disconnectTimerClearedCount: 0,
                disconnectTimerFiredCount: 0,
                outboundSignalingErrorCount: 0,
                inboundSignalingErrorCount: 0,
                pendingIceCandidateQueueLength: 0,
                reconnectAttemptsInFlight: 0,
                hasReconnectTimer: false
            },
            lanes: [],
            usesRelay: false,
            statsAvailable: false
        }]
    });
    facade.rallar.realtime.sendJson.mockResolvedValue([]);
    facade.rallar.messages.rtc.send.mockResolvedValue({});
    facade.rallar.messages.ws.send.mockResolvedValue({});
    facade.rallar.crdt.open.mockReset();
    facade.rallar.director.appoint.mockReset();
    facade.rallar.director.resign.mockReset();
    facade.rallar.director.status.mockReset();
    facade.rallar.director.createRelay.mockReset();
    facade.rallar.disconnect.mockResolvedValue(undefined);
    facade.rallar.status.mockReturnValue({ connected: true });
    facade.rallar.isConnected.mockReturnValue(true);
    facade.rallar.session.mockReturnValue(facade.session);
}

async function loadRuntime(): Promise<Runtime> {
    vi.resetModules();
    const target: TestWindow = {
        __blackBoxRallarEmit: (event) => {
            events.push(event);
        }
    };
    vi.stubGlobal('window', target);
    await import('../../shared-test/black-box-runner/browser/rallar-browser-runtime.ts');
    const runtime = target.__blackBoxRallar;
    if (!runtime) {
        throw new Error('Browser Rallar runtime did not install.');
    }
    return runtime;
}

function topics(): readonly string[] {
    return events.map((event) => String((event as { topic?: unknown; }).topic ?? ''));
}

function createFakeCrdtDocument(refId: string) {
    let value: unknown = {
        title: 'initial'
    };
    const update = (updateId: string, nextValue: unknown) => {
        value = nextValue;
        return {
            updateId
        };
    };

    return {
        ref: {
            documentId: refId,
            documentType: 'checklist'
        },
        read: vi.fn(() => value),
        subscribe: vi.fn(() => vi.fn()),
        applyLocal: vi.fn(async (batch) =>
            update('update-apply-1', {
                applied: batch
            })
        ),
        sequenceInsert: vi.fn(),
        sequenceMove: vi.fn(),
        sequenceDelete: vi.fn(),
        counterAdd: vi.fn(),
        counterIncrement: vi.fn(),
        counterDecrement: vi.fn(),
        numberMin: vi.fn(),
        numberMax: vi.fn(),
        operationGroupUpdateIds: vi.fn(() => []),
        undoOperationGroup: vi.fn(async (input) =>
            update('update-undo-1', {
                undone: input
            })
        ),
        redoOperationGroup: vi.fn(async (input) =>
            update('update-redo-1', {
                redone: input
            })
        ),
        pendingUpdates: vi.fn(() => []),
        failedPendingUpdates: vi.fn(() => []),
        dependencyBlockedUpdates: vi.fn(() => []),
        snapshot: vi.fn(() => ({ value })),
        flush: vi.fn(async (): Promise<void> => undefined),
        sync: vi.fn(async (options?: RallarCrdtSyncOptions): Promise<RallarCrdtSyncResult> => ({
            status: 'synced',
            transport: options?.transport ?? 'local-only',
            sentUpdateCount: 0,
            receivedUpdateCount: 0,
            pendingUpdateCount: 0,
            dependencyBlockedUpdateCount: 0
        })),
        close: vi.fn(async (): Promise<void> => undefined),
        destroy: vi.fn(async (): Promise<void> => undefined),
        health: vi.fn(() => ({
            status: 'clean',
            pendingUpdateCount: 0,
            failedPendingUpdateCount: 0,
            dependencyBlockedUpdateCount: 0,
            transportStrategy: 'local-only'
        }))
    };
}

describe('browser Rallar black-box runtime', () => {
    beforeEach(() => {
        resetFacade();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('authenticates without initializing realtime middleware or connected runtime state', async () => {
        const runtime = await loadRuntime();

        const diagnostics = await runtime.authenticate({
            connection: 'aliceHttp',
            actor: 'alice',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                register: 'if-needed'
            }
        });

        expect(diagnostics).toEqual({
            status: 'authenticated',
            connection: 'aliceHttp',
            actor: 'alice',
            clientId: 'client-1',
            sessionId: 'session-1',
            username: 'alice'
        });
        expect(JSON.stringify(diagnostics)).not.toContain('access-token-1');
        expect(JSON.stringify(diagnostics)).not.toContain('secret');
        expect(facade.rallar.configure).toHaveBeenCalledWith({
            apiBaseUrl: 'https://api.example.test'
        });
        expect(facade.rallar.auth.registerAndLogin).toHaveBeenCalledTimes(1);
        expect(facade.rallar.setDefaults).not.toHaveBeenCalled();
        expect(facade.rallar.connect).not.toHaveBeenCalled();
        expect(facade.rallar.rooms.join).not.toHaveBeenCalled();
        expect(facade.rallar.realtime.onJson).not.toHaveBeenCalled();
        expect(facade.rallar.messages.rtc.onMessage).not.toHaveBeenCalled();
        await expect(runtime.send({ data: 'not-connected' }))
            .rejects.toThrow('Black-box Rallar runtime is not connected.');
        expect(topics()).toEqual(expect.arrayContaining([
            'rallar.browser.authenticate_started',
            'rallar.browser.auth.register_started',
            'rallar.browser.auth.register_completed',
            'rallar.browser.authenticate_completed'
        ]));
        expect(topics()).not.toContain('rallar.browser.connect_started');
    });

    it('requires connected runtime cleanup before a fresh auth-only login', async () => {
        const runtime = await loadRuntime();
        const rallarConfig = {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret'
        };
        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                ...rallarConfig,
                leaveRoomOnClose: true
            }
        });
        expect(facade.rallar.auth.login).toHaveBeenCalledTimes(1);

        await expect(runtime.authenticate({
            connection: 'aliceHttp',
            actor: 'alice',
            rallar: rallarConfig
        })).rejects.toThrow(
            'Fresh Rallar authentication requires closing the connected black-box runtime first.'
        );

        expect(facade.rallar.auth.login).toHaveBeenCalledTimes(1);
        expect(facade.unsubscribeRealtime).not.toHaveBeenCalled();

        const closeDiagnostics = await runtime.close();
        expect(facade.rallar.rooms.leave).toHaveBeenCalledWith({
            roomId: 'room-1',
            clearCurrent: true,
            timeoutMs: undefined
        });
        expect(closeDiagnostics).toMatchObject({
            status: 'closed',
            connection: 'aliceRtc',
            roomId: 'room-1',
            leftRoom: true
        });
        expect(facade.unsubscribeRealtime).toHaveBeenCalledTimes(1);
    });

    it('point-refreshes the connected room with the caller deadline and signal', async () => {
        const runtime = await loadRuntime();
        const controller = new AbortController();

        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                applicationId: 'app-a',
                workspaceId: 'workspace-a',
                timeoutMs: 1_234
            }
        });

        await runtime.refreshRoom({
            signal: controller.signal,
            timeoutMs: 321
        });

        expect(facade.rallar.rooms.session).toHaveBeenCalledWith({
            applicationId: 'app-a',
            workspaceId: 'workspace-a',
            groupId: 'room-1'
        });
        expect(facade.roomRefresh).toHaveBeenCalledWith({
            signal: controller.signal,
            timeoutMs: 321
        });
        expect(facade.rallar.rooms.refresh).not.toHaveBeenCalled();
    });

    it('rejects room refresh when the connected config has no exact room reference', async () => {
        const runtime = await loadRuntime();

        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret'
            }
        });
        await expect(runtime.refreshRoom({ timeoutMs: 321 })).rejects.toMatchObject({
            name: 'RallarValidationError',
            issues: [
                {
                    path: '$.roomRef',
                    code: 'room-ref-required'
                }
            ]
        });

        expect(facade.rallar.rooms.session).not.toHaveBeenCalled();
        expect(facade.roomRefresh).not.toHaveBeenCalled();
        expect(facade.rallar.rooms.refresh).not.toHaveBeenCalled();
    });

    it('deduplicates auth bootstrap and reuses its restored session for full connect', async () => {
        let resolveRegistration!: (session: typeof facade.session) => void;
        facade.rallar.auth.registerAndLogin.mockImplementation(() =>
            new Promise((resolve) => {
                resolveRegistration = resolve;
            })
        );
        const runtime = await loadRuntime();
        const config = {
            connection: 'aliceHttp',
            actor: 'alice',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                register: 'if-needed' as const
            }
        };

        const firstAuthentication = runtime.authenticate(config);
        const secondAuthentication = runtime.authenticate(config);
        expect(facade.rallar.auth.registerAndLogin).toHaveBeenCalledTimes(1);

        resolveRegistration(facade.session);
        await Promise.all([firstAuthentication, secondAuthentication]);
        facade.rallar.auth.restore.mockReturnValue(facade.session);

        await runtime.connect({
            ...config,
            connection: 'aliceRtc',
            roomId: 'room-1'
        });

        expect(facade.rallar.auth.registerAndLogin).toHaveBeenCalledTimes(1);
        expect(facade.rallar.auth.restore).toHaveBeenCalled();
        expect(facade.rallar.connect).toHaveBeenCalledTimes(1);
        expect(facade.rallar.rooms.join).toHaveBeenCalledTimes(1);
    });

    it('preserves logout cleanup when connect reuses an authenticated session', async () => {
        const runtime = await loadRuntime();
        const authentication = {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret'
        };
        await runtime.authenticate({
            connection: 'aliceHttp',
            actor: 'alice',
            rallar: {
                ...authentication,
                logoutOnClose: true
            }
        });
        facade.rallar.auth.restore.mockReturnValue(facade.session);

        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                ...authentication,
                logoutOnClose: false
            }
        });
        const diagnostics = await runtime.close();

        expect(facade.rallar.auth.logout).toHaveBeenCalledTimes(1);
        expect(facade.rallar.disconnect).not.toHaveBeenCalled();
        expect(diagnostics).toMatchObject({
            status: 'closed',
            connection: 'aliceRtc',
            roomId: 'room-1',
            logout: true,
            disconnected: false
        });
    });

    it('shares an in-flight authentication bootstrap with connect', async () => {
        let resolveRegistration!: (session: typeof facade.session) => void;
        const registration = new Promise<typeof facade.session>((resolve) => {
            resolveRegistration = resolve;
        });
        facade.rallar.auth.registerAndLogin.mockReturnValue(registration);
        const runtime = await loadRuntime();
        const authentication = runtime.authenticate({
            connection: 'aliceHttp',
            actor: 'alice',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                register: 'if-needed'
            }
        });
        const connection = runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                register: 'if-needed'
            }
        });

        expect(facade.rallar.auth.registerAndLogin).toHaveBeenCalledTimes(1);
        resolveRegistration(facade.session);
        await Promise.all([authentication, connection]);

        expect(facade.rallar.auth.registerAndLogin).toHaveBeenCalledTimes(1);
        expect(facade.rallar.connect).toHaveBeenCalledTimes(1);
    });

    it('preserves each caller context while deduplicating same-identity auth bootstrap', async () => {
        let resolveRegistration!: (session: typeof facade.session) => void;
        facade.rallar.auth.registerAndLogin.mockImplementation(() =>
            new Promise((resolve) => {
                resolveRegistration = resolve;
            })
        );
        const runtime = await loadRuntime();

        const firstAuthentication = runtime.authenticate({
            connection: 'firstHttp',
            actor: 'first-actor',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                register: 'if-needed',
                logoutOnClose: false
            }
        });
        const secondAuthentication = runtime.authenticate({
            connection: 'secondHttp',
            actor: 'second-actor',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                register: 'if-needed',
                applicationId: 'app-2',
                workspaceId: 'workspace-2',
                logoutOnClose: true
            }
        });
        expect(facade.rallar.auth.registerAndLogin).toHaveBeenCalledTimes(1);

        resolveRegistration(facade.session);
        await expect(firstAuthentication).resolves.toMatchObject({
            connection: 'firstHttp',
            actor: 'first-actor'
        });
        await expect(secondAuthentication).resolves.toMatchObject({
            connection: 'secondHttp',
            actor: 'second-actor',
            applicationId: 'app-2',
            workspaceId: 'workspace-2'
        });

        const closeDiagnostics = await runtime.close();
        expect(facade.rallar.auth.logout).toHaveBeenCalledTimes(1);
        expect(closeDiagnostics).toMatchObject({
            connection: 'secondHttp',
            actor: 'second-actor',
            logout: true
        });
    });

    it('preserves logout cleanup when a later shared-auth caller disables it', async () => {
        let resolveRegistration!: (session: typeof facade.session) => void;
        facade.rallar.auth.registerAndLogin.mockImplementation(() =>
            new Promise((resolve) => {
                resolveRegistration = resolve;
            })
        );
        const runtime = await loadRuntime();
        const sharedIdentity = {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            register: 'if-needed' as const
        };

        const firstAuthentication = runtime.authenticate({
            connection: 'firstHttp',
            actor: 'first-actor',
            rallar: {
                ...sharedIdentity,
                logoutOnClose: true
            }
        });
        const secondAuthentication = runtime.authenticate({
            connection: 'secondHttp',
            actor: 'second-actor',
            rallar: {
                ...sharedIdentity,
                logoutOnClose: false
            }
        });

        resolveRegistration(facade.session);
        await Promise.all([firstAuthentication, secondAuthentication]);
        const closeDiagnostics = await runtime.close();

        expect(facade.rallar.auth.logout).toHaveBeenCalledTimes(1);
        expect(facade.rallar.disconnect).not.toHaveBeenCalled();
        expect(closeDiagnostics).toMatchObject({
            connection: 'secondHttp',
            actor: 'second-actor',
            logout: true,
            disconnected: false
        });
    });

    it('records provenance before a queued restore-only identity can authenticate', async () => {
        let resolveRegistration!: (session: typeof facade.session) => void;
        facade.rallar.auth.registerAndLogin.mockImplementation(() =>
            new Promise((resolve) => {
                resolveRegistration = resolve;
            })
        );
        const runtime = await loadRuntime();

        const aliceAuthentication = runtime.authenticate({
            connection: 'aliceHttp',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                register: 'if-needed'
            }
        });
        const bobAuthentication = runtime.authenticate({
            connection: 'bobRestore',
            rallar: {
                apiBaseUrl: 'https://other-api.example.test',
                username: 'bob'
            }
        });
        const bobRejection = expect(bobAuthentication).rejects.toThrow(
            'Rallar credentials are required when the authentication identity changes.'
        );
        facade.rallar.auth.restore.mockReturnValue(facade.session);

        resolveRegistration(facade.session);

        await expect(aliceAuthentication).resolves.toMatchObject({
            status: 'authenticated',
            username: 'alice'
        });
        await bobRejection;
        expect(facade.rallar.configure).not.toHaveBeenCalledWith({
            apiBaseUrl: 'https://other-api.example.test'
        });
    });

    it('does not restore stale cleanup state when a queued identity login fails', async () => {
        let resolveRegistration!: (session: typeof facade.session) => void;
        facade.rallar.auth.registerAndLogin.mockImplementation(() =>
            new Promise((resolve) => {
                resolveRegistration = resolve;
            })
        );
        facade.rallar.auth.login.mockRejectedValueOnce(new Error('bad credentials'));
        const runtime = await loadRuntime();

        const aliceAuthentication = runtime.authenticate({
            connection: 'aliceHttp',
            actor: 'alice',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                register: 'if-needed',
                logoutOnClose: true
            }
        });
        const bobAuthentication = runtime.authenticate({
            connection: 'bobHttp',
            actor: 'bob',
            rallar: {
                apiBaseUrl: 'https://other-api.example.test',
                username: 'bob',
                password: 'wrong',
                register: false
            }
        });
        const bobRejection = expect(bobAuthentication).rejects.toThrow(
            'bad credentials'
        );

        resolveRegistration(facade.session);

        await expect(aliceAuthentication).resolves.toMatchObject({
            status: 'authenticated',
            username: 'alice'
        });
        await bobRejection;

        const closeDiagnostics = await runtime.close();
        expect(facade.rallar.auth.logout).not.toHaveBeenCalled();
        expect(facade.rallar.disconnect).toHaveBeenCalledTimes(1);
        expect(closeDiagnostics).toMatchObject({
            connection: undefined,
            logout: false,
            disconnected: true
        });
    });

    it.each([
        {
            mismatch: 'API base URL',
            apiBaseUrl: 'https://other-api.example.test',
            username: 'alice',
            restoredSession: facade.session
        },
        {
            mismatch: 'username',
            apiBaseUrl: 'https://api.example.test',
            username: 'bob',
            restoredSession: facade.session
        },
        {
            mismatch: 'restored session',
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            restoredSession: {
                ...facade.session,
                sessionId: 'session-2'
            }
        }
    ])('does not reuse auth bootstrap after a $mismatch mismatch', async ({
        apiBaseUrl,
        username,
        restoredSession
    }) => {
        const runtime = await loadRuntime();
        await runtime.authenticate({
            connection: 'aliceHttp',
            rallar: {
                apiBaseUrl: 'https://api.example.test/',
                username: 'alice',
                password: 'secret',
                register: 'if-needed'
            }
        });
        facade.rallar.auth.restore.mockReturnValue(restoredSession);

        await runtime.connect({
            connection: 'rtc',
            rallar: {
                apiBaseUrl,
                username,
                password: 'secret',
                register: 'if-needed'
            }
        });

        expect(facade.rallar.auth.registerAndLogin).toHaveBeenCalledTimes(2);
    });

    it.each([
        {
            operation: 'authenticate',
            mismatch: 'API base URL',
            apiBaseUrl: 'https://other-api.example.test',
            username: 'alice'
        },
        {
            operation: 'authenticate',
            mismatch: 'username',
            apiBaseUrl: 'https://api.example.test',
            username: 'bob'
        },
        {
            operation: 'connect',
            mismatch: 'API base URL',
            apiBaseUrl: 'https://other-api.example.test',
            username: 'alice'
        },
        {
            operation: 'connect',
            mismatch: 'username',
            apiBaseUrl: 'https://api.example.test',
            username: 'bob'
        }
    ])('requires fresh credentials for $operation after a bootstrap $mismatch mismatch', async ({
        operation,
        apiBaseUrl,
        username
    }) => {
        const runtime = await loadRuntime();
        await runtime.authenticate({
            connection: 'aliceHttp',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                register: 'if-needed'
            }
        });
        facade.rallar.auth.restore.mockReturnValue(facade.session);

        const config = {
            connection: operation,
            rallar: {
                apiBaseUrl,
                username
            }
        };
        const result = operation === 'authenticate'
            ? runtime.authenticate(config)
            : runtime.connect(config);

        await expect(result).rejects.toThrow(
            'Rallar credentials are required when the authentication identity changes.'
        );
        expect(facade.rallar.auth.registerAndLogin).toHaveBeenCalledTimes(1);
        expect(facade.rallar.auth.login).not.toHaveBeenCalled();
        expect(facade.rallar.connect).not.toHaveBeenCalled();
    });

    it('keeps a known cross-API session rejected after fresh authentication fails', async () => {
        const runtime = await loadRuntime();
        await runtime.authenticate({
            connection: 'aliceHttp',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                register: 'if-needed'
            }
        });
        facade.rallar.auth.restore.mockReturnValue(facade.session);
        facade.rallar.auth.login.mockRejectedValueOnce(new Error('bad credentials'));

        await expect(runtime.authenticate({
            connection: 'bobHttp',
            rallar: {
                apiBaseUrl: 'https://other-api.example.test',
                username: 'bob',
                password: 'wrong'
            }
        })).rejects.toThrow('bad credentials');

        await expect(runtime.authenticate({
            connection: 'bobRestore',
            rallar: {
                apiBaseUrl: 'https://other-api.example.test',
                username: 'bob'
            }
        })).rejects.toThrow(
            'Rallar credentials are required when the authentication identity changes.'
        );
        expect(facade.rallar.auth.login).toHaveBeenCalledTimes(1);
    });

    it('uses the latest authenticated identity for cleanup when full connect fails after a switch', async () => {
        const runtime = await loadRuntime();
        await runtime.authenticate({
            connection: 'aliceHttp',
            actor: 'alice',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                logoutOnClose: true
            }
        });
        const bobSession = {
            ...facade.session,
            clientId: 'client-2',
            sessionId: 'session-2',
            username: 'bob'
        };
        facade.rallar.auth.login.mockResolvedValue(bobSession);
        facade.rallar.connect.mockRejectedValueOnce(new Error('realtime unavailable'));

        await expect(runtime.connect({
            connection: 'bobRtc',
            actor: 'bob',
            rallar: {
                apiBaseUrl: 'https://other-api.example.test',
                username: 'bob',
                password: 'other-secret'
            }
        })).rejects.toThrow('realtime unavailable');
        const diagnostics = await runtime.close();

        expect(facade.rallar.auth.logout).not.toHaveBeenCalled();
        expect(facade.rallar.disconnect).toHaveBeenCalledTimes(1);
        expect(diagnostics).toMatchObject({
            status: 'closed',
            connection: 'bobRtc',
            actor: 'bob',
            logout: false,
            disconnected: true
        });
    });

    it('waits for cancelled authentication and owns its logout cleanup', async () => {
        let resolveLogin!: (session: typeof facade.session) => void;
        facade.rallar.auth.login.mockImplementation(() =>
            new Promise((resolve) => {
                resolveLogin = resolve;
            })
        );
        const runtime = await loadRuntime();
        const authentication = runtime.authenticate({
            connection: 'aliceHttp',
            actor: 'alice',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                logoutOnClose: true
            }
        });
        const rejectedAuthentication = expect(authentication).rejects.toThrow(
            'Authentication was cancelled because the Rallar runtime closed.'
        );
        expect(facade.rallar.auth.login).toHaveBeenCalledTimes(1);
        facade.rallar.auth.restore.mockReturnValue(facade.session);

        const closing = runtime.close();
        await Promise.resolve();
        expect(facade.rallar.auth.logout).not.toHaveBeenCalled();
        expect(facade.rallar.disconnect).not.toHaveBeenCalled();
        resolveLogin(facade.session);
        await rejectedAuthentication;
        const closeDiagnostics = await closing;

        expect(closeDiagnostics).toMatchObject({
            status: 'closed',
            connection: 'aliceHttp',
            actor: 'alice',
            logout: true,
            disconnected: false
        });
        expect(facade.rallar.auth.logout).toHaveBeenCalledTimes(1);
        const secondCloseDiagnostics = await runtime.close();
        expect(secondCloseDiagnostics.connection).toBeUndefined();
        expect(facade.rallar.auth.logout).toHaveBeenCalledTimes(1);
    });

    it('honors every caller cleanup policy when shared authentication completes after close', async () => {
        let resolveRegistration!: (session: typeof facade.session) => void;
        facade.rallar.auth.registerAndLogin.mockImplementation(() =>
            new Promise((resolve) => {
                resolveRegistration = resolve;
            })
        );
        const runtime = await loadRuntime();
        const sharedIdentity = {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            register: 'if-needed' as const
        };
        const firstAuthentication = runtime.authenticate({
            connection: 'firstHttp',
            rallar: {
                ...sharedIdentity,
                logoutOnClose: false
            }
        });
        const secondAuthentication = runtime.authenticate({
            connection: 'secondHttp',
            rallar: {
                ...sharedIdentity,
                logoutOnClose: true
            }
        });
        const firstRejection = expect(firstAuthentication).rejects.toThrow(
            'Authentication was cancelled because the Rallar runtime closed.'
        );
        const secondRejection = expect(secondAuthentication).rejects.toThrow(
            'Authentication was cancelled because the Rallar runtime closed.'
        );
        facade.rallar.auth.restore.mockReturnValue(facade.session);

        const closing = runtime.close();
        resolveRegistration(facade.session);
        await Promise.all([firstRejection, secondRejection]);
        await closing;

        expect(facade.rallar.auth.registerAndLogin).toHaveBeenCalledTimes(1);
        expect(facade.rallar.auth.logout).toHaveBeenCalledTimes(1);
    });

    it('rejects retries until aborted authentication and close settle', async () => {
        let resolveFirstLogin!: (session: typeof facade.session) => void;
        let firstLoginSignal: AbortSignal | undefined;
        facade.rallar.auth.login
            .mockImplementationOnce((_request, options) =>
                new Promise((resolve) => {
                    firstLoginSignal = options?.signal;
                    resolveFirstLogin = resolve;
                })
            )
            .mockResolvedValueOnce(facade.session);
        const runtime = await loadRuntime();
        const config = {
            connection: 'aliceHttp',
            actor: 'alice',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret'
            }
        };
        const cancelledAuthentication = runtime.authenticate(config);
        const cancelledResult = expect(cancelledAuthentication).rejects.toThrow(
            'Authentication was cancelled because the Rallar runtime closed.'
        );
        const closing = runtime.close();
        await Promise.resolve();

        await expect(runtime.authenticate(config)).rejects.toThrow(
            'Authentication was cancelled because the Rallar runtime closed.'
        );
        expect(facade.rallar.auth.login).toHaveBeenCalledTimes(1);

        resolveFirstLogin(facade.session);
        await cancelledResult;
        await closing;

        const retry = runtime.authenticate(config);
        await expect(retry).resolves.toMatchObject({
            status: 'authenticated',
            sessionId: 'session-1'
        });
        expect(firstLoginSignal?.aborted).toBe(true);
        expect(facade.rallar.auth.login).toHaveBeenCalledTimes(2);
    });

    it('honors logout cleanup after auth-only bootstrap', async () => {
        const runtime = await loadRuntime();

        await runtime.authenticate({
            connection: 'aliceHttp',
            actor: 'alice',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                logoutOnClose: true
            }
        });
        const diagnostics = await runtime.close();

        expect(facade.rallar.auth.logout).toHaveBeenCalledWith({ timeoutMs: undefined });
        expect(facade.rallar.disconnect).not.toHaveBeenCalled();
        expect(diagnostics).toMatchObject({
            status: 'closed',
            connection: 'aliceHttp',
            actor: 'alice',
            logout: true,
            disconnected: false
        });
    });

    it('preserves authentication on auth-only close when logout is disabled', async () => {
        const runtime = await loadRuntime();

        await runtime.authenticate({
            connection: 'aliceHttp',
            actor: 'alice',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret'
            }
        });
        const diagnostics = await runtime.close();

        expect(facade.rallar.auth.logout).not.toHaveBeenCalled();
        expect(facade.rallar.disconnect).toHaveBeenCalledTimes(1);
        expect(diagnostics).toMatchObject({
            status: 'closed',
            connection: 'aliceHttp',
            actor: 'alice',
            logout: false,
            disconnected: true
        });
    });

    it('reports invalid auth bootstrap configuration and allows a corrected retry', async () => {
        const runtime = await loadRuntime();

        await expect(runtime.authenticate({
            connection: 'invalidHttp',
            rallar: {
                username: 'alice',
                password: 'secret'
            }
        })).rejects.toThrow('rallar.apiBaseUrl is required.');
        expect(topics()).toContain('rallar.browser.authenticate_failed');

        await expect(runtime.authenticate({
            connection: 'aliceHttp',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret'
            }
        })).resolves.toMatchObject({
            status: 'authenticated',
            sessionId: 'session-1'
        });
        expect(facade.rallar.auth.login).toHaveBeenCalledTimes(1);
    });

    it('clears failed auth bootstrap state before retrying the same identity', async () => {
        facade.rallar.auth.login.mockRejectedValueOnce(new Error('temporary auth failure'));
        const runtime = await loadRuntime();
        const config = {
            connection: 'aliceHttp',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret'
            }
        };

        await expect(runtime.authenticate(config)).rejects.toThrow('temporary auth failure');
        facade.rallar.auth.login.mockResolvedValue(facade.session);
        await expect(runtime.authenticate(config)).resolves.toMatchObject({
            status: 'authenticated',
            sessionId: 'session-1'
        });

        expect(facade.rallar.auth.login).toHaveBeenCalledTimes(2);
        expect(topics()).toContain('rallar.browser.authenticate_failed');
    });

    it('emits auth restore failure diagnostics when no session or credentials exist', async () => {
        const runtime = await loadRuntime();

        await expect(runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test'
            }
        })).rejects.toThrow('Rallar credentials are required');

        expect(topics()).toEqual(expect.arrayContaining([
            'rallar.browser.auth.restore_started',
            'rallar.browser.auth.restore_failed',
            'rallar.browser.connect.phase_failed',
            'rallar.browser.connect_failed'
        ]));
    });

    it('emits login failure diagnostics for bad credentials', async () => {
        facade.rallar.auth.login.mockRejectedValue(new Error('bad credentials'));
        const runtime = await loadRuntime();

        await expect(runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'wrong'
            }
        })).rejects.toThrow('bad credentials');

        expect(topics()).toEqual(expect.arrayContaining([
            'rallar.browser.auth.login_started',
            'rallar.browser.auth.login_failed',
            'rallar.browser.connect.phase_failed'
        ]));
    });

    it('leaves rooms, logs out, and emits cleanup diagnostics on close', async () => {
        const runtime = await loadRuntime();

        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                leaveRoomOnClose: true,
                logoutOnClose: true
            }
        });
        const closeResult = await runtime.close();

        expect(facade.unsubscribeRealtime).toHaveBeenCalledTimes(1);
        expect(facade.rallar.rooms.leave).toHaveBeenCalledWith({
            roomId: 'room-1',
            clearCurrent: true,
            timeoutMs: undefined
        });
        expect(facade.rallar.auth.logout).toHaveBeenCalledWith({ timeoutMs: undefined });
        expect(facade.rallar.disconnect).not.toHaveBeenCalled();
        expect(closeResult).toMatchObject({
            status: 'closed',
            roomId: 'room-1',
            unsubscribed: 1,
            leftRoom: true,
            logout: true,
            disconnected: false,
            cleanupErrors: []
        });
        expect(topics()).toEqual(expect.arrayContaining([
            'rallar.browser.cleanup.started',
            'rallar.browser.cleanup.unsubscribe_completed',
            'rallar.browser.cleanup.room_leave_completed',
            'rallar.browser.cleanup.logout_completed',
            'rallar.browser.closed'
        ]));
    });

    it('applies scoped Rallar defaults and passes room references through sends', async () => {
        const runtime = await loadRuntime();
        const roomRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            groupId: 'room-1'
        };

        const connectResult = await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            roomRef,
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
                roomRef,
                transport: 'messages.rtc',
                typeId: 'chat.message',
                topicId: 'chat'
            }
        });

        expect(facade.rallar.setDefaults).toHaveBeenCalledWith({
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            room: {
                roomId: 'room-1',
                roomRef
            },
            realtime: {
                laneId: 'realtime'
            },
            rtc: {}
        });
        expect(facade.rallar.rooms.join).toHaveBeenCalledWith('room-1', {
            timeoutMs: undefined,
            scope: {
                applicationId: 'app-1',
                workspaceId: 'workspace-a'
            }
        });
        expect(connectResult).toMatchObject({
            scope: {
                applicationId: 'app-1',
                workspaceId: 'workspace-a'
            },
            roomRef
        });

        await runtime.send({
            payload: {
                text: 'hello scoped room'
            },
            minSnapshotVersion: 42
        });

        expect(facade.rallar.messages.rtc.send).toHaveBeenCalledWith(expect.objectContaining({
            roomId: 'room-1',
            roomRef,
            minSnapshotVersion: 42,
            payload: {
                text: 'hello scoped room'
            }
        }));
    });

    it('omits browser RTC diagnostics counters from default health snapshots', async () => {
        const runtime = await loadRuntime();

        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                transport: 'realtime',
                laneId: 'control-lane'
            }
        });

        const health = await runtime.health();

        expect(facade.rallar.rtc.diagnostics).not.toHaveBeenCalled();
        expect(health).not.toHaveProperty('rtcDiagnostics');
        expect(health).not.toHaveProperty('rtcDiagnosticsError');
    });

    it('includes browser RTC diagnostics counters in health snapshots when requested', async () => {
        const runtime = await loadRuntime();

        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                transport: 'realtime',
                laneId: 'control-lane'
            }
        });

        const health = await runtime.health({ includeRtcDiagnostics: true });

        expect(facade.rallar.rtc.diagnostics).toHaveBeenCalledWith({
            laneIds: ['control-lane']
        });
        expect(health).toMatchObject({
            rtcDiagnostics: {
                peerCount: 1,
                peers: [{
                    peerId: 'peer-1',
                    connectionDiagnostics: {
                        connectCallCount: 1,
                        outboundOfferCount: 1,
                        inboundAnswerCount: 1
                    }
                }]
            }
        });
    });

    it('opens and manages CRDT document handles through the browser facade', async () => {
        const runtime = await loadRuntime();
        const firstDocument = createFakeCrdtDocument('doc-1');
        const secondDocument = createFakeCrdtDocument('doc-2');
        facade.rallar.crdt.open
            .mockResolvedValueOnce(firstDocument)
            .mockResolvedValueOnce(secondDocument);

        const open = await runtime.crdt.open({
            handle: 'doc',
            name: 'checklist',
            transport: 'local-only',
            initialValue: {
                title: 'initial'
            }
        });
        const apply = await runtime.crdt.apply({
            handle: 'doc',
            batch: {
                kind: 'batch',
                operations: [
                    {
                        kind: 'register.set',
                        path: ['title'],
                        value: 'changed',
                        policy: 'lww'
                    }
                ]
            }
        });
        const read = await runtime.crdt.read({ handle: 'doc' });
        const sync = await runtime.crdt.sync({
            handle: 'doc',
            transport: 'local-only',
            reason: 'unit-test'
        });
        const health = await runtime.crdt.health({ handle: 'doc' });
        const wait = await runtime.crdt.wait({
            handle: 'doc',
            timeoutMs: 1_000,
            intervalMs: 10,
            stableForMs: 0,
            sync: false,
            conditions: [
                {
                    source: 'value',
                    path: 'applied.operations.0.kind',
                    operator: 'equals',
                    expected: 'register.set'
                },
                {
                    source: 'health',
                    path: 'pendingUpdateCount',
                    operator: 'equals',
                    expected: 0
                }
            ]
        });
        const undo = await runtime.crdt.undo({
            handle: 'doc',
            targetOperationGroupId: 'group-1',
            operations: [
                {
                    kind: 'register.set',
                    path: ['title'],
                    value: 'initial',
                    policy: 'lww'
                }
            ]
        });
        const redo = await runtime.crdt.redo({
            handle: 'doc',
            targetOperationGroupId: 'group-1',
            operations: [
                {
                    kind: 'register.set',
                    path: ['title'],
                    value: 'changed',
                    policy: 'lww'
                }
            ]
        });
        const close = await runtime.crdt.close({ handle: 'doc' });

        await runtime.crdt.open({
            handle: 'destroy-doc',
            name: 'checklist-destroy',
            transport: 'local-only'
        });
        const destroy = await runtime.crdt.destroy({ handle: 'destroy-doc' });
        const runtimeHealth = await runtime.health();

        expect(facade.rallar.crdt.open).toHaveBeenCalledWith(
            'checklist',
            expect.objectContaining({
                transport: 'local-only',
                initialValue: {
                    title: 'initial'
                }
            })
        );
        expect(open).toMatchObject({ status: 'opened', handle: 'doc' });
        expect(apply).toMatchObject({ status: 'applied', updateId: 'update-apply-1' });
        expect(read).toMatchObject({ status: 'read', handle: 'doc' });
        expect(sync).toMatchObject({ status: 'synced', result: { status: 'synced' } });
        expect(health).toMatchObject({ status: 'health', handle: 'doc' });
        expect(wait).toMatchObject({ status: 'wait_matched', handle: 'doc', attempts: 1 });
        expect(undo).toMatchObject({ status: 'undone', updateId: 'update-undo-1' });
        expect(redo).toMatchObject({ status: 'redone', updateId: 'update-redo-1' });
        expect(close).toMatchObject({ status: 'closed', handle: 'doc' });
        expect(destroy).toMatchObject({ status: 'destroyed', handle: 'destroy-doc' });
        expect(firstDocument.close).toHaveBeenCalledTimes(1);
        expect(secondDocument.destroy).toHaveBeenCalledTimes(1);
        expect(runtimeHealth).toMatchObject({
            crdt: {
                handles: []
            }
        });
        expect(topics()).toEqual(expect.arrayContaining([
            'rallar.browser.crdt.opened',
            'rallar.browser.crdt.applied',
            'rallar.browser.crdt.read',
            'rallar.browser.crdt.synced',
            'rallar.browser.crdt.health',
            'rallar.browser.crdt.waiting',
            'rallar.browser.crdt.wait_matched',
            'rallar.browser.crdt.undone',
            'rallar.browser.crdt.redone',
            'rallar.browser.crdt.closed',
            'rallar.browser.crdt.destroyed'
        ]));
    });

    it('appoints a director and manages deterministic director relay handles', async () => {
        const runtime = await loadRuntime();
        const roomRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            groupId: 'room-1'
        };
        const directorStatus = {
            roomRef,
            roomId: 'room-1',
            role: 'director',
            state: 'fresh',
            isDirector: true,
            isFresh: true,
            active: true,
            freshness: 'fresh',
            nowEpochMs: 1_000,
            appointment: {
                version: 1,
                mode: 'appointed-spa',
                sessionId: 'session-1',
                principalId: 'client-1',
                epoch: 1,
                appointedAtEpochMs: 1_000,
                heartbeatTtlMs: 1_200
            }
        };
        let relayConfig: Record<string, any> | undefined;
        const relay = {
            status: vi.fn(() => directorStatus),
            sendIntent: vi.fn(async (intent) => ({
                status: 'sent',
                intent
            })),
            sendOutput: vi.fn(async (output) => ({
                status: 'sent',
                output
            })),
            sendHeartbeat: vi.fn(async () => ({ status: 'sent' })),
            sendSnapshot: vi.fn(async () => ({ status: 'sent' })),
            requestSync: vi.fn(async (payload) => ({
                status: 'sent',
                payload
            })),
            stop: vi.fn()
        };
        facade.rallar.director.appoint.mockResolvedValue(directorStatus);
        facade.rallar.director.resign.mockResolvedValue({
            ...directorStatus,
            role: 'none',
            state: 'none',
            isDirector: false,
            isFresh: false,
            appointment: undefined
        });
        facade.rallar.director.status.mockReturnValue(directorStatus);
        facade.rallar.director.createRelay.mockImplementation((config) => {
            relayConfig = config;
            return relay;
        });

        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            roomRef,
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
                roomRef
            }
        });

        const appoint = await runtime.director.appoint({
            roomId: 'room-1',
            roomRef,
            heartbeatTtlMs: 1_200
        });
        const status = await runtime.director.status({
            roomId: 'room-1',
            roomRef,
            refresh: true
        });
        const start = await runtime.director.relayStart({
            handle: 'relay-1',
            roomId: 'room-1',
            roomRef,
            topicId: 'app.test.director',
            intentTypeId: 'app.test.director.intent',
            outputTypeId: 'app.test.director.output',
            heartbeatIntervalMs: 300,
            snapshotIntervalMs: 500
        });
        expect(relayConfig).toMatchObject({
            roomId: 'room-1',
            roomRef,
            topicId: 'app.test.director',
            intentTypeId: 'app.test.director.intent',
            outputTypeId: 'app.test.director.output',
            heartbeatIntervalMs: 300,
            snapshotIntervalMs: 500
        });

        const output = await relayConfig?.onIntent({
            senderId: 'session-b',
            data: {
                intentId: 'intent-b-1',
                action: 'move'
            },
            envelope: {
                epoch: 1
            },
            receivedAtEpochMs: 1_100
        }, relay);
        await relayConfig?.onOutput({
            senderId: 'session-1',
            data: output,
            envelope: {
                epoch: 1
            },
            receivedAtEpochMs: 1_150
        });
        await relayConfig?.onSnapshot({
            senderId: 'session-1',
            data: relayConfig?.readSnapshot(),
            envelope: {
                epoch: 1
            },
            receivedAtEpochMs: 1_200
        });
        await relayConfig?.onSyncRequest({
            senderId: 'session-b',
            data: {
                reason: 'unit-test'
            },
            envelope: {
                epoch: 1
            },
            receivedAtEpochMs: 1_250
        }, relay);

        const intent = await runtime.director.intent({
            handle: 'relay-1',
            intent: {
                intentId: 'intent-c-1'
            }
        });
        const sync = await runtime.director.syncRequest({
            handle: 'relay-1',
            payload: {
                reason: 'late-join'
            }
        });
        const stop = await runtime.director.relayStop({
            handle: 'relay-1'
        });
        const health = await runtime.health();

        expect(facade.rallar.director.appoint).toHaveBeenCalledWith(
            roomRef,
            expect.objectContaining({
                heartbeatTtlMs: 1_200
            })
        );
        expect(facade.rallar.rooms.refresh).toHaveBeenCalled();
        expect(appoint).toMatchObject({ status: 'appointed', role: 'director' });
        expect(status).toMatchObject({ status: 'status', state: 'fresh' });
        expect(start).toMatchObject({ status: 'relay_started', handle: 'relay-1' });
        expect(output).toMatchObject({
            kind: 'black-box-director-output',
            intentId: 'intent-b-1',
            senderId: 'session-b',
            directorSessionId: 'session-1',
            epoch: 1
        });
        expect(intent).toMatchObject({ status: 'intent_sent', sendResult: { status: 'sent' } });
        expect(sync).toMatchObject({ status: 'sync_requested', sendResult: { status: 'sent' } });
        expect(stop).toMatchObject({
            status: 'relay_stopped',
            acceptedIntentCount: 1,
            outputCount: 2,
            snapshotCount: 1,
            syncRequestCount: 1
        });
        expect(relay.stop).toHaveBeenCalledTimes(1);
        expect(health).toMatchObject({
            director: {
                handles: []
            }
        });
        expect(topics()).toEqual(expect.arrayContaining([
            'rallar.browser.director.appointed',
            'rallar.browser.director.status',
            'rallar.browser.director.relay_started',
            'rallar.browser.director.intent_received',
            'rallar.browser.director.output_received',
            'rallar.browser.director.snapshot_received',
            'rallar.browser.director.sync_request_received',
            'rallar.browser.director.intent_sent',
            'rallar.browser.director.sync_requested',
            'rallar.browser.director.relay_stopped'
        ]));
    });

    it('times out CRDT waits with diagnostics', async () => {
        const runtime = await loadRuntime();
        facade.rallar.crdt.open.mockResolvedValueOnce(createFakeCrdtDocument('wait-timeout'));

        await runtime.crdt.open({
            handle: 'doc',
            name: 'wait-timeout',
            transport: 'local-only'
        });

        await expect(runtime.crdt.wait({
            handle: 'doc',
            timeoutMs: 5,
            intervalMs: 1,
            conditions: [
                {
                    source: 'value',
                    path: 'title',
                    operator: 'equals',
                    expected: 'never'
                }
            ]
        })).rejects.toThrow('Timed out waiting for CRDT conditions');

        expect(topics()).toEqual(expect.arrayContaining([
            'rallar.browser.crdt.waiting',
            'rallar.browser.crdt.wait_failed'
        ]));
    });

    it('subscribes to app WebSocket messages before sending and emits received payloads', async () => {
        const runtime = await loadRuntime();
        const roomRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            groupId: 'bb-group'
        };
        let wsHandler: ((message: Record<string, unknown>) => void) | undefined;
        facade.rallar.messages.ws.onMessage.mockImplementation((
            _selector: unknown,
            handler: (message: Record<string, unknown>) => void
        ) => {
            wsHandler = handler;
            return facade.unsubscribeMessagesWs;
        });
        facade.rallar.messages.ws.send.mockResolvedValue({
            status: 'sent',
            messageId: 'ws-message-1'
        });

        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'bb-group',
            roomRef,
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
                roomRef
            }
        });
        const sendResult = await runtime.sendWs({
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            scope: 'room',
            roomId: 'bb-group',
            groupId: 'bb-group',
            typeId: 'room.manual.message',
            topicId: 'room.manual.message',
            contextId: 'bb-group',
            payload: {
                text: 'hello over ws'
            }
        });

        expect(sendResult).toMatchObject({
            status: 'sent',
            transport: 'ws',
            roomId: 'bb-group',
            scope: 'room',
            typeId: 'room.manual.message',
            topicId: 'room.manual.message',
            contextId: 'bb-group',
            message: {
                text: 'hello over ws'
            }
        });
        expect(facade.rallar.messages.ws.onMessage).toHaveBeenCalledWith({
            typeId: 'room.manual.message',
            topicId: 'room.manual.message'
        }, expect.any(Function));
        expect(facade.rallar.messages.ws.send).toHaveBeenCalledWith(expect.objectContaining({
            roomId: 'bb-group',
            roomRef,
            scope: 'room',
            typeId: 'room.manual.message',
            topicId: 'room.manual.message',
            contextId: 'bb-group',
            payload: {
                text: 'hello over ws'
            }
        }));

        wsHandler?.({
            roomId: 'bb-group',
            senderId: 'bob-session',
            typeId: 'room.manual.message',
            topicId: 'room.manual.message',
            contextId: 'bb-group',
            payload: {
                text: 'received over ws'
            }
        });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'diagnostic',
                topic: 'rallar.browser.ws.subscribed',
                connection: 'aliceRtc',
                roomId: 'bb-group',
                typeId: 'room.manual.message',
                topicId: 'room.manual.message'
            }),
            expect.objectContaining({
                kind: 'message',
                topic: 'rallar.browser.ws.message',
                connection: 'aliceRtc',
                roomId: 'bb-group',
                senderId: 'bob-session',
                typeId: 'room.manual.message',
                topicId: 'room.manual.message',
                contextId: 'bb-group',
                data: {
                    text: 'received over ws'
                }
            })
        ]));

        await runtime.close();
        expect(facade.unsubscribeMessagesWs).toHaveBeenCalledTimes(1);
    });

    it('bridges relevant browser console warnings into structured diagnostics', async () => {
        const runtime = await loadRuntime();
        const originalWarn = console.warn;
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret'
            }
        });

        console.warn('Unhandled WS message: room.unknown');
        console.warn('Received data channel for different data channel name: rtc-data-channel vs rtc-realtime');

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'diagnostic',
                topic: 'rallar.browser.ws.unhandled_message',
                transport: 'ws',
                severity: 'warning',
                data: expect.objectContaining({
                    message: 'Unhandled WS message: room.unknown'
                })
            }),
            expect.objectContaining({
                kind: 'diagnostic',
                topic: 'rallar.browser.rtc.data_channel_warning',
                transport: 'realtime',
                severity: 'warning',
                data: expect.objectContaining({
                    message: 'Received data channel for different data channel name: rtc-data-channel vs rtc-realtime'
                })
            })
        ]));

        await runtime.close();
        warnSpy.mockRestore();
        expect(console.warn).toBe(originalWarn);
    });

    it('emits room join failure diagnostics for permission-style failures', async () => {
        facade.rallar.rooms.join.mockRejectedValue(new Error('forbidden room'));
        const runtime = await loadRuntime();

        await expect(runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'forbidden-room',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret'
            }
        })).rejects.toThrow('forbidden room');

        expect(topics()).toEqual(expect.arrayContaining([
            'rallar.browser.connect.phase_started',
            'rallar.browser.connect.phase_failed',
            'rallar.browser.connect_failed'
        ]));
    });

    it('emits send failure diagnostics for forbidden targets', async () => {
        facade.rallar.realtime.sendJson.mockRejectedValue(new Error('forbidden target'));
        const runtime = await loadRuntime();

        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret'
            }
        });
        await expect(runtime.send({
            roomId: 'room-1',
            peerIds: ['forbidden-session'],
            data: {
                text: 'hello'
            }
        })).rejects.toThrow('forbidden target');

        expect(topics()).toContain('rallar.browser.realtime.send_failed');
    });

    it('emits expected-session and duplicate-session diagnostics', async () => {
        const runtime = await loadRuntime();

        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                expectedSessionId: 'expected-session'
            }
        });
        await runtime.connect({
            connection: 'aliceRtc2',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                expectedSessionId: 'session-1'
            }
        });

        expect(topics()).toEqual(expect.arrayContaining([
            'rallar.browser.session.expected_mismatch',
            'rallar.browser.session.duplicate_detected',
            'rallar.browser.cleanup.unsubscribe_completed'
        ]));
    });

    it('creates an isolated facade for the installed black-box runtime', async () => {
        const rallarModule = await import('@shared-web/browser/rallar.ts');

        await loadRuntime();

        expect(rallarModule.createRallarFacade).toHaveBeenCalledTimes(1);
    });

    it('creates an injectable runtime without installing a browser global', async () => {
        vi.resetModules();
        const runtimeModule = await import(
            '../../shared-test/black-box-runner/browser/rallar-browser-runtime/runtime.ts'
        );
        const factoryEvents: Array<{ atEpochMs?: number; }> = [];
        const targetWindow = {
            __blackBoxRallarEmit: (event: { atEpochMs?: number; }) => {
                factoryEvents.push(event);
            }
        } as unknown as Window;
        const runtime = runtimeModule.createBlackBoxRallarRuntime({
            facade: facade.rallar as never,
            targetWindow,
            clock: {
                now: () => 12_345
            },
            delay: vi.fn(async () => undefined)
        });
        if (runtime.authenticate === undefined) {
            throw new Error('The injectable runtime did not expose authenticate.');
        }

        await runtime.authenticate({
            connection: 'factoryAuth',
            actor: 'alice',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret'
            }
        });

        expect(targetWindow.__blackBoxRallar).toBeUndefined();
        expect(factoryEvents.length).toBeGreaterThan(0);
        expect(factoryEvents.every((event) => event.atEpochMs === 12_345)).toBe(true);
    });

    it('rejects a connected identity change before mutating facade configuration', async () => {
        const runtime = await loadRuntime();
        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret'
            }
        });

        await expect(runtime.authenticate({
            connection: 'bobHttp',
            actor: 'bob',
            rallar: {
                apiBaseUrl: 'https://other-api.example.test',
                username: 'bob',
                password: 'secret'
            }
        })).rejects.toThrow(
            'Fresh Rallar authentication requires closing the connected black-box runtime first.'
        );

        expect(facade.rallar.configure).not.toHaveBeenCalledWith({
            apiBaseUrl: 'https://other-api.example.test'
        });
    });

    it('does not allow an in-flight connect to commit after close starts', async () => {
        let resolveConnect!: () => void;
        facade.rallar.connect.mockImplementationOnce(() =>
            new Promise<void>((resolve) => {
                resolveConnect = resolve;
            })
        );
        const runtime = await loadRuntime();
        const connecting = runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret'
            }
        });
        await vi.waitFor(() => {
            expect(facade.rallar.connect).toHaveBeenCalledTimes(1);
        });

        const closing = runtime.close();
        await Promise.resolve();
        expect(facade.rallar.disconnect).not.toHaveBeenCalled();

        resolveConnect();
        await expect(connecting).rejects.toThrow(
            'Connection was cancelled because the Rallar runtime closed.'
        );
        await closing;
        await expect(runtime.send({ data: 'after-close' })).rejects.toThrow(
            'Black-box Rallar runtime is not connected.'
        );
        expect(topics().lastIndexOf('rallar.browser.connect_completed')).toBeLessThan(0);
    });

    it('revalidates a queued connection target before mutating the facade', async () => {
        let resolveFirstConnect!: () => void;
        facade.rallar.connect.mockImplementationOnce(() =>
            new Promise<void>((resolve) => {
                resolveFirstConnect = resolve;
            })
        );
        const runtime = await loadRuntime();
        const first = runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret'
            }
        });
        await vi.waitFor(() => {
            expect(facade.rallar.connect).toHaveBeenCalledTimes(1);
        });

        const second = runtime.connect({
            connection: 'bobRtc',
            actor: 'bob',
            roomId: 'room-2',
            rallar: {
                apiBaseUrl: 'https://other-api.example.test',
                username: 'bob',
                password: 'other-secret'
            }
        });
        const secondResult = expect(second).rejects.toThrow(
            'Connected Rallar identity, scope, or room changes require close first.'
        );
        expect(facade.rallar.configure).not.toHaveBeenCalledWith({
            apiBaseUrl: 'https://other-api.example.test'
        });

        resolveFirstConnect();
        await first;
        await secondResult;
        expect(facade.rallar.configure).not.toHaveBeenCalledWith({
            apiBaseUrl: 'https://other-api.example.test'
        });
        expect(facade.rallar.connect).toHaveBeenCalledTimes(1);
    });

    it('serializes concurrent connects that share a target but use different transports', async () => {
        let resolveFirstConnect!: () => void;
        facade.rallar.connect.mockImplementationOnce(() =>
            new Promise<void>((resolve) => {
                resolveFirstConnect = resolve;
            })
        );
        const runtime = await loadRuntime();
        const baseConfig = {
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                typeId: 'chat.message',
                topicId: 'chat'
            }
        };

        const realtimeConnect = runtime.connect({
            ...baseConfig,
            rallar: {
                ...baseConfig.rallar,
                transport: 'realtime'
            }
        });
        await vi.waitFor(() => {
            expect(facade.rallar.connect).toHaveBeenCalledTimes(1);
        });
        const messagesConnect = runtime.connect({
            ...baseConfig,
            rallar: {
                ...baseConfig.rallar,
                transport: 'messages.rtc'
            }
        });
        expect(facade.rallar.connect).toHaveBeenCalledTimes(1);

        resolveFirstConnect();
        await expect(realtimeConnect).resolves.toMatchObject({
            transport: 'realtime'
        });
        await expect(messagesConnect).resolves.toMatchObject({
            transport: 'messages.rtc'
        });

        expect(facade.rallar.connect).toHaveBeenCalledTimes(2);
        expect(facade.rallar.realtime.onJson).toHaveBeenCalledTimes(1);
        expect(facade.rallar.messages.rtc.onMessage).toHaveBeenCalledTimes(1);
        expect(facade.unsubscribeRealtime).toHaveBeenCalledTimes(1);
    });

    it('serializes fresh authentication behind an in-flight connection', async () => {
        let resolveFirstConnect!: () => void;
        facade.rallar.connect.mockImplementationOnce(() =>
            new Promise<void>((resolve) => {
                resolveFirstConnect = resolve;
            })
        );
        const runtime = await loadRuntime();
        const connecting = runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret'
            }
        });
        await vi.waitFor(() => {
            expect(facade.rallar.connect).toHaveBeenCalledTimes(1);
        });

        const authenticating = runtime.authenticate({
            connection: 'bobHttp',
            actor: 'bob',
            rallar: {
                apiBaseUrl: 'https://other-api.example.test',
                username: 'bob',
                password: 'other-secret'
            }
        });
        expect(facade.rallar.configure.mock.calls.some(
            ([input]) => input.apiBaseUrl === 'https://other-api.example.test'
        )).toBe(false);

        resolveFirstConnect();
        await connecting;
        await expect(authenticating).rejects.toThrow(
            'Fresh Rallar authentication requires closing the connected black-box runtime first.'
        );
        expect(facade.rallar.configure.mock.calls.some(
            ([input]) => input.apiBaseUrl === 'https://other-api.example.test'
        )).toBe(false);
    });

    it('revalidates queued live CRDT bootstrap before mutating the facade', async () => {
        let resolveFirstConnect!: () => void;
        facade.rallar.connect.mockImplementationOnce(() =>
            new Promise<void>((resolve) => {
                resolveFirstConnect = resolve;
            })
        );
        facade.rallar.crdt.open.mockResolvedValueOnce(
            createFakeCrdtDocument('queued-live-doc')
        );
        const runtime = await loadRuntime();
        const connecting = runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret'
            }
        });
        await vi.waitFor(() => {
            expect(facade.rallar.connect).toHaveBeenCalledTimes(1);
        });

        const opening = runtime.crdt.open({
            handle: 'queued-live-doc',
            name: 'queued-live-doc',
            transport: 'ws',
            apiBaseUrl: 'https://other-api.example.test',
            roomId: 'room-2',
            username: 'bob',
            password: 'other-secret'
        });
        const openingResult = expect(opening).rejects.toThrow(
            'Connected Rallar identity, scope, or room changes require close first.'
        );

        resolveFirstConnect();
        await connecting;
        await openingResult;
        expect(facade.rallar.configure).not.toHaveBeenCalledWith({
            apiBaseUrl: 'https://other-api.example.test'
        });
        expect(facade.rallar.crdt.open).not.toHaveBeenCalled();
    });

    it('deduplicates concurrent close cleanup', async () => {
        const runtime = await loadRuntime();
        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                leaveRoomOnClose: true
            }
        });

        const [first, second] = await Promise.all([
            runtime.close(),
            runtime.close()
        ]);

        expect(first).toEqual(second);
        expect(facade.rallar.rooms.leave).toHaveBeenCalledTimes(1);
        expect(facade.rallar.disconnect).toHaveBeenCalledTimes(1);
        expect(facade.unsubscribeRealtime).toHaveBeenCalledTimes(1);
    });

    it('reserves CRDT handles before awaiting document creation', async () => {
        let resolveOpen!: (document: ReturnType<typeof createFakeCrdtDocument>) => void;
        facade.rallar.crdt.open.mockImplementationOnce(() =>
            new Promise((resolve) => {
                resolveOpen = resolve;
            })
        );
        const runtime = await loadRuntime();
        const opening = runtime.crdt.open({
            handle: 'shared-doc',
            name: 'checklist',
            transport: 'local-only'
        });
        await vi.waitFor(() => {
            expect(facade.rallar.crdt.open).toHaveBeenCalledTimes(1);
        });

        await expect(runtime.crdt.open({
            handle: 'shared-doc',
            name: 'checklist',
            transport: 'local-only'
        })).rejects.toThrow('CRDT document handle is already open: shared-doc');
        expect(facade.rallar.crdt.open).toHaveBeenCalledTimes(1);

        resolveOpen(createFakeCrdtDocument('doc-shared'));
        await opening;
    });

    it('waits for a late CRDT open and disposes the document during close', async () => {
        let resolveOpen!: (document: ReturnType<typeof createFakeCrdtDocument>) => void;
        facade.rallar.crdt.open.mockImplementationOnce(() =>
            new Promise((resolve) => {
                resolveOpen = resolve;
            })
        );
        const runtime = await loadRuntime();
        const document = createFakeCrdtDocument('doc-late');
        const opening = runtime.crdt.open({
            handle: 'late-doc',
            name: 'checklist',
            transport: 'local-only'
        });
        const openingResult = expect(opening).rejects.toThrow(
            'CRDT document open was cancelled because the Rallar runtime closed.'
        );
        await vi.waitFor(() => {
            expect(facade.rallar.crdt.open).toHaveBeenCalledTimes(1);
        });

        const closing = runtime.close();
        await Promise.resolve();
        expect(facade.rallar.disconnect).not.toHaveBeenCalled();
        resolveOpen(document);

        await openingResult;
        await closing;
        expect(document.close).toHaveBeenCalledTimes(1);
        await expect(runtime.crdt.read({ handle: 'late-doc' })).rejects.toThrow(
            'CRDT document handle is not open: late-doc'
        );
    });

    it('cancels a sleeping CRDT wait before close cleanup', async () => {
        vi.useFakeTimers();
        try {
            const document = createFakeCrdtDocument('wait-during-close');
            facade.rallar.crdt.open.mockResolvedValueOnce(document);
            const runtime = await loadRuntime();
            await runtime.crdt.open({
                handle: 'wait-during-close',
                name: 'wait-during-close',
                transport: 'local-only'
            });
            const waiting = runtime.crdt.wait({
                handle: 'wait-during-close',
                timeoutMs: 60_000,
                intervalMs: 60_000,
                conditions: [{
                    source: 'value',
                    path: 'title',
                    operator: 'equals',
                    expected: 'never'
                }]
            });
            const waitOutcome = waiting.then(
                () => undefined,
                (error) => error
            );
            await vi.advanceTimersByTimeAsync(0);
            expect(topics()).toContain('rallar.browser.crdt.waiting');

            const closing = runtime.close();
            const closeOutcome = closing.then(
                () => undefined,
                (error) => error
            );
            await vi.advanceTimersByTimeAsync(0);
            const disconnectCallsBeforeIntervalElapsed = facade.rallar.disconnect.mock.calls.length;

            await vi.advanceTimersByTimeAsync(60_000);
            const waitError = await waitOutcome;
            const closeError = await closeOutcome;

            expect(disconnectCallsBeforeIntervalElapsed).toBe(1);
            expect(waitError).toBeInstanceOf(Error);
            expect((waitError as Error).message).toBe(
                'CRDT operation completed after the runtime closed.'
            );
            expect(closeError).toBeUndefined();
            expect(document.close).toHaveBeenCalledTimes(1);
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('rejects a queued CRDT wait before it starts polling after close', async () => {
        vi.useFakeTimers();
        try {
            const document = createFakeCrdtDocument('queued-wait-during-close');
            let resolveApply!: (result: { updateId: string; }) => void;
            document.applyLocal.mockImplementationOnce(() =>
                new Promise((resolve) => {
                    resolveApply = resolve;
                })
            );
            facade.rallar.crdt.open.mockResolvedValueOnce(document);
            const runtime = await loadRuntime();
            await runtime.crdt.open({
                handle: 'queued-wait-during-close',
                name: 'queued-wait-during-close',
                transport: 'local-only'
            });
            const applying = runtime.crdt.apply({
                handle: 'queued-wait-during-close',
                batch: {
                    kind: 'batch',
                    operations: [{
                        kind: 'register.set',
                        path: ['title'],
                        value: 'changed',
                        policy: 'lww'
                    }]
                }
            });
            const applyOutcome = applying.then(
                () => undefined,
                (error) => error
            );
            await vi.advanceTimersByTimeAsync(0);
            expect(document.applyLocal).toHaveBeenCalledTimes(1);

            const waiting = runtime.crdt.wait({
                handle: 'queued-wait-during-close',
                timeoutMs: 60_000,
                intervalMs: 60_000,
                conditions: [{
                    source: 'value',
                    path: 'title',
                    operator: 'equals',
                    expected: 'never'
                }]
            });
            const waitOutcome = waiting.then(
                () => undefined,
                (error) => error
            );
            const closing = runtime.close();
            const closeOutcome = closing.then(
                () => undefined,
                (error) => error
            );

            resolveApply({ updateId: 'late-apply' });
            await vi.advanceTimersByTimeAsync(0);
            const disconnectCallsBeforeIntervalElapsed = facade.rallar.disconnect.mock.calls.length;

            await vi.advanceTimersByTimeAsync(60_000);
            const applyError = await applyOutcome;
            const waitError = await waitOutcome;
            const closeError = await closeOutcome;

            expect(disconnectCallsBeforeIntervalElapsed).toBe(1);
            expect(applyError).toBeInstanceOf(Error);
            expect(waitError).toBeInstanceOf(Error);
            expect((waitError as Error).message).toBe(
                'CRDT operation completed after the runtime closed.'
            );
            expect(closeError).toBeUndefined();
            expect(document.close).toHaveBeenCalledTimes(1);
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('rejects a CRDT wait promptly while close drains its in-flight sync', async () => {
        const document = createFakeCrdtDocument('sync-wait-during-close');
        let resolveSync!: (result: RallarCrdtSyncResult) => void;
        document.sync.mockImplementationOnce(() =>
            new Promise((resolve) => {
                resolveSync = resolve;
            })
        );
        facade.rallar.crdt.open.mockResolvedValueOnce(document);
        const runtime = await loadRuntime();
        await runtime.crdt.open({
            handle: 'sync-wait-during-close',
            name: 'sync-wait-during-close',
            transport: 'local-only'
        });
        let waitSettled = false;
        const waiting = runtime.crdt.wait({
            handle: 'sync-wait-during-close',
            timeoutMs: 60_000,
            intervalMs: 60_000,
            sync: { reason: 'wait-close-test' },
            conditions: [{
                source: 'value',
                path: 'title',
                operator: 'equals',
                expected: 'never'
            }]
        });
        const waitOutcome = waiting.then(
            () => undefined,
            (error) => {
                waitSettled = true;
                return error;
            }
        );
        await vi.waitFor(() => {
            expect(document.sync).toHaveBeenCalledTimes(1);
        });

        const closing = runtime.close();
        await vi.waitFor(() => {
            expect(waitSettled).toBe(true);
        });
        const waitSettledBeforeSync = waitSettled;
        const documentCloseCallsBeforeSync = document.close.mock.calls.length;

        resolveSync({
            status: 'synced',
            transport: 'local-only',
            sentUpdateCount: 0,
            receivedUpdateCount: 0,
            pendingUpdateCount: 0,
            dependencyBlockedUpdateCount: 0
        });
        const waitError = await waitOutcome;
        await closing;

        expect(waitSettledBeforeSync).toBe(true);
        expect(documentCloseCallsBeforeSync).toBe(0);
        expect(waitError).toBeInstanceOf(Error);
        expect((waitError as Error).message).toBe(
            'CRDT operation completed after the runtime closed.'
        );
        expect(document.close).toHaveBeenCalledTimes(1);
        expect(facade.rallar.disconnect).toHaveBeenCalledTimes(1);
    });

    it('does not close a CRDT document twice when explicit close races runtime close', async () => {
        let resolveDocumentClose!: () => void;
        const document = createFakeCrdtDocument('doc-closing');
        document.close.mockImplementationOnce(() =>
            new Promise<void>((resolve) => {
                resolveDocumentClose = resolve;
            })
        );
        facade.rallar.crdt.open.mockResolvedValueOnce(document);
        const runtime = await loadRuntime();
        await runtime.crdt.open({
            handle: 'closing-doc',
            name: 'checklist',
            transport: 'local-only'
        });

        const closingDocument = runtime.crdt.close({ handle: 'closing-doc' });
        await vi.waitFor(() => {
            expect(document.close).toHaveBeenCalledTimes(1);
        });
        const closingRuntime = runtime.close();
        resolveDocumentClose();

        await expect(closingDocument).rejects.toThrow(
            'CRDT operation completed after the runtime closed.'
        );
        await closingRuntime;
        expect(document.close).toHaveBeenCalledTimes(1);
    });

    it('does not close a destroyed CRDT document when destroy races runtime close', async () => {
        let resolveDocumentDestroy!: () => void;
        const document = createFakeCrdtDocument('doc-destroying');
        document.destroy.mockImplementationOnce(() =>
            new Promise<void>((resolve) => {
                resolveDocumentDestroy = resolve;
            })
        );
        facade.rallar.crdt.open.mockResolvedValueOnce(document);
        const runtime = await loadRuntime();
        await runtime.crdt.open({
            handle: 'destroying-doc',
            name: 'checklist',
            transport: 'local-only'
        });

        const destroyingDocument = runtime.crdt.destroy({ handle: 'destroying-doc' });
        await vi.waitFor(() => {
            expect(document.destroy).toHaveBeenCalledTimes(1);
        });
        const closingRuntime = runtime.close();
        resolveDocumentDestroy();

        await expect(destroyingDocument).rejects.toThrow(
            'CRDT operation completed after the runtime closed.'
        );
        await closingRuntime;
        expect(document.destroy).toHaveBeenCalledTimes(1);
        expect(document.close).not.toHaveBeenCalled();
    });

    it('rejects a live CRDT target change before reconfiguring the connected facade', async () => {
        const runtime = await loadRuntime();
        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                username: 'alice',
                password: 'secret'
            }
        });

        await expect(runtime.crdt.open({
            handle: 'other-live-doc',
            name: 'checklist',
            transport: 'ws',
            apiBaseUrl: 'https://other-api.example.test',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            roomId: 'room-1',
            username: 'alice',
            password: 'secret'
        })).rejects.toThrow(
            'Connected Rallar identity, scope, or room changes require close first.'
        );
        expect(facade.rallar.configure).not.toHaveBeenCalledWith({
            apiBaseUrl: 'https://other-api.example.test'
        });
        expect(facade.rallar.crdt.open).not.toHaveBeenCalled();
    });

    it('fences send completion after runtime close without serializing sends', async () => {
        let resolveSend!: (results: readonly unknown[]) => void;
        facade.rallar.realtime.sendJson.mockImplementationOnce(() =>
            new Promise((resolve) => {
                resolveSend = resolve;
            })
        );
        const runtime = await loadRuntime();
        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret'
            }
        });
        const sending = runtime.send({ data: 'late-message' });
        const sendResult = expect(sending).rejects.toThrow(
            'Rallar send completed after the runtime closed.'
        );
        await vi.waitFor(() => {
            expect(facade.rallar.realtime.sendJson).toHaveBeenCalledTimes(1);
        });

        await runtime.close();
        resolveSend([]);
        await sendResult;

        expect(topics()).not.toContain('rallar.browser.realtime.send_completed');
        expect(topics()).toContain('rallar.browser.realtime.send_failed');
    });

    it('rejects new resource effects while runtime close is in progress', async () => {
        let resolveDisconnect!: () => void;
        facade.rallar.disconnect.mockImplementationOnce(() =>
            new Promise<void>((resolve) => {
                resolveDisconnect = resolve;
            })
        );
        facade.rallar.crdt.open.mockResolvedValueOnce(
            createFakeCrdtDocument('doc-during-close')
        );
        const runtime = await loadRuntime();
        await runtime.connect({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret'
            }
        });
        facade.rallar.realtime.sendJson.mockClear();
        facade.rallar.crdt.open.mockClear();
        facade.rallar.director.appoint.mockClear();

        const closing = runtime.close();
        await vi.waitFor(() => {
            expect(facade.rallar.disconnect).toHaveBeenCalledTimes(1);
        });

        await expect(runtime.send({ data: 'during-close' })).rejects.toThrow(
            'Rallar send completed after the runtime closed.'
        );
        await expect(runtime.crdt.open({
            handle: 'during-close',
            name: 'during-close',
            transport: 'local-only'
        })).rejects.toThrow(
            'CRDT document open was cancelled because the Rallar runtime closed.'
        );
        await expect(runtime.director.appoint({
            roomId: 'room-1'
        })).rejects.toThrow(
            'Director operation completed after the runtime closed.'
        );

        expect(facade.rallar.realtime.sendJson).not.toHaveBeenCalled();
        expect(facade.rallar.crdt.open).not.toHaveBeenCalled();
        expect(facade.rallar.director.appoint).not.toHaveBeenCalled();

        resolveDisconnect();
        await closing;
    });
});
