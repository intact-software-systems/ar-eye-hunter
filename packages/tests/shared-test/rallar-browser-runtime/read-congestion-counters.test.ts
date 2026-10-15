import { beforeEach, expect, it } from 'vitest';

import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import { events, facade, loadRuntime, resetFacade } from './browser-rallar-runtime-test-harness.ts';

const CONNECTION = {
    connection: 'congestion',
    rallar: { apiBaseUrl: 'https://api.example.test', applicationId: 'app-1', username: 'alice', password: 'secret' }
};

function toCongestion(
    action: 'drop' | 'defer' | 'hand-over',
    carrier: 'ws' | 'rtc' = 'rtc'
): ALOutboundRuntimeDiagnosticsEvent {
    return { kind: 'congestion', carrier, cause: 'backpressured', action, priority: 0, msgId: `msg-${action}` };
}

function emitOutbound(event: ALOutboundRuntimeDiagnosticsEvent): void {
    facade.records.defaultWrites.at(-1)?.diagnosticsPorts?.outboundDiagnostics?.(event);
}

beforeEach(() => {
    resetFacade();
});

it('counts each congestion decision the page relays, by action, across both carriers', async () => {
    const runtime = await loadRuntime();
    await runtime.connect(CONNECTION);

    emitOutbound(toCongestion('drop'));
    emitOutbound(toCongestion('hand-over'));
    emitOutbound(toCongestion('defer'));
    emitOutbound(toCongestion('defer', 'ws'));
    emitOutbound({ kind: 'sender-queue-wait', senderId: 'sender-1', origin: 'send', queued: false, queuedBehindOrigin: 'none', durationMs: 0 });

    await expect(runtime.readCongestionCounters()).resolves.toEqual({
        dropped: 1,
        deferred: 2,
        handedOver: 1,
        rateLimited: 0,
        circuitOpen: 0,
        queuedBytesHighWater: 0
    });
    expect(events.filter((event) => event.topic === 'rallar.browser.alm.outbound_diagnostics')).toHaveLength(5);
});

it('counts the messages of each refused RTC hand-off by reason and keeps the highest queued bytes, with the ALM stream off', async () => {
    const runtime = await loadRuntime();
    await runtime.connect({ ...CONNECTION, rallar: { ...CONNECTION.rallar, almDiagnostics: false } });

    emitOutbound({ kind: 'rtc-handoff-refusal', reason: 'rate-limited', messageCount: 3 });
    emitOutbound({ kind: 'rtc-handoff-refusal', reason: 'rate-limited', messageCount: 1 });
    emitOutbound({ kind: 'rtc-handoff-refusal', reason: 'circuit-open', messageCount: 2 });
    emitOutbound({ kind: 'rtc-queued-bytes-high-water', queuedBytes: 4_096 });
    emitOutbound({ kind: 'rtc-queued-bytes-high-water', queuedBytes: 1_024 });

    await expect(runtime.readCongestionCounters()).resolves.toEqual({
        dropped: 0,
        deferred: 0,
        handedOver: 0,
        rateLimited: 4,
        circuitOpen: 2,
        queuedBytesHighWater: 4_096
    });
    expect(events.filter((event) => event.topic === 'rallar.browser.alm.outbound_diagnostics')).toEqual([]);
});

it('answers zero counts for a connected page that has decided nothing', async () => {
    const runtime = await loadRuntime();
    await runtime.connect(CONNECTION);

    await expect(runtime.readCongestionCounters()).resolves.toEqual({
        dropped: 0,
        deferred: 0,
        handedOver: 0,
        rateLimited: 0,
        circuitOpen: 0,
        queuedBytesHighWater: 0
    });
});

it('answers undefined before the facade is connected', async () => {
    const runtime = await loadRuntime();
    facade.behavior.isConnected.mockReturnValue(false);

    await expect(runtime.readCongestionCounters()).resolves.toBeUndefined();
});

it('counts from zero again after the page closes and reconnects', async () => {
    const runtime = await loadRuntime();
    await runtime.connect(CONNECTION);
    emitOutbound(toCongestion('drop'));
    emitOutbound(toCongestion('defer'));
    emitOutbound({ kind: 'rtc-handoff-refusal', reason: 'circuit-open', messageCount: 1 });
    emitOutbound({ kind: 'rtc-queued-bytes-high-water', queuedBytes: 2_048 });

    await runtime.close();
    await runtime.connect(CONNECTION);
    emitOutbound(toCongestion('hand-over'));

    await expect(runtime.readCongestionCounters()).resolves.toEqual({
        dropped: 0,
        deferred: 0,
        handedOver: 1,
        rateLimited: 0,
        circuitOpen: 0,
        queuedBytesHighWater: 0
    });
});
