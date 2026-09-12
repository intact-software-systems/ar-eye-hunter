import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';
import { DeterministicRtcOfferIds } from './webrtc/deterministic-rtc-offer-ids.ts';

import {
    decodeRtcSignalingMessage
} from '@shared/webrtc/decode-rtc-signaling-message.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';
import { QRtcSignalingAdmissionError } from '@shared/webrtc/qrtc-signaling-admission.ts';
import {
    QRtcSignal,
    QRtcSignalingMessage,
    QRtcSignalingSender,
    QRtcSignalingType
} from '@shared/webrtc/qrtc-signaling-contracts.ts';

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

    it('does not apply a previous offer answer to a successive local offer', async () => {
        const { peer, native } = createPeerFixture(true);
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await peer.handleSignal({
            signalType: QRtcSignalingType.Answer,
            offerId: 'offer-1',
            payload: {
                description: { type: 'answer', sdp: 'first-answer' },
                candidate: null
            }
        });
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await peer.handleSignal({
            signalType: QRtcSignalingType.Answer,
            offerId: 'offer-1',
            payload: {
                description: { type: 'answer', sdp: 'first-answer' },
                candidate: null
            }
        });
        expect(native.receivedDescriptions).toEqual([{ type: 'answer', sdp: 'first-answer' }]);
        expect(native.signalingState).toBe('have-local-offer');
        await peer.handleSignal({
            signalType: 'Answer',
            offerId: 'offer-2',
            payload: {
                description: { type: 'answer', sdp: 'second-answer' },
                candidate: null
            }
        });
        await peer.handleSignal({
            signalType: 'Answer',
            offerId: 'offer-2',
            payload: {
                description: { type: 'answer', sdp: 'second-answer' },
                candidate: null
            }
        });
        expect(native.receivedDescriptions).toEqual([
            { type: 'answer', sdp: 'first-answer' },
            { type: 'answer', sdp: 'second-answer' }
        ]);
        expect(peer.readDiagnostics().staleAnswerIgnoredCount).toBe(2);
    });

    it('does not emit an offer whose native creation finished after reset', async () => {
        const { peer, native, sentSignals } = createPeerFixture(true);
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const setLocalDescription = native.setLocalDescription.bind(native);
        vi.spyOn(native, 'setLocalDescription').mockImplementationOnce(async () => {
            started.resolve();
            await release.promise;
            await setLocalDescription();
        });
        const negotiation = native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await started.promise;
        peer.reset();
        peer.connect();
        release.resolve();
        await negotiation;
        expect(sentSignals).toEqual([]);
        expect(peer.status.pc?.signalingState).toBe('stable');
    });

    it('echoes the accepted remote offer and invalidates a politely rolled back local offer', async () => {
        const { peer, native, sentSignals } = createPeerFixture(true);
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await peer.handleSignal({
            signalType: 'Offer',
            offerId: 'remote-offer-id',
            payload: {
                description: { type: 'offer', sdp: 'remote-offer' },
                candidate: null
            }
        });
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await peer.handleSignal({
            signalType: 'Answer',
            offerId: 'offer-1',
            payload: {
                description: { type: 'answer', sdp: 'rolled-back-answer' },
                candidate: null
            }
        });
        expect(native.receivedDescriptions).toEqual([{ type: 'offer', sdp: 'remote-offer' }]);
        expect(sentSignals).toMatchObject([
            { signalType: 'Offer', offerId: 'offer-1' },
            { signalType: 'Answer', offerId: 'remote-offer-id' },
            { signalType: 'Offer', offerId: 'offer-2' }
        ]);
        await peer.handleSignal({
            signalType: 'Answer',
            offerId: 'offer-2',
            payload: {
                description: { type: 'answer', sdp: 'current-answer' },
                candidate: null
            }
        });
        expect(native.receivedDescriptions.at(-1)).toEqual({ type: 'answer', sdp: 'current-answer' });
    });

    it.each(['Offer', 'Answer'] as const)('retires queued signals and post-native work when reset interrupts %s application', async (signalType) => {
        const { peer, native, sentSignals } = createPeerFixture(true);
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const setRemoteDescription = native.setRemoteDescription.bind(native);
        vi.spyOn(native, 'setRemoteDescription').mockImplementationOnce(async (description) => {
            started.resolve();
            await release.promise;
            await setRemoteDescription(description);
        });
        const applying = signalType === 'Offer'
            ? peer.handleSignal({
                signalType,
                offerId: 'remote-offer',
                payload: {
                    description: { type: 'offer', sdp: 'old-offer' },
                    candidate: null
                }
            })
            : peer.handleSignal({
                signalType,
                offerId: 'offer-1',
                payload: {
                    description: { type: 'answer', sdp: 'old-answer' },
                    candidate: null
                }
            });
        await started.promise;
        const queued = peer.handleSignal({
            signalType: 'Offer',
            offerId: 'queued-offer',
            payload: {
                description: { type: 'offer', sdp: 'queued-old-offer' },
                candidate: null
            }
        });
        const queuedNegotiation = native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        peer.reset();
        peer.connect();
        const replacement = peer.status.pc;
        if (!(replacement instanceof SimulatedNativeRtcPeerConnection)) {
            throw new Error('Expected replacement native peer');
        }
        release.resolve();
        await Promise.all([applying, queued, queuedNegotiation]);
        expect(replacement.receivedDescriptions).toEqual([]);
        expect(replacement.receivedCandidates).toEqual([]);
        expect(sentSignals).toHaveLength(1);
        await replacement.onnegotiationneeded?.call(replacement, new Event('negotiationneeded'));
        await peer.handleSignal({
            signalType: 'Answer',
            offerId: 'offer-2',
            payload: {
                description: { type: 'answer', sdp: 'replacement-answer' },
                candidate: null
            }
        });
        expect(replacement.receivedDescriptions).toEqual([{ type: 'answer', sdp: 'replacement-answer' }]);
    });

    it('drops deferred outbound candidates from a retired native peer', async () => {
        const runtime = installNativeRtcRuntime();
        const sentSignals: QRtcSignalingMessage[] = [];
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const peer = new QRtcPeerConnection(
            {
                send: async (signal) => {
                    sentSignals.push(signal);
                    started.resolve();
                    await release.promise;
                }
            },
            createPeerInput(true),
            new DeterministicRtcOfferIds()
        );
        onTestFinished(() => {
            release.resolve();
            peer.reset();
            runtime.dispose();
        });
        peer.connect();
        const native = runtime.createdConnections[0];
        const negotiation = native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await started.promise;
        const candidate = native.onicecandidate?.call(native, new NativeIceCandidateEvent('retired-candidate'));
        peer.reset();
        peer.connect();
        release.resolve();
        await Promise.all([negotiation, candidate]);
        expect(sentSignals).toMatchObject([{ signalType: 'Offer', offerId: 'offer-1' }]);
        expect(peer.status.pc?.signalingState).toBe('stable');
    });

    it('does not send an answer when reset interrupts native answer creation', async () => {
        const { peer, native, sentSignals } = createPeerFixture(true);
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const setLocalDescription = native.setLocalDescription.bind(native);
        vi.spyOn(native, 'setLocalDescription').mockImplementationOnce(async () => {
            started.resolve();
            await release.promise;
            await setLocalDescription();
        });
        const applying = peer.handleSignal({
            signalType: 'Offer',
            offerId: 'remote-offer-id',
            payload: {
                description: { type: 'offer', sdp: 'retired-remote-offer' },
                candidate: null
            }
        });
        await started.promise;
        peer.reset();
        peer.connect();
        release.resolve();
        await applying;
        expect(sentSignals).toEqual([]);
        expect(peer.status.pc?.signalingState).toBe('stable');
    });

    it('consumes a matching answer only after native application succeeds', async () => {
        const { peer, native } = createPeerFixture(true);
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        const failure = new Error('Native answer application failed');
        vi.spyOn(native, 'setRemoteDescription').mockRejectedValueOnce(failure);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const answer = {
            signalType: 'Answer',
            offerId: 'offer-1',
            payload: { description: { type: 'answer', sdp: 'matching-answer' }, candidate: null }
        } satisfies QRtcSignal;
        await expect(peer.handleSignal(answer)).rejects.toBe(failure);
        expect(native.receivedDescriptions).toEqual([]);
        await peer.handleSignal(answer);
        expect(native.receivedDescriptions).toEqual([{ type: 'answer', sdp: 'matching-answer' }]);
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
                offerId: 'offer-1',
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
            await peer.handleSignal({
                signalType: QRtcSignalingType.IceCandidate,
                payload: {
                    description: null,
                    candidate: { candidate }
                }
            });
        }

        expect(native.receivedCandidates).toEqual([]);
        expect(peer.readDiagnostics()).toMatchObject({
            inboundIceCandidateCount: 2,
            queuedIceCandidateCount: 2,
            pendingIceCandidateQueueLength: 2
        });

        await peer.handleSignal({
            signalType: QRtcSignalingType.Offer,
            offerId: 'offer-1',
            payload: {
                description: { type: 'offer', sdp: 'remote-offer' },
                candidate: null
            }
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
            offerId: 'offer-1',
            payload: {
                description: { type: 'answer', sdp: 'answer-sdp' },
                candidate: null
            }
        }]);
    });

    it('accounts successful queued ICE against diagnostics reset during a native addition', async () => {
        const { peer, native } = createPeerFixture(true);
        for (const candidate of ['first', 'second']) {
            await peer.handleSignal({ signalType: QRtcSignalingType.IceCandidate, payload: { description: null, candidate: { candidate } } });
        }
        const additionStarted = Promise.withResolvers<void>();
        const releaseAddition = Promise.withResolvers<void>();
        const addIceCandidate = native.addIceCandidate.bind(native);
        vi.spyOn(native, 'addIceCandidate').mockImplementationOnce(async (candidate) => {
            additionStarted.resolve();
            await releaseAddition.promise;
            await addIceCandidate(candidate);
        });
        const offer = peer.handleSignal({
            signalType: QRtcSignalingType.Offer,
            offerId: 'offer-1',
            payload: {
                description: { type: 'offer', sdp: 'remote-offer' },
                candidate: null
            }
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

    it('ignores stale answers without clearing an impolite collision or its current offer', async () => {
        const { peer, native } = createPeerFixture(false);
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await peer.handleSignal({
            signalType: 'Offer',
            offerId: 'remote-offer',
            payload: {
                description: { type: 'offer', sdp: 'colliding-offer' },
                candidate: null
            }
        });
        await peer.handleSignal({
            signalType: 'Answer',
            offerId: 'stale-offer',
            payload: {
                description: { type: 'answer', sdp: 'stale-answer' },
                candidate: null
            }
        });
        await peer.handleSignal({
            signalType: 'IceCandidate',
            payload: {
                description: null,
                candidate: { candidate: 'ignored-collision-ice' }
            }
        });
        expect(native.receivedDescriptions).toEqual([]);
        expect(native.receivedCandidates).toEqual([]);
        expect(native.signalingState).toBe('have-local-offer');
        await peer.handleSignal({
            signalType: 'Answer',
            offerId: 'offer-1',
            payload: {
                description: { type: 'answer', sdp: 'matching-answer' },
                candidate: null
            }
        });
        expect(native.receivedDescriptions).toEqual([{ type: 'answer', sdp: 'matching-answer' }]);
        expect(peer.readDiagnostics()).toMatchObject({
            staleAnswerIgnoredCount: 1,
            ignoredOfferCollisionCount: 1,
            ignoredIceCandidateForIgnoredOfferCount: 1
        });
    });

    it('ignores offer collisions when impolite and retries with ICE restart on failure', async () => {
        vi.useFakeTimers();
        const { peer, native } = createPeerFixture(false);
        const restartIce = vi.spyOn(native, 'restartIce');
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await peer.handleSignal({
            signalType: QRtcSignalingType.Offer,
            offerId: 'offer-1',
            payload: {
                description: { type: 'offer', sdp: 'colliding-offer' },
                candidate: null
            }
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

    it('reports the hop a terminal signaling failure lost, instead of logging and dropping it', async () => {
        const runtime = installNativeRtcRuntime();
        onTestFinished(() => runtime.dispose());
        const terminal = new QRtcSignalingAdmissionError('expired', 'msg-7', 'Signaling admission returned expired');
        const signaler: QRtcSignalingSender = {
            send: async () => {
                throw terminal;
            }
        };
        const peer = new QRtcPeerConnection(signaler, createPeerInput(true), new DeterministicRtcOfferIds());
        onTestFinished(() => {
            peer.reset();
        });
        const failures: QRtcPeerConnection.SignalingFailure[] = [];
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        peer.connect({ onSignalingFailed: (failure) => failures.push(failure) });
        const native = runtime.createdConnections[0];
        if (!native) {
            throw new Error('Expected a native connection after connect');
        }

        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await native.onicecandidate?.call(native, new NativeIceCandidateEvent('ice-1'));

        // Each hop names the status admission gave it and the message that carried it.
        const rejected = { outcome: 'rejected', status: 'expired', messageId: 'msg-7' };
        expect(failures).toEqual([
            { peerSessionId: 'peer-1', signalType: QRtcSignalingType.Offer, admission: rejected, error: terminal },
            { peerSessionId: 'peer-1', signalType: QRtcSignalingType.IceCandidate, admission: rejected, error: terminal }
        ]);
        // The counters back the report up, and neither hop is reduced to a log line.
        expect(peer.readDiagnostics().outboundSignalingErrorCount).toBe(2);
        expect(consoleError).not.toHaveBeenCalled();
    });

    it('reports the answer hop a terminal admission lost, not only the inbound chain log', async () => {
        const runtime = installNativeRtcRuntime();
        onTestFinished(() => runtime.dispose());
        const terminal = new QRtcSignalingAdmissionError('expired', 'msg-9', 'Signaling admission returned expired');
        const signaler: QRtcSignalingSender = {
            send: async () => {
                throw terminal;
            }
        };
        const peer = new QRtcPeerConnection(signaler, createPeerInput(true), new DeterministicRtcOfferIds());
        onTestFinished(() => {
            peer.reset();
        });
        const failures: QRtcPeerConnection.SignalingFailure[] = [];
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        peer.connect({ onSignalingFailed: (failure) => failures.push(failure) });

        await expect(peer.handleSignal({
            signalType: QRtcSignalingType.Offer,
            offerId: 'offer-1',
            payload: {
                description: { type: 'offer', sdp: 'remote-offer' },
                candidate: null
            }
        })).rejects.toBe(terminal);

        // A lost answer strands the offerer in have-local-offer exactly as a lost offer does.
        expect(failures).toEqual([{
            peerSessionId: 'peer-1',
            signalType: QRtcSignalingType.Answer,
            admission: { outcome: 'rejected', status: 'expired', messageId: 'msg-9' },
            error: terminal
        }]);
        // The inbound chain still owns its own log and counter for the hop it could not complete.
        expect(peer.readDiagnostics().inboundSignalingErrorCount).toBe(1);
        expect(consoleError).toHaveBeenCalledWith('Signaling chain error', terminal);
    });

    it('names a hop that failed before admission saw the signal', async () => {
        const runtime = installNativeRtcRuntime();
        onTestFinished(() => runtime.dispose());
        const signaler: QRtcSignalingSender = { send: async () => {} };
        const peer = new QRtcPeerConnection(signaler, createPeerInput(true), new DeterministicRtcOfferIds());
        onTestFinished(() => {
            peer.reset();
        });
        const failures: QRtcPeerConnection.SignalingFailure[] = [];
        peer.connect({ onSignalingFailed: (failure) => failures.push(failure) });
        const native = runtime.createdConnections[0];
        if (!native) {
            throw new Error('Expected a native connection after connect');
        }
        const localDescriptionFailed = new Error('setLocalDescription rejected');
        native.setLocalDescription = () => Promise.reject(localDescriptionFailed);

        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));

        expect(failures).toEqual([{
            peerSessionId: 'peer-1',
            signalType: QRtcSignalingType.Offer,
            admission: { outcome: 'never-admitted' },
            error: localDescriptionFailed
        }]);
    });

    it('closes the native peer and clears its event handlers on reset', () => {
        const { peer, native } = createPeerFixture(true);

        peer.reset();

        expect(native.connectionState).toBe('closed');
        expect(peer.readDiagnostics().closedPeerConnectionCount).toBe(1);
        expect(native.onnegotiationneeded).toBeNull();
        expect(native.onicecandidate).toBeNull();
        expect(native.ondatachannel).toBeNull();
        expect(native.ontrack).toBeNull();
        expect(native.oniceconnectionstatechange).toBeNull();
        expect(native.onsignalingstatechange).toBeNull();
        expect(native.onconnectionstatechange).toBeNull();
    });

    it('stops reporting to the session reset closed, even for a hop still in flight', async () => {
        const runtime = installNativeRtcRuntime();
        onTestFinished(() => runtime.dispose());
        let failSend: (error: Error) => void = () => {};
        const pendingSend = new Promise<void>((_resolve, reject) => {
            failSend = reject;
        });
        let sendCalls = 0;
        const signaler: QRtcSignalingSender = {
            send: () => {
                sendCalls += 1;
                return pendingSend;
            }
        };
        const peer = new QRtcPeerConnection(signaler, createPeerInput(true), new DeterministicRtcOfferIds());
        const failures: QRtcPeerConnection.SignalingFailure[] = [];
        peer.connect({ onSignalingFailed: (failure) => failures.push(failure) });
        const native = runtime.createdConnections[0];
        if (!native) {
            throw new Error('Expected a native connection after connect');
        }
        const negotiation = native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await vi.waitFor(() => expect(sendCalls).toBe(1));

        peer.reset();
        failSend(new Error('signaling closed with the session'));
        await negotiation;

        // The hop did fail -- the counter proves it -- but the callbacks belonged to a closed session.
        expect(peer.readDiagnostics().outboundSignalingErrorCount).toBe(1);
        expect(failures).toEqual([]);
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
        const peer = new QRtcPeerConnection(signaler, createPeerInput(true), new DeterministicRtcOfferIds());
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
    readonly sentSignals: readonly QRtcSignalingMessage[];
}

function createPeerFixture(isPolite: boolean, callbacks: QRtcPeerConnection.StateCallbacks = {}): PeerConnectionFixture {
    const runtime = installNativeRtcRuntime();
    const sentSignals: QRtcSignalingMessage[] = [];
    const signaler: QRtcSignalingSender = {
        send: async (message) => {
            sentSignals.push(decodeRtcSignalingMessage(JSON.stringify(message)));
        }
    };
    const peer = new QRtcPeerConnection(signaler, createPeerInput(isPolite), new DeterministicRtcOfferIds());
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
