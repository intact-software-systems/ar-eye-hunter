import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALQosPolicyRequest } from '@shared/al-contracts/al-policy.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import {
    createScriptedTransportFaultPort,
    type ScriptedTransportFault,
    type TransportFaultPort
} from '@shared/transport-faults/transport-fault-port.ts';

import {
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM,
    type CapturedChannel,
    type RtcOriginOverlayFixture
} from './rtc-origin-overlay-fixture.ts';
import { createRtcRelayOverlayFixture } from './rtc-relay-overlay-fixture.ts';

function createBackpressureOriginFixture(faultPort?: TransportFaultPort): RtcOriginOverlayFixture {
    return createRtcOriginOverlayFixture({
        snapshot: createOriginSnapshot(['a', 'b', 'c'], 4),
        nextHopPeerIds: ['b', 'c'],
        faultPort
    });
}

/** The reliable channel to one next hop, holding `bufferedAmount` bytes against its 64 KiB high watermark. */
function holdBuffered(captured: CapturedChannel, bufferedAmount: number): void {
    const health = captured.channel.readHealth();
    vi.mocked(captured.channel.readHealth).mockReturnValue({ ...health, bufferedAmount });
}

function holdAtHighWatermark(captured: CapturedChannel): void {
    holdBuffered(captured, captured.channel.readHealth().flowControl.highWatermarkBytes);
}

function createBestEffortMulticast(resourceId: string): ALMessage {
    return newALMulticastMessage(
        'a',
        { topicId: 'chat', resourceId, contextId: 'room' },
        ORIGIN_ROOM,
        'chat.message.v1',
        { text: resourceId },
        { reliability: 'best-effort', ack: 'none', ttlMs: 30_000 }
    );
}

const REJECT_UNDER_CONGESTION: ALQosPolicyRequest = { congestion: { algo: 'reject', opts: { priority: 9 } } };

function createRejectingMulticast(resourceId: string): ALMessage {
    return newALMulticastMessage(
        'a',
        { topicId: 'chat', resourceId, contextId: 'room' },
        ORIGIN_ROOM,
        'chat.message.v1',
        { text: resourceId },
        { reliability: 'at-least-once', ack: 'none', ttlMs: 30_000, qos: REJECT_UNDER_CONGESTION }
    );
}

/** Marks a hop's channel as not ready for sends, whatever it buffers. */
function holdReadyState(captured: CapturedChannel, readyState: 'connecting' | 'closed'): void {
    const health = captured.channel.readHealth();
    vi.mocked(captured.channel.readHealth).mockReturnValue({ ...health, readyState });
}

function createChatFault(carrier: ScriptedTransportFault['carrier']): ScriptedTransportFault {
    return {
        faultId: `${carrier}-full`,
        carrier,
        match: { controlType: undefined, typeId: 'chat.message.v1', msgId: undefined },
        action: 'backpressure',
        remaining: 'until-cleared'
    };
}

function readCongestion(fixture: RtcOriginOverlayFixture) {
    return fixture.diagnostics.filter((event) => event.kind === 'congestion');
}

describe('the RTC origin\'s backpressure read of its ready next hops (D184, D185)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('refuses a best-effort room send as congested when every ready next hop is at its high watermark', async () => {
        const fixture = createBackpressureOriginFixture();
        holdAtHighWatermark(fixture.channels.b!);
        holdAtHighWatermark(fixture.channels.c!);
        const message = createBestEffortMulticast('every-hop-full');

        const verdict = (await enqueueAndDrain(fixture.manager, message)).verdict;

        expect(verdict).toMatchObject({ kind: 'refused', reason: 'congested' });
        expect(fixture.channels.b!.sent).toEqual([]);
        expect(fixture.channels.c!.sent).toEqual([]);
        expect(readCongestion(fixture)).toEqual([{
            kind: 'congestion',
            carrier: 'rtc',
            cause: 'backpressured',
            action: 'drop',
            priority: 0,
            msgId: message.id.msgId
        }]);
    });

    it('admits the send while one ready next hop can still take it, and sends on that hop', async () => {
        const fixture = createBackpressureOriginFixture();
        holdAtHighWatermark(fixture.channels.b!);
        holdBuffered(fixture.channels.c!, fixture.channels.c!.channel.readHealth().flowControl.highWatermarkBytes - 1);

        const verdict = (await enqueueAndDrain(fixture.manager, createBestEffortMulticast('one-hop-free'))).verdict;

        expect(verdict.kind).toBe('admitted');
        expect(fixture.channels.b!.sent).toEqual([]);
        expect(fixture.channels.c!.sent).toHaveLength(1);
    });

    it.each(['connecting', 'closed'] as const)(
        'reads only the next hops that are ready: a %s hop does not keep a send from being refused',
        async (readyState) => {
            const fixture = createBackpressureOriginFixture();
            holdReadyState(fixture.channels.b!, readyState);
            holdAtHighWatermark(fixture.channels.c!);

            const verdict = (await enqueueAndDrain(fixture.manager, createBestEffortMulticast(`${readyState}-hop`))).verdict;

            expect(verdict).toMatchObject({ kind: 'refused', reason: 'congested' });
            expect(fixture.channels.c!.sent).toEqual([]);
        }
    );

    it('does not count a hop that is not ready as full: with the ready hop free, the send is admitted', async () => {
        const fixture = createBackpressureOriginFixture();
        holdReadyState(fixture.channels.b!, 'closed');
        holdBuffered(fixture.channels.b!, 1_000_000);
        const message = createBestEffortMulticast('ready-hop-free');

        const verdict = (await enqueueAndDrain(fixture.manager, message)).verdict;

        expect(verdict.kind).toBe('admitted');
        expect(fixture.channels.c!.sent.map((sent) => sent.id.msgId)).toEqual([message.id.msgId]);
        expect(readCongestion(fixture)).toEqual([]);
    });

    it('admits an at-least-once send through backpressure and defers its submission on each full hop', async () => {
        const fixture = createBackpressureOriginFixture();
        holdAtHighWatermark(fixture.channels.b!);
        holdAtHighWatermark(fixture.channels.c!);
        const message = createOriginReceiverMulticast('deferred');

        const verdict = (await enqueueAndDrain(fixture.manager, message)).verdict;

        expect(verdict.kind).toBe('admitted');
        expect(fixture.channels.b!.sent).toEqual([]);
        expect(readCongestion(fixture)).toEqual([
            { kind: 'congestion', carrier: 'rtc', cause: 'backpressured', action: 'defer', priority: 5, msgId: message.id.msgId },
            { kind: 'congestion', carrier: 'rtc', cause: 'backpressured', action: 'defer', priority: 5, msgId: message.id.msgId }
        ]);
        expect(fixture.settlements).toContainEqual(expect.objectContaining({
            kind: 'attempt-settled',
            msgId: message.id.msgId,
            outcome: 'not-ready',
            submissionAttempted: false,
            willRetry: true
        }));
    });

    it('sends a deferred send once its hop drains, after the shared retry delay', async () => {
        const fixture = createBackpressureOriginFixture();
        holdAtHighWatermark(fixture.channels.b!);
        holdAtHighWatermark(fixture.channels.c!);
        const message = createOriginReceiverMulticast('drained');
        await enqueueAndDrain(fixture.manager, message);

        holdBuffered(fixture.channels.b!, 0);
        holdBuffered(fixture.channels.c!, 0);
        await vi.advanceTimersByTimeAsync(49);
        expect(fixture.channels.b!.sent).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);

        expect(fixture.channels.b!.sent.map((sent) => sent.id.msgId)).toEqual([message.id.msgId]);
        expect(fixture.channels.c!.sent.map((sent) => sent.id.msgId)).toEqual([message.id.msgId]);
    });

    it('holds the carrier backpressured for a message a scripted RTC fault matches, whatever its channels hold', async () => {
        const faults = createScriptedTransportFaultPort();
        faults.inject(createChatFault('rtc'));
        const fixture = createBackpressureOriginFixture(faults);

        const verdict = (await enqueueAndDrain(fixture.manager, createBestEffortMulticast('scripted-full'))).verdict;

        expect(verdict).toMatchObject({ kind: 'refused', reason: 'congested' });
        expect(faults.getObservations()).toEqual([{ faultId: 'rtc-full', carrier: 'rtc', decision: 'backpressure' }]);
    });

    it('reads no scripted fault of the WS carrier', async () => {
        const faults = createScriptedTransportFaultPort();
        faults.inject(createChatFault('ws'));
        const fixture = createBackpressureOriginFixture(faults);

        const verdict = (await enqueueAndDrain(fixture.manager, createBestEffortMulticast('ws-fault'))).verdict;

        expect(verdict.kind).toBe('admitted');
        expect(fixture.channels.b!.sent).toHaveLength(1);
        expect(faults.getObservations()).toEqual([]);
    });
});

describe('what never reads backpressure (D184)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('defers a reject-policy send that meets full hops when it is dequeued, never refusing it', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const fixture = createBackpressureOriginFixture();
        await enqueueAndDrain(fixture.manager, createBestEffortMulticast('starts-the-queue-engine'));
        holdAtHighWatermark(fixture.channels.b!);
        holdAtHighWatermark(fixture.channels.c!);
        const message = createRejectingMulticast('dequeued');
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.RTC_OUTBOX);

        await fixture.manager.outbox.enqueueIfAbsent({
            ...entry,
            dequeueAudit: { ...entry.dequeueAudit, nextTs: Temporal.Instant.fromEpochMilliseconds(Date.now()) }
        });
        fixture.resources.queueEngine.wakeAfterExternalWrite();
        await vi.advanceTimersByTimeAsync(100);
        holdBuffered(fixture.channels.b!, 0);
        holdBuffered(fixture.channels.c!, 0);
        await vi.advanceTimersByTimeAsync(200);

        expect(readCongestion(fixture).map((event) => event.action)).toContain('defer');
        expect(readCongestion(fixture).map((event) => event.action)).not.toContain('drop');
        expect(fixture.channels.b!.sent.map((sent) => sent.id.msgId)).toContain(message.id.msgId);
    });

    it('forwards another session\'s best-effort message, leaving the full channel to its submission', async () => {
        const faults = createScriptedTransportFaultPort();
        faults.inject({ ...createChatFault('rtc'), remaining: 1 });
        const snapshot = createOriginSnapshot(['a', 'b', 'c', 'd'], 4);
        const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['b', 'c'] });
        const relay = createRtcRelayOverlayFixture({ selfPeerId: 'b', snapshot, neighbourPeerIds: ['a', 'c', 'd'], faultPort: faults });
        const message = createBestEffortMulticast('forwarded');
        await origin.manager.enqueueIfAbsent(message);
        await expect.poll(() => origin.channels.b!.sent).toHaveLength(1);

        await relay.receive(origin.channels.b!.sent[0]!, 'a');

        await expect.poll(async () => (await relay.readSent('d')).map((sent) => sent.id.msgId)).toEqual([message.id.msgId]);
        expect(faults.getObservations()).toEqual([{ faultId: 'rtc-full', carrier: 'rtc', decision: 'backpressure' }]);
    });
});
