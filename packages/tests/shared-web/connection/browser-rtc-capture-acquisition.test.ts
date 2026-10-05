import type { BrowserConnectedMiddleware } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { createBrowserRtcCapture } from '@shared-web/browser/rtc/create-browser-rtc-capture.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import { readAuthSessionContractMocks, resetAuthSessionContractMocks } from '../session/browser-auth-session-contract-fixture.ts';

const mocks = readAuthSessionContractMocks();
installFakeBroadcastChannelPerTest();
beforeEach(async () => {
    await resetAuthSessionContractMocks();
    mocks.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => ({
        middleware: mocks.ctx.middleware,
        checkpoints: [],
        rtcCaptureReceipt: createBrowserRtcCapture({
            configuration: options.rtcCaptureConfiguration,
            connectionId: { status: 'observed', value: 'constructed' },
            record: options.diagnosticsPorts.signalingDiagnostics,
            nowEpochMs: () => 1
        }).receipt
    }));
});

describe('implicit message acquisition of the owned capture connection', () => {
    it.each(['active', 'pending'] as const)('keeps %s run selection when a send has no new capture intent', async (phase) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const construct = mocks.initialiseMiddleware.getMockImplementation()!;
        mocks.initialiseMiddleware.mockImplementation(async (...args) => {
            const result = await construct(...args);
            entered.resolve();
            await release.promise;
            return result;
        });
        const first = facade.connect({ rtcCaptureContext: { run: 'native' } });
        await entered.promise;
        if (phase === 'active') {
            release.resolve();
            await first;
        }
        const send = facade.messages.ws.send({ typeId: 'test', topicId: 'app.capture', payload: { value: 1 } }).then(
            () => ({ sent: true }),
            (error: unknown) => ({ error })
        );
        release.resolve();
        try {
            await first;
            expect(await send).toEqual({ sent: true });
            expect(facade.rtcCapture()?.configuration).toEqual({ mode: 'native', origin: 'run' });
            expect(mocks.initialiseMiddleware).toHaveBeenCalledTimes(1);
        }
        finally {
            await facade.disconnect();
        }
    });

    it('does not reuse active middleware after auth storage is cleared', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        await facade.connect({ rtcCaptureContext: { run: 'native' } });
        mocks.readSession.mockReturnValue(undefined);
        await expect(facade.messages.ws.send({ typeId: 'test', topicId: 'app.capture', payload: {} })).rejects.toThrow('no auth session');
        expect(facade.rtcCapture()).toBeUndefined();
        await facade.disconnect();
    });

    it('keeps the pending construction cancellation as the send failure', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const entered = Promise.withResolvers<void>();
        const pending = Promise.withResolvers<BrowserConnectedMiddleware>();
        mocks.initialiseMiddleware.mockImplementation(async () => {
            entered.resolve();
            return pending.promise;
        });
        const first = facade.connect({ rtcCaptureContext: { run: 'native' } }).catch((error: unknown) => error);
        await entered.promise;
        const send = facade.messages.ws.send({ typeId: 'test', topicId: 'app.capture', payload: {} }).catch((error: unknown) => error);
        const failure = new Error('construction cancelled');
        pending.reject(failure);
        expect(await first).toBe(failure);
        expect(await send).toBe(failure);
        expect(facade.rtcCapture()).toBeUndefined();
        await facade.disconnect();
    });
    it('reconciles replaced authentication before acquiring a new connection', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        await facade.connect({ rtcCaptureContext: { run: 'native' } });
        mocks.readSession.mockReturnValue({ ...mocks.ctx.session, sessionId: 'replacement' });
        try {
            await facade.messages.ws.send({ typeId: 'test', topicId: 'app.capture', payload: {} });
            expect(facade.session()?.sessionId).toBe('replacement');
            expect(facade.rtcCapture()?.configuration).toEqual({ mode: 'off', origin: 'product-default' });
            expect(mocks.initialiseMiddleware).toHaveBeenCalledTimes(2);
        }
        finally {
            await facade.disconnect();
        }
    });
});
