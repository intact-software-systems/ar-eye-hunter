import type { RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthSessionApiHttpError, createAuthSessionGroupSnapshot, installGroupSnapshotRepositoryMocks } from '../auth-session-contract-fixtures.ts';
import type * as ContractModules from '../auth-session-contract-modules.ts';
import { readAuthSessionContractMocks, resetAuthSessionContractMocks } from './browser-auth-session-contract-fixture.ts';

const mocks = readAuthSessionContractMocks();

describe('Rallar auth login, expiry, and registration contract', () => {
    beforeEach(resetAuthSessionContractMocks);

    it('passes signal and timeout options into auth login', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const signal = new AbortController().signal;
        let loginRequest: Parameters<ContractModules.AuthApi['loginToApi']>[0] | undefined;
        let loginOptions: Parameters<ContractModules.AuthApi['loginToApi']>[1] | undefined;
        mocks.loginToApi.mockImplementationOnce(async (request, options) => {
            loginRequest = request;
            loginOptions = options;
            return mocks.ctx.session;
        });

        await createRallarFacade().auth.login(
            {
                username: 'principal-1',
                password: 'password-1'
            },
            {
                signal,
                timeoutMs: 123
            }
        );

        expect(loginRequest).toEqual({
            username: 'principal-1',
            password: 'password-1'
        });
        expect(loginOptions?.signal).toBeInstanceOf(AbortSignal);
    });

    it('reuses one request ID when login retries after a lost response', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const requestIds: Array<string | undefined> = [];
        mocks.loginToApi.mockImplementation(async (_request, options) => {
            requestIds.push(options?.requestId);
            if (requestIds.length === 1) {
                throw createAuthSessionApiHttpError(503, 'response lost');
            }
            return mocks.ctx.session;
        });

        await createRallarFacade().auth.login(
            { username: 'principal-1', password: 'password-1' },
            { maxAttempts: 2 }
        );

        expect(requestIds).toHaveLength(2);
        expect(requestIds[0]).toBeTruthy();
        expect(new Set(requestIds).size).toBe(1);
    });

    it('emits the current auth state to auth change subscribers', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const authStates: RallarAuthState[] = [];

        const unsubscribe = createRallarFacade().auth.onChange((authState) => {
            authStates.push(authState);
        });

        expect(authStates).toEqual([
            {
                authenticated: true,
                reason: 'current',
                session: mocks.ctx.session
            }
        ]);

        unsubscribe();
    });

    it('locally logs out and tears down active transports when the session expires', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const expiringSession = {
            ...mocks.ctx.session,
            expiresAtEpochMs: 1_500
        };
        mocks.initialiseMiddleware.mockResolvedValue(mocks.ctx.middleware);
        mocks.readSession.mockImplementation(() =>
            Date.now() >= expiringSession.expiresAtEpochMs
                ? undefined
                : expiringSession
        );
        const transportState = {
            heartbeatStopped: false,
            rtcHeartbeatsStopped: false,
            remoteLogoutRequested: false,
            sessionCleared: false
        };
        let webSocketClose: { readonly code: number; readonly reason: string; } | undefined;
        mocks.heartbeat.stop.mockImplementation(() => {
            transportState.heartbeatStopped = true;
        });
        mocks.rtcRxStreamer.stopAllHeartbeats.mockImplementation(() => {
            transportState.rtcHeartbeatsStopped = true;
        });
        mocks.logoutFromApi.mockImplementation(async () => {
            transportState.remoteLogoutRequested = true;
            return { loggedOut: true };
        });
        mocks.clearSession.mockImplementation(() => {
            transportState.sessionCleared = true;
        });
        mocks.webSocketQueueBox.close.mockImplementation((code, reason) => {
            if (code === undefined || reason === undefined) {
                throw new Error('Auth cleanup must close WebSocket with code and reason');
            }
            webSocketClose = { code, reason };
            mocks.webSocket.close(code, reason);
        });
        const facade = createRallarFacade();
        const authStates: RallarAuthState[] = [];
        facade.auth.onChange((authState) => {
            authStates.push(authState);
        }, { emitCurrent: false });

        await facade.connect();
        await vi.advanceTimersByTimeAsync(500);
        await Promise.resolve();
        await Promise.resolve();

        expect({ ...transportState, webSocketClose }).toEqual({
            heartbeatStopped: true,
            rtcHeartbeatsStopped: true,
            remoteLogoutRequested: false,
            sessionCleared: true,
            webSocketClose: { code: 1000, reason: 'rallar-disconnect' }
        });
        expect(authStates).toEqual([
            {
                authenticated: false,
                reason: 'expired',
                session: undefined
            }
        ]);
        expect(facade.isConnected()).toBe(false);
    });

    it('does not expire a replacement session when an old expiry timer fires', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const oldSession = {
            ...mocks.ctx.session,
            expiresAtEpochMs: 1_500
        };
        const nextSession = {
            ...mocks.ctx.session,
            sessionId: 'session-2',
            accessToken: 'token-2',
            expiresAtEpochMs: 10_000
        };
        let currentSession: typeof oldSession | undefined = oldSession;
        let transportClosed = false;
        mocks.initialiseMiddleware.mockResolvedValue(mocks.ctx.middleware);
        mocks.readSession.mockImplementation(() => currentSession);
        mocks.clearSession.mockImplementation(() => {
            currentSession = undefined;
        });
        mocks.webSocketQueueBox.close.mockImplementation(() => {
            transportClosed = true;
        });
        const facade = createRallarFacade();

        await facade.connect();
        currentSession = nextSession;
        await vi.advanceTimersByTimeAsync(500);

        expect(currentSession).toBe(nextSession);
        expect(transportClosed).toBe(false);
        expect(facade.isConnected()).toBe(true);
    });

    it('locally logs out on API 401 without calling the logout endpoint', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        let storedSession: typeof mocks.ctx.session | undefined = mocks.ctx.session;
        let remoteLogoutRequested = false;
        const authStates: RallarAuthState[] = [];
        mocks.readSession.mockImplementation(() => storedSession);
        mocks.clearSession.mockImplementation(() => {
            storedSession = undefined;
        });
        mocks.logoutFromApi.mockImplementation(async () => {
            remoteLogoutRequested = true;
            return { loggedOut: true };
        });
        facade.auth.onChange((authState) => {
            authStates.push(authState);
        }, { emitCurrent: false });
        await facade.connect();
        mocks.refreshStateSnapshots.mockRejectedValue(
            createAuthSessionApiHttpError(401, 'Unauthorized')
        );

        await expect(facade.rooms.refresh()).rejects.toThrow('Unauthorized');

        expect(mocks.webSocketQueueBox.close).toHaveBeenCalledWith(
            1000,
            'rallar-disconnect'
        );
        expect(remoteLogoutRequested).toBe(false);
        expect(storedSession).toBeUndefined();
        expect(authStates).toEqual([
            {
                authenticated: false,
                reason: 'unauthorized',
                session: undefined
            }
        ]);
    });

    it('emits unauthorized auth state once when nested room operations see the same 401', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        let storedSession: typeof mocks.ctx.session | undefined = mocks.ctx.session;
        const authStates: RallarAuthState[] = [];
        const oldRoom = createAuthSessionGroupSnapshot('old-room', ['session-1']);
        const newRoom = createAuthSessionGroupSnapshot('new-room', ['session-1']);
        mocks.readSession.mockImplementation(() => storedSession);
        mocks.clearSession.mockImplementation(() => {
            storedSession = undefined;
        });

        facade.setDefaults({
            applicationId: 'app-1',
            workspaceId: 'workspace-1'
        });
        mocks.joinStateGroup.mockResolvedValueOnce(oldRoom);
        await facade.rooms.join('old-room');
        installGroupSnapshotRepositoryMocks(mocks, [oldRoom]);

        facade.auth.onChange((authState) => {
            authStates.push(authState);
        }, { emitCurrent: false });
        mocks.joinStateGroup.mockResolvedValueOnce(newRoom);
        mocks.leaveStateGroup.mockRejectedValueOnce(
            createAuthSessionApiHttpError(401, 'Unauthorized')
        );

        await expect(facade.rooms.join('new-room')).rejects.toThrow('Unauthorized');

        expect(authStates).toEqual([
            {
                authenticated: false,
                reason: 'unauthorized',
                session: undefined
            }
        ]);
        expect(storedSession).toBeUndefined();
    });

    it('does not locally log out on API 403 authorization errors', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        let storedSession: typeof mocks.ctx.session | undefined = mocks.ctx.session;
        const authStates: RallarAuthState[] = [];
        mocks.readSession.mockImplementation(() => storedSession);
        mocks.clearSession.mockImplementation(() => {
            storedSession = undefined;
        });
        await facade.connect();
        facade.auth.onChange((authState) => {
            authStates.push(authState);
        });
        mocks.refreshStateSnapshots.mockRejectedValue(
            createAuthSessionApiHttpError(403, 'Forbidden')
        );

        await expect(facade.rooms.refresh()).rejects.toThrow('Forbidden');

        expect(storedSession).toBe(mocks.ctx.session);
        expect(authStates.at(-1)).toEqual({
            authenticated: true,
            reason: 'current',
            session: mocks.ctx.session
        });
        expect(facade.isConnected()).toBe(true);
    });

    it('passes an explicit admin session into auth registration', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const signal = new AbortController().signal;
        const adminSession = {
            ...mocks.ctx.session,
            clientId: 'admin',
            accessToken: 'admin-token',
            username: 'admin'
        };
        let registerRequest: Parameters<ContractModules.AuthApi['registerWithApi']>[0] | undefined;
        let registerOptions: Parameters<ContractModules.AuthApi['registerWithApi']>[1] | undefined;
        mocks.registerWithApi.mockImplementationOnce(async (request, options) => {
            registerRequest = request;
            registerOptions = options;
            return {
                clientId: 'client-new',
                username: 'new-user',
                displayName: null,
                registeredAtEpochMs: 1_000
            };
        });

        await createRallarFacade().auth.register(
            {
                username: 'new-user',
                password: 'password-1',
                displayName: 'New User'
            },
            {
                adminSession,
                signal,
                timeoutMs: 123
            }
        );

        expect(registerRequest).toEqual({
            username: 'new-user',
            password: 'password-1',
            displayName: 'New User'
        });
        expect(registerOptions?.signal).toBeInstanceOf(AbortSignal);
        expect(registerOptions?.authSession).toBe(adminSession);
    });

    it('reuses one request ID when registration retries after a lost response', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const requestIds: Array<string | undefined> = [];
        mocks.registerWithApi.mockImplementation(async (_request, options) => {
            requestIds.push(options?.requestId);
            if (requestIds.length === 1) {
                throw createAuthSessionApiHttpError(503, 'response lost');
            }
            return {
                clientId: 'client-new',
                username: 'new-user',
                displayName: null,
                registeredAtEpochMs: 1_000
            };
        });

        await createRallarFacade().auth.register(
            { username: 'new-user', password: 'password-1' },
            { maxAttempts: 2 }
        );

        expect(requestIds).toHaveLength(2);
        expect(requestIds[0]).toBeTruthy();
        expect(new Set(requestIds).size).toBe(1);
    });

    it('can register and then log in with the new user', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const registrationRequests: Array<Parameters<ContractModules.AuthApi['registerWithApi']>[0]> = [];
        const loginRequests: Array<Parameters<ContractModules.AuthApi['loginToApi']>[0]> = [];
        const writtenSessions: Array<Parameters<ContractModules.Auth['writeSession']>[0]> = [];
        mocks.registerWithApi.mockImplementation(async (request) => {
            registrationRequests.push(request);
            return {
                clientId: 'client-new',
                username: 'new-user',
                displayName: null,
                registeredAtEpochMs: 1_000
            };
        });
        mocks.loginToApi.mockImplementation(async (request) => {
            loginRequests.push(request);
            return mocks.ctx.session;
        });
        mocks.writeSession.mockImplementation((session) => {
            writtenSessions.push(session);
        });

        await createRallarFacade().auth.registerAndLogin({
            username: 'new-user',
            password: 'password-1'
        });

        expect(registrationRequests).toEqual([
            { username: 'new-user', password: 'password-1' }
        ]);
        expect(loginRequests).toEqual([
            {
                username: 'new-user',
                password: 'password-1'
            }
        ]);
        expect(writtenSessions).toEqual([mocks.ctx.session]);
    });
});
