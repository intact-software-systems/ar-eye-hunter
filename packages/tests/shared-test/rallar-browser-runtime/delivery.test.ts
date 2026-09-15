import { createRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import { createSpaBrowserRallarRuntime } from '@shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { AL_DELIVERY_STATES, type ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { RallarValidationError } from '@shared/api/rallar-validation.ts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBrowserMessageSenderFixture } from '../../shared-web/messages/browser-message-sender-fixture.ts';
import { events, facade, loadRuntime, resetFacade } from './browser-rallar-runtime-test-harness.ts';

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

function createDelivery(verdict: ALDeliveryAdmissionVerdict | undefined) {
    const cancelled: string[] = [];
    const registry = new BrowserRallarDeliveryRegistry({
        nowMs: Date.now,
        retainTerminalMs: 60_000,
        maxEntries: 10,
        cancel: (msgId) => {
            cancelled.push(msgId);
        }
    });
    const handle = registry.open({
        id: { v: 2, msgId: 'msg-1', ts: Date.now(), senderId: 'client-1' },
        route: { topicId: 'alm.conformance', contextId: 'room-1', resourceId: 'room-1' },
        payload: { typeId: 'alm.conformance', contentType: 'application/json', resource: '{}' },
        delivery: { ack: 'receiver', reliability: 'at-least-once' }
    }, 'ws');
    if (verdict) {
        registry.record({ kind: 'admission', msgId: handle.msgId, carrier: 'ws', atMs: Date.now(), verdict });
    }
    return { registry, handle, cancelled };
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
    const delivery = createDelivery({ kind: 'admitted', durable: true, queuedAttempts: 1 });
    facade.behavior.typedSend.mockResolvedValue(delivery.handle);
    await runtime.connect(connection);
    expect(await runtime.sendMessage(send)).toEqual({ handleId: 'h-1', msgId: 'msg-1', carrier: 'ws', status: 'queued', reason: undefined });
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
    delivery.registry.record({ kind: 'attempt-started', msgId: 'msg-1', carrier: 'ws', atMs: Date.now(), attemptId: 'attempt-1' });
    delivery.registry.record({
        kind: 'attempt-settled',
        msgId: 'msg-1',
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
        msgId: 'msg-1',
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
    const delivery = createDelivery({ kind: 'admitted', durable: true, queuedAttempts: 1 });
    facade.behavior.typedSend.mockResolvedValue(delivery.handle);
    await runtime.connect(connection);
    await runtime.sendMessage(send);
    await runtime.close();
    await runtime.connect(connection);
    const observing = runtime.observeDelivery({ ...query, state: ['acknowledged'], timeoutMs: 100 });
    expect(await runtime.cancelDelivery(query)).toMatchObject({ state: 'cancelled' });
    expect(delivery.cancelled).toEqual(['msg-1']);
    expect(await observing).toMatchObject({ state: 'cancelled' });
    expect(await runtime.readReceipts(query)).toMatchObject({ state: 'cancelled' });
    const reloaded = await loadRuntime();
    for (const operation of ['observeDelivery', 'cancelDelivery', 'readReceipts'] as const) {
        expect(await reloaded[operation]({ ...query, state: ['acknowledged'], timeoutMs: 100 })).toEqual({
            handleId: 'h-1',
            state: 'unobservable',
            submitted: false,
            attempts: 0,
            confirmedHopPeerIds: [],
            unconfirmedHopPeerIds: [],
            reason: undefined
        });
    }
});

it('bounds a genuinely pending admission and observation with no storage polling', async () => {
    const runtime = await loadRuntime();
    const delivery = createDelivery({ kind: 'pending' });
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
        msgId: 'msg-1',
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
    const sender = createBrowserMessageSenderFixture(8).sender;
    facade.behavior.typedSend.mockImplementation(async (payload) => await sender.sendWs({ typeId: 'alm.conformance', topicId: 'room.conformance', payload }));
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

it('carries the earlier absolute command deadline into a pending admission wait', async () => {
    vi.setSystemTime(1_000);
    const native = await loadRuntime();
    const delivery = createDelivery({ kind: 'pending' });
    facade.behavior.typedSend.mockResolvedValue(delivery.handle);
    await native.connect(connection);
    vi.stubGlobal('window', { __blackBoxRallar: native });
    const runtime = createRallarBlackBoxBrowserTestRuntime({ rallarRuntime: createSpaBrowserRallarRuntime(), now: Date.now });
    const sending = runtime.execute({ kind: 'messages.send', commandId: 'bounded', ...send, timeoutMs: 500, deadlineEpochMs: 1_037, ttlMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(37);
    const outcome = await sending;
    expect(outcome.value).toMatchObject({ status: 'submitted', msgId: 'msg-1' });
    expect(await native.readReceipts(query)).toMatchObject({ state: 'submitted', attempts: 0 });
});

it.each([
    { verdict: { kind: 'refused', reason: 'oversized', detail: 'Payload exceeds 8 bytes.' } as const, state: 'rejected', ok: false },
    { verdict: { kind: 'admitted', durable: true, queuedAttempts: 1 } as const, state: 'queued', ok: true }
])('uses the typed RTC $state lifecycle in the command outcome', async ({ verdict, state, ok }) => {
    const native = await loadRuntime();
    const delivery = createDelivery(verdict);
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
    facade.behavior.rtcMessageSend.mockResolvedValue(createDelivery({ kind: 'admitted', durable: true, queuedAttempts: 1 }).handle);
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
    const sender = createBrowserMessageSenderFixture(8).sender;
    facade.behavior.typedSend.mockImplementation(async (payload) => await sender.sendWs({ typeId: 'alm.conformance', topicId: 'room.conformance', payload }));
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
