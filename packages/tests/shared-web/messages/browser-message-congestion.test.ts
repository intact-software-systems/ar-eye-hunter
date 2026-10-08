import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { BROWSER_DELIVERY_RETENTION } from '@shared-web/browser/composition/browser-delivery-composition.ts';
import { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserRallarMessageDispatch } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALDeliveryCarrier, ALDeliveryLifecycle } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type {
    ALOutboundCongestionDiagnostic,
    ALOutboundRuntimeDiagnosticsEvent
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import {
    AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES,
    createDefaultWsQueueBoxClientService,
    type WsQueueBoxClientService
} from '@shared/services/ws-queue-box-client-service.ts';
import {
    createScriptedTransportFaultPort,
    type ScriptedTransportFault,
    type ScriptedTransportFaultPort
} from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import {
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    ORIGIN_ROOM,
    type RtcOriginOverlayFixture
} from '../../shared/multicast/rtc-origin-overlay-fixture.ts';
import { TestWebSocket } from '../../shared/websocket/test-web-socket.ts';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

const TYPE_ID = 'chat.message.v1';

type CongestionStrategy = 'rtc' | 'ws' | 'rtc-with-ws-fallback';

/**
 * The facade's admission owners (dispatch, registry and session deliveries) over the two real carriers of origin `a`:
 * the RTC overlay with open channels to its next hops `b` and `c`, and the WS client on a test socket. One scripted
 * fault port serves both, as the connect's diagnostics ports do, and both carriers settle into the registry.
 */
interface CongestionFixture {
    readonly faults: ScriptedTransportFaultPort;
    readonly rtc: RtcOriginOverlayFixture;
    readonly socket: TestWebSocket;
    send(strategy: CongestionStrategy, reliability: 'best-effort' | 'at-least-once', ack?: 'receiver'): RallarMessageHandle;
    /** The WS client's own ingress, as its socket's message callback admits a frame. */
    acceptOnWs(message: ALMessage): Promise<void>;
    /** The session's congestion diagnostics: the RTC overlay's, then the WS client's and the dispatch's in order. */
    readCongestion(): readonly ALOutboundCongestionDiagnostic[];
}

interface CongestionCarriers {
    readonly rtc: RtcOriginOverlayFixture;
    readonly ws: WsQueueBoxClientService;
    readonly socket: TestWebSocket;
}

async function openCongestionCarriers(
    faults: ScriptedTransportFaultPort,
    deliveries: BrowserRallarDeliveryRegistry,
    diagnostics: ALOutboundRuntimeDiagnosticsEvent[]
): Promise<CongestionCarriers> {
    vi.stubGlobal('WebSocket', TestWebSocket);
    const rtc = createRtcOriginOverlayFixture({
        snapshot: createOriginSnapshot(['a', 'b', 'c'], 4),
        nextHopPeerIds: ['b', 'c'],
        faultPort: faults,
        onSettlement: (settlement) => deliveries.record(settlement)
    });
    const socket = new JsonWebSocketClient(() => 'ws://congestion-test', faults);
    const ws = createDefaultWsQueueBoxClientService({
        socket,
        sessionId: 'a',
        serverPeerId: 'server',
        outbox: new InMemoryQueueBox(),
        outboundSettlements: (settlement) => deliveries.record(settlement),
        outboundDiagnostics: (event) => diagnostics.push(event)
    });
    onTestFinished(() => {
        ws.close();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });
    const connecting = socket.connect();
    await Promise.resolve();
    const native = TestWebSocket.instances[0]!;
    native.open();
    await connecting;
    return { rtc, ws, socket: native };
}

async function openCongestionFixture(): Promise<CongestionFixture> {
    const faults = createScriptedTransportFaultPort();
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const deliveries = new BrowserRallarDeliveryRegistry({ nowMs: Date.now, ...BROWSER_DELIVERY_RETENTION, cancel: () => {} });
    const { rtc, ws, socket } = await openCongestionCarriers(faults, deliveries, diagnostics);
    const context = createDefaultApiMiddlewareTestDouble({
        session: { sessionId: 'a' },
        middleware: {
            rtcRxStreamer: {
                enqueueOutboxIfAbsent: async (message, carrierGap) => await rtc.manager.enqueueLegIfAbsent(message, carrierGap),
                handOverOutbox: async (msgId) => await rtc.manager.handOver(msgId)
            },
            webSocketQueueBox: { enqueueOutboxIfAbsent: async (message) => await ws.enqueueOutboxIfAbsent(message) },
            outboundDiagnostics: (event) => diagnostics.push(event)
        }
    });
    const feed = new BrowserDeliverySettlements();
    const sessionDeliveries = new BrowserSessionDeliveries(deliveries, { deliverySettlements: feed, readMiddleware: () => context });
    sessionDeliveries.beginSession(context.session);
    feed.open(sessionDeliveries.observers, { relaySettlement: () => {} });
    const dispatch = new BrowserRallarMessageDispatch({ deliveries, sessionDeliveries, nowMs: Date.now });
    let sequence = 0;
    return {
        faults,
        rtc,
        socket,
        send: (strategy, reliability, ack) => {
            sequence += 1;
            const message = newALMulticastMessage(
                'a',
                { topicId: 'chat', resourceId: `congested-${sequence}`, contextId: 'room' },
                ORIGIN_ROOM,
                TYPE_ID,
                { sequence },
                ack === undefined
                    ? { reliability, ack: 'none', ttlMs: 30_000 }
                    : { reliability, ack, ttlMs: 30_000, qos: { ack: { algo: 'hop' } } }
            );
            const carrier: ALDeliveryCarrier = strategy === 'ws' ? 'ws' : 'rtc';
            const handle = deliveries.open(message, carrier);
            dispatch.send({ context, carrier, message, canFallback: strategy === 'rtc-with-ws-fallback', payloadIssues: [], onStorageUnavailable: 'refuse' });
            return handle;
        },
        acceptOnWs: async (message) => void await ws.acceptIncomingMessage(message),
        readCongestion: () =>
            [...rtc.diagnostics, ...diagnostics].filter(
                (event): event is ALOutboundCongestionDiagnostic => event.kind === 'congestion'
            )
    };
}

function toBackpressureFault(carrier: ScriptedTransportFault['carrier'], remaining: ScriptedTransportFault['remaining']): ScriptedTransportFault {
    return {
        faultId: `${carrier}-at-watermark`,
        carrier,
        match: { controlType: undefined, typeId: TYPE_ID, msgId: undefined },
        action: 'backpressure',
        remaining
    };
}

/** The WS hop's ACK: a WS origin's one hop is the server. */
function toServerAck(msgId: string): ALMessage {
    return newALAckControlMessage(
        { v: 3, msgId: `ack-${msgId}`, senderId: 'server', ts: Date.now() },
        {
            ackedMsgId: msgId,
            originPeerId: 'a',
            logicalRecipientPeerId: 'server',
            fromPeerId: 'server',
            toPeerId: 'a',
            status: 'accepted',
            observedAtEpochMs: Date.now(),
            carrier: 'ws'
        }
    );
}

function toAttemptRows(lifecycle: ALDeliveryLifecycle) {
    return lifecycle.evidence.attempts.map(({ carrier, outcome, refusalReason, submissionAttempted }) => ({
        carrier,
        outcome,
        refusalReason,
        submissionAttempted
    }));
}

describe('a best-effort send its carrier holds at the watermark, through the facade\'s admission over the real carriers', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('hands the RTC leg to WS under rtc-with-ws-fallback, which carries it to its acknowledgement, and reports the drop and the hand-over', async () => {
        const fixture = await openCongestionFixture();
        fixture.faults.inject(toBackpressureFault('rtc', 'until-cleared'));

        const handle = fixture.send('rtc-with-ws-fallback', 'best-effort', 'receiver');
        await vi.advanceTimersByTimeAsync(0);
        await fixture.acceptOnWs(toServerAck(handle.msgId));
        await vi.advanceTimersByTimeAsync(0);
        const { lifecycle } = await handle.wait();

        expect(lifecycle.state).toBe('acknowledged');
        expect(toAttemptRows(lifecycle)).toEqual([
            { carrier: 'rtc', outcome: 'refused', refusalReason: 'congested', submissionAttempted: false },
            { carrier: 'ws', outcome: 'sent', refusalReason: undefined, submissionAttempted: true }
        ]);
        expect(lifecycle.evidence.carrierFallback).toBeUndefined();
        expect(fixture.rtc.channels.b!.sent).toEqual([]);
        expect(fixture.rtc.channels.c!.sent).toEqual([]);
        expect(fixture.socket.sent.map((frame) => JSON.parse(frame).id.msgId)).toEqual([handle.msgId]);
        expect(fixture.readCongestion()).toEqual([
            { kind: 'congestion', carrier: 'rtc', cause: 'backpressured', action: 'drop', priority: 0, msgId: handle.msgId },
            { kind: 'congestion', carrier: 'rtc', cause: 'backpressured', action: 'hand-over', priority: 0, msgId: handle.msgId }
        ]);
    });

    it('ends the same send on rtc alone rejected congested, with no attempt and nothing written', async () => {
        const fixture = await openCongestionFixture();
        fixture.faults.inject(toBackpressureFault('rtc', 'until-cleared'));

        const handle = fixture.send('rtc', 'best-effort');
        const { lifecycle } = await handle.wait();

        expect(lifecycle).toMatchObject({
            state: 'rejected',
            evidence: { failure: { kind: 'refused', reason: 'congested' }, carrierFallback: undefined }
        });
        expect(lifecycle.evidence.attempts).toEqual([]);
        expect(fixture.socket.sent).toEqual([]);
        expect(fixture.readCongestion().map((event) => event.action)).toEqual(['drop']);
    });

    it('ends a WS send above the socket watermark rejected congested, with nothing written', async () => {
        const fixture = await openCongestionFixture();
        fixture.socket.bufferedAmount = AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES;

        const handle = fixture.send('ws', 'best-effort');
        const { lifecycle } = await handle.wait();

        expect(lifecycle).toMatchObject({ state: 'rejected', evidence: { failure: { kind: 'refused', reason: 'congested' } } });
        expect(lifecycle.evidence.attempts).toEqual([]);
        expect(fixture.socket.sent).toEqual([]);
        expect(fixture.readCongestion()).toEqual([
            { kind: 'congestion', carrier: 'ws', cause: 'backpressured', action: 'drop', priority: 0, msgId: handle.msgId }
        ]);
    });
});

describe('an at-least-once send under backpressure, through the facade\'s admission over the real carriers', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('settles its RTC attempts not-ready while the port holds the carrier, and writes the send once it releases', async () => {
        const fixture = await openCongestionFixture();
        fixture.faults.inject(toBackpressureFault('rtc', 'until-cleared'));

        const handle = fixture.send('rtc', 'at-least-once');
        await vi.advanceTimersByTimeAsync(200);

        // A retried attempt keeps its row, so the not-ready outcome is read while the hold lasts.
        expect(handle.lifecycle().state).toBe('queued');
        expect(handle.lifecycle().evidence.attempts.map((attempt) => attempt.outcome)).toEqual(['not-ready', 'not-ready']);
        expect(fixture.rtc.channels.b!.sent).toEqual([]);
        fixture.faults.inject(toBackpressureFault('rtc', 0));
        await vi.advanceTimersByTimeAsync(100);
        const { lifecycle } = await handle.wait();

        expect(lifecycle.state).toBe('transport-accepted');
        expect(lifecycle.evidence.attempts.map((attempt) => attempt.outcome)).toEqual(['sent', 'sent']);
        expect(fixture.rtc.channels.b!.sent.map((sent) => sent.id.msgId)).toEqual([handle.msgId]);
        expect(new Set(fixture.readCongestion().map((event) => event.action))).toEqual(new Set(['defer']));
    });

    it('settles its WS attempt not-ready while the socket holds the watermark, and writes the send once it drains', async () => {
        const fixture = await openCongestionFixture();
        fixture.socket.bufferedAmount = AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES;

        const handle = fixture.send('ws', 'at-least-once');
        await vi.advanceTimersByTimeAsync(200);

        expect(handle.lifecycle().state).toBe('queued');
        expect(handle.lifecycle().evidence.attempts.map((attempt) => attempt.outcome)).toEqual(['not-ready']);
        expect(fixture.socket.sent).toEqual([]);
        fixture.socket.bufferedAmount = 0;
        await vi.advanceTimersByTimeAsync(100);
        const { lifecycle } = await handle.wait();

        expect(lifecycle.state).toBe('transport-accepted');
        expect(lifecycle.evidence.attempts.map((attempt) => attempt.outcome)).toEqual(['sent']);
        expect(fixture.socket.sent.map((frame) => JSON.parse(frame).id.msgId)).toEqual([handle.msgId]);
        expect(new Set(fixture.readCongestion().map((event) => event.action))).toEqual(new Set(['defer']));
    });
});
