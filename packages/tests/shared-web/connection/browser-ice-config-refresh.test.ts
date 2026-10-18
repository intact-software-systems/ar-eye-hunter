import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { BrowserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import type { RallarFacade } from '@shared-web/browser/rallar-facade-contract.ts';
import type { RallarRtcFacade } from '@shared-web/browser/rallar-realtime.ts';

import '../../setup-browser-indexeddb.ts';

const session = { clientId: 'refresh-client', sessionId: 'refresh-session', username: 'test', accessToken: 'initial', expiresAtEpochMs: 1_000_000 };
const options = {
    rtcCaptureConfiguration: { mode: 'off', origin: 'product-default' } as const,
    qosProvider: undefined,
    readVolatileSessionLimits: undefined,
    deliverySettlements: { ws: () => {}, rtc: () => {}, holds: () => false },
    diagnosticsPorts: toRallarDiagnosticsPorts(undefined),
    onResyncRequired: () => {},
    scope: { applicationId: 'ice-refresh', workspaceId: 'test' }
};
let rallar: RallarFacade;
let runtime: BrowserTransportRuntime;
let iceResponse: () => Promise<Response>;
let configResponse: () => Promise<Response>;
const requests: Array<{ readonly url: string; readonly authorization: string | null; }> = [];

beforeEach(async () => {
    vi.resetModules();
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key)
    });
    const auth = await import('@shared/api/auth.ts');
    auth.writeSession(session);
    const config = await import('@shared-web/browser/api-client-config.ts');
    config.configureApiClient({ apiBaseUrl: 'https://first.test' });
    runtime = (await import('@shared-web/browser/connection/browser-transport-runtime.ts')).browserTransportRuntime;
    rallar = (await import('@shared-web/browser/rallar.ts')).rallar;
    requests.length = 0;
    iceResponse = async () => Response.json({ iceServers: [], expiresAtEpochMs: 20_000 });
    configResponse = async () => Response.json({ apiBaseUrl: 'https://first.test', wsBaseUrl: 'wss://first.test', endpoints: { createWs: '/ws' } });
    vi.stubGlobal('fetch', readResponse);
    const websocket = await import('@shared/websocket/json-web-socket-client.ts');
    vi.spyOn(websocket.JsonWebSocketClient.prototype, 'connect').mockResolvedValue();
    const state = await import('@shared-web/browser/state-read/refresh-state-snapshots.ts');
    vi.spyOn(state, 'refreshStateSnapshots').mockResolvedValue({ clients: [], groups: [] });
    const heartbeat = await import('@shared-web/browser/session/browser-session-heartbeat.ts');
    vi.spyOn(heartbeat, 'initHeartbeat').mockResolvedValue({ sessionId: session.sessionId, generationId: 'heartbeat', stop: () => {} });
});

afterEach(async () => {
    const middleware = runtime.readMiddleware()?.middleware;
    runtime.shutdown();
    await middleware?.qboxEngine.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('browser ICE configuration refresh', () => {
    it('refreshes before expiry without changing active transport and supplies the next transport', async () => {
        const first = await runtime.init(options);
        iceResponse = async () => Response.json({ iceServers: [{ urls: 'stun:next.test' }], expiresAtEpochMs: 30_000 });
        await expect(rallar.rtc.refreshIceConfig()).resolves.toBeUndefined();
        expect(runtime.readConnection()).toBe(first);
        expect(first.middleware.middleware.webRtcConnectionService.input.iceCandidates.iceServers).toEqual([]);
        runtime.shutdown();
        const next = await runtime.init(options);
        expect(next.middleware.middleware.webRtcConnectionService.input.iceCandidates.iceServers).toEqual([{ urls: 'stun:next.test' }]);
        expect(requests.filter((request) => request.url.endsWith('/api/webrtc/ice'))).toHaveLength(2);
    });

    it('refreshes an authenticated disconnected browser through the narrow RTC entry without connecting', async () => {
        const rtc: RallarRtcFacade = rallar.rtc;
        await rtc.refreshIceConfig();
        expect(runtime.isReady()).toBe(false);
        expect(runtime.isInitializing()).toBe(false);
        expect(requests).toEqual([{ url: 'https://first.test/api/webrtc/ice', authorization: 'Bearer initial' }]);
    });

    it('rejects missing authentication without requesting ICE or connecting', async () => {
        (await import('@shared/api/auth.ts')).clearSession();
        await expect(rallar.rtc.refreshIceConfig()).rejects.toThrow('no auth session');
        expect(requests).toEqual([]);
        expect(runtime.isReady()).toBe(false);
    });

    it.each(['refresh-first', 'init-first'] as const)('coalesces refresh and initialization: %s', async (order) => {
        const entered = Promise.withResolvers<void>();
        const response = Promise.withResolvers<Response>();
        iceResponse = () => {
            entered.resolve();
            return response.promise;
        };
        const first = order === 'refresh-first' ? rallar.rtc.refreshIceConfig() : runtime.init(options);
        await entered.promise;
        const second = order === 'refresh-first' ? runtime.init(options) : rallar.rtc.refreshIceConfig();
        response.resolve(Response.json({ iceServers: [{ urls: 'stun:shared.test' }], expiresAtEpochMs: 30_000 }));
        await Promise.all([first, second]);
        expect(runtime.readMiddleware()?.middleware.webRtcConnectionService.input.iceCandidates.iceServers).toEqual([{ urls: 'stun:shared.test' }]);
        expect(requests.filter((request) => request.url.endsWith('/api/webrtc/ice'))).toHaveLength(1);
    });

    it('cancels a joining caller independently while the shared refresh succeeds', async () => {
        const response = Promise.withResolvers<Response>();
        iceResponse = () => response.promise;
        const first = rallar.rtc.refreshIceConfig();
        const controller = new AbortController();
        const joined = rallar.rtc.refreshIceConfig({ signal: controller.signal });
        const cancelled = expect(joined).rejects.toMatchObject({ name: 'CommandCancelledError' });
        controller.abort();
        await cancelled;
        response.resolve(Response.json({ iceServers: [{ urls: 'stun:shared.test' }], expiresAtEpochMs: 30_000 }));
        await first;
        const next = await runtime.init(options);
        expect(next.middleware.middleware.webRtcConnectionService.input.iceCandidates.iceServers).toEqual([{ urls: 'stun:shared.test' }]);
        expect(requests.filter((request) => request.url.endsWith('/api/webrtc/ice'))).toHaveLength(1);
    });

    it('keeps a refresh when a joining initialization is cancelled', async () => {
        const response = Promise.withResolvers<Response>();
        iceResponse = () => response.promise;
        const refresh = rallar.rtc.refreshIceConfig();
        const controller = new AbortController();
        const initializing = runtime.init({ ...options, signal: controller.signal });
        const cancelled = expect(initializing).rejects.toMatchObject({ name: 'CommandCancelledError' });
        await new Promise<void>((resolve) => setImmediate(resolve));
        controller.abort();
        await cancelled;
        response.resolve(Response.json({ iceServers: [{ urls: 'stun:shared.test' }], expiresAtEpochMs: 30_000 }));
        await refresh;
        const next = await runtime.init(options);
        expect(next.middleware.middleware.webRtcConnectionService.input.iceCandidates.iceServers).toEqual([{ urls: 'stun:shared.test' }]);
        expect(requests.filter((request) => request.url.endsWith('/api/webrtc/ice'))).toHaveLength(1);
    });

    it('preserves a completed refresh when its caller aborts later', async () => {
        const controller = new AbortController();
        await rallar.rtc.refreshIceConfig({ signal: controller.signal });
        controller.abort();
        await runtime.init(options);
        expect(requests.filter((request) => request.url.endsWith('/api/webrtc/ice'))).toHaveLength(1);
    });

    it('uses the current token when initialization reaches ICE after token refresh', async () => {
        const entered = Promise.withResolvers<void>();
        const response = Promise.withResolvers<Response>();
        configResponse = () => {
            entered.resolve();
            return response.promise;
        };
        const initializing = runtime.init(options);
        await entered.promise;
        (await import('@shared/api/auth.ts')).writeSession({ ...session, accessToken: 'refreshed' });
        response.resolve(Response.json({ apiBaseUrl: 'https://first.test', wsBaseUrl: 'wss://first.test', endpoints: { createWs: '/ws' } }));
        await initializing;
        expect(requests.filter((request) => request.url.endsWith('/api/webrtc/ice'))).toEqual([
            { url: 'https://first.test/api/webrtc/ice', authorization: 'Bearer refreshed' }
        ]);
    });

    it.each(['http', 'malformed', 'abort', 'deadline'] as const)('invalidates old success on %s failure and permits later recovery', async (failure) => {
        await rallar.rtc.refreshIceConfig();
        const late = Promise.withResolvers<Response>();
        iceResponse = failure === 'http'
            ? async () => new Response('limited', { status: 429 })
            : failure === 'malformed'
            ? async () => Response.json({ iceServers: [] })
            : () => late.promise;
        const controller = new AbortController();
        const refresh = rallar.rtc.refreshIceConfig({ signal: controller.signal, ...(failure === 'deadline' ? { timeoutMs: 1 } : {}) });
        const rejected = expect(refresh).rejects.toBeInstanceOf(Error);
        if (failure === 'abort') {
            controller.abort();
        }
        await rejected;
        iceResponse = async () => Response.json({ iceServers: [{ urls: 'stun:recovered.test' }], expiresAtEpochMs: 30_000 });
        const next = await runtime.init(options);
        expect(next.middleware.middleware.webRtcConnectionService.input.iceCandidates.iceServers).toEqual([{ urls: 'stun:recovered.test' }]);
        late.resolve(Response.json({ iceServers: [{ urls: 'stun:late.test' }], expiresAtEpochMs: 40_000 }));
        await new Promise<void>((resolve) => setImmediate(resolve));
        runtime.shutdown();
        const reused = await runtime.init(options);
        expect(reused.middleware.middleware.webRtcConnectionService.input.iceCandidates.iceServers).toEqual([{ urls: 'stun:recovered.test' }]);
        expect(requests.filter((request) => request.url.endsWith('/api/webrtc/ice'))).toHaveLength(3);
    });

    it.each(['shutdown', 'auth-end', 'auth-replace', 'target-replace'] as const)('fences a late response after %s', async (replacement) => {
        const late = Promise.withResolvers<Response>();
        iceResponse = () => late.promise;
        const retired = rallar.rtc.refreshIceConfig();
        const rejected = expect(retired).rejects.toThrow('cancelled');
        const auth = await import('@shared/api/auth.ts');
        if (replacement === 'shutdown') {
            runtime.shutdown();
        }
        if (replacement === 'auth-end') {
            auth.clearSession();
        }
        if (replacement === 'auth-replace') {
            auth.writeSession({ ...session, sessionId: 'new-session' });
        }
        if (replacement === 'target-replace') {
            (await import('@shared-web/browser/api-client-config.ts')).configureApiClient({ apiBaseUrl: 'https://second.test' });
        }
        iceResponse = async () => Response.json({ iceServers: [{ urls: 'stun:current.test' }], expiresAtEpochMs: 30_000 });
        if (replacement !== 'auth-end') {
            await rallar.rtc.refreshIceConfig();
        }
        late.resolve(Response.json({ iceServers: [{ urls: 'stun:retired.test' }], expiresAtEpochMs: 40_000 }));
        await rejected;
        if (replacement === 'auth-end') {
            auth.writeSession(session);
            await rallar.rtc.refreshIceConfig();
        }
        const next = await runtime.init(options);
        expect(next.middleware.middleware.webRtcConnectionService.input.iceCandidates.iceServers).toEqual([{ urls: 'stun:current.test' }]);
        expect(requests.filter((request) => request.url.endsWith('/api/webrtc/ice'))).toHaveLength(2);
    });

    it('keeps a replacement refresh when an aborted initialization later fails', async () => {
        const entered = Promise.withResolvers<void>();
        const late = Promise.withResolvers<Response>();
        iceResponse = () => {
            entered.resolve();
            return late.promise;
        };
        const controller = new AbortController();
        const retired = runtime.init({ ...options, signal: controller.signal });
        const cancelled = expect(retired).rejects.toMatchObject({ name: 'CommandCancelledError' });
        await entered.promise;
        controller.abort();
        const currentResponse = Promise.withResolvers<Response>();
        iceResponse = () => currentResponse.promise;
        const current = rallar.rtc.refreshIceConfig();
        await cancelled;
        late.resolve(new Response('failed', { status: 500 }));
        await new Promise<void>((resolve) => setImmediate(resolve));
        const joined = rallar.rtc.refreshIceConfig();
        currentResponse.resolve(Response.json({ iceServers: [{ urls: 'stun:current.test' }], expiresAtEpochMs: 30_000 }));
        await Promise.all([current, joined]);
        expect(requests.filter((request) => request.url.endsWith('/api/webrtc/ice'))).toHaveLength(2);
        const next = await runtime.init(options);
        expect(next.middleware.middleware.webRtcConnectionService.input.iceCandidates.iceServers).toEqual([{ urls: 'stun:current.test' }]);
    });

    it('does not adopt an old response when the API target changes away and back', async () => {
        const late = Promise.withResolvers<Response>();
        iceResponse = () => late.promise;
        const retired = rallar.rtc.refreshIceConfig();
        const cancelled = expect(retired).rejects.toThrow('cancelled');
        const config = await import('@shared-web/browser/api-client-config.ts');
        iceResponse = async () => Response.json({ iceServers: [], expiresAtEpochMs: 30_000 });
        config.configureApiClient({ apiBaseUrl: 'https://second.test' });
        await rallar.rtc.refreshIceConfig();
        config.configureApiClient({ apiBaseUrl: 'https://first.test' });
        iceResponse = async () => Response.json({ iceServers: [{ urls: 'stun:current.test' }], expiresAtEpochMs: 30_000 });
        await rallar.rtc.refreshIceConfig();
        late.resolve(Response.json({ iceServers: [{ urls: 'stun:retired.test' }], expiresAtEpochMs: 40_000 }));
        await cancelled;
        const next = await runtime.init(options);
        expect(next.middleware.middleware.webRtcConnectionService.input.iceCandidates.iceServers).toEqual([{ urls: 'stun:current.test' }]);
        expect(requests.filter((request) => request.url.endsWith('/api/webrtc/ice'))).toHaveLength(3);
    });
});

async function readResponse(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    requests.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') });
    if (String(url).endsWith('/api/config')) {
        return configResponse();
    }
    if (String(url).endsWith('/api/webrtc/ice')) {
        return iceResponse();
    }
    throw new Error(`Unexpected HTTP request: ${url}`);
}
