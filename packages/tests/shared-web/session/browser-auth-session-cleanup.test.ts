import type { RallarBrowserMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarWsLifecycleEvent } from '@shared-web/browser/rallar-realtime-facade.ts';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { createAuthSessionApiHttpError } from '../auth-session-contract-fixtures.ts';
import type * as ContractModules from '../auth-session-contract-modules.ts';
import { createDeferred } from '../browser-lifecycle-fixtures.ts';
import { readAuthSessionContractMocks, resetAuthSessionContractMocks } from './browser-auth-session-contract-fixture.ts';

const mocks = readAuthSessionContractMocks();

describe('Rallar auth logout and transport cleanup contract', () => {
    beforeEach(resetAuthSessionContractMocks);

    it('revokes the backend session when logging out', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const signal = new AbortController().signal;
        let storedSession: typeof mocks.ctx.session | undefined = mocks.ctx.session;
        let logoutOptions: Parameters<ContractModules.AuthApi['logoutFromApi']>[0] | undefined;
        mocks.readSession.mockImplementation(() => storedSession);
        mocks.clearSession.mockImplementation(() => {
            storedSession = undefined;
        });
        mocks.logoutFromApi.mockImplementationOnce(async (options) => {
            logoutOptions = options;
            return { loggedOut: true };
        });

        await createRallarFacade().auth.logout({ signal, timeoutMs: 123 });

        expect(logoutOptions?.signal).toBeInstanceOf(AbortSignal);
        expect(storedSession).toBeUndefined();
    });

    it('reuses one request ID when logout retries after a lost response', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const requestIds: Array<string | undefined> = [];
        mocks.logoutFromApi.mockImplementation(async (options) => {
            requestIds.push(options?.requestId);
            if (requestIds.length === 1) {
                throw createAuthSessionApiHttpError(503, 'response lost');
            }
            return { loggedOut: true };
        });

        await createRallarFacade().auth.logout({ maxAttempts: 2 });

        expect(requestIds).toHaveLength(2);
        expect(requestIds[0]).toBeTruthy();
        expect(new Set(requestIds).size).toBe(1);
    });

    it('clears local auth before revoking manual logout and uses the captured session', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        let storedSession: typeof mocks.ctx.session | undefined = mocks.ctx.session;
        let sessionWasClearedBeforeRevoke = false;
        let logoutOptions: Parameters<ContractModules.AuthApi['logoutFromApi']>[0] | undefined;
        mocks.readSession.mockImplementation(() => storedSession);
        mocks.clearSession.mockImplementation(() => {
            storedSession = undefined;
        });
        mocks.logoutFromApi.mockImplementationOnce(async (options) => {
            sessionWasClearedBeforeRevoke = storedSession === undefined;
            logoutOptions = options;
            return { loggedOut: true };
        });

        await createRallarFacade().auth.logout();

        expect(sessionWasClearedBeforeRevoke).toBe(true);
        expect(logoutOptions).toMatchObject({
            authSession: mocks.ctx.session
        });
    });

    it('deletes captured session browser AL runtime rows even when revoke fails', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const deletedSessionIds: string[] = [];
        mocks.logoutFromApi.mockRejectedValueOnce(new Error('revoke failed'));
        mocks.deleteBrowserALRuntimeEntriesForSession.mockImplementation(
            async (sessionId) => {
                deletedSessionIds.push(sessionId);
                return {
                    dbName: 'rallar-browser-al-runtime',
                    storeName: 'entries',
                    keyPrefixes: [],
                    scanned: 0,
                    deleted: 0
                };
            }
        );

        await expect(createRallarFacade().auth.logout()).rejects.toThrow(
            'revoke failed'
        );

        expect(deletedSessionIds).toEqual(['session-1']);
        expect(mocks.deleteBrowserQueueBoxDatabasesForSession).toHaveBeenCalledWith('session-1');
    });

    it('does not reconnect with a stale session while manual logout is in progress', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        let storedSession: typeof mocks.ctx.session | undefined = mocks.ctx.session;
        const logoutStarted = createDeferred<void>();
        const logoutResult = createDeferred<{ loggedOut: boolean; }>();
        const initializedSessionIds: string[] = [];
        mocks.readSession.mockImplementation(() => storedSession);
        mocks.clearSession.mockImplementation(() => {
            storedSession = undefined;
        });
        mocks.logoutFromApi.mockImplementation(() => {
            logoutStarted.resolve();
            return logoutResult.promise;
        });
        mocks.initialiseMiddleware.mockImplementation(async (session) => {
            initializedSessionIds.push(session.sessionId);
            return mocks.ctx.middleware;
        });
        const facade = createRallarFacade();

        await facade.connect();
        const logoutPromise = facade.auth.logout();
        await logoutStarted.promise;

        const startPromise = facade.start();
        await Promise.resolve();
        logoutResult.resolve({ loggedOut: true });
        const startResult = await startPromise;
        await logoutPromise;

        expect(initializedSessionIds).toEqual(['session-1']);
        expect(startResult).toEqual({
            session: undefined,
            connected: false
        });
    });

    it('shuts down middleware that resolves after logout during connect', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const deferred = createDeferred<RallarBrowserMiddleware>();
        const cleanupState = {
            heartbeatStopped: false,
            rtcReceiverDisposed: false,
            knownPeersRead: false,
            queueStopped: false
        };
        let webSocketClose: { readonly code: number; readonly reason: string; } | undefined;
        mocks.heartbeat.stop.mockImplementation(() => {
            cleanupState.heartbeatStopped = true;
        });
        mocks.rtcRxStreamer.dispose.mockImplementation(() => {
            cleanupState.rtcReceiverDisposed = true;
        });
        mocks.webRtcConnectionService.knownPeerIds.mockImplementation(() => {
            cleanupState.knownPeersRead = true;
            return [];
        });
        mocks.qboxEngine.stop.mockImplementation(() => {
            cleanupState.queueStopped = true;
        });
        mocks.webSocketQueueBox.close.mockImplementation((code, reason) => {
            if (code === undefined || reason === undefined) {
                throw new Error('Auth cleanup must close WebSocket with code and reason');
            }
            webSocketClose = { code, reason };
            mocks.webSocket.close(code, reason);
        });
        mocks.initialiseMiddleware.mockReturnValueOnce(deferred.promise);
        const facade = createRallarFacade();

        const connectPromise = facade.connect();
        await Promise.resolve();

        await facade.auth.logout();
        const expectation = expect(connectPromise).rejects.toThrow(
            'Rallar connection was cancelled because auth ended.'
        );

        deferred.resolve(mocks.ctx.middleware);
        await expectation;

        expect(facade.status()).toBe('idle');
        expect(facade.isConnected()).toBe(false);
        expect({ ...cleanupState, webSocketClose }).toEqual({
            heartbeatStopped: true,
            rtcReceiverDisposed: true,
            knownPeersRead: true,
            queueStopped: true,
            webSocketClose: { code: 1000, reason: 'rallar-disconnect' }
        });
    });

    it('cancels a pending connection before replacing credentials and reconnects with the replacement', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const pendingMiddleware = createDeferred<RallarBrowserMiddleware>();
        const replacementSession = {
            ...mocks.ctx.session,
            sessionId: 'session-2',
            accessToken: 'token-2'
        };
        const firstInitializationStarted = createDeferred<void>();
        const initializedSessionIds: string[] = [];
        let currentSession = mocks.ctx.session;
        mocks.readSession.mockImplementation(() => currentSession);
        mocks.writeSession.mockImplementation((session) => {
            currentSession = session;
        });
        mocks.initialiseMiddleware
            .mockImplementationOnce((session) => {
                initializedSessionIds.push(session.sessionId);
                firstInitializationStarted.resolve();
                return pendingMiddleware.promise;
            })
            .mockImplementationOnce(async (session) => {
                initializedSessionIds.push(session.sessionId);
                return mocks.ctx.middleware;
            });
        mocks.loginToApi.mockResolvedValue(replacementSession);
        const facade = createRallarFacade();

        const pendingConnect = facade.connect();
        await firstInitializationStarted.promise;

        await expect(
            facade.auth.login({
                username: 'principal-2',
                password: 'password-2'
            })
        ).resolves.toBe(replacementSession);

        expect(facade.status()).toBe('idle');
        expect(facade.isConnected()).toBe(false);

        pendingMiddleware.resolve(mocks.ctx.middleware);
        await expect(pendingConnect).rejects.toThrow(
            'Rallar connection was cancelled because auth ended.'
        );

        await expect(facade.connect()).resolves.toMatchObject({
            session: replacementSession
        });
        expect(initializedSessionIds).toEqual(['session-1', 'session-2']);
    });

    it('closes WS through the queue-box service when logging out after connect', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        let storedSession: typeof mocks.ctx.session | undefined = mocks.ctx.session;
        const logoutState = {
            heartbeatStopped: false,
            rtcReceiverDisposed: false,
            backendRevoked: false
        };
        let webSocketClose: { readonly code: number; readonly reason: string; } | undefined;
        mocks.readSession.mockImplementation(() => storedSession);
        mocks.clearSession.mockImplementation(() => {
            storedSession = undefined;
        });
        mocks.heartbeat.stop.mockImplementation(() => {
            logoutState.heartbeatStopped = true;
        });
        mocks.rtcRxStreamer.dispose.mockImplementation(() => {
            logoutState.rtcReceiverDisposed = true;
        });
        mocks.logoutFromApi.mockImplementation(async () => {
            logoutState.backendRevoked = true;
            return { loggedOut: true };
        });
        mocks.webSocketQueueBox.close.mockImplementation((code, reason) => {
            if (code === undefined || reason === undefined) {
                throw new Error('Auth cleanup must close WebSocket with code and reason');
            }
            webSocketClose = { code, reason };
            mocks.webSocket.close(code, reason);
        });
        const facade = createRallarFacade();

        await facade.connect();
        await facade.auth.logout();

        expect({ ...logoutState, webSocketClose }).toEqual({
            heartbeatStopped: true,
            rtcReceiverDisposed: true,
            backendRevoked: true,
            webSocketClose: { code: 1000, reason: 'rallar-disconnect' }
        });
        expect(storedSession).toBeUndefined();
        expect(facade.isConnected()).toBe(false);
    });

    it('disconnects every known RTC peer, including stale lane peers', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue([
            'peer-ready',
            'peer-stale'
        ]);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue([
            'peer-ready',
            'peer-stale'
        ]);
        mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes.mockReturnValue(
            ['peer-ready']
        );
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([
            'peer-ready'
        ]);
        const disconnectedPeerIds: string[] = [];
        mocks.webRtcConnectionService.disconnectPeer.mockImplementation((peerId) => {
            disconnectedPeerIds.push(peerId);
            return true;
        });
        const facade = createRallarFacade();
        const wsLifecycle: RallarWsLifecycleEvent[] = [];
        facade.ws.onLifecycle(
            (event) => {
                wsLifecycle.push(event);
            },
            {
                emitCurrent: false
            }
        );

        await facade.connect();
        await facade.disconnect();

        expect(disconnectedPeerIds).toEqual(['peer-ready', 'peer-stale']);
        expect(mocks.webSocketQueueBox.close).toHaveBeenCalledWith(
            1000,
            'rallar-disconnect'
        );
        expect(mocks.webSocket.close).toHaveBeenCalledWith(
            1000,
            'rallar-disconnect'
        );
        expect(wsLifecycle.at(-1)).toMatchObject({
            kind: 'disconnected',
            code: 1000,
            reason: 'rallar-disconnect',
            intentional: true,
            status: {
                connectState: 'idle',
                readyState: 'missing',
                reconnectEnabled: false
            }
        });
    });
});
