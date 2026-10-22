import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { AL_RTC_OVERLAY_CAPABILITIES, toALCarrierQosInputProvider } from '@shared/al-contracts/al-carrier-capabilities.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { Either } from '@shared/resilience/Either.ts';
import { toRateLimiter } from '@shared/resilience/rate-limiter.ts';
import type { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { createDefaultWebRtcRxStreamerService, WebRtcRxStreamerService } from '@shared/services/web-rtc-rx-streamer-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { QRtcDataChannel } from '@shared/webrtc/qrtc-data-channel.ts';
import { QRtcMediaChannel } from '@shared/webrtc/qrtc-media-channel.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';

import { DeterministicRtcOfferIds } from '../webrtc/deterministic-rtc-offer-ids.ts';

interface ReceivingEndpoint {
    readonly wire: RecordingDataChannel;
    readonly admissionEvents: ALInboundRuntimeDiagnosticsEvent[];
}

const ADMISSION_EVENT_KINDS: ReadonlySet<ALInboundRuntimeDiagnosticsEvent['kind']> = new Set([
    'admission-outcome',
    'undecoded-rejection'
]);

const MESSAGE_TO_ANOTHER_PEER = newALUnicastMessage(
    'peer-1',
    { topicId: 'test', resourceId: 'misaddressed', contextId: 'inbound' },
    'another-peer',
    'received',
    {},
    { ttlMs: 30_000 }
);

describe('RTC receiver admission of data-channel messages', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('answers a heartbeat ping without admitting it as an AL message', async () => {
        const endpoint = createReceivingEndpoint(undefined);
        const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await endpoint.wire.receive({ type: 'ping', pingType: 'ping', ts: 1 });

        expect(endpoint.wire.sent.map((data) => JSON.parse(data))).toEqual([{ type: 'ping', pingType: 'pong', ts: 1 }]);
        expect(warnings).not.toHaveBeenCalled();
        expect(endpoint.admissionEvents).toEqual([]);
    });

    it('records a value that is no AL envelope as one undecoded rejection instead of warning about it', async () => {
        const endpoint = createReceivingEndpoint(undefined);
        const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await endpoint.wire.receive({ id: { msgId: 'not-an-envelope' } });

        expect(warnings).not.toHaveBeenCalled();
        expect(endpoint.admissionEvents).toEqual([
            { kind: 'undecoded-rejection', carrier: 'rtc', fromPeerId: 'peer-1', rejection: 'malformed' }
        ]);
    });

    it('records an AL message rejected on its initial admission instead of warning about it', async () => {
        const endpoint = createReceivingEndpoint(undefined);
        const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await endpoint.wire.receive(MESSAGE_TO_ANOTHER_PEER);

        expect(warnings).not.toHaveBeenCalled();
        expect(endpoint.admissionEvents).toEqual([
            expect.objectContaining({
                kind: 'admission-outcome',
                msgId: MESSAGE_TO_ANOTHER_PEER.id.msgId,
                carrier: 'rtc',
                outcome: 'unauthorized',
                reason: 'unauthorized'
            })
        ]);
    });

    it('records an AL message rejected after authority refresh instead of warning about it', async () => {
        const endpoint = createReceivingEndpoint({ afterInboundAdmission: async () => true, dispose: () => {} });
        const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(ALInboundMessageRuntime.prototype, 'admitIncomingMessage').mockResolvedValueOnce(
            Either.ofRight({ kind: 'pending-admission' })
        );

        await endpoint.wire.receive(MESSAGE_TO_ANOTHER_PEER);

        expect(warnings).not.toHaveBeenCalled();
        expect(endpoint.admissionEvents).toEqual([
            expect.objectContaining({
                kind: 'admission-outcome',
                msgId: MESSAGE_TO_ANOTHER_PEER.id.msgId,
                outcome: 'unauthorized',
                reason: 'unauthorized'
            })
        ]);
    });
});

function createReceivingEndpoint(
    roomAuthorityRefresh: WebRtcRxStreamerService.RoomAuthorityRefresh | undefined
): ReceivingEndpoint {
    const connection = new QRtcPeerConnection(
        { send: async () => undefined },
        {
            sessionId: 'self',
            peerSessionId: 'peer-1',
            token: 'test-token',
            iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
            isPolite: false
        },
        new DeterministicRtcOfferIds()
    );
    const channel = new QRtcDataChannel(connection, {
        faultPort: createPassThroughTransportFaultPort(),
        peerId: 'peer-1',
        dataChannelName: 'rtc-test'
    });
    const wire = new RecordingDataChannel();
    vi.spyOn(connection, 'createDataChannel').mockReturnValue(wire);
    const peer: WebRtcConnectionService.Peer = {
        peerId: 'peer-1',
        connection,
        channel,
        channels: new Map([['reliable', channel]]),
        media: new QRtcMediaChannel(connection, { peerId: 'peer-1' })
    };
    const admissionEvents: ALInboundRuntimeDiagnosticsEvent[] = [];
    const streamer = createDefaultWebRtcRxStreamerService({
        multicast: createMulticast(),
        sessionId: 'self',
        roomAuthorityRefresh,
        inboundDiagnostics: (event) => {
            if (ADMISSION_EVENT_KINDS.has(event.kind)) {
                admissionEvents.push(event);
            }
        }
    });
    onTestFinished(() => streamer.dispose());
    streamer.setRttReportingPeerIds([]);
    streamer.addPeer(peer);
    channel.connect(true);
    wire.open();
    return { wire, admissionEvents };
}

function createMulticast(): WebRtcOverlayMulticastManager {
    const multicast = new WebRtcOverlayMulticastManager({
        quotaNow: Date.now,
        creationNow: Temporal.Now.instant,
        connectionService: {
            input: { sessionId: 'self' },
            readyPeerIdsForLane: () => [],
            readPeer: () => undefined
        },
        groupCache: new LatestRepository(),
        overlayCache: new LatestRepository(),
        multicasterFactory: () => {
            throw new Error('Inbound admission must not construct multicast messages');
        },
        qosProvider: toALCarrierQosInputProvider(AL_RTC_OVERLAY_CAPABILITIES, undefined),
        outboundDiagnostics: undefined,
        outboundSettlements: undefined,
        outboundRuntime: createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage }),
        circuitBreaker: toCircuitBreaker(),
        rateLimiter: toRateLimiter(),
        faultPort: createPassThroughTransportFaultPort(),
        dequeueResilience: createDefaultALOutboundDequeueResilience()
    });
    onTestFinished(() => multicast.dispose());
    return multicast;
}

class RecordingDataChannel extends EventTarget implements RTCDataChannel {
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
    readonly sent: string[] = [];

    open(): void {
        this.readyState = 'open';
        this.onopen?.call(this, new Event('open'));
    }

    close(): void {
        this.readyState = 'closed';
    }

    send(data: string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>): void {
        if (typeof data !== 'string') {
            throw new Error('The admission wire records JSON strings only');
        }
        this.sent.push(data);
    }

    async receive(message: object): Promise<void> {
        await this.onmessage?.call(this, new MessageEvent('message', { data: JSON.stringify(message) }));
    }
}
