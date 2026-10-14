import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
    BrowserTransportRuntime,
    type BrowserTransportInitOptions
} from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { BrowserConnectedMiddleware } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import type { ALCheckpointPort } from '@shared/alm/checkpoint/al-checkpoint.ts';
import type { ALBrowserLocks } from '@shared/alm/storage/al-browser-locks.ts';

import { installFakePageLifecyclePerTest } from '../al-runtime/fake-page-lifecycle.ts';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

const rtcCaptureReceipt = await vi.hoisted(async () => (await import('../rtc/browser-rtc-capture-fixture.ts')).createBrowserRtcCaptureReceiptFixture());

type MiddlewareModule = typeof import('@shared-web/browser/connection/initialise-browser-middleware.ts');
type AuthModule = typeof import('@shared/api/auth.ts');

const mocks = vi.hoisted(() => ({
    initialiseMiddleware: vi.fn<MiddlewareModule['initialiseMiddleware']>(),
    readSession: vi.fn<AuthModule['readSession']>()
}));

vi.mock(
    import('@shared-web/browser/connection/initialise-browser-middleware.ts'),
    async (importOriginal): Promise<Partial<MiddlewareModule>> => ({
        ...await importOriginal(),
        initialiseMiddleware: mocks.initialiseMiddleware
    })
);

vi.mock(import('@shared/api/auth.ts'), (): Partial<AuthModule> => ({
    readSession: mocks.readSession
}));

const readPage = installFakePageLifecyclePerTest();

describe('the page lifecycle of a connected browser transport', () => {
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
        transportUp.resolve({ middleware: middleware.middleware, rtcCaptureReceipt, checkpoints: [recordFlushes('flush', flushes)] });
        await expect(pending).rejects.toThrow('Rallar connection was cancelled because auth ended.');
        readPage().hide();

        expect(flushes).toEqual([]);
    });
});

interface ConnectedTransport {
    readonly transport: BrowserTransportRuntime;
    /** One entry per flush the connect asked of each carrier's checkpoint, named by the carrier. */
    readonly flushes: readonly string[];
}

/** Without a Locks API the connect owns its session's work at once. */
async function connectTransport(locks: ALBrowserLocks | undefined = undefined): Promise<ConnectedTransport> {
    vi.stubGlobal('navigator', { locks });
    const middleware = createDefaultApiMiddlewareTestDouble();
    const flushes: string[] = [];
    mocks.readSession.mockReturnValue(middleware.session);
    mocks.initialiseMiddleware.mockResolvedValue({
        middleware: middleware.middleware,
        rtcCaptureReceipt,
        checkpoints: [recordFlushes('ws', flushes), recordFlushes('rtc', flushes)]
    });
    const transport = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
    onTestFinished(() => transport.shutdown());
    await transport.init(toInitOptions());
    return { transport, flushes };
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
        qosProvider: undefined,
        readVolatileSessionLimits: undefined,
        deliverySettlements: { ws: () => {}, rtc: () => {}, holds: () => false },
        diagnosticsPorts: toRallarDiagnosticsPorts(undefined),
        onResyncRequired: () => {}
    };
}
