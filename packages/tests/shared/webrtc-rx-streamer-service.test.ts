import { Temporal } from '@js-temporal/polyfill';
import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { AL_RTC_OVERLAY_CAPABILITIES, toALCarrierQosInputProvider } from '@shared/al-contracts/al-carrier-capabilities.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/Resilience.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import type { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { createDefaultWebRtcRxStreamerService, WebRtcRxStreamerService } from '@shared/services/web-rtc-rx-streamer-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { QRtcDataChannel } from '@shared/webrtc/qrtc-data-channel.ts';
import { QRtcMediaChannel } from '@shared/webrtc/qrtc-media-channel.ts';
import { QRtcPeerConnection, type QRtcOnRemoteStreamCallback } from '@shared/webrtc/qrtc-peer-connection.ts';

import { EmptyMediaStream, EmptyRtcTrackEvent } from './rtc-media-test-events.ts';
import { DeterministicRtcOfferIds } from './webrtc/deterministic-rtc-offer-ids.ts';

interface MediaFixture extends MediaPeerFixture {
    readonly service: WebRtcRxStreamerService;
}

interface MediaPeerFixture {
    readonly peer: WebRtcConnectionService.Peer;
    readonly publishRemoteStream: QRtcOnRemoteStreamCallback;
    readonly attachedStreams: MediaStream[];
    readonly stoppedMediaKinds: string[];
}

describe('WebRtcRxStreamerService media lifecycle', () => {
    beforeEach(() =>
        onTestFinished(() => {
            vi.restoreAllMocks();
        })
    );

    it('hydrates new peers with cached media settings and publishes remote streams', async () => {
        const fixture = createMediaFixture();
        const localStream = new EmptyMediaStream('local-1');
        const policy = { maxVideoBitrateBps: 120_000, maxAudioBitrateBps: 48_000 };
        const received: MediaStream[] = [];
        fixture.service.onRemoteStreamDo('remote', async (_peerId, stream) => {
            received.push(stream);
        });

        await fixture.service.setLocalMediaStream(localStream);
        fixture.service.setLocalAudioEnabled(true);
        fixture.service.setLocalVideoEnabled(false);
        fixture.service.setMediaPolicy(policy);
        fixture.service.addPeer(fixture.peer);

        await vi.waitFor(() => expect(fixture.peer.media.status.localVideoEnabled).toBe(false));
        expect(fixture.peer.connection.status.mediaPolicy).toEqual(policy);
        expect(fixture.attachedStreams).toEqual([localStream]);
        expect(fixture.peer.media.status.localAudioEnabled).toBe(true);
        const remoteStream = new EmptyMediaStream('remote-1');
        await fixture.publishRemoteStream(remoteStream, new EmptyRtcTrackEvent(remoteStream));
        expect(received).toEqual([remoteStream]);
    });

    it('updates existing peers and stops publishing their remote streams after removal', async () => {
        const fixture = createMediaFixture();
        fixture.service.addPeer(fixture.peer);
        const localStream = new EmptyMediaStream('local-2');
        const policy = { preferredVideoCodecs: ['video/VP8'] };
        const received: MediaStream[] = [];
        fixture.service.onRemoteStreamDo('remote', async (_peerId, stream) => {
            received.push(stream);
        });

        await fixture.service.setLocalMediaStream(localStream);
        fixture.service.setLocalAudioEnabled(true);
        fixture.service.setLocalVideoEnabled(true);
        fixture.service.stopLocalMedia('video');
        fixture.service.setMediaPolicy(policy);

        expect(fixture.attachedStreams).toEqual([localStream]);
        expect(fixture.peer.media.status.localAudioEnabled).toBe(true);
        expect(fixture.peer.media.status.localVideoEnabled).toBe(true);
        expect(fixture.stoppedMediaKinds).toEqual(['video']);
        expect(fixture.peer.connection.status.mediaPolicy).toEqual(policy);
        fixture.service.removePeer(fixture.peer);
        const remoteStream = new EmptyMediaStream('removed-remote');
        await fixture.publishRemoteStream(remoteStream, new EmptyRtcTrackEvent(remoteStream));
        expect(received).toEqual([]);
    });
});

interface MediaFixtureInput {
    readonly queueEngine?: InboxOutboxEngine;
    readonly inboundStores?: ALInboundRuntimeStores;
    readonly roomAuthorityRefresh?: WebRtcRxStreamerService.RoomAuthorityRefresh;
}

function createMediaFixture(input: MediaFixtureInput = {}): MediaFixture {
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
            throw new Error('Media control must not construct multicast messages');
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
    const service = createDefaultWebRtcRxStreamerService({ multicast, sessionId: 'self', ...input });
    onTestFinished(() => service.dispose());
    service.setRttReportingPeerIds([]);
    return { service, ...createMediaPeerFixture() };
}

function createMediaPeerFixture(): MediaPeerFixture {
    const signaler = { send: async () => undefined, connect: async () => undefined };
    const iceCandidates = { iceServers: [], expiresAtEpochMs: 60_000 };
    const connection = new QRtcPeerConnection(signaler, {
        sessionId: 'self',
        peerSessionId: 'peer-1',
        token: 'test-token',
        iceCandidates,
        isPolite: false
    }, new DeterministicRtcOfferIds());
    const channel = new QRtcDataChannel(connection, { faultPort: createPassThroughTransportFaultPort(), peerId: 'peer-1', dataChannelName: 'test' });
    const media = new QRtcMediaChannel(connection, { peerId: 'peer-1' });
    const subscription = vi.spyOn(connection, 'onRemoteStreamDo');
    media.connect();
    const publishRemoteStream = subscription.mock.calls[0]?.[1];
    if (!publishRemoteStream) {
        throw new Error('Expected media subscription on the peer event port');
    }
    const attachedStreams: MediaStream[] = [];
    const stoppedMediaKinds: string[] = [];
    vi.spyOn(connection, 'setLocalMediaStream').mockImplementation(async (stream) => {
        attachedStreams.push(stream);
    });
    vi.spyOn(connection, 'stopLocalMedia').mockImplementation((kind) => {
        stoppedMediaKinds.push(kind);
    });
    return {
        peer: { peerId: 'peer-1', connection, channel, channels: new Map([['reliable', channel]]), media },
        publishRemoteStream,
        attachedStreams,
        stoppedMediaKinds
    };
}

describe('RTC receiver owned inbound completion', () => {
    it.each(['clean', 'authority-failure', 'release-failure'] as const)('joins direct commit-started release and attempts cleanup for %s', async (ending) => {
        const engine = new InboxOutboxEngine();
        const resources = createDefaultALInboundRuntimeResources({
            queueEngine: engine,
            selfPeerId: 'self',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox', Temporal.Now.instant())
        });
        const entered = Promise.withResolvers<void>();
        const allowRelease = Promise.withResolvers<void>();
        const failure = new ALAdmissionCorruptionError('receiver-release', new Error('owned cleanup failed'));
        let releaseFinished = false;
        const releaseEntries = resources.workQueue.releaseEntries.bind(resources.workQueue);
        const release = vi.spyOn(resources.workQueue, 'releaseEntries').mockImplementation(async (entries) => {
            if (entries.length > 0) {
                entered.resolve();
                await allowRelease.promise;
            }
            if (ending === 'release-failure' && entries.length > 0) {
                throw failure;
            }
            const result = await releaseEntries(entries);
            if (entries.length > 0) {
                releaseFinished = true;
            }
            return result;
        });
        const authority = vi.fn(() => {
            if (ending === 'authority-failure') {
                throw failure;
            }
        });
        const fixture = createMediaFixture({
            queueEngine: engine,
            inboundStores: resources,
            roomAuthorityRefresh: { afterInboundAdmission: async () => false, dispose: authority }
        });
        const registration = vi.spyOn(fixture.peer.channel, 'onRtcMessageDo');
        const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
        onTestFinished(async () => {
            allowRelease.resolve();
            authority.mockImplementation(() => {});
            await Promise.allSettled([Promise.resolve().then(() => fixture.service.dispose()), engine.stop()]);
            release.mockRestore();
            registration.mockRestore();
            diagnostics.mockRestore();
        });
        fixture.service.onInboxMessageDo('received', { onMessage: async () => {} });
        fixture.service.setRttReportingPeerIds([]);
        fixture.service.addPeer(fixture.peer);
        const receive = registration.mock.calls.at(-1)?.[1];
        if (!receive) {
            throw new Error('Real receiver must register its peer admission callback');
        }
        await receive.onMessage(
            newALUnicastMessage('peer-1', { topicId: 'test', resourceId: 'owned', contextId: 'inbound' }, 'self', 'received', {}, { ttlMs: 30_000 }),
            new MessageEvent('message')
        );
        await entered.promise;
        let completed = false;
        let startedDisposal: Promise<void>;
        try {
            startedDisposal = Promise.resolve(fixture.service.dispose());
        }
        catch (caught) {
            startedDisposal = Promise.reject(caught);
        }
        expect(authority).toHaveBeenCalledOnce();
        const disposal = startedDisposal.then(
            () => {
                completed = true;
                return undefined;
            },
            (error) => {
                completed = true;
                return error;
            }
        );
        const keysBeforeDisposedAdmission = await resources.workQueue.getAllKeys();
        await receive.onMessage(
            newALUnicastMessage('peer-1', { topicId: 'test', resourceId: 'after-dispose', contextId: 'inbound' }, 'self', 'received', {}, { ttlMs: 30_000 }),
            new MessageEvent('message')
        );
        expect(await resources.workQueue.getAllKeys()).toEqual(keysBeforeDisposedAdmission);
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
            expect(authority).toHaveBeenCalledOnce();
            expect(releaseFinished).toBe(false);
            expect(completed, 'RTC receiver disposal escaped its direct commit-started release').toBe(false);
        }
        finally {
            allowRelease.resolve();
        }
        expect(await disposal).toBe(ending === 'clean' ? undefined : failure);
    });
});
