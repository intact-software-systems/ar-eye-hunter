import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createDefaultBrowserSessionQosInputs } from '@shared-web/browser/composition/browser-session-composition.ts';
import type { BrowserServerClockSession } from '@shared-web/browser/connection/browser-server-clock-session.ts';
import {
    BrowserTransportRuntime,
    type BrowserTransportInitOptions
} from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { BrowserConnectedMiddleware } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { startDefaultBrowserServerClockSession } from '@shared-web/browser/connection/start-default-browser-server-clock-session.ts';
import type { ALCheckpointPort } from '@shared/alm/checkpoint/al-checkpoint.ts';
import type { ALBrowserLocks } from '@shared/alm/storage/al-browser-locks.ts';

import { NO_RTC_GRANTED_TOPICS } from '../../shared/multicast/rtc-granted-topic-reader-fixtures.ts';
import { KEYLESS_PUBLICATION_VERIFIER } from '../../shared/multicast/rtc-publication-proof-verifier-fixtures.ts';
import { NO_RTC_TOPIC_SUBSCRIPTIONS } from '../../shared/multicast/rtc-topic-subscription-reader-fixtures.ts';
import { UNAVAILABLE_PUBLICATION_CRYPTO } from '../../shared/signature/publication-crypto-fixtures.ts';
import { installFakePageLifecyclePerTest } from '../al-runtime/fake-page-lifecycle.ts';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';
import { createDefaultBrowserServerClockFixture } from './browser-server-clock-fixture.ts';

const rtcCaptureReceipt = await vi.hoisted(async () => (await import('../rtc/browser-rtc-capture-fixture.ts')).createBrowserRtcCaptureReceiptFixture());

type MiddlewareModule = typeof import('@shared-web/browser/connection/initialise-browser-middleware.ts');
type AuthModule = typeof import('@shared/api/auth.ts');

const mocks = vi.hoisted(() => ({
    initialiseMiddleware: vi.fn<MiddlewareModule['initialiseMiddleware']>(),
    readSession: vi.fn<AuthModule['readSession']>()
}));

const { createInitialiseMiddlewareDouble } = await vi.hoisted(async () => await import('./create-initialise-middleware-double.ts'));
vi.mock(
    import('@shared-web/browser/connection/initialise-browser-middleware.ts'),
    async (importOriginal): Promise<Partial<MiddlewareModule>> => ({
        ...await importOriginal(),
        initialiseMiddleware: createInitialiseMiddlewareDouble(mocks.initialiseMiddleware)
    })
);

vi.mock(import('@shared/api/auth.ts'), (): Partial<AuthModule> => ({
    readSession: mocks.readSession
}));

const readPage = installFakePageLifecyclePerTest();

describe('the page lifecycle of a connected browser transport', () => {
    it.each([false, true])('rejects setup cancelled by a synchronous channel callback (replacement: %s)', async (replace) => {
        vi.stubGlobal('navigator', {});
        const middleware = createDefaultApiMiddlewareTestDouble();
        mocks.readSession.mockReturnValue(middleware.session);
        mocks.initialiseMiddleware.mockImplementation(async () => ({
            middleware: middleware.middleware,
            rtcCaptureReceipt,
            checkpoints: [],
            serverClock: createDefaultBrowserServerClockFixture()
        }));
        const openPort = vi.fn<BrowserTransportRuntime.Input['openSessionChannelPort']>();
        const transport = new BrowserTransportRuntime({ openSessionChannelPort: openPort });
        let replacement: Promise<BrowserTransportRuntime.Connection> | undefined;
        let channelClosed = false;
        openPort.mockReturnValue(undefined).mockImplementationOnce(() => {
            transport.shutdown();
            if (replace) {
                replacement = transport.init(toInitOptions());
            }
            return {
                onmessage: null,
                postMessage: () => {},
                close: () => {
                    channelClosed = true;
                }
            };
        });
        onTestFinished(() => transport.shutdown());

        await expect(Promise.resolve().then(() => transport.init(toInitOptions()))).rejects.toThrow('cancelled');

        expect(channelClosed).toBe(true);
        if (replacement) {
            const current = await replacement;
            expect(transport.readConnection()).toBe(current);
            transport.shutdown();
            expect(current.serverClock.signal.aborted).toBe(true);
        }
        else {
            expect(transport.isReady()).toBe(false);
        }
    });

    it('cancels a pending clock request when the transport shuts down', async () => {
        const entered = Promise.withResolvers<AbortSignal>();
        const response = Promise.withResolvers<Response>();
        vi.stubGlobal('fetch', (_url: RequestInfo | URL, init?: RequestInit) => {
            if (!init?.signal) {
                throw new Error('Clock request must be cancellable');
            }
            entered.resolve(init.signal);
            return response.promise;
        });
        const middleware = createDefaultApiMiddlewareTestDouble();
        mocks.readSession.mockReturnValue(middleware.session);
        mocks.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => ({
            middleware: middleware.middleware,
            rtcCaptureReceipt,
            checkpoints: [],
            serverClock: await startDefaultBrowserServerClockSession({
                baseUrl: 'https://test',
                serverPeerId: 'server',
                signal: options.signal
            })
        }));
        const transport = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
        const outcome = transport.init(toInitOptions()).catch((error: unknown) => error);
        const requestSignal = await entered.promise;
        onTestFinished(async () => {
            response.resolve(Response.json({ serverPeerId: 'server', serverNowEpochMs: Date.now() }));
            await outcome;
            transport.shutdown();
        });

        transport.shutdown();

        expect(requestSignal.aborted).toBe(true);
        expect(await outcome).toBeInstanceOf(Error);
        expect(transport.isReady()).toBe(false);
    });

    it.each(['hide', 'freeze', 'pagehide'] as const)('flushes owned checkpoints before calibration closes the connection on %s', async (event) => {
        vi.stubGlobal('navigator', {});
        vi.stubGlobal('fetch', async () => Response.json({ serverPeerId: 'server', serverNowEpochMs: Date.now() }));
        const serverClock = await startDefaultBrowserServerClockSession({
            baseUrl: 'https://test',
            serverPeerId: 'server',
            signal: undefined
        });
        const middleware = createDefaultApiMiddlewareTestDouble();
        const flushes: string[] = [];
        mocks.readSession.mockReturnValue(middleware.session);
        mocks.initialiseMiddleware.mockResolvedValue({
            middleware: middleware.middleware,
            rtcCaptureReceipt,
            serverClock,
            checkpoints: [recordFlushes('ws', flushes), recordFlushes('rtc', flushes)]
        });
        const transport = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
        onTestFinished(async () => {
            transport.shutdown();
            await serverClock.close();
        });
        await transport.init(toInitOptions());

        readPage()[event]();

        expect(serverClock.signal.aborted).toBe(true);
        expect(transport.isReady()).toBe(false);
        expect(flushes).toEqual(['ws', 'rtc']);
    });

    it('ends the active transport when its calibrated clock lifetime ends', async () => {
        const connected = await connectTransport();
        expect(connected.transport.isReady()).toBe(true);
        await connected.serverClock.close(new Error('Clock expired'));
        expect(connected.transport.isReady()).toBe(false);
        expect(connected.transport.readConnection()).toBeUndefined();
    });

    it('closes calibration when the active transport shuts down', async () => {
        const connected = await connectTransport();
        connected.transport.shutdown();
        expect(connected.serverClock.signal.aborted).toBe(true);
    });

    it('refuses a middleware result whose clock already ended', async () => {
        const middleware = createDefaultApiMiddlewareTestDouble();
        const serverClock = createDefaultBrowserServerClockFixture();
        await serverClock.close();
        mocks.readSession.mockReturnValue(middleware.session);
        mocks.initialiseMiddleware.mockResolvedValue({
            middleware: middleware.middleware,
            rtcCaptureReceipt,
            checkpoints: [],
            serverClock
        });
        const transport = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
        onTestFinished(() => transport.shutdown());
        await expect(transport.init(toInitOptions())).rejects.toThrow('server clock calibration ended');
        expect(transport.isReady()).toBe(false);
    });

    it('flushes the connect\'s checkpoints when its page hides, is hidden away or freezes', async () => {
        const middleware = await connectTransport();

        readPage().hide();
        readPage().pagehide();
        readPage().freeze();

        expect(middleware.flushes).toEqual(['ws', 'rtc', 'ws', 'rtc', 'ws', 'rtc']);
    });

    it('stops flushing once the connect ends', async () => {
        const middleware = await connectTransport();

        middleware.transport.shutdown();
        readPage().hide();
        readPage().pagehide();
        readPage().freeze();

        expect(middleware.flushes).toEqual([]);
    });

    // Another tab holds the session's owner lock for the whole test.
    it('flushes nothing for a connect that waits for the session\'s work', async () => {
        const middleware = await connectTransport({ request: async () => await new Promise<never>(() => {}) });

        readPage().hide();
        readPage().pagehide();
        readPage().freeze();

        expect(middleware.flushes).toEqual([]);
    });

    it('registers nothing for a connect the disconnect cancelled before its transport was up', async () => {
        vi.stubGlobal('navigator', {});
        const middleware = createDefaultApiMiddlewareTestDouble();
        const flushes: string[] = [];
        const transportUp = Promise.withResolvers<BrowserConnectedMiddleware>();
        mocks.readSession.mockReturnValue(middleware.session);
        mocks.initialiseMiddleware.mockReturnValue(transportUp.promise);
        const transport = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });

        const pending = transport.init(toInitOptions());
        transport.shutdown();
        transportUp.resolve({
            middleware: middleware.middleware,
            rtcCaptureReceipt,
            serverClock: createDefaultBrowserServerClockFixture(),
            checkpoints: [recordFlushes('flush', flushes)]
        });
        await expect(pending).rejects.toThrow('Rallar connection was cancelled because auth ended.');
        readPage().hide();

        expect(flushes).toEqual([]);
    });
});

interface ConnectedTransport {
    readonly transport: BrowserTransportRuntime;
    readonly serverClock: BrowserServerClockSession.Port;
    /** One entry per flush the connect asked of each carrier's checkpoint, named by the carrier. */
    readonly flushes: readonly string[];
}

/** Without a Locks API the connect owns its session's work at once. */
async function connectTransport(locks: ALBrowserLocks | undefined = undefined): Promise<ConnectedTransport> {
    vi.stubGlobal('navigator', { locks });
    const middleware = createDefaultApiMiddlewareTestDouble();
    const serverClock = createDefaultBrowserServerClockFixture();
    const flushes: string[] = [];
    mocks.readSession.mockReturnValue(middleware.session);
    mocks.initialiseMiddleware.mockResolvedValue({
        middleware: middleware.middleware,
        rtcCaptureReceipt,
        serverClock,
        checkpoints: [recordFlushes('ws', flushes), recordFlushes('rtc', flushes)]
    });
    const transport = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
    onTestFinished(() => transport.shutdown());
    await transport.init(toInitOptions());
    return { transport, flushes, serverClock };
}

/** A carrier's checkpoint that logs each flush under the carrier's name and does nothing else. */
function recordFlushes(carrier: string, flushes: string[]): ALCheckpointPort {
    return {
        restore: async () => undefined,
        flush: () => {
            flushes.push(carrier);
        },
        dispose: () => undefined,
        isOwned: () => true,
        onTakenOverDo: () => ({ unsubscribe: () => undefined }),
        reportFirstBatch: () => undefined
    };
}

function toInitOptions(): BrowserTransportInitOptions {
    return {
        rtcCaptureConfiguration: { mode: 'off', origin: 'product-default' },
        ...createDefaultBrowserSessionQosInputs(),
        deliverySettlements: { ws: () => {}, rtc: () => {}, holds: () => false },
        diagnosticsPorts: toRallarDiagnosticsPorts(undefined),
        onResyncRequired: () => {},
        publicationCrypto: Promise.resolve(UNAVAILABLE_PUBLICATION_CRYPTO),
        publicationVerifier: KEYLESS_PUBLICATION_VERIFIER,
        grantedTopics: NO_RTC_GRANTED_TOPICS,
        topicSubscriptions: NO_RTC_TOPIC_SUBSCRIPTIONS
    };
}
