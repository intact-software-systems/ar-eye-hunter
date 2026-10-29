import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { BrowserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import * as heartbeat from '@shared-web/browser/session/browser-session-heartbeat.ts';
import * as stateSnapshots from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
import type { ApiConfigResponse } from '@shared/api/api-config.ts';
import { clearSession, writeSession } from '@shared/api/auth.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import '../../setup-browser-indexeddb.ts';

const apiConfiguration: ApiConfigResponse = {
    apiBaseUrl: 'https://first.test',
    wsBaseUrl: 'wss://first.test',
    endpoints: { createWs: '/ws' },
    serverPeerId: 'ice-fixture-server'
};
const session = { clientId: 'ice-client', sessionId: 'ice-session', username: 'test', accessToken: 'initial', expiresAtEpochMs: 1_000_000 };
const options = {
    rtcCaptureConfiguration: { mode: 'off', origin: 'product-default' } as const,
    qosProvider: undefined,
    readVolatileSessionLimits: undefined,
    readPublicationStageLimits: undefined,
    deliverySettlements: { ws: () => {}, rtc: () => {}, holds: () => false },
    diagnosticsPorts: toRallarDiagnosticsPorts(undefined),
    onResyncRequired: () => {},
    scope: { applicationId: 'ice-cache', workspaceId: 'test' }
};
let runtime: BrowserTransportRuntime;
let iceResponse: () => Promise<Response>;
let configResponse: (apiUrl: URL) => Promise<Response>;
const requests: Array<{ readonly url: string; readonly authorization: string | null; }> = [];

beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key)
    });
    writeSession(session);
    configureApiClient({ apiBaseUrl: 'https://first.test' });
    runtime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
    requests.length = 0;
    iceResponse = async () => Response.json({ iceServers: [], expiresAtEpochMs: 20_000 });
    configResponse = async (apiUrl) =>
        Response.json({
            ...apiConfiguration,
            apiBaseUrl: apiUrl.origin,
            wsBaseUrl: `wss://${apiUrl.host}`
        });
    vi.stubGlobal('fetch', readResponse);
    vi.spyOn(JsonWebSocketClient.prototype, 'connect').mockResolvedValue();
    vi.spyOn(stateSnapshots, 'refreshStateSnapshots').mockResolvedValue({ clients: [], groups: [] });
    vi.spyOn(heartbeat, 'initHeartbeat').mockResolvedValue({ sessionId: session.sessionId, generationId: 'heartbeat', stop: () => {} });
});

afterEach(async () => {
    const middleware = runtime.readMiddleware()?.middleware;
    runtime.shutdown();
    await middleware?.qboxEngine.stop();
    configureApiClient({ apiBaseUrl: '' });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('browser ICE configuration reuse', () => {
    it('reuses successful local ICE across reconnect and token refresh while rebuilding transport and capture identity', async () => {
        const first = await runtime.init(options);
        runtime.shutdown();
        writeSession({ ...session, accessToken: 'refreshed', expiresAtEpochMs: 2_000_000 });
        const second = await runtime.init(options);

        expect(second.middleware.middleware.webRtcConnectionService.input.iceCandidates).toEqual({ iceServers: [], expiresAtEpochMs: 20_000 });
        expect(second.middleware.middleware.webRtcConnectionService).not.toBe(first.middleware.middleware.webRtcConnectionService);
        expect(second.middleware.middleware.webSocketQueueBox).not.toBe(first.middleware.middleware.webSocketQueueBox);
        expect(second.rtcCapture).not.toEqual(first.rtcCapture);
        expect(requests.filter((request) => request.url.endsWith('/api/webrtc/ice'))).toEqual([
            { url: 'https://first.test/api/webrtc/ice', authorization: 'Bearer initial' }
        ]);
        expect(requests.filter((request) => request.url.endsWith('/api/config'))).toHaveLength(2);
    });

    it('refreshes exactly at server expiry without using authentication expiry as a TTL', async () => {
        await runtime.init(options);
        runtime.shutdown();
        vi.mocked(Date.now).mockReturnValue(19_999);
        await runtime.init(options);
        runtime.shutdown();
        vi.mocked(Date.now).mockReturnValue(20_000);
        iceResponse = async () => Response.json({ iceServers: [{ urls: 'stun:next.test' }], expiresAtEpochMs: 30_000 });
        const current = await runtime.init(options);

        expect(current.middleware.middleware.webRtcConnectionService.input.iceCandidates.iceServers).toEqual([{ urls: 'stun:next.test' }]);
        expect(requests.filter((request) => request.url.endsWith('/api/webrtc/ice'))).toHaveLength(2);
    });

    it('separates API targets and does not resurrect an older target value', async () => {
        await runtime.init(options);
        runtime.shutdown();
        configureApiClient({ apiBaseUrl: 'https://second.test/' });
        await runtime.init(options);
        runtime.shutdown();
        configureApiClient({ apiBaseUrl: 'https://first.test' });
        await runtime.init(options);

        expect(requests.filter((request) => request.url.endsWith('/api/webrtc/ice')).map((request) => request.url)).toEqual([
            'https://first.test/api/webrtc/ice',
            'https://second.test/api/webrtc/ice',
            'https://first.test/api/webrtc/ice'
        ]);
    });

    it.each([
        null,
        {},
        { iceServers: [] },
        { iceServers: [], expiresAtEpochMs: null },
        { iceServers: [], expiresAtEpochMs: '20000' },
        { iceServers: [], expiresAtEpochMs: 10_000 },
        { iceServers: [], expiresAtEpochMs: 9_999 },
        { iceServers: 'bad', expiresAtEpochMs: 20_000 },
        { iceServers: [null], expiresAtEpochMs: 20_000 },
        { iceServers: [{}], expiresAtEpochMs: 20_000 },
        { iceServers: [{ urls: [42] }], expiresAtEpochMs: 20_000 },
        { iceServers: [{ urls: 'turn:test', username: 42 }], expiresAtEpochMs: 20_000 },
        { iceServers: [{ urls: 'turn:test', credential: {} }], expiresAtEpochMs: 20_000 }
    ])('rejects invalid fresh ICE %j and recovers on the next initialization', async (invalid) => {
        iceResponse = async () => Response.json(invalid);
        expect(await runtime.init(options).then(() => 'connected', () => 'rejected')).toBe('rejected');
        expect(runtime.isReady()).toBe(false);
        iceResponse = async () => Response.json({ iceServers: [], expiresAtEpochMs: 20_000 });
        await expect(runtime.init(options)).resolves.toBeDefined();
        expect(requests.filter((request) => request.url.endsWith('/api/webrtc/ice'))).toHaveLength(2);
    });

    it('does not retry a failed HTTP acquisition and allows the next initialization to recover', async () => {
        iceResponse = async () => new Response('limited', { status: 429 });
        await expect(runtime.init(options)).rejects.toMatchObject({ status: 429 });
        expect(requests.filter((request) => request.url.endsWith('/api/webrtc/ice'))).toHaveLength(1);
        iceResponse = async () => Response.json({ iceServers: [], expiresAtEpochMs: 20_000 });
        await expect(runtime.init(options)).resolves.toBeDefined();
    });

    it('coalesces active initialization and detaches a shutdown acquisition before a late response', async () => {
        const entered = Promise.withResolvers<void>();
        const pending = Promise.withResolvers<Response>();
        iceResponse = () => {
            entered.resolve();
            return pending.promise;
        };
        const first = runtime.init(options);
        const cancelled = expect(first).rejects.toThrow('cancelled');
        await entered.promise;
        expect(runtime.init(options)).toBe(first);
        runtime.shutdown();
        iceResponse = async () => Response.json({ iceServers: [{ urls: 'stun:current.test' }], expiresAtEpochMs: 30_000 });
        const current = await runtime.init(options);
        pending.resolve(Response.json({ iceServers: [{ urls: 'stun:retired.test' }], expiresAtEpochMs: 40_000 }));
        await cancelled;
        expect(runtime.readConnection()).toBe(current);
        runtime.shutdown();
        const next = await runtime.init(options);
        expect(next.middleware.middleware.webRtcConnectionService.input.iceCandidates.iceServers).toEqual([{ urls: 'stun:current.test' }]);
        expect(requests.filter((request) => request.url.endsWith('/api/webrtc/ice'))).toHaveLength(2);
    });

    it('recovers after cancellation even if the cancelled HTTP request ignores abort', async () => {
        const entered = Promise.withResolvers<void>();
        const pending = Promise.withResolvers<Response>();
        iceResponse = () => {
            entered.resolve();
            return pending.promise;
        };
        const controller = new AbortController();
        const first = runtime.init({ ...options, signal: controller.signal });
        const cancelled = expect(first).rejects.toThrow('aborted');
        await entered.promise;
        controller.abort();
        await cancelled;
        iceResponse = async () => Response.json({ iceServers: [], expiresAtEpochMs: 20_000 });
        await expect(runtime.init(options)).resolves.toBeDefined();
        pending.resolve(Response.json({ iceServers: [], expiresAtEpochMs: 40_000 }));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(requests.filter((request) => request.url.endsWith('/api/webrtc/ice'))).toHaveLength(2);
    });

    it('rejects auth-ended initialization even when a completed ICE configuration is reusable', async () => {
        await runtime.init(options);
        runtime.shutdown();
        clearSession();
        await expect(runtime.init(options)).rejects.toThrow('no auth session');
        expect(runtime.isReady()).toBe(false);
        expect(requests.filter((request) => request.url.endsWith('/api/webrtc/ice'))).toHaveLength(1);
    });

    it('pins an acquisition to its initial API target while WS startup is pending', async () => {
        const entered = Promise.withResolvers<void>();
        const pending = Promise.withResolvers<Response>();
        configResponse = () => {
            entered.resolve();
            return pending.promise;
        };
        const first = runtime.init(options);
        await entered.promise;
        configureApiClient({ apiBaseUrl: 'https://second.test' });
        pending.resolve(Response.json(apiConfiguration));
        await first;
        expect(requests.filter((request) => request.url.endsWith('/api/webrtc/ice')).map((request) => request.url)).toEqual([
            'https://first.test/api/webrtc/ice'
        ]);
    });

    it('rejects non-finite server expiry decoded from JSON', async () => {
        iceResponse = async () => new Response('{"iceServers":[],"expiresAtEpochMs":1e400}');
        expect(await runtime.init(options).then(() => 'connected', () => 'rejected')).toBe('rejected');
    });

    it('does not retain a response that arrives after auth ended', async () => {
        const entered = Promise.withResolvers<void>();
        const pending = Promise.withResolvers<Response>();
        iceResponse = () => {
            entered.resolve();
            return pending.promise;
        };
        const first = runtime.init(options);
        const cancelled = expect(first).rejects.toThrow('auth ended');
        await entered.promise;
        clearSession();
        pending.resolve(Response.json({ iceServers: [], expiresAtEpochMs: 40_000 }));
        await cancelled;
        writeSession(session);
        iceResponse = async () => Response.json({ iceServers: [], expiresAtEpochMs: 20_000 });
        const current = await runtime.init(options);
        expect(current.middleware.middleware.webRtcConnectionService.input.iceCandidates.expiresAtEpochMs).toBe(20_000);
        expect(requests.filter((request) => request.url.endsWith('/api/webrtc/ice'))).toHaveLength(2);
    });
});

async function readResponse(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    requests.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') });
    if (String(url).endsWith('/api/config')) {
        return configResponse(new URL(String(url)));
    }
    if (String(url).endsWith('/api/webrtc/ice')) {
        return iceResponse();
    }
    throw new Error(`Unexpected HTTP request: ${url}`);
}
