import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi,
    type Mock
} from 'vitest';

import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { BrowserFacadeRuntimeState } from '@shared-web/browser/composition/browser-facade-runtime-state.ts';
import { BrowserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import { BrowserSessionAuthLifecycle } from '@shared-web/browser/session/session-auth-lifecycle.ts';
import type { RallarSessionConnectionLifecycle } from '@shared-web/browser/session/session-connection-lifecycle.ts';
import {
    readSession,
    resetAuthSessionStorage,
    writeSession
} from '@shared/api/auth.ts';

import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

interface AuthFixture {
    readonly lifecycle: BrowserSessionAuthLifecycle;
    readonly middleware: ApiMiddleware;
    readonly transportRuntime: BrowserTransportRuntime;
    readonly deliveries: BrowserRallarDeliveryRegistry;
    readonly sessionDeliveries: BrowserSessionDeliveries;
    readonly connect: Mock<RallarSessionConnectionLifecycle['connect']>;
    readonly runtime: BrowserFacadeRuntimeState;
}

describe('Rallar auth state notifications', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        configureTestCacheRepositories();
        const storage = new Map<string, string>();
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key)
        });
        resetAuthSessionStorage();
        onTestFinished(() => {
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
        });
    });

    it('preserves a replacement when an old connection later reports unauthorized', async () => {
        const fixture = createDefaultAuthFixture(() => {});
        const initialSession = fixture.middleware.session;
        writeSession(initialSession);
        await fixture.lifecycle.connect();
        const registered = fixture.connect.mock.calls[0][0];
        const replacement = { ...initialSession, sessionId: 'replacement' };
        writeSession(replacement);
        fixture.sessionDeliveries.beginSession(replacement);
        const handle = openObservedMessage(fixture, 'replacement-connection');
        await registered.onAuthInvalid(new ApiHttpError('POST', '/heartbeat', 401, 'expired'));
        expect(readSession()).toEqual(replacement);
        expect(fixture.runtime.readConnectState()).toBe('connected');
        expect(handle.lifecycle().state).toBe('submitted');
    });

    it('preserves a replacement when an old auth-aware operation later rejects unauthorized', async () => {
        const fixture = createDefaultAuthFixture(() => {});
        const initialSession = fixture.middleware.session;
        writeSession(initialSession);
        fixture.sessionDeliveries.beginSession(initialSession);
        const request = Promise.withResolvers<void>();
        const error = new ApiHttpError('POST', '/operation', 401, 'expired');
        const operation = fixture.lifecycle.runAuthAwareOperation(() => request.promise);
        const rejected = expect(operation).rejects.toBe(error);
        const replacement = { ...initialSession, clientId: 'replacement-client' };
        writeSession(replacement);
        fixture.sessionDeliveries.beginSession(replacement);
        const handle = openObservedMessage(fixture, 'replacement-operation');
        request.reject(error);
        await rejected;
        expect(readSession()).toEqual(replacement);
        expect(fixture.runtime.readConnectState()).toBe('connected');
        expect(handle.lifecycle().state).toBe('submitted');
    });

    it('uses current auth for an operation even while cached middleware belongs to the previous session', async () => {
        const fixture = createDefaultAuthFixture(() => {});
        const replacement = { ...fixture.middleware.session, sessionId: 'current-auth' };
        vi.spyOn(fixture.transportRuntime, 'readMiddleware').mockReturnValue(fixture.middleware);
        writeSession(replacement);
        fixture.sessionDeliveries.beginSession(replacement);
        const handle = openObservedMessage(fixture, 'current-auth-stale-transport');
        const error = new ApiHttpError('POST', '/operation', 401, 'expired');
        await expect(fixture.lifecycle.runAuthAwareOperation(() => Promise.reject(error))).rejects.toBe(error);
        expect(readSession()).toBeUndefined();
        expect(fixture.runtime.readConnectState()).toBe('idle');
        expect(handle.lifecycle().state).toBe('unobservable');
    });

    it('ends current-session observations when its auth-aware operation rejects unauthorized', async () => {
        const fixture = createDefaultAuthFixture(() => {});
        writeSession(fixture.middleware.session);
        fixture.sessionDeliveries.beginSession(fixture.middleware.session);
        const handle = openObservedMessage(fixture, 'current-operation');
        const error = new ApiHttpError('POST', '/operation', 401, 'expired');
        await expect(fixture.lifecycle.runAuthAwareOperation(() => Promise.reject(error))).rejects.toBe(error);
        expect(readSession()).toBeUndefined();
        expect(fixture.runtime.readConnectState()).toBe('idle');
        expect(handle.lifecycle().state).toBe('unobservable');
    });

    it('ignores an ended old identity while a newer auth session remains active', async () => {
        const oldSession = createDefaultApiMiddlewareTestDouble().session;
        const replacement = { ...oldSession, clientId: 'replacement-client' };
        writeSession(replacement);
        const { lifecycle } = createDefaultAuthFixture(() => {});
        const states: RallarAuthState[] = [];
        lifecycle.onAuthChange((state) => {
            states.push(state);
        }, { emitCurrent: false });
        await lifecycle.endAuthSession('expired', { revoke: false, session: oldSession });
        expect(readSession()).toEqual(replacement);
        expect(states.filter((state) => !state.authenticated)).toEqual([]);
    });
    it('notifies auth listeners even when the state emit fails', async () => {
        // The app's sign-out rests on this notification, so a failing side
        // effect must not stand between the teardown and its listeners.
        const { lifecycle } = createDefaultAuthFixture(() => {
            throw new Error('state emit failed');
        });
        const states: RallarAuthState[] = [];
        lifecycle.onAuthChange((state) => {
            states.push(state);
        }, { emitCurrent: false });

        await expect(
            lifecycle.endAuthSession('logout', { revoke: false })
        ).rejects.toThrow('state emit failed');

        expect(states.at(-1)).toMatchObject({ authenticated: false, reason: 'logout' });
    });

    it('keeps later observers on a replacement login started by a logout observer', async () => {
        const fixture = createDefaultAuthFixture(() => {});
        const initialSession = fixture.middleware.session;
        const replacement = { ...initialSession, sessionId: 'replacement-login' };
        writeSession(initialSession);
        const replacementLogin = Promise.withResolvers<void>();
        const states: RallarAuthState[] = [];
        fixture.lifecycle.onAuthChange((state) => {
            if (state.reason === 'logout') {
                return fixture.lifecycle.activateLoginSession(replacement)
                    .then(replacementLogin.resolve, replacementLogin.reject);
            }
        }, { emitCurrent: false });
        fixture.lifecycle.onAuthChange((state) => {
            states.push(state);
        }, { emitCurrent: false });

        await fixture.lifecycle.endAuthSession('logout', { revoke: false });
        await replacementLogin.promise;

        expect(readSession()).toEqual(replacement);
        expect(states).toEqual([{ authenticated: true, reason: 'login', session: replacement }]);
    });

    it('keeps a replay-renewed subscription when its old handle unsubscribes', async () => {
        const fixture = createDefaultAuthFixture(() => {});
        const states: RallarAuthState[] = [];
        const listener = (state: RallarAuthState) => {
            states.push(state);
        };
        const old = fixture.lifecycle.onAuthChange(listener, { emitCurrent: false });
        const renewed = fixture.lifecycle.onAuthChange(listener);
        old();

        await fixture.lifecycle.activateLoginSession(fixture.middleware.session);
        renewed();
        await fixture.lifecycle.endAuthSession('logout', { revoke: false });

        expect(states).toEqual([
            { authenticated: false, reason: 'current', session: undefined },
            { authenticated: true, reason: 'login', session: fixture.middleware.session }
        ]);
    });

    it('defers a subscription added without replay until the next auth change', async () => {
        const fixture = createDefaultAuthFixture(() => {});
        const states: RallarAuthState[] = [];
        const listener = (state: RallarAuthState) => {
            states.push(state);
        };
        fixture.lifecycle.onAuthChange((state) => {
            if (state.reason === 'login') {
                fixture.lifecycle.onAuthChange(listener, { emitCurrent: false });
            }
        }, { emitCurrent: false });

        await fixture.lifecycle.activateLoginSession(fixture.middleware.session);
        expect(states).toEqual([]);
        await fixture.lifecycle.endAuthSession('logout', { revoke: false });
        expect(states).toEqual([{ authenticated: false, reason: 'logout', session: undefined }]);
    });

    it('does not retain a subscriber when reading its current auth state fails', async () => {
        const fixture = createDefaultAuthFixture(() => {});
        const states: RallarAuthState[] = [];
        vi.spyOn(localStorage, 'getItem').mockImplementationOnce(() => {
            throw new Error('auth storage unavailable');
        });

        expect(() =>
            fixture.lifecycle.onAuthChange((state) => {
                states.push(state);
            })
        ).toThrow('auth storage unavailable');
        await fixture.lifecycle.activateLoginSession(fixture.middleware.session);

        expect(states).toEqual([]);
        expect(readSession()).toEqual(fixture.middleware.session);
    });

    it('preserves login and later observers when callbacks and their error reporter fail', async () => {
        const fixture = createDefaultAuthFixture(() => {});
        const states: RallarAuthState[] = [];
        vi.spyOn(console, 'error').mockImplementation(() => {
            throw new Error('reporter unavailable');
        });
        fixture.lifecycle.onAuthChange(() => {
            throw new Error('sync observer failed');
        }, { emitCurrent: false });
        fixture.lifecycle.onAuthChange(async () => {
            throw new Error('async observer failed');
        }, { emitCurrent: false });
        fixture.lifecycle.onAuthChange((state) => {
            states.push(state);
        }, { emitCurrent: false });

        await expect(fixture.lifecycle.activateLoginSession(fixture.middleware.session)).resolves.toBeUndefined();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(readSession()).toEqual(fixture.middleware.session);
        expect(states).toEqual([{ authenticated: true, reason: 'login', session: fixture.middleware.session }]);
    });

    it('preserves replacement login while old cleanup finishes with an error', async () => {
        const cleanupStarted = Promise.withResolvers<void>();
        const cleanupFinished = Promise.withResolvers<void>();
        const cleanupFailure = new Error('old data scope cleanup failed');
        const closedSessionIds: string[] = [];
        const fixture = createDefaultAuthFixture(() => {}, (session) => {
            closedSessionIds.push(session.sessionId);
            cleanupStarted.resolve();
            return cleanupFinished.promise;
        });
        const initialSession = fixture.middleware.session;
        const replacement = { ...initialSession, sessionId: 'login-during-cleanup' };
        writeSession(initialSession);
        const states: RallarAuthState[] = [];
        fixture.lifecycle.onAuthChange((state) => {
            states.push(state);
        }, { emitCurrent: false });

        const ending = expect(fixture.lifecycle.endAuthSession('logout', { revoke: false }))
            .rejects.toBe(cleanupFailure);
        await cleanupStarted.promise;
        await fixture.lifecycle.activateLoginSession(replacement);
        cleanupFinished.reject(cleanupFailure);
        await ending;

        expect(readSession()).toEqual(replacement);
        expect(closedSessionIds).toEqual([initialSession.sessionId]);
        expect(states).toEqual([{ authenticated: true, reason: 'login', session: replacement }]);
    });

    it('rechecks current auth after state emission starts a replacement login', async () => {
        const stateEvents = new EventTarget();
        const fixture = createDefaultAuthFixture(() => {
            stateEvents.dispatchEvent(new Event('change'));
        });
        const initialSession = fixture.middleware.session;
        const replacement = { ...initialSession, sessionId: 'login-during-state-emission' };
        writeSession(initialSession);
        const replacementLogin = Promise.withResolvers<void>();
        stateEvents.addEventListener('change', () => {
            void fixture.lifecycle.activateLoginSession(replacement)
                .then(replacementLogin.resolve, replacementLogin.reject);
        });
        const states: RallarAuthState[] = [];
        fixture.lifecycle.onAuthChange((state) => {
            states.push(state);
        }, { emitCurrent: false });

        await fixture.lifecycle.endAuthSession('logout', { revoke: false });
        await replacementLogin.promise;

        expect(readSession()).toEqual(replacement);
        expect(states).toEqual([{ authenticated: true, reason: 'login', session: replacement }]);
    });
});

function createDefaultAuthFixture(
    emitState: () => void,
    closeDataScopes: BrowserSessionAuthLifecycle.Input['closeDataScopes'] = () => Promise.resolve()
): AuthFixture {
    const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
    const runtime = new BrowserFacadeRuntimeState(transportRuntime);
    onTestFinished(() => runtime.clearAuthExpiryTimer());
    const middleware = createDefaultApiMiddlewareTestDouble();
    const deliveries = new BrowserRallarDeliveryRegistry({ nowMs: Date.now, retainTerminalMs: 60_000, maxEntries: 512, cancel: () => {} });
    const sessionDeliveries = new BrowserSessionDeliveries(deliveries, transportRuntime, readSession);
    const connect = vi.fn<RallarSessionConnectionLifecycle['connect']>().mockResolvedValue({
        middleware,
        diagnosticsPorts: Object.freeze(toRallarDiagnosticsPorts(undefined)),
        rtcCapture: { status: 'unavailable', reason: 'absent' }
    });
    runtime.setConnectState('connected');
    const disconnect = async (): Promise<void> => {
        runtime.setConnectState('idle');
    };
    const lifecycle = new BrowserSessionAuthLifecycle({
        sessionDeliveries,
        nowMs: Date.now,
        newRequestId: crypto.randomUUID.bind(crypto),
        connectionRuntime: runtime,
        transportRuntime,
        authRuntime: runtime,
        connectionLifecycle: { connect, disconnect, readRtcCaptureConfiguration: () => transportRuntime.readRtcCaptureConfiguration() },
        emitState,
        closeDataScopes
    });
    return { lifecycle, middleware, transportRuntime, deliveries, sessionDeliveries, connect, runtime };
}

function openObservedMessage(fixture: AuthFixture, msgId: string): RallarMessageHandle {
    return fixture.deliveries.open({
        id: { v: 3, msgId, ts: Date.now(), senderId: fixture.middleware.session.sessionId },
        route: { topicId: 'app.event', contextId: 'all', resourceId: msgId },
        payload: { typeId: 'app.event', resource: 'true' },
        delivery: { reliability: 'at-least-once', ack: 'receiver' }
    }, 'ws');
}
