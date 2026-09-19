import 'fake-indexeddb/auto';
import {
    afterEach,
    beforeEach,
    expect,
    it,
    vi
} from 'vitest';

import type {
    BlackBoxRallarDeliveryObservation,
    BlackBoxRallarMessageSendInput
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import type { BlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import { requireBlackBoxRallarInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts';
import { decodeBlackBoxRallarMessageSendInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-messaging-input.ts';
import { createSpaBrowserRallarRuntime } from '@shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';
import type { RallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/browser/browser-command-contracts.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { createRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import { BROWSER_DELIVERY_RETENTION } from '@shared-web/browser/composition/browser-delivery-composition.ts';
import type { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import type { RallarMessageHandle } from '@shared-web/browser/rallar.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { AL_DELIVERY_STATES, type ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { toALOutboundEnqueueStatus } from '@shared/alm/delivery/to-al-outbound-enqueue-status.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { RallarValidationError } from '@shared/api/rallar-validation.ts';
import { createCountingIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import { createBrowserMessageSenderFixture } from '../../shared-web/messages/browser-message-sender-fixture.ts';
import { createDefaultOutboundTestRuntime, runOutboundWorkTask } from '../../shared/alm/outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload } from '../../shared/alm/outbound-test-payload.ts';
import {
    events,
    facade,
    loadRuntime,
    resetFacade
} from './browser-rallar-runtime-test-harness.ts';
import { openFacadeDelivery } from './browser-runtime-facade-test-double.ts';

interface DeliveryFixture {
    readonly registry: BrowserRallarDeliveryRegistry;
    readonly handle: RallarMessageHandle;
    readonly msgId: string;
}

interface RtcRecipeRuntime {
    readonly native: BlackBoxRallarRuntime;
    readonly runtime: RallarBlackBoxBrowserTestRuntime;
}

const connection = {
    connection: 'aliceAlm',
    actor: 'alice',
    roomId: 'room-1',
    rallar: {
        apiBaseUrl: 'https://api.example.test',
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        username: 'alice',
        password: 'secret'
    }
};
const send = { connection: 'aliceAlm', carrier: 'ws' as const, typeId: 'alm.conformance', payload: { n: 1 }, handleId: 'h-1', timeoutMs: 100 };
const query = { connection: 'aliceAlm', handleId: 'h-1' };
const unknownObservation = {
    state: 'unobservable',
    submitted: false,
    attempts: 0,
    confirmedHopPeerIds: [],
    unconfirmedHopPeerIds: [],
    reason: undefined,
    backpressured: false,
    enqueued: false
};

function openDelivery(verdict: ALDeliveryAdmissionVerdict | undefined): DeliveryFixture {
    const handle = openFacadeDelivery('ws', verdict);
    return { registry: facade.deliveries, handle, msgId: handle.msgId };
}

function sendThroughProductionSender(maxPayloadBytes: number): void {
    const sender = createBrowserMessageSenderFixture(maxPayloadBytes, facade.deliveries).sender;
    facade.behavior.typedSend.mockImplementation(async (payload) => await sender.sendWs({ typeId: 'alm.conformance', topicId: 'room.conformance', payload }));
}

/** One live send per registry entry, so the send before them is the oldest one the registry evicts. */
async function sendPastTheEntryBound(runtime: BlackBoxRallarRuntime): Promise<void> {
    for (let index = 0; index < BROWSER_DELIVERY_RETENTION.maxEntries; index += 1) {
        await runtime.sendMessage({ ...send, handleId: `h-${index}`, payload: index });
    }
}

async function readEveryLedgerView(
    runtime: BlackBoxRallarRuntime,
    handleId: string
): Promise<readonly BlackBoxRallarDeliveryObservation[]> {
    const handle = { connection: 'aliceAlm', handleId };
    return [
        await runtime.observeDelivery({ ...handle, state: ['acknowledged'], timeoutMs: 100 }),
        await runtime.readReceipts(handle),
        await runtime.cancelDelivery(handle)
    ];
}

beforeEach(() => {
    resetFacade();
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it('projects queued, submitted and acknowledged evidence without bridging settlements', async () => {
    const runtime = await loadRuntime();
    const delivery = openDelivery({ kind: 'admitted', durable: true, queuedAttempts: 1 });
    facade.behavior.typedSend.mockResolvedValue(delivery.handle);
    await runtime.connect(connection);
    expect(await runtime.sendMessage(send)).toEqual({ handleId: 'h-1', msgId: delivery.msgId, carrier: 'ws', status: 'queued', reason: undefined });
    expect(await runtime.observeDelivery({ ...query, state: ['queued'], timeoutMs: 100 })).toEqual({
        handleId: 'h-1',
        state: 'queued',
        submitted: false,
        attempts: 0,
        confirmedHopPeerIds: [],
        unconfirmedHopPeerIds: [],
        reason: undefined,
        backpressured: false,
        enqueued: true
    });
    const before = events.slice();
    delivery.registry.record({ kind: 'attempt-started', msgId: delivery.msgId, carrier: 'ws', atMs: Date.now(), attemptId: 'attempt-1' });
    delivery.registry.record({
        kind: 'attempt-settled',
        msgId: delivery.msgId,
        carrier: 'ws',
        atMs: Date.now(),
        attemptId: 'attempt-1',
        outcome: 'sent',
        submissionAttempted: true,
        detail: undefined,
        willRetry: false
    });
    expect(await runtime.observeDelivery({ ...query, state: ['transport-accepted'], timeoutMs: 100 })).toMatchObject({
        state: 'transport-accepted',
        submitted: true,
        attempts: 1
    });
    delivery.registry.record({
        kind: 'acknowledgement',
        msgId: delivery.msgId,
        carrier: 'ws',
        atMs: Date.now(),
        confirmedHopPeerIds: ['peer-1'],
        unconfirmedHopPeerIds: ['peer-2'],
        complete: true
    });
    expect(await runtime.readReceipts(query)).toMatchObject({
        state: 'acknowledged',
        confirmedHopPeerIds: ['peer-1'],
        unconfirmedHopPeerIds: ['peer-2'],
        attempts: 1
    });
    expect(events).toEqual(before);
});

it('cancels owner attempts, preserves handles on reconnect and ends waits on an unrequested terminal state', async () => {
    const runtime = await loadRuntime();
    const delivery = openDelivery({ kind: 'admitted', durable: true, queuedAttempts: 1 });
    facade.behavior.typedSend.mockResolvedValue(delivery.handle);
    await runtime.connect(connection);
    await runtime.sendMessage(send);
    await runtime.close();
    await runtime.connect(connection);
    const observing = runtime.observeDelivery({ ...query, state: ['acknowledged'], timeoutMs: 100 });
    expect(await runtime.cancelDelivery(query)).toMatchObject({ state: 'cancelled' });
    expect(facade.records.cancelledMessageIds).toEqual([delivery.msgId]);
    expect(await observing).toMatchObject({ state: 'cancelled' });
    expect(await runtime.readReceipts(query)).toMatchObject({ state: 'cancelled' });
    const reloaded = await loadRuntime();
    for (const operation of ['observeDelivery', 'cancelDelivery', 'readReceipts'] as const) {
        expect(await reloaded[operation]({ ...query, state: ['acknowledged'], timeoutMs: 100 })).toEqual({
            handleId: 'h-1',
            ...unknownObservation
        });
    }
});

it('bounds a production pending admission and observes it without additional storage reads', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const runtime = await loadRuntime();
    const fixture = createBrowserMessageSenderFixture(64, facade.deliveries);
    const observer = createCountingIndexedDbOperationObserver();
    const backend = new IndexedDbAdmissionBackend({
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {},
        dbName: `pending-observation-${crypto.randomUUID()}`,
        storeName: 'entries',
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer
    });
    const admissionStore = createALOutboundAdmissionStore({
        nowMs: Date.now,
        canonicalScope: 'pending-observation',
        decodePrepared: decodeOutboundTestPayload,
        namespace: 'pending-observation',
        backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const outbound = createDefaultOutboundTestRuntime({
        queueEngine: new InboxOutboxEngine(),
        stores: { admissionStore, workQueue: backend.workQueue },
        planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, persist: true, preparedMessages: [{ kind: 'send' }] }),
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
    const admissionStored = Promise.withResolvers<void>();
    const releaseAdmission = Promise.withResolvers<void>();
    vi.mocked(fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent).mockImplementation(async (message) => {
        const admitted = await outbound.enqueueIfAbsent(message);
        await runOutboundWorkTask(outbound);
        admissionStored.resolve();
        await releaseAdmission.promise;
        return admitted;
    });
    facade.behavior.typedSend.mockImplementation(async (payload, options) =>
        await fixture.sender.sendTyped({ ...options, typeId: 'alm.conformance', topicId: 'room.conformance', payload })
    );
    await runtime.connect(connection);
    const sending = runtime.sendMessage({ ...send, timeoutMs: 37, ttlMs: 60_000 });
    await admissionStored.promise;
    const storageBefore = observer.getCounts();
    expect(storageBefore.byKind.read).toBeGreaterThan(0);
    expect(storageBefore.byKind.write).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(37);
    expect(await sending).toMatchObject({ status: 'submitted' });
    const observing = runtime.observeDelivery({ ...query, state: ['acknowledged'], timeoutMs: 100 });
    const timedOut = expect(observing).rejects.toThrow('Delivery handle h-1 did not reach [acknowledged]; last state submitted');
    await vi.advanceTimersByTimeAsync(100);
    await timedOut;
    expect(observer.getCounts()).toEqual(storageBefore);
    releaseAdmission.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(await runtime.observeDelivery({ ...query, state: ['queued'], timeoutMs: 100 })).toMatchObject({ state: 'queued', enqueued: true, attempts: 0 });
    expect(await runtime.readReceipts(query)).toMatchObject({ state: 'queued', enqueued: true, attempts: 0 });
    expect(observer.getCounts()).toEqual(storageBefore);
});

it.each(AL_DELIVERY_STATES)('decodes the shared %s state and returns a lost observation', async (state) => {
    const runtime = await loadRuntime();
    expect(await runtime.observeDelivery({ ...query, state: [state], timeoutMs: 0 })).toMatchObject({ state: 'unobservable' });
});

it('projects the real rejected handle and preserves its reason', async () => {
    const runtime = await loadRuntime();
    sendThroughProductionSender(8);
    await runtime.connect(connection);
    expect(await runtime.sendMessage({ ...send, payload: { text: 'too large' } })).toMatchObject({
        msgId: expect.any(String),
        status: 'rejected',
        reason: 'Payload exceeds 8 bytes.'
    });
    expect(await runtime.readReceipts(query)).toMatchObject({ state: 'rejected', reason: 'Payload exceeds 8 bytes.', attempts: 0 });
});

it.each([new Error('ws lane closed'), new RallarValidationError('Invalid payload.', [])])(
    'propagates pre-envelope errors without inventing a ledger entry: %s',
    async (error) => {
        const runtime = await loadRuntime();
        facade.behavior.typedSend.mockRejectedValue(error);
        await runtime.connect(connection);
        await expect(runtime.sendMessage(send)).rejects.toThrow(error);
        expect(await runtime.readReceipts(query)).toMatchObject({ state: 'unobservable', attempts: 0 });
    }
);

it('projects a durable admission as enqueued and a queued admission as queued', async () => {
    const runtime = await loadRuntime();
    const delivery = openDelivery({ kind: 'admitted', durable: true, queuedAttempts: 1 });
    facade.behavior.typedSend.mockResolvedValue(delivery.handle);
    await runtime.connect(connection);
    await runtime.sendMessage(send);

    expect(await runtime.readReceipts(query)).toMatchObject({ state: 'queued', enqueued: true, backpressured: false });
});

it('projects a non-durable admission as accepted without calling it enqueued', async () => {
    const runtime = await loadRuntime();
    const delivery = openDelivery({ kind: 'admitted', durable: false, queuedAttempts: 0 });
    facade.behavior.typedSend.mockResolvedValue(delivery.handle);
    await runtime.connect(connection);
    await runtime.sendMessage(send);

    expect(await runtime.readReceipts(query)).toMatchObject({ state: 'accepted', enqueued: false, backpressured: false });
});

it.each([
    { reason: 'rate-limited' as const, backpressured: true },
    { reason: 'circuit-open' as const, backpressured: true },
    { reason: 'no-route' as const, backpressured: false }
])('reads an unroutable $reason admission as backpressured=$backpressured', async ({ reason, backpressured }) => {
    const runtime = await loadRuntime();
    const detail = `${reason} at the ws carrier`;
    facade.behavior.typedSend.mockImplementation(async () => {
        const handle = openFacadeDelivery('ws', { kind: 'unroutable', reason, detail });
        facade.deliveries.record({ kind: 'attempts-exhausted', msgId: handle.msgId, carrier: 'ws', atMs: Date.now(), detail });
        return handle;
    });
    await runtime.connect(connection);
    await runtime.sendMessage(send);

    expect(await runtime.readReceipts(query)).toMatchObject({ state: 'failed', backpressured, enqueued: false });
});

it('reads a handle the session registry dropped after terminal retention as unobservable', async () => {
    vi.setSystemTime(1_000);
    const runtime = await loadRuntime();
    sendThroughProductionSender(8);
    await runtime.connect(connection);
    expect(await runtime.sendMessage({ ...send, handleId: 'h-old', payload: { text: 'too large' } })).toMatchObject({ status: 'rejected' });
    expect(await runtime.readReceipts({ ...query, handleId: 'h-old' })).toMatchObject({ state: 'rejected', reason: 'Payload exceeds 8 bytes.' });

    vi.setSystemTime(1_000 + BROWSER_DELIVERY_RETENTION.retainTerminalMs + 1);
    await runtime.sendMessage({ ...send, handleId: 'h-new', payload: true });

    expect(await readEveryLedgerView(runtime, 'h-old')).toEqual(Array(3).fill({ handleId: 'h-old', ...unknownObservation }));
    expect(await runtime.readReceipts({ ...query, handleId: 'h-new' })).toMatchObject({ state: 'queued' });
});

it('reads a live handle the session registry evicted past its entry bound as unobservable', async () => {
    const runtime = await loadRuntime();
    sendThroughProductionSender(64);
    await runtime.connect(connection);
    await runtime.sendMessage({ ...send, handleId: 'h-first', payload: true });
    await sendPastTheEntryBound(runtime);

    expect(await readEveryLedgerView(runtime, 'h-first')).toEqual(Array(3).fill({ handleId: 'h-first', ...unknownObservation }));
    expect(await runtime.readReceipts({ ...query, handleId: `h-${BROWSER_DELIVERY_RETENTION.maxEntries - 1}` })).toMatchObject({ state: 'queued' });
});

it('reads a handle the session registry evicted while an observe waited on it as unobservable', async () => {
    const runtime = await loadRuntime();
    sendThroughProductionSender(64);
    await runtime.connect(connection);
    await runtime.sendMessage({ ...send, handleId: 'h-first', payload: true });
    const observing = runtime.observeDelivery({ ...query, handleId: 'h-first', state: ['acknowledged'], timeoutMs: 1_000 });
    await sendPastTheEntryBound(runtime);

    expect(await observing).toEqual({ handleId: 'h-first', ...unknownObservation });
});

it('waits the 5,000 ms default admission budget when a send names neither timeout nor deadline', async () => {
    vi.setSystemTime(1_000);
    const native = await loadRuntime();
    const delivery = openDelivery({ kind: 'pending' });
    facade.behavior.typedSend.mockResolvedValue(delivery.handle);
    await native.connect(connection);
    vi.stubGlobal('window', { __blackBoxRallar: native });
    const runtime = createRallarBlackBoxBrowserTestRuntime({ rallarRuntime: createSpaBrowserRallarRuntime(), now: Date.now });
    const { timeoutMs: _timeoutMs, ...unbounded } = send;
    let settled = false;
    const sending = runtime.execute({ kind: 'messages.send', commandId: 'default-budget', ...unbounded, ttlMs: 60_000 });
    void sending.then(() => {
        settled = true;
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await sending).value).toMatchObject({ status: 'submitted', msgId: delivery.msgId });
});

it('clamps an already-elapsed command deadline to a zero admission wait', async () => {
    vi.setSystemTime(2_000);
    const native = await loadRuntime();
    const delivery = openDelivery({ kind: 'pending' });
    facade.behavior.typedSend.mockResolvedValue(delivery.handle);
    await native.connect(connection);
    const pageInputs: BlackBoxRallarMessageSendInput[] = [];
    const recordingRuntime: BlackBoxRallarRuntime = {
        ...native,
        sendMessage: async (input) => {
            pageInputs.push(requireBlackBoxRallarInput(decodeBlackBoxRallarMessageSendInput(input)));
            return await native.sendMessage(input);
        }
    };
    vi.stubGlobal('window', { __blackBoxRallar: recordingRuntime });
    const runtime = createRallarBlackBoxBrowserTestRuntime({ rallarRuntime: createSpaBrowserRallarRuntime(), now: Date.now });
    const sending = runtime.execute({ kind: 'messages.send', commandId: 'elapsed', ...send, timeoutMs: 500, deadlineEpochMs: 1_500, ttlMs: 60_000 });

    await vi.advanceTimersByTimeAsync(0);
    expect((await sending).value).toMatchObject({ status: 'submitted', msgId: delivery.msgId });
    expect(pageInputs).toEqual([expect.objectContaining({ timeoutMs: 0 })]);
});

it('carries the earlier absolute command deadline into a pending admission wait', async () => {
    vi.setSystemTime(1_000);
    const native = await loadRuntime();
    const delivery = openDelivery({ kind: 'pending' });
    facade.behavior.typedSend.mockResolvedValue(delivery.handle);
    await native.connect(connection);
    vi.stubGlobal('window', { __blackBoxRallar: native });
    const runtime = createRallarBlackBoxBrowserTestRuntime({ rallarRuntime: createSpaBrowserRallarRuntime(), now: Date.now });
    const sending = runtime.execute({ kind: 'messages.send', commandId: 'bounded', ...send, timeoutMs: 500, deadlineEpochMs: 1_037, ttlMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(37);
    const outcome = await sending;
    expect(outcome.value).toMatchObject({ status: 'submitted', msgId: delivery.msgId });
    expect(await native.readReceipts(query)).toMatchObject({ state: 'submitted', attempts: 0 });
});

it('reports a typed RTC rejection as a failed recipe command with its reason', async () => {
    const { runtime } = await connectRtcRecipeRuntime();
    const admission = deferRtcAdmission();
    const running = runtime.execute({ kind: 'rtc.send', commandId: 'rejected-rtc', transport: 'messages.rtc', send: { payload: true } });
    await vi.advanceTimersByTimeAsync(0);
    admission.resolve({ kind: 'refused', reason: 'oversized', detail: 'Payload exceeds 8 bytes.' });
    const result = await running;
    expect(result.ok).toBe(false);
    expect(result.value).toMatchObject({ message: { state: 'rejected' }, sendObservation: { status: 'rejected', ok: false } });
    expect(result.error).toMatchObject({ code: 'RALLAR_BB_RTC_SEND_FAILED', message: expect.stringContaining('Payload exceeds 8 bytes.') });
});

it('keeps the authored bounded-rejection cancellation probe aligned with a real terminal handle', async () => {
    const native = await loadRuntime();
    sendThroughProductionSender(8);
    await native.connect(connection);
    vi.stubGlobal('window', { __blackBoxRallar: native });
    const runtime = createRallarBlackBoxBrowserTestRuntime({ rallarRuntime: createSpaBrowserRallarRuntime() });
    const scenario = createAlmConformanceRecipes({
        group: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
        carrier: 'ws',
        typeId: 'alm.conformance',
        senderConnection: 'aliceAlm',
        receiverConnection: 'receiver',
        deadlineMs: 18_000
    })
        .find((entry) => entry.scenarioId === 'bounded-rejection');
    expect(scenario).toBeDefined();
    const commands = scenario!.sender.commands.filter((command) => ['messages.send', 'messages.observe', 'messages.cancel'].includes(command.kind));
    expect(new Set(commands.map((command) => command.commandId)).size).toBe(commands.length);
    for (const command of commands) {
        const result = await runtime.execute(command);
        expect(result.ok, result.error?.message).toBe(true);
        if (command.kind === 'messages.observe') {
            expect(command.state).toEqual(['rejected']);
            expect(result.value).toMatchObject({ state: 'rejected' });
        }
    }
});

function deferRtcAdmission(): PromiseWithResolvers<ALDeliveryAdmissionVerdict> {
    const fixture = createBrowserMessageSenderFixture(64, facade.deliveries);
    const admission = Promise.withResolvers<ALDeliveryAdmissionVerdict>();
    vi.mocked(fixture.middleware.middleware.rtcRxStreamer.enqueueOutboxIfAbsent).mockImplementation(async (message): Promise<ALOutboundEnqueueResult> => {
        const verdict = await admission.promise;
        return { message, verdict, status: toALOutboundEnqueueStatus(verdict), entries: [] };
    });
    facade.behavior.rtcMessageSend.mockImplementation(async (request) => await fixture.sender.sendRtc(request));
    return admission;
}

async function connectRtcRecipeRuntime(): Promise<RtcRecipeRuntime> {
    const native = await loadRuntime();
    await native.connect({ ...connection, rallar: { ...connection.rallar, transport: 'messages.rtc', typeId: 'alm.conformance' } });
    vi.stubGlobal('window', { __blackBoxRallar: native });
    return { native, runtime: createRallarBlackBoxBrowserTestRuntime({ rallarRuntime: createSpaBrowserRallarRuntime(), now: Date.now }) };
}

it.each([
    { reason: 'rate-limited' as const, backpressured: true },
    { reason: 'circuit-open' as const, backpressured: true },
    { reason: 'no-route' as const, backpressured: false }
])('waits for delayed RTC $reason admission before evaluating loop backpressure', async ({ reason, backpressured }) => {
    const { runtime } = await connectRtcRecipeRuntime();
    const admission = deferRtcAdmission();
    let settled = false;
    const running = runtime.execute({
        kind: 'loop',
        commandId: 'admission-loop',
        count: 1,
        continueOnFailure: true,
        thresholds: { failOnBackpressure: true },
        commands: [{ kind: 'rtc.send', commandId: 'admission-send', transport: 'messages.rtc', send: { payload: true } }]
    });
    void running.then(() => {
        settled = true;
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(settled).toBe(false);
    admission.resolve({ kind: 'unroutable', reason, detail: reason });
    const result = await running;
    expect(result.value).toMatchObject({ sends: { backpressureCount: backpressured ? 1 : 0 } });
    expect(result.value).toMatchObject({ thresholdFailures: backpressured ? [expect.objectContaining({ category: 'backpressure' })] : undefined });
});

it.each([
    { reason: 'rate-limited' as const, backpressured: true },
    { reason: 'circuit-open' as const, backpressured: true },
    { reason: 'no-route' as const, backpressured: false }
])('waits for delayed RTC $reason admission before evaluating stream backpressure', async ({ reason, backpressured }) => {
    const { runtime } = await connectRtcRecipeRuntime();
    const admission = deferRtcAdmission();
    const running = runtime.execute({
        kind: 'rtc.stream',
        commandId: 'admission-stream',
        transport: 'messages.rtc',
        count: 1,
        intervalMs: 1,
        continueOnSendFailure: true,
        thresholds: { maxBackpressureCount: 0 },
        send: { payload: true }
    });
    await vi.advanceTimersByTimeAsync(20);
    admission.resolve({ kind: 'unroutable', reason, detail: reason });
    const result = await running;
    expect(result.ok).toBe(!backpressured);
    expect(result.value).toMatchObject({
        backpressureCount: backpressured ? 1 : 0,
        observations: [{ status: 'failed', backpressured, queued: false, enqueued: false }]
    });
});

it.each(['rtc.send', 'rtc.stream'] as const)('projects delayed durable admission through %s without waiting for delivery', async (kind) => {
    const { runtime } = await connectRtcRecipeRuntime();
    const admission = deferRtcAdmission();
    const running = runtime.execute({ kind, commandId: 'durable', transport: 'messages.rtc', count: 1, intervalMs: 1, send: { payload: true } });
    await vi.advanceTimersByTimeAsync(20);
    admission.resolve({ kind: 'admitted', durable: true, queuedAttempts: 1 });
    const result = await running;
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject(
        kind === 'rtc.send'
            ? { sendObservation: { status: 'queued', queued: true, enqueued: true, backpressured: false } }
            : { observations: [{ status: 'queued', queued: true, enqueued: true, backpressured: false }] }
    );
});

it.each(['messages.rtc', undefined] as const)('bounds a pending RTC admission with the earlier deadline for transport %s', async (transport) => {
    vi.setSystemTime(1_000);
    const { runtime } = await connectRtcRecipeRuntime();
    deferRtcAdmission();
    let settled = false;
    const running = runtime.execute({
        kind: 'rtc.send',
        commandId: 'bounded-rtc',
        transport,
        timeoutMs: 500,
        deadlineEpochMs: 1_037,
        send: { payload: true, ttlMs: 60_000 }
    });
    void running.then(() => {
        settled = true;
    });
    await vi.advanceTimersByTimeAsync(36);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect((await running).value).toMatchObject({ sendObservation: { status: 'submitted', enqueued: false } });
});

it('uses the default 5,000 ms RTC admission budget and clears the wait when the runtime closes', async () => {
    const { native } = await connectRtcRecipeRuntime();
    deferRtcAdmission();
    let settled = false;
    const running = native.send({ payload: true, ttlMs: 60_000 });
    void running.then(() => {
        settled = true;
    }, () => {
        settled = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    const closed = expect(running).rejects.toThrow('Rallar send completed after the runtime closed.');
    await native.close();
    await closed;
    expect(vi.getTimerCount()).toBe(0);
});

it.each(['rtc.send', 'rtc.stream'] as const)('clamps an elapsed %s deadline instead of waiting for admission', async (kind) => {
    vi.setSystemTime(2_000);
    const { runtime } = await connectRtcRecipeRuntime();
    deferRtcAdmission();
    const running = runtime.execute({
        kind,
        commandId: 'elapsed-rtc',
        transport: 'messages.rtc',
        timeoutMs: 500,
        deadlineEpochMs: 1_000,
        count: 1,
        intervalMs: 1,
        send: { payload: true, ttlMs: 60_000 }
    });
    await vi.advanceTimersByTimeAsync(0);
    expect((await running).value).toMatchObject(
        kind === 'rtc.send'
            ? { sendObservation: { status: 'submitted' } }
            : { observations: [{ status: 'submitted', enqueued: false, backpressured: false }] }
    );
});

it('returns the still-submitted RTC evidence when the default admission budget ends', async () => {
    const { native } = await connectRtcRecipeRuntime();
    deferRtcAdmission();
    const running = native.send({ payload: true, ttlMs: 60_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await running).toMatchObject({ message: { state: 'submitted', enqueued: false, backpressured: false } });
    expect(vi.getTimerCount()).toBe(0);
});

it.each(['messages.rtc', undefined] as const)('shares the stream command deadline across delayed frames for transport %s', async (transport) => {
    vi.setSystemTime(1_000);
    const { runtime } = await connectRtcRecipeRuntime();
    deferRtcAdmission();
    const running = runtime.execute({
        kind: 'rtc.stream',
        commandId: 'bounded-stream',
        transport,
        timeoutMs: 500,
        deadlineEpochMs: 1_037,
        count: 2,
        intervalMs: 20,
        send: { payload: true, ttlMs: 60_000 }
    });
    await vi.advanceTimersByTimeAsync(37);
    expect((await running).value).toMatchObject({
        observations: [
            { status: 'submitted', durationMs: 37, enqueued: false, backpressured: false },
            { status: 'submitted', durationMs: 17, enqueued: false, backpressured: false }
        ]
    });
});

it('deducts sender connection time from the RTC admission deadline', async () => {
    vi.setSystemTime(1_000);
    const { native } = await connectRtcRecipeRuntime();
    const fixture = createBrowserMessageSenderFixture(64, facade.deliveries);
    const connection = Promise.withResolvers<typeof fixture.middleware>();
    fixture.connect.mockReturnValue(connection.promise);
    vi.mocked(fixture.middleware.middleware.rtcRxStreamer.enqueueOutboxIfAbsent).mockReturnValue(new Promise(() => undefined));
    facade.behavior.rtcMessageSend.mockImplementation(async (request) => await fixture.sender.sendRtc(request));
    let settled = false;
    const running = native.send({ payload: true, ttlMs: 60_000 }, 1_037);
    void running.then(() => {
        settled = true;
    });
    await vi.advanceTimersByTimeAsync(20);
    connection.resolve(fixture.middleware);
    await vi.advanceTimersByTimeAsync(16);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await running).toMatchObject({ message: { state: 'submitted', enqueued: false } });
    expect(vi.getTimerCount()).toBe(0);
});

it.each(
    [
        { scenarioId: 'deadline-expiry', state: 'queued' },
        { scenarioId: 'delivery-baseline', state: 'queued' },
        { scenarioId: 'ordering-resync', state: 'queued' },
        { scenarioId: 'deadline-expiry', state: 'transport-accepted' },
        { scenarioId: 'delivery-baseline', state: 'transport-accepted' },
        { scenarioId: 'ordering-resync', state: 'transport-accepted' },
        { scenarioId: 'deadline-expiry', state: 'rejected' },
        { scenarioId: 'deadline-expiry', state: 'failed' }
    ] as const
)('requires successful admission for $scenarioId after the handle reaches $state', async ({ scenarioId, state }) => {
    const { runtime } = await connectRtcRecipeRuntime();
    const fixture = createBrowserMessageSenderFixture(64, facade.deliveries);
    if (state === 'rejected' || state === 'failed') {
        vi.mocked(fixture.middleware.middleware.rtcRxStreamer.enqueueOutboxIfAbsent).mockImplementation(async (message) => ({
            message,
            entries: [],
            verdict: state === 'rejected'
                ? { kind: 'refused', reason: 'unsupported', detail: 'Admission refused.' }
                : { kind: 'failed', detail: 'Admission failed.' },
            status: 'failed'
        }));
    }
    facade.behavior.typedSend.mockImplementation(async (payload, options) => {
        const handle = await fixture.sender.sendTyped({ ...options, ack: 'receiver', typeId: 'alm.conformance', payload });
        await handle.wait({ until: ['queued'], timeoutMs: 100 });
        if (state === 'transport-accepted') {
            fixture.registry.record({ kind: 'attempt-started', carrier: 'rtc', msgId: handle.msgId, atMs: Date.now(), attemptId: 'attempt-1' });
            fixture.registry.record({
                kind: 'attempt-settled',
                carrier: 'rtc',
                msgId: handle.msgId,
                atMs: Date.now(),
                attemptId: 'attempt-1',
                outcome: 'sent',
                submissionAttempted: true,
                detail: undefined,
                willRetry: false
            });
        }
        return handle;
    });
    const scenario = createAlmConformanceRecipes({
        group: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
        carrier: 'rtc',
        typeId: 'alm.conformance',
        senderConnection: 'aliceAlm',
        receiverConnection: 'receiver',
        deadlineMs: 18_000
    }).find((entry) => entry.scenarioId === scenarioId)!;
    const commands = scenario.sender.commands.filter((command) =>
        command.kind === 'messages.send' || command.kind === 'messages.observe' ||
        (command.kind === 'assert' && !command.source.includes('storage-counters'))
    );
    const running = runtime.execute({ kind: 'recipe.run', commandId: 'conformance', recipe: { ...scenario.sender, commands } });
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await running;
    expect(result.ok, result.error?.message).toBe(state !== 'rejected' && state !== 'failed');
    if (state === 'rejected' || state === 'failed') {
        expect(runtime.state().failures.some((failure) => failure.error?.code === 'RALLAR_BLACK_BOX_ASSERT_FAILED')).toBe(true);
    }
});
