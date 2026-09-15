import type { BlackBoxRallarDeliveryObservation } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import type { BlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import { createSpaBrowserRallarRuntime } from '@shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { createRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import { BROWSER_DELIVERY_RETENTION } from '@shared-web/browser/composition/browser-delivery-composition.ts';
import { AL_DELIVERY_STATES, type ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { RallarValidationError } from '@shared/api/rallar-validation.ts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBrowserMessageSenderFixture } from '../../shared-web/messages/browser-message-sender-fixture.ts';
import { events, facade, loadRuntime, resetFacade } from './browser-rallar-runtime-test-harness.ts';
import { openFacadeDelivery } from './browser-runtime-facade-test-double.ts';

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
    reason: undefined
};

function openDelivery(verdict: ALDeliveryAdmissionVerdict | undefined) {
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
        reason: undefined
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

it('bounds a genuinely pending admission and observation with no storage polling', async () => {
    const runtime = await loadRuntime();
    const delivery = openDelivery({ kind: 'pending' });
    facade.behavior.typedSend.mockResolvedValue(delivery.handle);
    await runtime.connect(connection);
    const storageBefore = await runtime.readStorageCounters({ reset: false });
    const sending = runtime.sendMessage({ ...send, timeoutMs: 37, ttlMs: 60_000 });
    await vi.advanceTimersByTimeAsync(37);
    expect(await sending).toMatchObject({ status: 'submitted' });
    const observing = runtime.observeDelivery({ ...query, state: ['acknowledged'], timeoutMs: 100 });
    const timedOut = expect(observing).rejects.toThrow('Delivery handle h-1 did not reach [acknowledged]; last state submitted');
    await vi.advanceTimersByTimeAsync(100);
    await timedOut;
    expect(await runtime.readStorageCounters({ reset: false })).toEqual(storageBefore);
    delivery.registry.record({
        kind: 'admission',
        msgId: delivery.msgId,
        carrier: 'ws',
        atMs: Date.now(),
        verdict: { kind: 'admitted', durable: true, queuedAttempts: 1 }
    });
    expect(await runtime.readReceipts(query)).toMatchObject({ state: 'queued', attempts: 0 });
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
    const pageInputs: Parameters<BlackBoxRallarRuntime['sendMessage']>[0][] = [];
    const recordingRuntime: BlackBoxRallarRuntime = {
        ...native,
        sendMessage: async (input) => {
            pageInputs.push(input);
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

it.each([
    { verdict: { kind: 'refused', reason: 'oversized', detail: 'Payload exceeds 8 bytes.' } as const, state: 'rejected', ok: false },
    { verdict: { kind: 'admitted', durable: true, queuedAttempts: 1 } as const, state: 'queued', ok: true }
])('uses the typed RTC $state lifecycle in the command outcome', async ({ verdict, state, ok }) => {
    const native = await loadRuntime();
    const delivery = openDelivery(verdict);
    facade.behavior.rtcMessageSend.mockResolvedValue(delivery.handle);
    await native.connect({ ...connection, rallar: { ...connection.rallar, transport: 'messages.rtc', typeId: 'alm.conformance' } });
    vi.stubGlobal('window', { __blackBoxRallar: native });
    const runtime = createRallarBlackBoxBrowserTestRuntime({ rallarRuntime: createSpaBrowserRallarRuntime() });
    const outcome = await runtime.execute({
        kind: 'rtc.send',
        commandId: 'typed-rtc',
        transport: 'messages.rtc',
        send: { typeId: 'alm.conformance', payload: { text: 'sample' } }
    });
    expect(outcome.ok).toBe(ok);
    expect(outcome.value).toMatchObject({ message: { state }, sendObservation: { status: state, ok } });
    if (!ok) {
        expect(outcome.error).toMatchObject({ code: 'RALLAR_BB_RTC_SEND_FAILED', message: expect.stringContaining('Payload exceeds 8 bytes.') });
    }
});

it('projects typed RTC lifecycle evidence for each stream frame', async () => {
    const native = await loadRuntime();
    facade.behavior.rtcMessageSend.mockResolvedValue(openDelivery({ kind: 'admitted', durable: true, queuedAttempts: 1 }).handle);
    await native.connect({ ...connection, rallar: { ...connection.rallar, transport: 'messages.rtc', typeId: 'alm.conformance' } });
    vi.stubGlobal('window', { __blackBoxRallar: native });
    const runtime = createRallarBlackBoxBrowserTestRuntime({ rallarRuntime: createSpaBrowserRallarRuntime() });
    const running = runtime.execute({
        kind: 'rtc.stream',
        commandId: 'typed-stream',
        transport: 'messages.rtc',
        count: 1,
        intervalMs: 1,
        send: { typeId: 'alm.conformance', payload: true }
    });
    await vi.advanceTimersByTimeAsync(0);
    expect((await running).value).toMatchObject({ observations: [{ status: 'queued', ok: true }] });
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
