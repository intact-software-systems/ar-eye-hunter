import { getEventListeners } from 'node:events';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import {
    DecodedRtcSignalingMessage,
    decodeRtcSignalingMessage
} from '@shared/webrtc/decode-rtc-signaling-message.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';
import {
    QRtcSignalingSender,
    QRtcSignalingType
} from '@shared/webrtc/QRtcSignalingContracts.ts';

import {
    installNativeRtcRuntime,
    SimulatedNativeRtcPeerConnection
} from './native-rtc-connection-fixture.ts';
import {
    SimulatedMediaStream,
    SimulatedMediaTrack,
    SimulatedNativeMediaPeerConnection,
    SimulatedRtcTrackEvent
} from './native-rtc-media-fixture.ts';

describe('QRtcPeerConnection', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('negotiates offers, forwards ICE candidates, and dispatches remote events', async () => {
        const onConnected = vi.fn(async () => {});
        const { peer, native, sentSignals } = createPeerFixture(true, { onConnected });
        const seenDataChannels: string[] = [];
        const seenTracks: string[] = [];
        const seenStreams: string[] = [];
        peer.onDataChannelDo('dc', async (event) => {
            seenDataChannels.push(event.channel.label);
        });
        peer.onTrackDo('track', async (event) => {
            seenTracks.push(event.track.kind);
        });
        peer.onRemoteStreamDo('stream', async (stream) => {
            seenStreams.push(stream.id);
        });

        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await native.onicecandidate?.call(native, new NativeIceCandidateEvent('ice-1'));
        await native.receiveDataChannel('chat');
        await native.ontrack?.call(
            native,
            new SimulatedRtcTrackEvent(
                new SimulatedMediaTrack('video'),
                new SimulatedMediaStream('remote-1', [new SimulatedMediaTrack('audio')])
            )
        );
        native.setConnected();

        expect(sentSignals).toEqual([
            {
                channel: 'RtcSignal',
                type: 'Signal',
                fromId: 'self',
                toId: 'peer-1',
                sessionId: 'self',
                token: 'token-1',
                signalType: 'Offer',
                payload: {
                    description: { type: 'offer', sdp: 'offer-sdp' },
                    candidate: null
                }
            },
            {
                channel: 'RtcSignal',
                type: 'Signal',
                fromId: 'self',
                toId: 'peer-1',
                sessionId: 'self',
                token: 'token-1',
                signalType: 'IceCandidate',
                payload: {
                    description: null,
                    candidate: { candidate: 'ice-1' }
                }
            }
        ]);
        expect(seenDataChannels).toEqual(['chat']);
        expect(seenTracks).toEqual(['video']);
        expect(seenStreams).toEqual(['remote-1']);
        expect(onConnected).toHaveBeenCalledOnce();
        expect(peer.isOpen()).toBe(true);
        expect(peer.readDiagnostics()).toMatchObject({
            connectCallCount: 1,
            connectIgnoredCount: 0,
            negotiationNeededCount: 1,
            negotiationSkippedCount: 0,
            offerCreatedCount: 1,
            outboundOfferCount: 1,
            outboundIceCandidateCount: 1,
            pendingIceCandidateQueueLength: 0,
            reconnectAttemptsInFlight: 0,
            hasReconnectTimer: false
        });

        peer.resetDiagnostics();

        expect(peer.readDiagnostics()).toMatchObject({
            connectCallCount: 0,
            negotiationNeededCount: 0,
            outboundOfferCount: 0,
            outboundIceCandidateCount: 0
        });
    });

    it('queues ice candidates until a remote description exists and answers remote offers', async () => {
        const { peer, native, sentSignals } = createPeerFixture(true);
        for (const candidate of ['queued-ice-1', 'queued-ice-2']) {
            await peer.handleSignal(QRtcSignalingType.IceCandidate, {
                description: null,
                candidate: { candidate }
            });
        }

        expect(native.receivedCandidates).toEqual([]);
        expect(peer.readDiagnostics()).toMatchObject({
            inboundIceCandidateCount: 2,
            queuedIceCandidateCount: 2,
            pendingIceCandidateQueueLength: 2
        });

        await peer.handleSignal(QRtcSignalingType.Offer, {
            description: { type: 'offer', sdp: 'remote-offer' },
            candidate: null
        });

        expect(native.receivedDescriptions).toEqual([{ type: 'offer', sdp: 'remote-offer' }]);
        expect(native.receivedCandidates).toEqual([
            { candidate: 'queued-ice-1' },
            { candidate: 'queued-ice-2' }
        ]);
        expect(peer.readDiagnostics()).toMatchObject({
            inboundOfferCount: 1,
            outboundAnswerCount: 1,
            addedIceCandidateCount: 2,
            flushedIceCandidateCount: 2,
            pendingIceCandidateQueueLength: 0
        });
        expect(sentSignals).toEqual([{
            channel: 'RtcSignal',
            type: 'Signal',
            fromId: 'self',
            toId: 'peer-1',
            sessionId: 'self',
            token: 'token-1',
            signalType: 'Answer',
            payload: {
                description: { type: 'answer', sdp: 'answer-sdp' },
                candidate: null
            }
        }]);
    });

    it('accounts successful queued ICE against diagnostics reset during a native addition', async () => {
        const { peer, native } = createPeerFixture(true);
        for (const candidate of ['first', 'second']) {
            await peer.handleSignal(QRtcSignalingType.IceCandidate, { description: null, candidate: { candidate } });
        }
        const additionStarted = Promise.withResolvers<void>();
        const releaseAddition = Promise.withResolvers<void>();
        const addIceCandidate = native.addIceCandidate.bind(native);
        vi.spyOn(native, 'addIceCandidate').mockImplementationOnce(async (candidate) => {
            additionStarted.resolve();
            await releaseAddition.promise;
            await addIceCandidate(candidate);
        });
        const offer = peer.handleSignal(QRtcSignalingType.Offer, {
            description: { type: 'offer', sdp: 'remote-offer' },
            candidate: null
        });
        await additionStarted.promise;
        try {
            peer.resetDiagnostics();
            expect(peer.readDiagnostics().addedIceCandidateCount).toBe(0);
        }
        finally {
            releaseAddition.resolve();
            await offer;
        }

        expect(native.receivedCandidates).toEqual([{ candidate: 'first' }, { candidate: 'second' }]);
        expect(peer.readDiagnostics()).toMatchObject({
            inboundOfferCount: 0,
            queuedIceCandidateCount: 0,
            addedIceCandidateCount: 2,
            flushedIceCandidateCount: 2,
            pendingIceCandidateQueueLength: 0
        });
    });

    it('ignores stale answers without clearing negotiation collision flags', async () => {
        const { peer, native, sentSignals } = createPeerFixture(false);
        const localDescriptionStarted = Promise.withResolvers<void>();
        const releaseLocalDescription = Promise.withResolvers<void>();
        const setLocalDescription = native.setLocalDescription.bind(native);
        vi.spyOn(native, 'setLocalDescription').mockImplementationOnce(async (description) => {
            localDescriptionStarted.resolve();
            await releaseLocalDescription.promise;
            await setLocalDescription(description);
        });
        const negotiation = native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await localDescriptionStarted.promise;

        try {
            await peer.handleSignal(QRtcSignalingType.Offer, {
                description: { type: 'offer', sdp: 'colliding-offer' },
                candidate: null
            });
            await peer.handleSignal(QRtcSignalingType.Answer, {
                description: { type: 'answer', sdp: 'stale-answer' },
                candidate: null
            });
            await peer.handleSignal(QRtcSignalingType.IceCandidate, {
                description: null,
                candidate: { candidate: 'ignored-collision-ice' }
            });
            await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));

            expect(native.receivedDescriptions).toEqual([]);
            expect(native.receivedCandidates).toEqual([]);
            expect(sentSignals).toEqual([]);
            expect(peer.readDiagnostics()).toMatchObject({
                inboundAnswerCount: 1,
                staleAnswerIgnoredCount: 1,
                ignoredOfferCollisionCount: 1,
                ignoredIceCandidateForIgnoredOfferCount: 1,
                pendingIceCandidateQueueLength: 0,
                negotiationSkippedCount: 1
            });
        }
        finally {
            releaseLocalDescription.resolve();
            await negotiation;
        }
        expect(sentSignals.map((message) => message.signalType)).toEqual([QRtcSignalingType.Offer]);
    });

    it('ignores offer collisions when impolite and retries with ICE restart on failure', async () => {
        vi.useFakeTimers();
        const { peer, native } = createPeerFixture(false);
        const restartIce = vi.spyOn(native, 'restartIce');
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await peer.handleSignal(QRtcSignalingType.Offer, {
            description: { type: 'offer', sdp: 'colliding-offer' },
            candidate: null
        });

        expect(native.receivedDescriptions).toEqual([]);
        expect(peer.readDiagnostics()).toMatchObject({
            inboundOfferCount: 1,
            offerCollisionCount: 1,
            ignoredOfferCollisionCount: 1
        });

        await peer.handleReconnect();
        await peer.handleReconnect();
        expect(peer.readDiagnostics()).toMatchObject({
            reconnectAttemptCount: 1,
            reconnectAttemptsInFlight: 1,
            reconnectTimerAlreadyActiveCount: 1,
            hasReconnectTimer: true
        });

        native.connectionState = 'failed';
        await vi.advanceTimersByTimeAsync(2_000);

        expect(restartIce).toHaveBeenCalledOnce();
        expect(peer.readDiagnostics()).toMatchObject({
            iceRestartCount: 1,
            iceRestartSkippedConnectedCount: 0,
            hasReconnectTimer: false
        });

        for (const delayMs of [4_000, 8_000, 16_000, 32_000]) {
            await peer.handleReconnect();
            await vi.advanceTimersByTimeAsync(delayMs);
        }
        expect(restartIce).toHaveBeenCalledTimes(5);
        await peer.handleReconnect();

        expect(native.connectionState).toBe('closed');
        expect(peer.isReadyToConnect()).toBe(true);
        expect(peer.readDiagnostics()).toMatchObject({
            reconnectAttemptCount: 5,
            reconnectExhaustedCount: 1,
            resetCount: 1,
            closedPeerConnectionCount: 1
        });
    });

    it('cleans up peer connection handlers and listeners on reset', () => {
        const { peer, native } = createPeerFixture(true);
        expect(getEventListeners(native, 'icegatheringstatechange')).toHaveLength(1);

        peer.reset();

        expect(native.connectionState).toBe('closed');
        expect(peer.readDiagnostics().closedPeerConnectionCount).toBe(1);
        expect(getEventListeners(native, 'icegatheringstatechange')).toHaveLength(0);
        expect(native.onnegotiationneeded).toBeNull();
        expect(native.onicecandidate).toBeNull();
        expect(native.ondatachannel).toBeNull();
        expect(native.ontrack).toBeNull();
        expect(native.oniceconnectionstatechange).toBeNull();
        expect(native.onsignalingstatechange).toBeNull();
        expect(native.onconnectionstatechange).toBeNull();
    });

    it('coalesces repeated disconnected events into one reconnect timer', async () => {
        vi.useFakeTimers();
        const { peer, native } = createPeerFixture(true);
        native.connectionState = 'disconnected';
        native.onconnectionstatechange?.call(native, new Event('connectionstatechange'));
        native.onconnectionstatechange?.call(native, new Event('connectionstatechange'));

        expect(peer.readDiagnostics()).toMatchObject({
            disconnectTimerScheduledCount: 1,
            disconnectTimerAlreadyActiveCount: 1,
            disconnectTimerClearedCount: 0,
            disconnectTimerFiredCount: 0
        });

        native.setConnected();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(peer.readDiagnostics()).toMatchObject({
            disconnectTimerScheduledCount: 1,
            disconnectTimerAlreadyActiveCount: 1,
            disconnectTimerClearedCount: 1,
            disconnectTimerFiredCount: 0,
            reconnectAttemptCount: 0
        });
    });

    it('adds and replaces local tracks and toggles media state', async () => {
        vi.stubGlobal('RTCPeerConnection', SimulatedNativeMediaPeerConnection);
        const signaler: QRtcSignalingSender = { send: async () => {} };
        const peer = new QRtcPeerConnection(signaler, createPeerInput(true));
        onTestFinished(() => {
            peer.reset();
        });
        peer.connect();
        const native = peer.status.pc;
        if (!(native instanceof SimulatedNativeMediaPeerConnection)) {
            throw new Error('Expected the installed native media connection');
        }
        const firstAudio = new SimulatedMediaTrack('audio', 'first-audio');
        const firstVideo = new SimulatedMediaTrack('video', 'first-video');
        const firstStream = new SimulatedMediaStream('local-1', [firstAudio, firstVideo]);

        await peer.setLocalMediaStream(firstStream);

        const senders = native.getSenders();
        expect(senders.map((sender) => sender.track)).toEqual([firstAudio, firstVideo]);
        const secondAudio = new SimulatedMediaTrack('audio', 'second-audio');
        const secondVideo = new SimulatedMediaTrack('video', 'second-video');
        const secondStream = new SimulatedMediaStream('local-2', [secondAudio, secondVideo]);

        await peer.setLocalMediaStream(secondStream);

        expect(native.getSenders()).toEqual(senders);
        expect(senders.map((sender) => sender.track)).toEqual([secondAudio, secondVideo]);
        peer.setLocalAudioEnabled(false);
        peer.setLocalVideoEnabled(false);
        peer.stopLocalMedia('audio');

        expect(secondAudio.enabled).toBe(false);
        expect(secondVideo.enabled).toBe(false);
        expect(secondAudio.readyState).toBe('ended');
        expect(secondVideo.readyState).toBe('live');
    });
});

interface PeerConnectionFixture {
    readonly peer: QRtcPeerConnection;
    readonly native: SimulatedNativeRtcPeerConnection;
    readonly sentSignals: readonly DecodedRtcSignalingMessage[];
}

function createPeerFixture(isPolite: boolean, callbacks: QRtcPeerConnection.StateCallbacks = {}): PeerConnectionFixture {
    const runtime = installNativeRtcRuntime();
    const sentSignals: DecodedRtcSignalingMessage[] = [];
    const signaler: QRtcSignalingSender = {
        send: async (message) => {
            sentSignals.push(decodeRtcSignalingMessage(JSON.stringify(message)));
        }
    };
    const peer = new QRtcPeerConnection(signaler, createPeerInput(isPolite));
    onTestFinished(() => {
        try {
            peer.reset();
        }
        finally {
            runtime.dispose();
        }
    });
    peer.connect(callbacks);
    const native = runtime.createdConnections[0];
    if (!native) {
        throw new Error('Expected a native connection after connect');
    }
    return { peer, native, sentSignals };
}

function createPeerInput(isPolite: boolean): QRtcPeerConnection.InputDto {
    return {
        sessionId: 'self',
        token: 'token-1',
        peerSessionId: 'peer-1',
        iceCandidates: {
            iceServers: [],
            expiresAtEpochMs: Date.now() + 1_000
        },
        isPolite
    };
}

class NativeIceCandidateEvent extends Event implements RTCPeerConnectionIceEvent {
    readonly candidate: RTCIceCandidate;

    constructor(candidate: string) {
        super('icecandidate');
        this.candidate = {
            candidate,
            address: null,
            component: null,
            foundation: null,
            port: null,
            priority: null,
            protocol: null,
            relatedAddress: null,
            relatedPort: null,
            sdpMLineIndex: null,
            sdpMid: null,
            tcpType: null,
            type: null,
            usernameFragment: null,
            toJSON: () => ({ candidate })
        };
    }
}
