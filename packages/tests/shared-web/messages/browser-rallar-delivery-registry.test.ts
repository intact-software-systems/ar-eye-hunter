import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_DELIVERY_ADMITTED_STATES,
    type ALDeliverySettlement,
    type ALDeliverySettlementSink
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

const START_MS = 10_000;
const RETAIN_TERMINAL_MS = 60_000;
const MAX_ENTRIES = 512;

describe('BrowserRallarDeliveryRegistry', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('open', () => {
        it('returns a submitted handle carrying the envelope identity', () => {
            const harness = createHarness();

            const handle = harness.registry.open(toTestMessage('msg-1'), 'rtc');

            expect(handle.msgId).toBe('msg-1');
            expect(handle.typeId).toBe('chat.message.v1');
            expect(handle.lifecycle().state).toBe('submitted');
            expect(handle.lifecycle().ackMode).toBe('receiver');
            expect(harness.registry.size()).toBe(1);
        });

        it('returns the same handle when the same envelope is opened again', () => {
            const harness = createHarness();
            const message = toTestMessage('msg-1');

            const first = harness.registry.open(message, 'rtc');
            const second = harness.registry.open(message, 'ws');

            expect(second).toBe(first);
            expect(harness.registry.size()).toBe(1);
        });

        it('defaults the ack mode to none when the envelope carries no delivery block', () => {
            const harness = createHarness();

            const handle = harness.registry.open(toBestEffortTestMessage('msg-1'), 'rtc');

            expect(handle.lifecycle().ackMode).toBe('none');
        });

        it('arms no timer for an opened message', () => {
            const harness = createHarness();

            harness.registry.open(toExpiringTestMessage('msg-1', START_MS + 5_000), 'rtc');
            harness.sink(toAdmittedSettlement('msg-1', START_MS));

            expect(vi.getTimerCount()).toBe(0);
        });
    });

    describe('record', () => {
        it('moves the lifecycle through admission, attempt start, and transport acceptance', () => {
            const harness = createHarness();
            const handle = harness.registry.open(toTestMessage('msg-1'), 'rtc');

            harness.sink(toAdmittedSettlement('msg-1', START_MS));
            expect(handle.lifecycle().state).toBe('accepted');

            harness.sink(toAttemptStartedSettlement('msg-1', START_MS));
            expect(handle.lifecycle().state).toBe('accepted');
            expect(handle.lifecycle().evidence.attempts).toHaveLength(1);

            harness.sink(toAttemptSentSettlement('msg-1', START_MS));
            expect(handle.lifecycle().state).toBe('transport-accepted');
        });

        it('notifies a listener once per settlement, in order', () => {
            const harness = createHarness();
            const handle = harness.registry.open(toTestMessage('msg-1'), 'rtc');
            const states: string[] = [];
            handle.onEvent((lifecycle) => {
                states.push(lifecycle.state);
            });

            harness.sink(toAdmittedSettlement('msg-1', START_MS));
            harness.sink(toAttemptStartedSettlement('msg-1', START_MS));
            harness.sink(toAttemptSentSettlement('msg-1', START_MS));

            expect(states).toEqual(['accepted', 'accepted', 'transport-accepted']);
        });

        it('stops notifying a listener after it unsubscribes', () => {
            const harness = createHarness();
            const handle = harness.registry.open(toTestMessage('msg-1'), 'rtc');
            const states: string[] = [];

            const unsubscribe = handle.onEvent((lifecycle) => {
                states.push(lifecycle.state);
            });
            harness.sink(toAdmittedSettlement('msg-1', START_MS));
            unsubscribe();
            harness.sink(toAttemptStartedSettlement('msg-1', START_MS));

            expect(states).toEqual(['accepted']);
        });

        it('does not await an async listener', () => {
            const harness = createHarness();
            const handle = harness.registry.open(toTestMessage('msg-1'), 'rtc');
            let listenerSettled = false;
            handle.onEvent(async () => {
                await Promise.resolve();
                listenerSettled = true;
            });

            harness.sink(toAdmittedSettlement('msg-1', START_MS));

            expect(listenerSettled).toBe(false);
            expect(handle.lifecycle().state).toBe('accepted');
        });

        it('ignores a settlement for a msgId it never opened', () => {
            const harness = createHarness();

            harness.sink(toAdmittedSettlement('msg-unknown', START_MS));

            expect(harness.registry.size()).toBe(0);
        });

        it('drops settlements written into a closed sink', () => {
            const harness = createHarness();
            const handle = harness.registry.open(toTestMessage('msg-1'), 'rtc');

            harness.closeSink();
            harness.sink(toAdmittedSettlement('msg-1', START_MS));

            expect(handle.lifecycle().state).toBe('submitted');
        });

        it('keeps delivering through a second sink after the first is closed', () => {
            const harness = createHarness();
            const handle = harness.registry.open(toTestMessage('msg-1'), 'rtc');
            const second = harness.registry.createSink();

            harness.closeSink();
            second.sink(toAdmittedSettlement('msg-1', START_MS));

            expect(handle.lifecycle().state).toBe('accepted');
        });
    });

    describe('wait', () => {
        it('resolves settled at the first terminal state', async () => {
            const harness = createHarness();
            const handle = harness.registry.open(toTestMessage('msg-1'), 'rtc');

            const pending = handle.wait();
            harness.sink(toAdmittedSettlement('msg-1', START_MS));
            harness.sink(toAcknowledgementSettlement('msg-1', START_MS));

            const outcome = await pending;
            expect(outcome.status).toBe('settled');
            expect(outcome.lifecycle.state).toBe('acknowledged');
        });

        it('resolves settled without arming a timer when the condition already holds', async () => {
            const harness = createHarness();
            const handle = harness.registry.open(toTestMessage('msg-1'), 'rtc');
            harness.sink(toAdmittedSettlement('msg-1', START_MS));
            harness.sink(toAcknowledgementSettlement('msg-1', START_MS));

            const pending = handle.wait({ timeoutMs: 1_000 });
            expect(vi.getTimerCount()).toBe(0);

            expect((await pending).status).toBe('settled');
        });

        it('resolves settled at an admitted state listed in until', async () => {
            const harness = createHarness();
            const handle = harness.registry.open(toTestMessage('msg-1'), 'rtc');

            const pending = handle.wait({ until: AL_DELIVERY_ADMITTED_STATES });
            harness.sink(toAdmittedSettlement('msg-1', START_MS));

            const outcome = await pending;
            expect(outcome.status).toBe('settled');
            expect(outcome.lifecycle.state).toBe('accepted');
        });

        it('resolves timeout with the current lifecycle after timeoutMs', async () => {
            const harness = createHarness();
            const handle = harness.registry.open(toTestMessage('msg-1'), 'rtc');
            harness.sink(toAdmittedSettlement('msg-1', START_MS));

            const pending = handle.wait({ timeoutMs: 500 });
            await harness.advanceMs(500);

            const outcome = await pending;
            expect(outcome.status).toBe('timeout');
            expect(outcome.lifecycle.state).toBe('accepted');
            expect(vi.getTimerCount()).toBe(0);
        });

        it('resolves aborted when the signal aborts while the wait is armed', async () => {
            const harness = createHarness();
            const handle = harness.registry.open(toTestMessage('msg-1'), 'rtc');
            const controller = new AbortController();

            const pending = handle.wait({ timeoutMs: 5_000, signal: controller.signal });
            controller.abort();

            const outcome = await pending;
            expect(outcome.status).toBe('aborted');
            expect(outcome.lifecycle.state).toBe('submitted');
            expect(vi.getTimerCount()).toBe(0);
        });

        it('resolves aborted without arming a timer when the signal already aborted', async () => {
            const harness = createHarness();
            const handle = harness.registry.open(toTestMessage('msg-1'), 'rtc');

            const pending = handle.wait({ timeoutMs: 5_000, signal: AbortSignal.abort() });
            expect(vi.getTimerCount()).toBe(0);

            expect((await pending).status).toBe('aborted');
        });

        it('clears both timers when a settlement resolves the wait', async () => {
            const harness = createHarness();
            const handle = harness.registry.open(toExpiringTestMessage('msg-1', START_MS + 5_000), 'rtc');

            const pending = handle.wait({ timeoutMs: 1_000 });
            expect(vi.getTimerCount()).toBe(2);
            harness.sink(toCancelledSettlement('msg-1', START_MS));

            expect((await pending).status).toBe('settled');
            expect(vi.getTimerCount()).toBe(0);
        });
    });

    describe('the message deadline', () => {
        it('reads expired once the deadline has elapsed', () => {
            const harness = createHarness();
            const handle = harness.registry.open(toExpiringTestMessage('msg-1', START_MS - 1), 'rtc');

            const lifecycle = handle.lifecycle();

            expect(lifecycle.state).toBe('expired');
            expect(lifecycle.evidence.reason).toBe('The deadline elapsed before a terminal settlement.');
        });

        it('notifies listeners when a lazy read crosses the deadline', () => {
            const harness = createHarness();
            const handle = harness.registry.open(toExpiringTestMessage('msg-1', START_MS + 100), 'rtc');
            const states: string[] = [];
            handle.onEvent((lifecycle) => {
                states.push(lifecycle.state);
            });

            harness.setNowMs(START_MS + 100);

            expect(handle.lifecycle().state).toBe('expired');
            expect(states).toEqual(['expired']);
            expect(handle.lifecycle().state).toBe('expired');
            expect(states).toEqual(['expired']);
        });

        it('expires a pending wait when the deadline timer fires', async () => {
            const harness = createHarness();
            const handle = harness.registry.open(toExpiringTestMessage('msg-1', START_MS + 100), 'rtc');

            const pending = handle.wait();
            await harness.advanceMs(100);

            const outcome = await pending;
            expect(outcome.status).toBe('settled');
            expect(outcome.lifecycle.state).toBe('expired');
            expect(vi.getTimerCount()).toBe(0);
        });
    });

    describe('cancel', () => {
        it('calls the port once and records cancelled with the last seen carrier', () => {
            const harness = createHarness();
            const handle = harness.registry.open(toTestMessage('msg-1'), 'rtc');
            harness.sink(toAdmittedSettlement('msg-1', START_MS));

            handle.cancel();

            expect(harness.cancelledMsgIds).toEqual(['msg-1']);
            const lifecycle = handle.lifecycle();
            expect(lifecycle.state).toBe('cancelled');
            expect(lifecycle.evidence.reason).toBe('Cancelled by the sender.');
        });

        it('records nothing more when the owner cancelled synchronously inside the port call', () => {
            const harness = createHarness();
            const handle = harness.registry.open(toTestMessage('msg-1'), 'rtc');
            const states: string[] = [];
            handle.onEvent((lifecycle) => {
                states.push(lifecycle.state);
            });
            harness.onCancel((msgId) => {
                harness.sink(toCancelledSettlement(msgId, START_MS));
            });

            handle.cancel();

            expect(states).toEqual(['cancelled']);
            expect(handle.lifecycle().lateSettlementCount).toBe(0);
        });

        it('is a no-op on a terminal handle and does not call the port', () => {
            const harness = createHarness();
            const handle = harness.registry.open(toTestMessage('msg-1'), 'rtc');
            harness.sink(toAcknowledgementSettlement('msg-1', START_MS));

            handle.cancel();

            expect(harness.cancelledMsgIds).toEqual([]);
            expect(handle.lifecycle().state).toBe('acknowledged');
        });
    });

    describe('retention', () => {
        it('releases the oldest non-terminal entry unobservable once maxEntries is exceeded', async () => {
            const harness = createHarness({ retainTerminalMs: RETAIN_TERMINAL_MS, maxEntries: 2 });
            const oldest = harness.registry.open(toTestMessage('msg-1'), 'rtc');
            const pending = oldest.wait();
            harness.registry.open(toTestMessage('msg-2'), 'rtc');

            harness.registry.open(toTestMessage('msg-3'), 'rtc');

            expect(harness.registry.size()).toBe(2);
            expect(oldest.lifecycle().state).toBe('unobservable');
            expect(oldest.lifecycle().evidence.reason).toBe('The observation was lost before a terminal settlement.');
            const outcome = await pending;
            expect(outcome.status).toBe('settled');
            expect(outcome.lifecycle.state).toBe('unobservable');
        });

        it('ignores later settlements for a released entry', () => {
            const harness = createHarness({ retainTerminalMs: RETAIN_TERMINAL_MS, maxEntries: 1 });
            const released = harness.registry.open(toTestMessage('msg-1'), 'rtc');

            harness.registry.open(toTestMessage('msg-2'), 'rtc');
            harness.sink(toAdmittedSettlement('msg-1', START_MS));

            expect(released.lifecycle().state).toBe('unobservable');
        });

        it('drops terminal entries older than retainTerminalMs', () => {
            const harness = createHarness({ retainTerminalMs: 1_000, maxEntries: MAX_ENTRIES });
            harness.registry.open(toTestMessage('msg-1'), 'rtc');
            harness.sink(toAcknowledgementSettlement('msg-1', START_MS));

            harness.setNowMs(START_MS + 1_001);
            harness.registry.open(toTestMessage('msg-2'), 'rtc');

            expect(harness.registry.size()).toBe(1);
        });

        it('keeps a terminal entry until retainTerminalMs elapses', () => {
            const harness = createHarness({ retainTerminalMs: 1_000, maxEntries: MAX_ENTRIES });
            harness.registry.open(toTestMessage('msg-1'), 'rtc');
            harness.sink(toAcknowledgementSettlement('msg-1', START_MS));

            harness.setNowMs(START_MS + 1_000);
            harness.registry.open(toTestMessage('msg-2'), 'rtc');

            expect(harness.registry.size()).toBe(2);
        });

        it('drops the oldest terminal entry before releasing a younger non-terminal one', () => {
            const harness = createHarness({ retainTerminalMs: RETAIN_TERMINAL_MS, maxEntries: 2 });
            harness.registry.open(toTestMessage('msg-1'), 'rtc');
            const live = harness.registry.open(toTestMessage('msg-2'), 'rtc');
            harness.sink(toAcknowledgementSettlement('msg-1', START_MS));

            harness.registry.open(toTestMessage('msg-3'), 'rtc');

            expect(harness.registry.size()).toBe(2);
            expect(live.lifecycle().state).toBe('submitted');
        });
    });

    describe('releaseAll', () => {
        it('resolves every non-terminal entry unobservable and keeps the entries', async () => {
            const harness = createHarness();
            const live = harness.registry.open(toTestMessage('msg-1'), 'rtc');
            const settled = harness.registry.open(toTestMessage('msg-2'), 'rtc');
            harness.sink(toAcknowledgementSettlement('msg-2', START_MS));
            const pending = live.wait();

            harness.registry.releaseAll();

            expect(live.lifecycle().state).toBe('unobservable');
            expect(settled.lifecycle().state).toBe('acknowledged');
            expect(harness.registry.size()).toBe(2);
            expect((await pending).lifecycle.state).toBe('unobservable');
        });
    });
});

interface DeliveryRegistryHarness {
    readonly registry: BrowserRallarDeliveryRegistry;
    /** What crossed the cancel port, in order. */
    readonly cancelledMsgIds: readonly string[];
    readonly sink: ALDeliverySettlementSink;
    closeSink(): void;
    /** Stands in for a carrier owner that states its own `cancelled` inside the port call. */
    onCancel(emit: (msgId: string) => void): void;
    setNowMs(nowMs: number): void;
    advanceMs(durationMs: number): Promise<void>;
}

interface DeliveryRegistryLimits {
    readonly retainTerminalMs: number;
    readonly maxEntries: number;
}

function createHarness(
    limits: DeliveryRegistryLimits = { retainTerminalMs: RETAIN_TERMINAL_MS, maxEntries: MAX_ENTRIES }
): DeliveryRegistryHarness {
    let currentMs = START_MS;
    const cancelledMsgIds: string[] = [];
    const cancelEmitters = new Set<(msgId: string) => void>();
    const registry = new BrowserRallarDeliveryRegistry({
        nowMs: () => currentMs,
        retainTerminalMs: limits.retainTerminalMs,
        maxEntries: limits.maxEntries,
        cancel: (msgId) => {
            cancelledMsgIds.push(msgId);
            for (const emit of cancelEmitters) {
                emit(msgId);
            }
        }
    });
    const carrier = registry.createSink();

    return {
        registry,
        cancelledMsgIds,
        sink: carrier.sink,
        closeSink: () => carrier.close(),
        onCancel: (emit) => {
            cancelEmitters.add(emit);
        },
        setNowMs: (nowMs) => {
            currentMs = nowMs;
        },
        advanceMs: async (durationMs) => {
            currentMs += durationMs;
            await vi.advanceTimersByTimeAsync(durationMs);
        }
    };
}

function toTestMessage(msgId: string): ALMessage {
    return {
        id: { v: 2, msgId, ts: START_MS, senderId: 'sender-1' },
        route: { topicId: 'room.chat', contextId: 'room-1', resourceId: 'chat' },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'chat.message.v1', resource: '{}' }
    };
}

function toExpiringTestMessage(msgId: string, expiresAtMs: number): ALMessage {
    return { ...toTestMessage(msgId), constraints: { expiresAtMs } };
}

function toBestEffortTestMessage(msgId: string): ALMessage {
    return {
        id: { v: 2, msgId, ts: START_MS, senderId: 'sender-1' },
        route: { topicId: 'room.chat', contextId: 'room-1', resourceId: 'chat' },
        payload: { typeId: 'chat.message.v1', resource: '{}' }
    };
}

function toAdmittedSettlement(msgId: string, atMs: number): ALDeliverySettlement {
    return {
        kind: 'admission',
        msgId,
        carrier: 'rtc',
        atMs,
        verdict: { kind: 'admitted', durable: true, queuedAttempts: 0 }
    };
}

function toAttemptStartedSettlement(msgId: string, atMs: number): ALDeliverySettlement {
    return { kind: 'attempt-started', msgId, carrier: 'rtc', atMs, attemptId: 'attempt-1' };
}

function toAttemptSentSettlement(msgId: string, atMs: number): ALDeliverySettlement {
    return {
        kind: 'attempt-settled',
        msgId,
        carrier: 'rtc',
        atMs,
        attemptId: 'attempt-1',
        outcome: 'sent',
        submissionAttempted: true,
        detail: undefined,
        willRetry: false
    };
}

function toAcknowledgementSettlement(msgId: string, atMs: number): ALDeliverySettlement {
    return {
        kind: 'acknowledgement',
        msgId,
        carrier: 'rtc',
        atMs,
        confirmedHopPeerIds: ['peer-1'],
        unconfirmedHopPeerIds: [],
        complete: true
    };
}

function toCancelledSettlement(msgId: string, atMs: number): ALDeliverySettlement {
    return { kind: 'cancelled', msgId, carrier: 'rtc', atMs };
}
