import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { BrowserFacadeRuntimeState } from '@shared-web/browser/composition/browser-facade-runtime-state.ts';
import { BrowserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import { initHeartbeat } from '@shared-web/browser/session/browser-session-heartbeat.ts';
import type { RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import { BrowserSessionAuthLifecycle } from '@shared-web/browser/session/session-auth-lifecycle.ts';
import type { RallarSessionConnectionLifecycle } from '@shared-web/browser/session/session-connection-lifecycle.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { Mock } from 'vitest';
import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';
import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

type RefreshModule = typeof import('@shared-web/browser/session/refresh-state-heartbeat.ts');
type AuthModule = typeof import('@shared/api/auth.ts');

const mocks = vi.hoisted(() => ({
    clearSession: vi.fn(),
    readSession: vi.fn<AuthModule['readSession']>(),
    refreshStateHeartbeat: vi.fn<RefreshModule['refreshStateHeartbeat']>()
}));

vi.mock(import('@shared/api/auth.ts'), async (importOriginal): Promise<Partial<AuthModule>> => ({
    ...await importOriginal(),
    clearSession: mocks.clearSession,
    readSession: mocks.readSession
}));

vi.mock(import('@shared-web/browser/session/refresh-state-heartbeat.ts'), async (original): Promise<RefreshModule> => ({
    ...await original(),
    refreshStateHeartbeat: mocks.refreshStateHeartbeat
}));

interface AuthFixture {
    readonly lifecycle: BrowserSessionAuthLifecycle;
    readonly middleware: ApiMiddleware;
    readonly transportRuntime: BrowserTransportRuntime;
    readonly deliveries: BrowserRallarDeliveryRegistry;
    readonly sessionDeliveries: BrowserSessionDeliveries;
    readonly connect: Mock<RallarSessionConnectionLifecycle['connect']>;
    readonly disconnect: Mock<RallarSessionConnectionLifecycle['disconnect']>;
}

function createAuthFixture(emitState: () => void): AuthFixture {
    const transportRuntime = new BrowserTransportRuntime();
    const runtime = new BrowserFacadeRuntimeState(transportRuntime);
    onTestFinished(() => runtime.clearAuthExpiryTimer());
    const middleware = createDefaultApiMiddlewareTestDouble();
    const deliveries = new BrowserRallarDeliveryRegistry({ nowMs: Date.now, retainTerminalMs: 60_000, maxEntries: 512, cancel: () => {} });
    const sessionDeliveries = new BrowserSessionDeliveries(deliveries, transportRuntime);
    const connect = vi.fn<RallarSessionConnectionLifecycle['connect']>().mockResolvedValue(middleware);
    const disconnect = vi.fn<RallarSessionConnectionLifecycle['disconnect']>().mockResolvedValue(undefined);
    const lifecycle = new BrowserSessionAuthLifecycle({
        sessionDeliveries,
        nowMs: Date.now,
        newRequestId: crypto.randomUUID.bind(crypto),
        connectionRuntime: runtime,
        transportRuntime,
        authRuntime: runtime,
        connectionLifecycle: { connect, disconnect },
        emitState,
        closeDataScopes: () => Promise.resolve()
    });
    return { lifecycle, middleware, transportRuntime, deliveries, sessionDeliveries, connect, disconnect };
}

function openObservedMessage(fixture: AuthFixture, msgId: string): RallarMessageHandle {
    return fixture.deliveries.open({
        id: { v: 2, msgId, ts: Date.now(), senderId: fixture.middleware.session.sessionId },
        route: { topicId: 'app.event', contextId: 'all', resourceId: msgId },
        payload: { typeId: 'app.event', resource: 'true' },
        delivery: { reliability: 'at-least-once', ack: 'receiver' }
    }, 'ws');
}

describe('Rallar auth session teardown notification', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        configureTestCacheRepositories();
    });

    it('preserves a replacement when a stopped old heartbeat later rejects unauthorized', async () => {
        const fixture = createAuthFixture(() => {});
        const initialSession = fixture.middleware.session;
        mocks.readSession.mockReturnValue(initialSession);
        await fixture.lifecycle.connect();
        const registered = fixture.connect.mock.calls[0][0];
        const request = Promise.withResolvers<Awaited<ReturnType<RefreshModule['refreshStateHeartbeat']>>>();
        mocks.refreshStateHeartbeat.mockReturnValue(request.promise);
        const onAuthInvalid = vi.fn(async (error: unknown) => await registered.onAuthInvalid(toError(error)));
        const heartbeat = await initHeartbeat({
            clientId: initialSession.clientId,
            sessionId: initialSession.sessionId,
            isOnline: true
        }, { authSession: initialSession, onAuthInvalid });
        heartbeat.stop();
        const replacement = { ...initialSession, sessionId: 'replacement' };
        mocks.readSession.mockReturnValue(replacement);
        fixture.sessionDeliveries.beginSession(replacement);
        const handle = openObservedMessage(fixture, 'replacement-heartbeat');
        request.reject(new ApiHttpError('POST', '/heartbeat', 401, 'expired'));
        await vi.waitFor(() => expect(onAuthInvalid).toHaveBeenCalledOnce());
        await onAuthInvalid.mock.results[0].value;
        expect(mocks.clearSession).not.toHaveBeenCalled();
        expect(fixture.disconnect).not.toHaveBeenCalled();
        expect(handle.lifecycle().state).toBe('submitted');
    });

    it('preserves a replacement when an old auth-aware operation later rejects unauthorized', async () => {
        const fixture = createAuthFixture(() => {});
        const initialSession = fixture.middleware.session;
        mocks.readSession.mockReturnValue(initialSession);
        fixture.sessionDeliveries.beginSession(initialSession);
        const request = Promise.withResolvers<void>();
        const error = new ApiHttpError('POST', '/operation', 401, 'expired');
        const operation = fixture.lifecycle.runAuthAwareOperation(() => request.promise);
        const rejected = expect(operation).rejects.toBe(error);
        const replacement = { ...initialSession, clientId: 'replacement-client' };
        mocks.readSession.mockReturnValue(replacement);
        fixture.sessionDeliveries.beginSession(replacement);
        const handle = openObservedMessage(fixture, 'replacement-operation');
        request.reject(error);
        await rejected;
        expect(mocks.clearSession).not.toHaveBeenCalled();
        expect(fixture.disconnect).not.toHaveBeenCalled();
        expect(handle.lifecycle().state).toBe('submitted');
    });

    it('uses current auth for an operation even while cached middleware belongs to the previous session', async () => {
        const fixture = createAuthFixture(() => {});
        const replacement = { ...fixture.middleware.session, sessionId: 'current-auth' };
        vi.spyOn(fixture.transportRuntime, 'readMiddleware').mockReturnValue(fixture.middleware);
        mocks.readSession.mockReturnValue(replacement);
        fixture.sessionDeliveries.beginSession(replacement);
        const handle = openObservedMessage(fixture, 'current-auth-stale-transport');
        const error = new ApiHttpError('POST', '/operation', 401, 'expired');
        await expect(fixture.lifecycle.runAuthAwareOperation(() => Promise.reject(error))).rejects.toBe(error);
        expect(mocks.clearSession).toHaveBeenCalledOnce();
        expect(fixture.disconnect).toHaveBeenCalledOnce();
        expect(handle.lifecycle().state).toBe('unobservable');
    });

    it('ends current-session observations when its auth-aware operation rejects unauthorized', async () => {
        const fixture = createAuthFixture(() => {});
        mocks.readSession.mockReturnValue(fixture.middleware.session);
        fixture.sessionDeliveries.beginSession(fixture.middleware.session);
        const handle = openObservedMessage(fixture, 'current-operation');
        const error = new ApiHttpError('POST', '/operation', 401, 'expired');
        await expect(fixture.lifecycle.runAuthAwareOperation(() => Promise.reject(error))).rejects.toBe(error);
        expect(mocks.clearSession).toHaveBeenCalledOnce();
        expect(fixture.disconnect).toHaveBeenCalledOnce();
        expect(handle.lifecycle().state).toBe('unobservable');
    });

    it('ignores an ended old identity while a newer auth session remains active', async () => {
        const oldSession = createDefaultApiMiddlewareTestDouble().session;
        mocks.readSession.mockReturnValue({ ...oldSession, clientId: 'replacement-client' });
        const emitState = vi.fn();
        const { lifecycle } = createAuthFixture(emitState);
        await lifecycle.endAuthSession('expired', { revoke: false, session: oldSession });
        expect(mocks.clearSession).not.toHaveBeenCalled();
        expect(emitState).not.toHaveBeenCalled();
    });
    it('notifies auth listeners even when the state emit fails', async () => {
        // The app's sign-out rests on this notification, so a failing side
        // effect must not stand between the teardown and its listeners.
        const { lifecycle } = createAuthFixture(() => {
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
});
