import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

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
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import {
    installNativeRtcRuntime,
    SimulatedNativeRtcPeerConnection
} from './native-rtc-connection-fixture.ts';
import {
    SimulatedMediaStream,
    SimulatedMediaTrack,
    SimulatedNativeMediaPeerConnection,
    SimulatedRtcSender,
    SimulatedRtcTrackEvent,
    SimulatedRtcTransceiver
} from './native-rtc-media-fixture.ts';
import { DeterministicRtcOfferIds } from './webrtc/deterministic-rtc-offer-ids.ts';

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
            connectionGeneration: 1,
            offerId: 'offer-1',
            payload: {
                description: { type: 'answer', sdp: 'first-answer' },
                candidate: null
            }
        });
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await peer.handleSignal({
            signalType: QRtcSignalingType.Answer,
            connectionGeneration: 1,
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
            connectionGeneration: 1,
            offerId: 'offer-2',
            payload: {
                description: { type: 'answer', sdp: 'second-answer' },
                candidate: null
            }
        });
        await peer.handleSignal({
            signalType: 'Answer',
            connectionGeneration: 1,
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

    it.each([
        { blockedOperation: 'native-offer', replacementOfferId: 'offer-1' },
        { blockedOperation: 'outbound-offer', replacementOfferId: 'offer-2' }
    ])('negotiates after reset while the retired $blockedOperation remains unresolved', async ({ blockedOperation, replacementOfferId }) => {
        const { peer, native, sentSignals } = createPeerFixture(true);
        const started = Promise.withResolvers<void>();
        const retiredOperation = Promise.withResolvers<void>();
        onTestFinished(() => retiredOperation.resolve());
        const remainPending = async () => {
            started.resolve();
            await retiredOperation.promise;
        };
        if (blockedOperation === 'native-offer') {
            vi.spyOn(native, 'setLocalDescription').mockImplementationOnce(remainPending);
        }
        else {
            vi.spyOn(peer.signaler, 'send').mockImplementationOnce(remainPending);
        }
        void native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await started.promise;

        peer.reset();
        peer.connect();
        const replacement = peer.status.pc;
        if (!(replacement instanceof SimulatedNativeRtcPeerConnection)) {
            throw new Error('Expected replacement native peer');
        }
        const negotiation = replacement.onnegotiationneeded?.call(replacement, new Event('negotiationneeded'));
        await vi.waitFor(() => expect(sentSignals).toMatchObject([{ signalType: 'Offer', offerId: replacementOfferId }]));
        await negotiation;
        await peer.handleSignal({
            signalType: 'Answer',
            connectionGeneration: 1,
            offerId: replacementOfferId,
            payload: { description: { type: 'answer', sdp: 'replacement-answer' }, candidate: null }
        });

        expect(replacement.receivedDescriptions).toEqual([{ type: 'answer', sdp: 'replacement-answer' }]);
        expect(replacement.signalingState).toBe('stable');
        expect(native.connectionState).toBe('closed');
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
            connectionGeneration: 1,
            payload: {
                description: { type: 'offer', sdp: 'remote-offer' },
                candidate: null
            }
        });
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await peer.handleSignal({
            signalType: 'Answer',
            connectionGeneration: 1,
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
            connectionGeneration: 1,
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
        onTestFinished(() => release.resolve());
        vi.spyOn(native, 'setRemoteDescription').mockImplementationOnce(async (description) => {
            started.resolve();
            await release.promise;
            await setRemoteDescription(description);
        });
        const applying = signalType === 'Offer'
            ? peer.handleSignal({
                signalType,
                offerId: 'remote-offer',
                connectionGeneration: 1,
                payload: {
                    description: { type: 'offer', sdp: 'old-offer' },
                    candidate: null
                }
            })
            : peer.handleSignal({
                signalType,
                offerId: 'offer-1',
                connectionGeneration: 1,
                payload: {
                    description: { type: 'answer', sdp: 'old-answer' },
                    candidate: null
                }
            });
        await started.promise;
        const queued = peer.handleSignal({
            signalType: 'Offer',
            offerId: 'queued-offer',
            connectionGeneration: 1,
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
        let retiredCallsSettled = false;
        const retiredCalls = Promise.all([applying, queued, queuedNegotiation]).then(() => {
            retiredCallsSettled = true;
        });
        await vi.waitFor(() => expect(retiredCallsSettled).toBe(true));
        await retiredCalls;
        expect(replacement.receivedDescriptions).toEqual([]);
        expect(replacement.receivedCandidates).toEqual([]);
        expect(sentSignals).toHaveLength(1);
        await replacement.onnegotiationneeded?.call(replacement, new Event('negotiationneeded'));
        await peer.handleSignal({
            signalType: 'Answer',
            connectionGeneration: 1,
            offerId: 'offer-2',
            payload: {
                description: { type: 'answer', sdp: 'replacement-answer' },
                candidate: null
            }
        });
        expect(replacement.receivedDescriptions).toEqual([{ type: 'answer', sdp: 'replacement-answer' }]);
        release.resolve();
        await vi.waitFor(() => expect(native.receivedDescriptions).toHaveLength(1));
        expect(replacement.signalingState).toBe('stable');
        expect(replacement.receivedDescriptions).toEqual([{ type: 'answer', sdp: 'replacement-answer' }]);
        expect(sentSignals).toMatchObject([
            { signalType: 'Offer', offerId: 'offer-1' },
            { signalType: 'Offer', offerId: 'offer-2' }
        ]);
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
        const nativeFinished = Promise.withResolvers<void>();
        const replacementStarted = Promise.withResolvers<void>();
        const releaseReplacement = Promise.withResolvers<void>();
        onTestFinished(() => {
            release.resolve();
            releaseReplacement.resolve();
        });
        const setLocalDescription = native.setLocalDescription.bind(native);
        vi.spyOn(native, 'setLocalDescription').mockImplementationOnce(async () => {
            started.resolve();
            await release.promise;
            await setLocalDescription();
            nativeFinished.resolve();
        });
        const applying = peer.handleSignal({
            signalType: 'Offer',
            offerId: 'remote-offer-id',
            connectionGeneration: 1,
            payload: {
                description: { type: 'offer', sdp: 'retired-remote-offer' },
                candidate: null
            }
        });
        await started.promise;
        peer.reset();
        peer.connect();
        const replacement = peer.status.pc;
        if (!(replacement instanceof SimulatedNativeRtcPeerConnection)) {
            throw new Error('Expected replacement native peer');
        }
        vi.spyOn(replacement, 'setLocalDescription').mockImplementationOnce(async () => {
            replacementStarted.resolve();
            await releaseReplacement.promise;
        });
        const replacementNegotiation = replacement.onnegotiationneeded?.call(replacement, new Event('negotiationneeded'));
        await replacementStarted.promise;
        await applying;
        expect(peer.status.makingOffer).toBe(true);
        expect(sentSignals).toEqual([]);

        release.resolve();
        await nativeFinished.promise;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(sentSignals).toEqual([]);
        expect(peer.status.pc).toBe(replacement);
        expect(peer.status.makingOffer).toBe(true);
        expect(replacement.signalingState).toBe('stable');
        releaseReplacement.resolve();
        await replacementNegotiation;
    });

    it('consumes a matching answer only after native application succeeds', async () => {
        const { peer, native } = createPeerFixture(true);
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        const failure = new Error('Native answer application failed');
        vi.spyOn(native, 'setRemoteDescription').mockRejectedValueOnce(failure);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const answer = {
            signalType: 'Answer',
            connectionGeneration: 1,
            offerId: 'offer-1',
            payload: { description: { type: 'answer', sdp: 'matching-answer' }, candidate: null }
        } satisfies QRtcSignal;
        await expect(peer.handleSignal(answer)).rejects.toBe(failure);
        expect(native.receivedDescriptions).toEqual([]);
        await peer.handleSignal(answer);
        expect(native.receivedDescriptions).toEqual([{ type: 'answer', sdp: 'matching-answer' }]);
    });

    it('observes a late native rejection after the retired caller has settled', async () => {
        const { peer, native } = createPeerFixture(true);
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        const started = Promise.withResolvers<void>();
        const application = Promise.withResolvers<void>();
        onTestFinished(() => application.resolve());
        vi.spyOn(native, 'setRemoteDescription').mockImplementationOnce(() => {
            started.resolve();
            return application.promise;
        });
        const applying = peer.handleSignal({
            signalType: 'Answer',
            connectionGeneration: 1,
            offerId: 'offer-1',
            payload: { description: { type: 'answer', sdp: 'retired-answer' }, candidate: null }
        });
        await started.promise;
        peer.reset();
        await applying;
        peer.connect();
        application.reject(new Error('Closed native connection'));
        await Promise.resolve();
        await Promise.resolve();
        expect(peer.status.pc?.signalingState).toBe('stable');
        expect(peer.readDiagnostics().inboundSignalingErrorCount).toBe(0);
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
                connectionGeneration: 7,
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
                connectionGeneration: 7,
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
                connectionGeneration: 1,
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
            connectionGeneration: 1,
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
            connectionGeneration: 7,
            offerId: 'offer-1',
            payload: {
                description: { type: 'answer', sdp: 'answer-sdp' },
                candidate: null
            }
        }]);
    });

    it('refuses an offer below the highest generation it applied, without applying or answering it', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const { peer, native, sentSignals } = createPeerFixture(true, {}, createRecordingDependencies(events));
        await peer.handleSignal(createRemoteOffer('current-offer', 20, 'current-offer-sdp'));
        await peer.handleSignal(createRemoteOffer('superseded-offer', 19, 'superseded-offer-sdp'));

        expect(native.receivedDescriptions).toEqual([{ type: 'offer', sdp: 'current-offer-sdp' }]);
        expect(sentSignals.map((signal) => [signal.signalType, 'offerId' in signal ? signal.offerId : undefined]))
            .toEqual([['Answer', 'current-offer']]);
        expect(events.filter((event) => event.kind === 'native-signal-decision' && event.offerId === 'superseded-offer'))
            .toEqual([
                expect.objectContaining({ disposition: 'application-started' }),
                expect.objectContaining({
                    disposition: 'offer-superseded',
                    capturedPeerConnection: true,
                    currentPeerConnection: true,
                    signalingState: 'stable',
                    connectionGeneration: 19,
                    appliedRemoteGeneration: 20
                }),
                expect.objectContaining({ disposition: 'application-returned' })
            ]);
    });

    it('refuses a lower generation before the collision logic, keeping its own pending offer', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const { peer, native, sentSignals } = createPeerFixture(true, {}, createRecordingDependencies(events));
        await peer.handleSignal(createRemoteOffer('current-offer', 20, 'current-offer-sdp'));
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        expect(native.signalingState).toBe('have-local-offer');
        await peer.handleSignal(createRemoteOffer('superseded-offer', 19, 'superseded-offer-sdp'));

        expect(native.signalingState).toBe('have-local-offer');
        expect(native.localDescription).toMatchObject({ type: 'offer' });
        expect(native.receivedDescriptions).toEqual([{ type: 'offer', sdp: 'current-offer-sdp' }]);
        expect(sentSignals.map((signal) => [signal.signalType, 'offerId' in signal ? signal.offerId : undefined]))
            .toEqual([['Answer', 'current-offer'], ['Offer', 'offer-1']]);
        expect(events.filter((event) => event.kind === 'native-signal-decision' && event.offerId === 'superseded-offer'))
            .toContainEqual(expect.objectContaining({
                disposition: 'offer-superseded',
                signalingState: 'have-local-offer',
                connectionGeneration: 19,
                appliedRemoteGeneration: 20
            }));
    });

    it('refuses a generation below one it applied through a polite rollback', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const { peer, native, sentSignals } = createPeerFixture(true, {}, createRecordingDependencies(events));
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await peer.handleSignal(createRemoteOffer('current-offer', 20, 'current-offer-sdp'));
        await peer.handleSignal(createRemoteOffer('superseded-offer', 19, 'superseded-offer-sdp'));

        expect(peer.readDiagnostics().politeOfferRollbackCount).toBe(1);
        expect(native.receivedDescriptions).toEqual([{ type: 'offer', sdp: 'current-offer-sdp' }]);
        expect(sentSignals.map((signal) => [signal.signalType, 'offerId' in signal ? signal.offerId : undefined]))
            .toEqual([['Offer', 'offer-1'], ['Answer', 'current-offer']]);
        expect(events.filter((event) => event.kind === 'native-signal-decision' && event.offerId === 'superseded-offer'))
            .toContainEqual(expect.objectContaining({
                disposition: 'offer-superseded',
                connectionGeneration: 19,
                appliedRemoteGeneration: 20
            }));
    });

    it('answers a renegotiation of the generation it applied', async () => {
        const { peer, native, sentSignals } = createPeerFixture(true);
        await peer.handleSignal(createRemoteOffer('first-offer', 20, 'first-offer-sdp'));
        await peer.handleSignal(createRemoteOffer('renegotiation-offer', 20, 'renegotiation-offer-sdp'));

        expect(native.receivedDescriptions).toEqual([
            { type: 'offer', sdp: 'first-offer-sdp' },
            { type: 'offer', sdp: 'renegotiation-offer-sdp' }
        ]);
        expect(sentSignals.map((signal) => 'offerId' in signal ? signal.offerId : undefined))
            .toEqual(['first-offer', 'renegotiation-offer']);
    });

    it('applies a higher generation and refuses the generations below it', async () => {
        const { peer, native, sentSignals } = createPeerFixture(true);
        await peer.handleSignal(createRemoteOffer('older-offer', 10, 'older-offer-sdp'));
        await peer.handleSignal(createRemoteOffer('newer-offer', 20, 'newer-offer-sdp'));
        await peer.handleSignal(createRemoteOffer('between-offer', 15, 'between-offer-sdp'));

        expect(native.receivedDescriptions).toEqual([
            { type: 'offer', sdp: 'older-offer-sdp' },
            { type: 'offer', sdp: 'newer-offer-sdp' }
        ]);
        expect(sentSignals.map((signal) => 'offerId' in signal ? signal.offerId : undefined))
            .toEqual(['older-offer', 'newer-offer']);
    });

    it('keeps the applied generation across a native reset but not into another connection', async () => {
        const { peer, sentSignals } = createPeerFixture(true);
        await peer.handleSignal(createRemoteOffer('current-offer', 20, 'current-offer-sdp'));
        peer.reset();
        peer.connect();
        const replacement = peer.status.pc;
        if (!(replacement instanceof SimulatedNativeRtcPeerConnection)) {
            throw new Error('Expected replacement native peer');
        }
        await peer.handleSignal(createRemoteOffer('superseded-offer', 19, 'superseded-offer-sdp'));
        expect(replacement.receivedDescriptions).toEqual([]);
        expect(sentSignals.map((signal) => 'offerId' in signal ? signal.offerId : undefined)).toEqual(['current-offer']);

        const successor = createPeerFixture(true);
        await successor.peer.handleSignal(createRemoteOffer('superseded-offer', 19, 'superseded-offer-sdp'));
        expect(successor.native.receivedDescriptions).toEqual([{ type: 'offer', sdp: 'superseded-offer-sdp' }]);
        expect(successor.sentSignals.map((signal) => 'offerId' in signal ? signal.offerId : undefined))
            .toEqual(['superseded-offer']);
    });

    it('holds a candidate of a newer remote connection that overtook its offer, then applies it to that offer', async () => {
        const { peer, native } = createPeerFixture(true);
        const applications = recordCandidateApplications(native);
        await peer.handleSignal(createRemoteOffer('first-offer', 10, 'first-offer-sdp'));
        await peer.handleSignal(createRemoteOffer('second-offer', 20, 'second-offer-sdp'));
        await peer.handleSignal(createRemoteCandidate('third-candidate', 30));

        expect(applications).toEqual([]);
        expect(peer.readDiagnostics().pendingIceCandidateQueueLength).toBe(1);

        await peer.handleSignal(createRemoteOffer('third-offer', 30, 'third-offer-sdp'));
        expect(applications).toEqual([{ candidate: 'third-candidate', remoteSdp: 'third-offer-sdp' }]);
        expect(peer.readDiagnostics().pendingIceCandidateQueueLength).toBe(0);
    });

    it('drops a candidate of a superseded remote connection, held or direct, and keeps a newer one held', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const { peer, native } = createPeerFixture(true, {}, createRecordingDependencies(events));
        const applications = recordCandidateApplications(native);
        await peer.handleSignal(createRemoteCandidate('early-superseded-candidate', 10));
        await peer.handleSignal(createRemoteCandidate('early-current-candidate', 20));
        await peer.handleSignal(createRemoteCandidate('early-newer-candidate', 30));
        await peer.handleSignal(createRemoteOffer('current-offer', 20, 'current-offer-sdp'));
        await peer.handleSignal(createRemoteCandidate('late-superseded-candidate', 10));

        expect(applications).toEqual([{ candidate: 'early-current-candidate', remoteSdp: 'current-offer-sdp' }]);
        expect(peer.readDiagnostics().pendingIceCandidateQueueLength).toBe(1);
        expect(events.filter((event) => event.kind === 'native-signal-decision' && event.disposition === 'ice-superseded'))
            .toEqual([
                expect.objectContaining({
                    signalType: 'IceCandidate',
                    capturedPeerConnection: true,
                    currentPeerConnection: true,
                    signalingState: 'have-remote-offer',
                    connectionGeneration: 10,
                    appliedRemoteGeneration: 20
                }),
                expect.objectContaining({ signalingState: 'stable', connectionGeneration: 10, appliedRemoteGeneration: 20 })
            ]);
    });

    it('applies a candidate of the remote connection it applied, across that connection renegotiating', async () => {
        const { peer, native } = createPeerFixture(true);
        const applications = recordCandidateApplications(native);
        await peer.handleSignal(createRemoteOffer('first-offer', 20, 'first-offer-sdp'));
        await peer.handleSignal(createRemoteCandidate('first-candidate', 20));
        await peer.handleSignal(createRemoteOffer('ice-restart-offer', 20, 'ice-restart-offer-sdp'));
        await peer.handleSignal(createRemoteCandidate('restart-candidate', 20));

        expect(applications).toEqual([
            { candidate: 'first-candidate', remoteSdp: 'first-offer-sdp' },
            { candidate: 'restart-candidate', remoteSdp: 'ice-restart-offer-sdp' }
        ]);
    });

    it('holds a newer candidate through a polite rollback and applies it to the offer that rolled back its own', async () => {
        const { peer, native } = createPeerFixture(true);
        const applications = recordCandidateApplications(native);
        await peer.handleSignal(createRemoteOffer('first-offer', 20, 'first-offer-sdp'));
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await peer.handleSignal(createRemoteCandidate('replacement-candidate', 30));

        expect(applications).toEqual([]);

        await peer.handleSignal(createRemoteOffer('replacement-offer', 30, 'replacement-offer-sdp'));
        expect(peer.readDiagnostics().politeOfferRollbackCount).toBe(1);
        expect(applications).toEqual([{ candidate: 'replacement-candidate', remoteSdp: 'replacement-offer-sdp' }]);
    });

    it('judges the answering connection candidates by the generation its answer carried', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const { peer, native, sentSignals } = createPeerFixture(true, {}, createRecordingDependencies(events));
        const applications = recordCandidateApplications(native);
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await peer.handleSignal(createRemoteAnswer('offer-1', 50, 'answer-sdp'));
        await peer.handleSignal(createRemoteCandidate('answering-candidate', 50));
        await peer.handleSignal(createRemoteCandidate('replacement-candidate', 60));
        await peer.handleSignal(createRemoteCandidate('superseded-candidate', 40));

        expect(applications).toEqual([{ candidate: 'answering-candidate', remoteSdp: 'answer-sdp' }]);
        expect(events.filter((event) => event.kind === 'native-signal-decision' && event.disposition === 'ice-superseded'))
            .toEqual([expect.objectContaining({ connectionGeneration: 40, appliedRemoteGeneration: 50 })]);

        await peer.handleSignal(createRemoteOffer('replacement-offer', 60, 'replacement-offer-sdp'));
        expect(applications).toEqual([
            { candidate: 'answering-candidate', remoteSdp: 'answer-sdp' },
            { candidate: 'replacement-candidate', remoteSdp: 'replacement-offer-sdp' }
        ]);
        expect(sentSignals.map((signal) => [signal.signalType, signal.connectionGeneration])).toEqual([
            ['Offer', 7],
            ['Answer', 7]
        ]);
    });

    it('holds the answering connection candidates until its answer, then applies those of its generation to it', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const { peer, native } = createPeerFixture(true, {}, createRecordingDependencies(events));
        const applications = recordCandidateApplications(native);
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await peer.handleSignal(createRemoteCandidate('first-answering-candidate', 50));
        await peer.handleSignal(createRemoteCandidate('superseded-candidate', 49));
        await peer.handleSignal(createRemoteCandidate('second-answering-candidate', 50));

        expect(applications).toEqual([]);

        await peer.handleSignal(createRemoteAnswer('offer-1', 50, 'answer-sdp'));
        expect(applications).toEqual([
            { candidate: 'first-answering-candidate', remoteSdp: 'answer-sdp' },
            { candidate: 'second-answering-candidate', remoteSdp: 'answer-sdp' }
        ]);
        expect(events.filter((event) => event.kind === 'native-signal-decision' && event.disposition === 'ice-superseded'))
            .toEqual([expect.objectContaining({ connectionGeneration: 49, appliedRemoteGeneration: 50 })]);
    });

    it('refuses an older remote connection offer after a newer one answered, and applies the newer one candidates', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const { peer, native, sentSignals } = createPeerFixture(false, {}, createRecordingDependencies(events));
        const applications = recordCandidateApplications(native);
        await peer.handleSignal(createRemoteOffer('first-offer', 1, 'first-offer-sdp'));
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await peer.handleSignal(createRemoteOffer('third-offer', 3, 'third-offer-sdp'));
        await peer.handleSignal(createRemoteCandidate('early-third-candidate', 3));
        await peer.handleSignal(createRemoteCandidate('older-candidate', 0));
        await peer.handleSignal(createRemoteAnswer('offer-1', 3, 'third-answer-sdp'));
        await peer.handleSignal(createRemoteOffer('second-offer', 2, 'second-offer-sdp'));
        await peer.handleSignal(createRemoteCandidate('third-candidate', 3));

        expect(peer.readDiagnostics().ignoredOfferCollisionCount).toBe(1);
        expect(native.receivedDescriptions.map((description) => description.sdp))
            .toEqual(['first-offer-sdp', 'third-answer-sdp']);
        expect(sentSignals.map((signal) => [signal.signalType, 'offerId' in signal ? signal.offerId : undefined]))
            .toEqual([['Answer', 'first-offer'], ['Offer', 'offer-1']]);
        expect(applications).toEqual([
            { candidate: 'early-third-candidate', remoteSdp: 'third-answer-sdp' },
            { candidate: 'third-candidate', remoteSdp: 'third-answer-sdp' }
        ]);
        expect(events.filter((event) => event.kind === 'native-signal-decision' && event.signalType === 'IceCandidate'))
            .toContainEqual(expect.objectContaining({
                disposition: 'ice-superseded',
                signalingState: 'have-local-offer',
                connectionGeneration: 0,
                appliedRemoteGeneration: 1
            }));
        expect(events.filter((event) => event.kind === 'native-signal-decision' && event.offerId === 'second-offer'))
            .toContainEqual(expect.objectContaining({
                disposition: 'offer-superseded',
                connectionGeneration: 2,
                appliedRemoteGeneration: 3
            }));
    });

    it('refuses an answer below the applied remote generation and rolls back its offer, so it can renegotiate', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const { peer, native, sentSignals } = createPeerFixture(true, {}, createRecordingDependencies(events));
        await peer.handleSignal(createRemoteOffer('current-offer', 5, 'current-offer-sdp'));
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await peer.handleSignal(createRemoteAnswer('offer-1', 4, 'superseded-answer-sdp'));

        expect(native.signalingState).toBe('stable');
        expect(native.receivedDescriptions.map((description) => description.sdp)).toEqual(['current-offer-sdp']);
        expect(events.filter((event) => event.kind === 'native-signal-decision' && event.signalType === 'Answer'))
            .toContainEqual(expect.objectContaining({
                disposition: 'answer-superseded',
                offerId: 'offer-1',
                signalingState: 'have-local-offer',
                connectionGeneration: 4,
                appliedRemoteGeneration: 5
            }));

        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await peer.handleSignal(createRemoteAnswer('offer-1', 5, 'late-answer-sdp'));
        await peer.handleSignal(createRemoteAnswer('offer-2', 5, 'current-answer-sdp'));
        expect(sentSignals.map((signal) => [signal.signalType, 'offerId' in signal ? signal.offerId : undefined]))
            .toEqual([['Answer', 'current-offer'], ['Offer', 'offer-1'], ['Offer', 'offer-2']]);
        expect(native.signalingState).toBe('stable');
        expect(native.receivedDescriptions.map((description) => description.sdp))
            .toEqual(['current-offer-sdp', 'current-answer-sdp']);
    });

    it('holds at most 64 candidates, displacing the oldest', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const { peer, native } = createPeerFixture(true, {}, createRecordingDependencies(events));
        for (let index = 0; index <= 64; index++) {
            await peer.handleSignal(createRemoteCandidate(`candidate-${index}`, 20));
        }

        expect(peer.readDiagnostics().pendingIceCandidateQueueLength).toBe(64);
        expect(events.filter((event) => event.kind === 'native-signal-decision' && event.disposition === 'ice-displaced'))
            .toEqual([expect.objectContaining({ signalType: 'IceCandidate' })]);

        await peer.handleSignal(createRemoteOffer('current-offer', 20, 'current-offer-sdp'));
        expect(native.receivedCandidates).toEqual(
            Array.from({ length: 64 }, (_, index) => ({ candidate: `candidate-${index + 1}` }))
        );
    });

    it('drops held candidates with the native connection they waited for', async () => {
        const { peer } = createPeerFixture(true);
        await peer.handleSignal(createRemoteOffer('first-offer', 20, 'first-offer-sdp'));
        await peer.handleSignal(createRemoteCandidate('held-candidate', 30));
        peer.reset();
        peer.connect();
        const replacement = peer.status.pc;
        if (!(replacement instanceof SimulatedNativeRtcPeerConnection)) {
            throw new Error('Expected replacement native peer');
        }
        await peer.handleSignal(createRemoteOffer('replacement-offer', 30, 'replacement-offer-sdp'));

        expect(replacement.receivedDescriptions).toEqual([{ type: 'offer', sdp: 'replacement-offer-sdp' }]);
        expect(replacement.receivedCandidates).toEqual([]);
    });

    it('accounts successful queued ICE against diagnostics reset during a native addition', async () => {
        const { peer, native } = createPeerFixture(true);
        for (const candidate of ['first', 'second']) {
            await peer.handleSignal({
                signalType: QRtcSignalingType.IceCandidate,
                connectionGeneration: 1,
                payload: { description: null, candidate: { candidate } }
            });
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
            connectionGeneration: 1,
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
            connectionGeneration: 1,
            payload: {
                description: { type: 'offer', sdp: 'colliding-offer' },
                candidate: null
            }
        });
        await peer.handleSignal({
            signalType: 'Answer',
            connectionGeneration: 1,
            offerId: 'stale-offer',
            payload: {
                description: { type: 'answer', sdp: 'stale-answer' },
                candidate: null
            }
        });
        await peer.handleSignal({
            signalType: 'IceCandidate',
            connectionGeneration: 1,
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
            connectionGeneration: 1,
            offerId: 'offer-1',
            payload: {
                description: { type: 'answer', sdp: 'matching-answer' },
                candidate: null
            }
        });
        expect(native.receivedDescriptions).toEqual([{ type: 'answer', sdp: 'matching-answer' }]);
        expect(native.receivedCandidates).toEqual([{ candidate: 'ignored-collision-ice' }]);
        expect(peer.readDiagnostics()).toMatchObject({
            staleAnswerIgnoredCount: 1,
            ignoredOfferCollisionCount: 1,
            ignoredIceCandidateForIgnoredOfferCount: 0
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
            connectionGeneration: 1,
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
        const terminal = new QRtcSignalingAdmissionError(
            { kind: 'expired', detail: 'Signaling admission returned expired' },
            'msg-7',
            'Signaling admission returned expired'
        );
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

        // Each hop names the verdict admission gave it and the message that carried it.
        const rejected = {
            outcome: 'rejected',
            verdict: { kind: 'expired', detail: 'Signaling admission returned expired' },
            messageId: 'msg-7'
        };
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
        const terminal = new QRtcSignalingAdmissionError(
            { kind: 'expired', detail: 'Signaling admission returned expired' },
            'msg-9',
            'Signaling admission returned expired'
        );
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
            connectionGeneration: 1,
            payload: {
                description: { type: 'offer', sdp: 'remote-offer' },
                candidate: null
            }
        })).rejects.toBe(terminal);

        // A lost answer strands the offerer in have-local-offer exactly as a lost offer does.
        expect(failures).toEqual([{
            peerSessionId: 'peer-1',
            signalType: QRtcSignalingType.Answer,
            admission: {
                outcome: 'rejected',
                verdict: { kind: 'expired', detail: 'Signaling admission returned expired' },
                messageId: 'msg-9'
            },
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
        expect(native.onconnectionstatechange).toBeNull();
    });

    it.each(['transceiver-stop', 'transceiver-enumeration', 'native-close'] as const)(
        'releases retired resources and isolates replacement after %s fails',
        async (failure) => {
            vi.useFakeTimers();
            const { peer, native, sentSignals } = createPeerFixture(true);
            const track = new SimulatedMediaTrack('audio');
            const first = new SimulatedRtcTransceiver(new SimulatedRtcSender(track), track);
            const remaining = new SimulatedRtcTransceiver(new SimulatedRtcSender(track), track);
            const enumerate = vi.spyOn(native, 'getTransceivers').mockReturnValue([first, remaining]);
            const error = new Error('Native cleanup failed');
            const errors: Error[] = [];
            vi.spyOn(console, 'error').mockImplementation((_message, cause: Error) => errors.push(cause));
            if (failure === 'transceiver-stop') {
                vi.spyOn(first, 'stop').mockImplementationOnce(() => {
                    throw error;
                });
            }
            else if (failure === 'transceiver-enumeration') {
                enumerate.mockImplementationOnce(() => {
                    throw error;
                });
            }
            else {
                vi.spyOn(native, 'close').mockImplementationOnce(() => {
                    throw error;
                });
            }
            const retiredNegotiation = native.onnegotiationneeded;
            native.connectionState = 'disconnected';
            native.onconnectionstatechange?.call(native, new Event('connectionstatechange'));
            await peer.handleReconnect();
            expect(vi.getTimerCount()).toBe(2);

            peer.reset();

            expect.soft(remaining.stopped).toBe(failure !== 'transceiver-enumeration');
            expect.soft(native.connectionState).toBe(failure === 'native-close' ? 'disconnected' : 'closed');
            expect.soft(peer.readDiagnostics().closedPeerConnectionCount).toBe(failure === 'native-close' ? 0 : 1);
            expect.soft(native.onnegotiationneeded).toBeNull();
            expect.soft(native.onicecandidate).toBeNull();
            expect.soft(native.ondatachannel).toBeNull();
            expect.soft(native.ontrack).toBeNull();
            expect.soft(native.onconnectionstatechange).toBeNull();
            expect.soft(vi.getTimerCount()).toBe(0);
            expect(errors).toContain(error);
            peer.connect();
            await retiredNegotiation?.call(native, new Event('negotiationneeded'));
            await vi.advanceTimersByTimeAsync(10_000);
            expect(peer.status.pc).not.toBe(native);
            expect(peer.status.pc?.signalingState).toBe('stable');
            expect(sentSignals).toEqual([]);
            expect(peer.readDiagnostics().reconnectAttemptsInFlight).toBe(0);
        }
    );

    it('stops reporting to the session reset closed, even for a hop still in flight', async () => {
        const runtime = installNativeRtcRuntime();
        onTestFinished(() => runtime.dispose());
        const pendingSend = Promise.withResolvers<void>();
        onTestFinished(() => pendingSend.resolve());
        let sendCalls = 0;
        const signaler: QRtcSignalingSender = {
            send: () => {
                sendCalls += 1;
                return pendingSend.promise;
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
        pendingSend.reject(new Error('signaling closed with the session'));
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

function createPeerFixture(
    isPolite: boolean,
    callbacks: QRtcPeerConnection.StateCallbacks = {},
    dependencies: QRtcPeerConnection.Dependencies = new DeterministicRtcOfferIds()
): PeerConnectionFixture {
    const runtime = installNativeRtcRuntime();
    const sentSignals: QRtcSignalingMessage[] = [];
    const signaler: QRtcSignalingSender = {
        send: async (message) => {
            sentSignals.push(decodeRtcSignalingMessage(JSON.stringify(message)));
        }
    };
    const peer = new QRtcPeerConnection(signaler, createPeerInput(isPolite), dependencies);
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

function createRecordingDependencies(events: RtcSignalingDiagnostics.Event[]): QRtcPeerConnection.Dependencies {
    return {
        createOfferId: new DeterministicRtcOfferIds().createOfferId,
        signalingDiagnostics: { nowEpochMs: () => 1, record: (event) => events.push(event) }
    };
}

function createRemoteOffer(offerId: string, connectionGeneration: number, sdp: string): QRtcSignal {
    return {
        signalType: 'Offer',
        offerId,
        connectionGeneration,
        payload: { description: { type: 'offer', sdp }, candidate: null }
    };
}

function createRemoteAnswer(offerId: string, connectionGeneration: number, sdp: string): QRtcSignal {
    return {
        signalType: 'Answer',
        offerId,
        connectionGeneration,
        payload: { description: { type: 'answer', sdp }, candidate: null }
    };
}

function createRemoteCandidate(candidate: string, connectionGeneration: number): QRtcSignal {
    return { signalType: 'IceCandidate', connectionGeneration, payload: { description: null, candidate: { candidate } } };
}

interface CandidateApplication {
    readonly candidate: string | undefined;
    /** The SDP of the remote description the native connection held when the candidate was added. */
    readonly remoteSdp: string | undefined;
}

function recordCandidateApplications(native: SimulatedNativeRtcPeerConnection): readonly CandidateApplication[] {
    const applications: CandidateApplication[] = [];
    const addIceCandidate = native.addIceCandidate.bind(native);
    vi.spyOn(native, 'addIceCandidate').mockImplementation(async (candidate) => {
        applications.push({ candidate: candidate?.candidate, remoteSdp: native.remoteDescription?.sdp });
        await addIceCandidate(candidate);
    });
    return applications;
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
        isPolite,
        connectionGeneration: 7
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
