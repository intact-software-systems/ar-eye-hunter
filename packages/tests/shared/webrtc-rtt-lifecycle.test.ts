import { createInMemoryALInboundRuntimeStores } from '@shared/alm/ALRuntimeStores.ts';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { createDefaultALOutboundRuntimeResources } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { WebRtcConnectionService, type QRtcPeerDto } from '@shared/services/web-rtc-connection-service.ts';
import { WebRtcRxStreamerService } from '@shared/services/web-rtc-rx-streamer-service.ts';
import { QRtcDataChannel } from '@shared/webrtc/qrtc-data-channel.ts';
import { QRtcMediaChannel } from '@shared/webrtc/qrtc-media-channel.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';

interface StreamingEndpoint {
    readonly streamer: WebRtcRxStreamerService;
    readonly peer: QRtcPeerDto;
    readonly wire: LoopbackDataChannel;
    readonly measurements: RttMeasurementInfo[];
}

describe('RTC single-reporter heartbeat lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'] });
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('keeps the non-reporting endpoint responsive without publishing a second RTT stream', async () => {
        const reporter = createStreamingEndpoint('session-a', 'session-b');
        const responder = createStreamingEndpoint('session-b', 'session-a');
        openStreamingPair(reporter, responder);

        await vi.advanceTimersByTimeAsync(5_020);

        expect(reporter.measurements).toEqual([{
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 20,
            createdAtEpochMs: expect.any(Number),
            version: 2
        }]);
        expect(responder.measurements).toEqual([]);
        expect(reporter.wire.sent.map((message) => JSON.parse(message).pingType)).toEqual(['ping']);
        expect(responder.wire.sent.map((message) => JSON.parse(message).pingType)).toEqual(['pong']);
        expect(reporter.peer.channel.isOpen()).toBe(true);
        expect(responder.peer.channel.isOpen()).toBe(true);
    });

    it('continues answering remote pings after local reporting is disabled', async () => {
        const reporter = createStreamingEndpoint('session-a', 'session-b');
        const responder = createStreamingEndpoint('session-b', 'session-a');
        openStreamingPair(reporter, responder);
        responder.streamer.setRttReportingPeerIds(['session-a']);
        responder.streamer.setRttReportingPeerIds([]);

        await vi.advanceTimersByTimeAsync(5_020);

        expect(reporter.measurements.map((measurement) => measurement.rttMs)).toEqual([20]);
        expect(responder.measurements).toEqual([]);
        expect(responder.wire.sent.map((message) => JSON.parse(message).pingType)).toEqual(['pong']);
    });

    it('cleans up removed peers and resumes one monotonic stream after reconnect', async () => {
        const reporter = createStreamingEndpoint('session-a', 'session-b');
        const responder = createStreamingEndpoint('session-b', 'session-a');
        openStreamingPair(reporter, responder);
        await vi.advanceTimersByTimeAsync(5_020);

        responder.streamer.removePeer(responder.peer);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(reporter.measurements.map((measurement) => measurement.version)).toEqual([2]);

        responder.streamer.addPeer(responder.peer);
        responder.wire.open();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(reporter.measurements.map((measurement) => measurement.version)).toEqual([2, 3]);
        expect(responder.measurements).toEqual([]);

        reporter.streamer.stopAllHeartbeats();
        responder.streamer.stopAllHeartbeats();
        const sentCount = reporter.wire.sent.length + responder.wire.sent.length;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(reporter.wire.sent.length + responder.wire.sent.length).toBe(sentCount);
    });

    it('carries the reporting version across channel closure and peer replacement', async () => {
        const reporter = createStreamingEndpoint('session-a', 'session-b');
        const responder = createStreamingEndpoint('session-b', 'session-a');
        openStreamingPair(reporter, responder);
        await vi.advanceTimersByTimeAsync(5_020);

        reporter.wire.close();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(reporter.measurements.map((measurement) => measurement.version)).toEqual([2]);
        reporter.peer.channel.connect(true);
        reporter.wire.open();
        await vi.advanceTimersByTimeAsync(5_020);
        expect(reporter.measurements.map((measurement) => measurement.version)).toEqual([2, 3]);

        reporter.streamer.removePeer(reporter.peer);
        reporter.streamer.addPeer(reporter.peer);
        reporter.wire.open();
        await vi.advanceTimersByTimeAsync(5_020);
        expect(reporter.measurements.map((measurement) => measurement.version)).toEqual([2, 3, 4]);
        expect(responder.measurements).toEqual([]);
    });

    it('answers zero-origin pings but ignores malformed traffic and unsolicited passive pongs', async () => {
        const reporter = createStreamingEndpoint('session-a', 'session-b');
        const responder = createStreamingEndpoint('session-b', 'session-a');
        openStreamingPair(reporter, responder);
        reporter.streamer.setRttReportingPeerIds([]);
        for (
            const message of [
                { type: 'ping', pingType: 'invalid', ts: 0 },
                { type: 'ping', pingType: 'ping', ts: '0' },
                { type: 'ping', pingType: 'ping', ts: null },
                { type: 'ping', pingType: 'pong', ts: 0 }
            ]
        ) {
            reporter.wire.send(JSON.stringify(message));
        }
        await vi.advanceTimersByTimeAsync(20);
        expect(responder.wire.sent).toEqual([]);
        expect(responder.measurements).toEqual([]);

        reporter.wire.send(JSON.stringify({ type: 'ping', pingType: 'ping', ts: 0 }));
        await vi.advanceTimersByTimeAsync(20);
        expect(responder.wire.sent.map((message) => JSON.parse(message))).toEqual([{ type: 'ping', pingType: 'pong', ts: 0 }]);
        expect(reporter.measurements).toEqual([]);
    });

    it('resumes reporting without resetting versions or duplicating timers during refresh', async () => {
        const reporter = createStreamingEndpoint('session-a', 'session-b');
        const responder = createStreamingEndpoint('session-b', 'session-a');
        openStreamingPair(reporter, responder);
        await vi.advanceTimersByTimeAsync(5_020);
        reporter.streamer.setRttReportingPeerIds([]);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(reporter.measurements.map((measurement) => measurement.version)).toEqual([2]);

        reporter.streamer.setRttReportingPeerIds(['session-b']);
        reporter.streamer.setRttReportingPeerIds(['session-b']);
        await vi.advanceTimersByTimeAsync(5_020);
        expect(reporter.measurements.map((measurement) => measurement.version)).toEqual([2, 3]);

        reporter.streamer.removePeer(reporter.peer);
        reporter.wire.open();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(reporter.measurements.map((measurement) => measurement.version)).toEqual([2, 3]);
    });
});

function createStreamingEndpoint(sessionId: string, peerSessionId: string): StreamingEndpoint {
    const signaler = { send: async () => undefined, connect: async () => undefined };
    const iceCandidates = { iceServers: [], expiresAtEpochMs: 60_000 };
    const connection = new QRtcPeerConnection(signaler, {
        sessionId,
        peerSessionId,
        token: 'test-token',
        iceCandidates,
        isPolite: false
    });
    const channel = new QRtcDataChannel(connection, { peerId: peerSessionId, dataChannelName: 'rtc-test' });
    const wire = new LoopbackDataChannel();
    vi.spyOn(connection, 'createDataChannel').mockReturnValue(wire);
    const peer: QRtcPeerDto = {
        peerId: peerSessionId,
        connection,
        channel,
        channels: new Map([['reliable', channel]]),
        media: new QRtcMediaChannel(connection, { peerId: peerSessionId })
    };
    const connectionService = new WebRtcConnectionService(signaler, {
        sessionId,
        token: 'test-token',
        iceCandidates,
        dataChannelName: 'rtc-test',
        rtcSignalingTopicId: 'rtc-signaling'
    });
    const multicast = new WebRtcOverlayMulticastManager(
        new InMemoryQueueBox(new Map()),
        connectionService,
        new LatestRepository(),
        new LatestRepository(),
        () => {
            throw new Error('Heartbeat traffic must not enter multicast');
        },
        qosProvider: undefined,
        outboundDiagnostics: undefined,
        outboundRuntime: createDefaultALOutboundRuntimeResources(),
        circuitBreaker: toCircuitBreaker(),
        rateLimiter: toRateLimiter()
    });
    const measurements: RttMeasurementInfo[] = [];
    streamer.onRttMeasurementDo('observations', {
        onHeartbeat: async (measurement) => {
            measurements.push(measurement);
        }
    });
    streamer.addPeer(peer);
    channel.connect(true);
    return { streamer, peer, wire, measurements };
}

function openStreamingPair(reporter: StreamingEndpoint, responder: StreamingEndpoint): void {
    reporter.wire.remote = responder.wire;
    responder.wire.remote = reporter.wire;
    reporter.streamer.setRttReportingPeerIds(['session-b']);
    responder.streamer.setRttReportingPeerIds([]);
    reporter.wire.open();
    responder.wire.open();
}

class LoopbackDataChannel extends EventTarget implements RTCDataChannel {
    readonly label = 'rtc-test';
    readonly id = 1;
    readonly ordered = true;
    readonly protocol = '';
    readonly negotiated = false;
    readonly maxPacketLifeTime = null;
    readonly maxRetransmits = null;
    readonly bufferedAmount = 0;
    bufferedAmountLowThreshold = 0;
    binaryType: BinaryType = 'arraybuffer';
    readyState: RTCDataChannelState = 'connecting';
    onopen: RTCDataChannel['onopen'] = null;
    onclose: RTCDataChannel['onclose'] = null;
    onclosing: RTCDataChannel['onclosing'] = null;
    onerror: RTCDataChannel['onerror'] = null;
    onmessage: RTCDataChannel['onmessage'] = null;
    onbufferedamountlow: RTCDataChannel['onbufferedamountlow'] = null;
    remote: LoopbackDataChannel | undefined;
    readonly sent: string[] = [];

    open(): void {
        this.readyState = 'open';
        this.onopen?.call(this, new Event('open'));
    }

    close(): void {
        this.readyState = 'closed';
        this.onclose?.call(this, new Event('close'));
    }

    send(data: string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>): void {
        if (typeof data !== 'string' || !this.remote) {
            throw new Error('The heartbeat wire requires a connected JSON string transport');
        }
        this.sent.push(data);
        const remote = this.remote;
        setTimeout(() => remote.onmessage?.call(remote, new MessageEvent('message', { data })), 10);
    }
}
