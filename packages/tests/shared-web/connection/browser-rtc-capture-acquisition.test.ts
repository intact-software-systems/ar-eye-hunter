import type { BrowserConnectedMiddleware } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { RallarRtcCaptureConnectionRequiredError } from '@shared-web/browser/connection/rallar-rtc-capture-connection-required-error.ts';
import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import { createBrowserRtcCapture } from '@shared-web/browser/rtc/create-browser-rtc-capture.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { RtcNativeObservationScope } from '@shared/webrtc/rtc-native-observation-scope.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import { readAuthSessionContractMocks, resetAuthSessionContractMocks } from '../session/browser-auth-session-contract-fixture.ts';

const mocks = readAuthSessionContractMocks();
installFakeBroadcastChannelPerTest();
beforeEach(async () => {
    await resetAuthSessionContractMocks();
    let construction = 0;
    mocks.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => ({
        middleware: mocks.ctx.middleware,
        checkpoints: [],
        rtcCaptureReceipt: createBrowserRtcCapture({
            configuration: options.rtcCaptureConfiguration,
            connectionId: { status: 'observed', value: `constructed-${++construction}` },
            record: options.diagnosticsPorts.signalingDiagnostics,
            nowEpochMs: () => 1
        }).receipt
    }));
});

describe('implicit message acquisition of the owned capture connection', () => {
    it.each(
        [
            ['missing', 'replaced', 'ws'],
            ['unavailable', 'replaced', 'ws'],
            ['missing', 'current', 'ws'],
            ['unavailable', 'current', 'ws'],
            ['missing', 'ordinary-replaced', 'ws'],
            ['unavailable', 'ordinary-replaced', 'ws'],
            ['missing', 'replaced', 'rtc'],
            ['unavailable', 'replaced', 'rtc'],
            ['missing', 'current', 'rtc'],
            ['unavailable', 'current', 'rtc'],
            ['missing', 'ordinary-replaced', 'rtc'],
            ['unavailable', 'ordinary-replaced', 'rtc']
        ] as const
    )('fences capture after %s storage with %s authentication on %s', async (storageResult, ownership, carrier) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        await facade.connect({ rtcCaptureMode: 'off' });
        const receipt = facade.rtcCapture();
        const storage = mocks.ctx.middleware.storageAvailability;
        storage.availability.accept(
            storageResult === 'missing'
                ? { kind: 'unavailable', reason: { cause: 'missing', detail: 'No IndexedDB.' } }
                : { kind: 'available' }
        );
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const admitted: { sender: string; currentSession: string | undefined; durability: string | undefined; }[] = [];
        const replaceAuthentication = (): void => {
            if (ownership !== 'current') {
                mocks.readSession.mockReturnValue({ ...mocks.ctx.session, sessionId: 'replacement' });
            }
        };
        const readSkip = storage.getDurableLaneSkip.bind(storage);
        const skip = vi.spyOn(storage, 'getDurableLaneSkip').mockImplementationOnce(() => {
            const result = readSkip();
            if (storageResult === 'missing') {
                queueMicrotask(replaceAuthentication);
            }
            return result;
        });
        const outbox = carrier === 'ws' ? mocks.webSocketQueueBox.enqueueOutboxIfAbsent : mocks.rtcRxStreamer.enqueueOutboxIfAbsent;
        outbox.mockImplementation(async (message) => {
            if (message.qos?.durability?.algo === 'local-outbox') {
                entered.resolve();
                await release.promise;
                return {
                    verdict: { kind: 'storage-unavailable', cause: 'quota', detail: 'QuotaExceededError' },
                    message,
                    entries: [],
                    trackedReceiptAlgo: 'none'
                };
            }
            admitted.push({
                sender: message.id.senderId,
                currentSession: mocks.readSession()?.sessionId,
                durability: message.qos?.durability?.algo
            });
            return { verdict: { kind: 'admitted', durable: false, queuedAttempts: 1 }, message, entries: [], trackedReceiptAlgo: 'none' };
        });
        const channel = facade.messages.channel({
            typeId: 'test',
            topicId: 'app.capture',
            purpose: 'command',
            durability: 'local-outbox',
            onStorageUnavailable: 'volatile'
        });
        try {
            const send = channel.send({}, {
                strategy: carrier,
                rtcCaptureMode: ownership === 'ordinary-replaced' ? undefined : 'off',
                roomRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
                scope: 'all',
                ack: 'none'
            });
            if (storageResult === 'unavailable') {
                await entered.promise;
                replaceAuthentication();
                release.resolve();
            }
            const handle = await send;
            const outcome = await handle.wait({ until: ['queued'] });
            expect.soft(admitted).toEqual(
                ownership === 'replaced'
                    ? []
                    : [{
                        sender: mocks.ctx.session.sessionId,
                        currentSession: ownership === 'current' ? mocks.ctx.session.sessionId : 'replacement',
                        durability: 'volatile'
                    }]
            );
            expect.soft(handle.lifecycle().state).toBe(ownership === 'replaced' ? 'failed' : 'queued');
            if (ownership === 'replaced') {
                expect.soft(outcome).toMatchObject({
                    status: 'settled',
                    lifecycle: { state: 'failed', evidence: { failure: { kind: 'admission-failed' }, reason: 'session-not-current' } }
                });
            }
            expect(handle.rtcCapture()).toEqual({ status: 'observed', value: receipt });
            expect(handle.rtcCapture()).toMatchObject({
                value: { application: { status: 'applied', mode: 'off' }, connectionId: { status: 'observed', value: 'constructed-1' } }
            });
        }
        finally {
            release.resolve();
            skip.mockRestore();
            storage.availability.accept({ kind: 'available' });
            await facade.disconnect();
        }
    });

    it.each(['disposed', 'replaced'] as const)('never downgrades onto a %s graph after storage settles', async (graph) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        await facade.connect({ rtcCaptureMode: 'off' });
        const originalReceipt = facade.rtcCapture();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const volatileAdmissions: ALMessage[] = [];
        mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementation(async (message) => {
            if (message.qos?.durability?.algo === 'local-outbox') {
                entered.resolve();
                await release.promise;
                return {
                    verdict: { kind: 'storage-unavailable', cause: 'quota', detail: 'QuotaExceededError' },
                    message,
                    entries: [],
                    trackedReceiptAlgo: 'none'
                };
            }
            volatileAdmissions.push(message);
            return { verdict: { kind: 'admitted', durable: false, queuedAttempts: 1 }, message, entries: [], trackedReceiptAlgo: 'none' };
        });
        const channel = facade.messages.channel({
            typeId: 'test',
            topicId: 'app.capture',
            purpose: 'command',
            durability: 'local-outbox',
            onStorageUnavailable: 'volatile'
        });
        try {
            const send = channel.sendWs({}, { rtcCaptureMode: 'off', scope: 'all', ack: 'none' });
            await entered.promise;
            const handle = await send;
            await facade.disconnect();
            if (graph === 'replaced') {
                await facade.connect({ rtcCaptureMode: 'off' });
                expect(facade.rtcCapture()?.connectionId).toEqual({ status: 'observed', value: 'constructed-2' });
            }
            release.resolve();
            // Drain the released storage continuation through the event loop, including a closed epoch that emits no settlement.
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            expect.soft(volatileAdmissions).toEqual([]);
            expect(await handle.wait({ signal: AbortSignal.abort() })).toMatchObject({ status: 'aborted', lifecycle: { state: 'submitted' } });
            expect(handle.rtcCapture()).toEqual({ status: 'observed', value: originalReceipt });
            expect(handle.rtcCapture()).toMatchObject({ value: { connectionId: { status: 'observed', value: 'constructed-1' } } });
        }
        finally {
            release.resolve();
            await facade.disconnect();
        }
    });

    it.each([
        { rtcCaptureMode: '' },
        { rtcCaptureMode: null },
        { rtcCaptureMode: true },
        { rtcCaptureMode: 'all' },
        { rtcCaptureContext: null },
        { rtcCaptureContext: { run: false } },
        { rtcCaptureContext: { recipe: 'all' } },
        { rtcCaptureContext: { run: 'off', unrecognized: 'native' } }
    ])('rejects invalid capture $rtcCaptureMode $rtcCaptureContext before constructing or queuing', async (capture) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const input = JSON.parse(JSON.stringify({ typeId: 'test', topicId: 'app.capture', payload: {}, ...capture }));
        try {
            await expect(facade.messages.ws.send(input)).rejects.toBeInstanceOf(Error);
            expect(mocks.initialiseMiddleware.mock.calls).toEqual([]);
            expect(mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls).toEqual([]);
        }
        finally {
            await facade.disconnect();
        }
    });

    it.each(['ws', 'rtc', 'ws-then-rtc', 'rtc-with-ws-fallback'] as const)('preserves explicit capture through typed %s acquisition', async (strategy) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        await facade.connect({ rtcCaptureMode: 'native' });
        const channel = facade.messages.channel({ typeId: 'test', topicId: 'app.capture', purpose: 'command' });
        try {
            await expect(channel.send({}, {
                strategy,
                roomRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
                rtcCaptureMode: 'off'
            })).rejects.toBeInstanceOf(RallarRtcCaptureConnectionRequiredError);
            expect(mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls).toEqual([]);
            expect(mocks.rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls).toEqual([]);
        }
        finally {
            await facade.disconnect();
        }
    });

    it.each(
        [
            { capture: { rtcCaptureContext: { run: 'off', recipe: 'native' }, rtcCaptureMode: 'native' }, expected: { mode: 'off', origin: 'run' } },
            { capture: { rtcCaptureContext: { recipe: 'off' }, rtcCaptureMode: 'native' }, expected: { mode: 'native', origin: 'step' } },
            { capture: { rtcCaptureContext: { recipe: 'off' } }, expected: { mode: 'off', origin: 'recipe' } },
            { capture: {}, expected: { mode: 'native', origin: 'host' } }
        ] as const
    )('keeps canonical $expected.origin precedence on the acquired handle', async ({ capture, expected }) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const recorded: RtcSignalingDiagnostics.Event[] = [];
        facade.setDefaults({
            applicationId: 'app',
            rtc: { captureMode: 'native' },
            diagnosticsPorts: { signalingDiagnostics: (event) => recorded.push(event) }
        });
        try {
            const handle = await facade.messages.ws.send({ typeId: 'test', topicId: 'app.capture', payload: {}, ...capture });
            expect(handle.rtcCapture()).toMatchObject({
                status: 'observed',
                value: {
                    configuration: expected,
                    application: { status: 'applied', mode: expected.mode },
                    connectionId: { status: 'observed', value: 'constructed-1' }
                }
            });
            expect(mocks.webSocketQueueBox.enqueueOutboxIfAbsent).toHaveBeenCalledTimes(1);
            if (expected.mode === 'off') {
                expect(recorded).toEqual([]);
            }
        }
        finally {
            await facade.disconnect();
        }
    });

    it('refuses failed Native initialization without failing or replacing its connection', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        facade.setDefaults({ applicationId: 'app', diagnosticsPorts: { signalingDiagnostics: () => {} } });
        const capability = vi.spyOn(RtcNativeObservationScope, 'create').mockReturnValue({ status: 'unavailable', reason: 'initialization-failed' });
        try {
            await facade.connect({ rtcCaptureMode: 'native' });
            const receipt = facade.rtcCapture();
            expect(receipt?.application).toEqual({ status: 'unavailable', reason: 'initialization-failed' });
            await expect(facade.messages.ws.send({ typeId: 'test', topicId: 'app.capture', payload: {}, rtcCaptureMode: 'native' })).rejects.toMatchObject({
                code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                reason: 'application-unavailable',
                rtcCapture: { status: 'observed', value: receipt }
            });
            expect(facade.isConnected()).toBe(true);
            expect(facade.rtcCapture()).toBe(receipt);
            expect(mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls).toEqual([]);
        }
        finally {
            capability.mockRestore();
            await facade.disconnect();
        }
    });

    it('binds replacement acquisition to the requested Native graph and preserves old handle history', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        facade.setDefaults({ applicationId: 'app', diagnosticsPorts: { signalingDiagnostics: () => {} } });
        try {
            const first = await facade.messages.ws.send({ typeId: 'test', topicId: 'app.capture', payload: {}, rtcCaptureContext: { recipe: 'native' } });
            const firstReceipt = first.rtcCapture();
            mocks.readSession.mockReturnValue({ ...mocks.ctx.session, sessionId: 'replacement' });
            const next = await facade.messages.ws.send({ typeId: 'test', topicId: 'app.capture', payload: {}, rtcCaptureContext: { run: 'native' } });
            expect(next.rtcCapture()).toMatchObject({
                status: 'observed',
                value: {
                    configuration: { mode: 'native', origin: 'run' },
                    application: { status: 'applied', mode: 'native' },
                    connectionId: { status: 'observed', value: 'constructed-2' }
                }
            });
            expect(first.rtcCapture()).toBe(firstReceipt);
            expect(firstReceipt).toMatchObject({
                status: 'observed',
                value: {
                    configuration: { mode: 'native', origin: 'recipe' },
                    connectionId: { status: 'observed', value: 'constructed-1' }
                }
            });
            const reused = await facade.messages.ws.send({ typeId: 'test', topicId: 'app.capture', payload: {}, rtcCaptureContext: { recipe: 'native' } });
            expect(reused.rtcCapture()).toEqual(next.rtcCapture());
        }
        finally {
            await facade.disconnect();
        }
    });

    it('refuses required unavailable capture while preserving the successful connection', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        await facade.connect({ rtcCaptureMode: 'native' });
        const receipt = facade.rtcCapture();
        expect(receipt?.application).toEqual({ status: 'unavailable', reason: 'sink-unavailable' });
        try {
            const outcome = await facade.messages.ws.send({ typeId: 'test', topicId: 'app.capture', payload: {}, rtcCaptureMode: 'native' }).then(
                () => ({ sent: true }),
                (error: unknown) => ({ error })
            );
            expect.soft(mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls).toEqual([]);
            expect.soft(outcome).toMatchObject({ error: { code: 'RALLAR_RTC_CAPTURE_UNVERIFIED', reason: 'application-unavailable' } });
            expect(facade.isConnected()).toBe(true);
            expect(facade.rtcCapture()).toBe(receipt);
        }
        finally {
            await facade.disconnect();
        }
    });

    it('does not admit a required send when its message ID callback replaces authentication', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        await facade.connect({ rtcCaptureMode: 'off' });
        const id = vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(() => {
            mocks.readSession.mockReturnValue({ ...mocks.ctx.session, sessionId: 'replacement' });
            return '11111111-1111-4111-8111-111111111111';
        });
        try {
            const outcome = await facade.messages.ws.send({
                typeId: 'test',
                topicId: 'app.capture',
                resourceId: 'resource',
                payload: {},
                rtcCaptureMode: 'off'
            }).then(
                () => ({ sent: true }),
                (error: unknown) => ({ error })
            );
            expect.soft(mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls).toEqual([]);
            expect(outcome).toMatchObject({ error: { code: 'RALLAR_RTC_CAPTURE_UNVERIFIED', reason: 'session-not-current' } });
        }
        finally {
            id.mockRestore();
            await facade.disconnect();
        }
    });

    it('snapshots capture before opaque payload serialization can mutate caller intent', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        await facade.connect({ rtcCaptureMode: 'off' });
        const context: { run: RallarOperationOptions['rtcCaptureMode']; } = { run: 'off' };
        try {
            const outcome = await facade.messages.ws.send({
                typeId: 'test',
                topicId: 'app.capture',
                rtcCaptureContext: context,
                payload: {
                    get value() {
                        context.run = 'native';
                        return 1;
                    }
                }
            }).then(() => ({ sent: true }), (error: unknown) => ({ error }));
            expect(outcome).toEqual({ sent: true });
        }
        finally {
            await facade.disconnect();
        }
    });

    it.each(['active', 'pending'] as const)('refuses explicit Off before queue admission on a %s Native graph', async (phase) => {
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
        const admitted: ALMessage[] = [];
        const enqueue = mocks.webSocketQueueBox.enqueueOutboxIfAbsent.getMockImplementation()!;
        mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementation(async (...args) => {
            admitted.push(args[0]);
            return await enqueue(...args);
        });
        const first = facade.connect({ rtcCaptureContext: { run: 'native' } });
        await entered.promise;
        if (phase === 'active') {
            release.resolve();
            await first;
        }
        const capture: RallarOperationOptions = { rtcCaptureMode: 'off' };
        const send = facade.messages.ws.send({ ...capture, typeId: 'test', topicId: 'app.capture', payload: {} }).then(
            () => ({ sent: true }),
            (error: unknown) => ({ error })
        );
        release.resolve();
        try {
            await first;
            const outcome = await send;
            expect.soft(admitted).toEqual([]);
            expect(outcome).toEqual({ error: expect.any(RallarRtcCaptureConnectionRequiredError) });
        }
        finally {
            await facade.disconnect();
        }
    });

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
            (handle) => ({ sent: true, rtcCapture: handle.rtcCapture() }),
            (error: unknown) => ({ error })
        );
        release.resolve();
        try {
            await first;
            expect(await send).toEqual({ sent: true, rtcCapture: { status: 'observed', value: facade.rtcCapture() } });
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
