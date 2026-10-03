import {
    afterEach,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { ALInboundAdmittedDelivery } from '@shared/alm/inbound/al-inbound-admitted-delivery.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { createDefaultWsQueueBoxClientService, type WsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { WsRtcSignalingTransportUsingWsQBox } from '@shared/webrtc/ws-rtc-signaling-transport-using-ws-q-box.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { TestWebSocket } from '../websocket/test-web-socket.ts';

interface ConsumerFixture {
    readonly service: WsQueueBoxClientService;
    readonly events: readonly ALInboundRuntimeDiagnosticsEvent[];
}

interface ConsumerFixtureInput {
    readonly sinkThrows: boolean;
}

const signal = {
    id: { v: 2, msgId: 'signal', ts: 1, senderId: 'sender' },
    route: { topicId: 'topic', resourceId: 'signal', contextId: 'context' },
    targets: { mode: 'unicast', toPeerId: 'receiver' },
    payload: { typeId: 'rtc-signaling', contentType: 'application/json', resource: '{}' }
};

function createConsumerFixture(input: ConsumerFixtureInput): ConsumerFixture {
    const events: ALInboundRuntimeDiagnosticsEvent[] = [];
    const service = createDefaultWsQueueBoxClientService({
        outbox: new InMemoryQueueBox(),
        socket: new JsonWebSocketClient('ws://unused', createPassThroughTransportFaultPort()),
        sessionId: 'receiver',
        serverPeerId: 'server',
        queueEngine: new InboxOutboxEngine(),
        inboundDiagnostics: (event) => {
            events.push(event);
            if (input.sinkThrows && event.kind === 'consumer-invocation') {
                throw new Error('private sink failure');
            }
        }
    });
    onTestFinished(() => service.close());
    return { service, events };
}

function consumerEvents(events: readonly ALInboundRuntimeDiagnosticsEvent[]) {
    return events.filter((event) => event.kind === 'consumer-invocation');
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    TestWebSocket.instances.length = 0;
});

it.each(['returned', 'retry', 'threw'] as const)('names an actual exact-type callback that %s, even with a failing sink', async (outcome) => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const fixture = createConsumerFixture({ sinkThrows: true });
    const calls: string[] = [];
    fixture.service.onInboxMessageDo('rtc-signaling', {
        onMessage: async () => {
            calls.push('exact');
            if (outcome === 'threw') {
                throw new Error('private callback error');
            }
            return outcome === 'retry' ? 'retry' : undefined;
        }
    });
    fixture.service.onAnyInboxMessageDo('observer', {
        onMessage: async () => {
            calls.push('any');
        }
    });
    await fixture.service.acceptIncomingMessage(signal);
    await expect.poll(() => consumerEvents(fixture.events).length).toBe(1);
    expect(calls).toEqual(outcome === 'returned' ? ['exact', 'any'] : ['exact']);
    expect(consumerEvents(fixture.events)).toEqual([{
        kind: 'consumer-invocation',
        msgId: 'signal',
        typeId: 'rtc-signaling',
        carrier: 'ws',
        selection: 'exact-type',
        outcome,
        beganAtMs: 100,
        settledAtMs: 100
    }]);
    expect(JSON.stringify(consumerEvents(fixture.events))).not.toContain('private');
});

it.each(['all-in', 'on-any'] as const)('does not label %s-only delivery as exact-type consumer invocation', async (selection) => {
    const fixture = createConsumerFixture({ sinkThrows: false });
    const calls: string[] = [];
    const callback = {
        onMessage: async () => {
            calls.push(selection);
        }
    };
    if (selection === 'all-in') {
        fixture.service.onAllInboxMessagesDo(callback);
    }
    else {
        fixture.service.onAnyInboxMessageDo('observer', callback);
    }
    await fixture.service.acceptIncomingMessage(signal);
    await expect.poll(() => calls).toEqual([selection]);
    expect(consumerEvents(fixture.events)).toMatchObject([{ selection: 'absent', outcome: 'not-invoked' }]);
});

it('does not report a deferred exact-type callback returned until it settles', async () => {
    const fixture = createConsumerFixture({ sinkThrows: false });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    onTestFinished(() => release.resolve());
    let calls = 0;
    fixture.service.onInboxMessageDo('rtc-signaling', {
        onMessage: async () => {
            calls += 1;
            entered.resolve();
            await release.promise;
        }
    });
    await fixture.service.acceptIncomingMessage(signal);
    await entered.promise;
    expect(calls).toBe(1);
    expect(consumerEvents(fixture.events)).toEqual([]);
    release.resolve();
    await expect.poll(() => consumerEvents(fixture.events)).toMatchObject([{ selection: 'exact-type', outcome: 'returned' }]);
});

it('reports returned invocation while closing prevents later wildcard and any callbacks', async () => {
    const fixture = createConsumerFixture({ sinkThrows: false });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const calls: string[] = [];
    onTestFinished(() => release.resolve());
    fixture.service.onInboxMessageDo('rtc-signaling', {
        onMessage: async () => {
            calls.push('exact');
            entered.resolve();
            await release.promise;
        }
    });
    fixture.service.onAllInboxMessagesDo({
        onMessage: async () => {
            calls.push('wildcard');
        }
    });
    fixture.service.onAnyInboxMessageDo('observer', {
        onMessage: async () => {
            calls.push('any');
        }
    });
    await fixture.service.acceptIncomingMessage(signal);
    await entered.promise;
    fixture.service.close();
    release.resolve();
    await expect.poll(() => consumerEvents(fixture.events)).toMatchObject([{ outcome: 'returned' }]);
    expect(calls).toEqual(['exact']);
    expect(fixture.events).toContainEqual(expect.objectContaining({ kind: 'dispatch-decision', disposition: 'port-retry' }));
});

it('keeps an exact callback return when expiry prevents subsequent consumers', async () => {
    let nowMs = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const fixture = createConsumerFixture({ sinkThrows: false });
    const calls: string[] = [];
    fixture.service.onInboxMessageDo('rtc-signaling', {
        onMessage: async () => {
            calls.push('exact');
            nowMs = 200;
        }
    });
    fixture.service.onAllInboxMessagesDo({
        onMessage: async () => {
            calls.push('wildcard');
        }
    });
    await fixture.service.acceptIncomingMessage({ ...signal, constraints: { expiresAtMs: 200 } });
    await expect.poll(() => consumerEvents(fixture.events)).toMatchObject([{ outcome: 'returned', beganAtMs: 100, settledAtMs: 200 }]);
    expect(calls).toEqual(['exact']);
    expect(fixture.events).toContainEqual(expect.objectContaining({ kind: 'dispatch-decision', disposition: 'port-threw' }));
});

it('does not leak message identity between simultaneous clients and later callbacks', async () => {
    const first = createConsumerFixture({ sinkThrows: false });
    const second = createConsumerFixture({ sinkThrows: false });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    onTestFinished(() => release.resolve());
    first.service.onInboxMessageDo('rtc-signaling', {
        onMessage: async () => {
            entered.resolve();
            await release.promise;
        }
    });
    second.service.onInboxMessageDo('rtc-signaling', { onMessage: async () => 'retry' });
    await first.service.acceptIncomingMessage(signal);
    await entered.promise;
    await second.service.acceptIncomingMessage({ ...signal, id: { ...signal.id, msgId: 'parallel' } });
    await expect.poll(() => consumerEvents(second.events)).toMatchObject([{ msgId: 'parallel', outcome: 'retry' }]);
    expect(consumerEvents(first.events)).toEqual([]);
    release.resolve();
    await expect.poll(() => consumerEvents(first.events)).toMatchObject([{ msgId: 'signal', outcome: 'returned' }]);
    await first.service.acceptIncomingMessage({ ...signal, id: { ...signal.id, msgId: 'later' } });
    await expect.poll(() => consumerEvents(first.events)).toMatchObject([{ msgId: 'signal', outcome: 'returned' }, { msgId: 'later', outcome: 'returned' }]);
});

it('observes a returned RTC receiver when that receiver catches its native callback error', async () => {
    vi.stubGlobal('WebSocket', TestWebSocket);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fixture = createConsumerFixture({ sinkThrows: true });
    const original = new Error('private native callback failure');
    let calls = 0;
    const transport = new WsRtcSignalingTransportUsingWsQBox(fixture.service, 'rtc-signaling');
    const connected = transport.connect({
        sessionId: 'receiver',
        token: 'test-token',
        callbacks: {
            onOpen: async () => {},
            onClose: async () => {},
            onError: async () => {},
            onMessage: async () => {
                calls += 1;
                throw original;
            }
        }
    });
    await Promise.resolve();
    const socket = TestWebSocket.instances.at(-1);
    if (socket === undefined) {
        throw new Error('Expected test WebSocket');
    }
    socket.open();
    await connected;
    await fixture.service.acceptIncomingMessage(signal);
    await expect.poll(() => consumerEvents(fixture.events)).toMatchObject([{ outcome: 'returned' }]);
    expect(calls).toBe(1);
    expect(errorLog).toHaveBeenCalledWith('Error in onMessage handler', original);
    expect(JSON.stringify(consumerEvents(fixture.events))).not.toContain('private');
});

it('preserves the exact callback error through admitted delivery when the consumer diagnostic sink fails', async () => {
    const fixture = createConsumerFixture({ sinkThrows: true });
    const original = new Error('original callback failure');
    let observedError: Error | undefined;
    let errorCount = 0;
    const deliver = ALInboundAdmittedDelivery.prototype.deliver;
    vi.spyOn(ALInboundAdmittedDelivery.prototype, 'deliver').mockImplementation(async function (this: ALInboundAdmittedDelivery, effect, observed) {
        try {
            return await deliver.call(this, effect, observed);
        }
        catch (error) {
            errorCount += 1;
            if (error instanceof Error) {
                observedError = error;
            }
            throw error;
        }
    });
    let calls = 0;
    fixture.service.onInboxMessageDo('rtc-signaling', {
        onMessage: async () => {
            calls += 1;
            throw original;
        }
    });
    await fixture.service.acceptIncomingMessage(signal);
    await expect.poll(() => errorCount).toBe(1);
    expect(calls).toBe(1);
    expect(observedError).toBe(original);
    expect(consumerEvents(fixture.events)).toMatchObject([{ selection: 'exact-type', outcome: 'threw' }]);
});
