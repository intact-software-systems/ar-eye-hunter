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
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/rate-limiter.ts';
import type { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { createDefaultWebRtcRxStreamerService, type WebRtcRxStreamerService } from '@shared/services/web-rtc-rx-streamer-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { QRtcDataChannel } from '@shared/webrtc/qrtc-data-channel.ts';
import { QRtcMediaChannel } from '@shared/webrtc/qrtc-media-channel.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';

import { NO_RTC_GRANTED_TOPICS } from '../multicast/rtc-granted-topic-reader-fixtures.ts';
import { KEYLESS_PUBLICATION_VERIFIER } from '../multicast/rtc-publication-proof-verifier-fixtures.ts';
import { NO_RTC_TOPIC_SUBSCRIPTIONS } from '../multicast/rtc-topic-subscription-reader-fixtures.ts';
import { UNAVAILABLE_PUBLICATION_CRYPTO } from '../signature/publication-crypto-fixtures.ts';
import { DeterministicRtcOfferIds } from '../webrtc/deterministic-rtc-offer-ids.ts';

interface ReceivingEndpoint {
    readonly wire: RecordingDataChannel;
    readonly admissionEvents: ALInboundRuntimeDiagnosticsEvent[];
    readonly delivered: string[];
}

const ADMISSION_EVENT_KINDS: ReadonlySet<ALInboundRuntimeDiagnosticsEvent['kind']> = new Set([
    'admission-outcome',
    'undecoded-rejection'
]);

const MESSAGE_TO_ANOTHER_PEER = newALUnicastMessage(
    {
        createdAtEpochMs: Date.now(),
        senderId: 'peer-1',
        route: { topicId: 'test', resourceId: 'misaddressed', contextId: 'inbound' },
        toPeerId: 'another-peer',
        typeId: 'received',
        resource: {},
        options: { ttlMs: 30_000 }
    }
);

describe('RTC receiver admission of data-channel messages', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('answers a heartbeat ping without admitting it as an AL message', async () => {
        const endpoint = createReceivingEndpoint();
        const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await endpoint.wire.receive({ type: 'ping', pingType: 'ping', ts: 1 });

        expect(endpoint.wire.sent.map((data) => JSON.parse(data))).toEqual([{ type: 'ping', pingType: 'pong', ts: 1 }]);
        expect(warnings).not.toHaveBeenCalled();
        expect(endpoint.admissionEvents).toEqual([]);
    });

    it('records a value that is no AL envelope as one undecoded rejection instead of warning about it', async () => {
        const endpoint = createReceivingEndpoint();
        const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await endpoint.wire.receive({ id: { msgId: 'not-an-envelope' } });

        expect(warnings).not.toHaveBeenCalled();
        expect(endpoint.admissionEvents).toEqual([
            { kind: 'undecoded-rejection', carrier: 'rtc', fromPeerId: 'peer-1', rejection: 'malformed' }
        ]);
    });

    it('records an AL message rejected on its initial admission instead of warning about it', async () => {
        const endpoint = createReceivingEndpoint();
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

    it('records expiry after authority refresh advances the supplied clock', async () => {
        let serverNow = 10_000_000;
        const endpoint = createReceivingEndpoint(() => serverNow, {
            afterInboundAdmission: async () => {
                serverNow = 10_000_100;
                return true;
            },
            dispose: () => {}
        });
        const message = {
            ...newALUnicastMessage({
                createdAtEpochMs: Date.now(),
                senderId: 'peer-1',
                route: { topicId: 'test', resourceId: 'refresh', contextId: 'inbound' },
                toPeerId: 'self',
                typeId: 'received',
                resource: {}
            }),
            constraints: { expiresAtMs: 10_000_100 }
        };
        const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await endpoint.wire.receive(message);

        expect(endpoint.admissionEvents).toEqual([
            expect.objectContaining({ msgId: message.id.msgId, outcome: 'committed', reason: 'admitted' }),
            expect.objectContaining({ msgId: message.id.msgId, outcome: 'rejected', reason: 'expired' })
        ]);
        expect(warnings).not.toHaveBeenCalled();
    });

    it.each([-20_000, 20_000])('uses its supplied epoch for admission and delivery with local offset %i', async (offsetMs) => {
        let serverNow = 10_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => serverNow + offsetMs);
        const endpoint = createReceivingEndpoint(() => serverNow);
        const live = {
            ...newALUnicastMessage({
                createdAtEpochMs: Date.now(),
                senderId: 'peer-1',
                route: { topicId: 'test', resourceId: 'live', contextId: 'inbound' },
                toPeerId: 'self',
                typeId: 'received',
                resource: {}
            }),
            constraints: { expiresAtMs: 10_000_100 }
        };

        await endpoint.wire.receive(live);

        await expect.poll(() => endpoint.delivered).toEqual([live.id.msgId]);
        expect(endpoint.admissionEvents).toContainEqual(expect.objectContaining({
            msgId: live.id.msgId,
            outcome: 'committed',
            reason: 'admitted'
        }));
        serverNow = 10_000_100;
        const expired = { ...live, id: { ...live.id, msgId: 'expired-at-boundary' } };

        await endpoint.wire.receive(expired);

        expect(endpoint.admissionEvents).toContainEqual(expect.objectContaining({
            msgId: expired.id.msgId,
            outcome: 'rejected',
            reason: 'expired'
        }));
        expect(endpoint.delivered).toEqual([live.id.msgId]);
    });
});

function createReceivingEndpoint(
    nowEpochMs: () => number = Date.now,
    roomAuthorityRefresh?: WebRtcRxStreamerService.RoomAuthorityRefresh
): ReceivingEndpoint {
    const connection = new QRtcPeerConnection(
        { send: async () => undefined },
        {
            sessionId: 'self',
            peerSessionId: 'peer-1',
            token: 'test-token',
            iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
            isPolite: false,
            offerGeneration: 1
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
    const delivered: string[] = [];
    const streamer = createDefaultWebRtcRxStreamerService({
        multicast: createMulticast(),
        publicationCrypto: UNAVAILABLE_PUBLICATION_CRYPTO,
        sessionId: 'self',
        nowEpochMs,
        roomAuthorityRefresh,
        creationNow: () => Temporal.Instant.fromEpochMilliseconds(nowEpochMs()),
        inboundDiagnostics: (event) => {
            if (ADMISSION_EVENT_KINDS.has(event.kind)) {
                admissionEvents.push(event);
            }
        }
    });
    onTestFinished(() => streamer.dispose());
    streamer.onInboxMessageDo('received', {
        onMessage: async (message) => {
            delivered.push(message.id.msgId);
        }
    });
    streamer.setRttReportingPeerIds([]);
    streamer.addPeer(peer);
    channel.connect(true);
    wire.open();
    return { wire, admissionEvents, delivered };
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
        layoutTransitionsCache: new LatestRepository(),
        plannedOverlayCache: new LatestRepository(),
        replacedLayoutOverlapMs: 15_000,
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
        dequeueResilience: createDefaultALOutboundDequeueResilience(),
        grantedTopics: NO_RTC_GRANTED_TOPICS,
        publicationCrypto: UNAVAILABLE_PUBLICATION_CRYPTO,
        publicationVerifier: KEYLESS_PUBLICATION_VERIFIER,
        topicSubscriptions: NO_RTC_TOPIC_SUBSCRIPTIONS,
        selfPrincipalId: 'self'
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
