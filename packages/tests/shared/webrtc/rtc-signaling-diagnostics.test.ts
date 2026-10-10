import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { newALEventRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';
import type {
    QRtcSignalingMessage,
    QRtcSignalingTransportInput
} from '@shared/webrtc/qrtc-signaling-contracts.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import {
    installNativeRtcRuntime,
    SimulatedNativeRtcPeerConnection,
    type NativeRtcRuntime
} from '../native-rtc-connection-fixture.ts';
import { DeterministicRtcOfferIds } from './deterministic-rtc-offer-ids.ts';

afterEach(() => vi.restoreAllMocks());

describe('owned RTC signaling observations', () => {
    it('distinguishes pending native application from the caller and native return', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const { peer, native } = createObservedPeer((event) => events.push(event), () => 123, true);
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        onTestFinished(() => release.resolve());
        const apply = native.setRemoteDescription.bind(native);
        vi.spyOn(native, 'setRemoteDescription').mockImplementationOnce(async (description) => {
            started.resolve();
            await release.promise;
            await apply(description);
        });
        let settled = false;
        const caller = peer.handleSignal(answer('offer-1')).then(() => {
            settled = true;
        });
        await started.promise;
        expect(settled).toBe(false);
        expect(native.receivedDescriptions).toEqual([]);
        expect(events).toContainEqual(
            expect.objectContaining({ kind: 'native-signal-decision', disposition: 'application-started', currentPeerConnection: true, atEpochMs: 123 })
        );
        expect(events).not.toContainEqual(expect.objectContaining({ kind: 'signal-caller-release' }));
        release.resolve();
        await caller;
        expect(native.receivedDescriptions).toEqual([{ type: 'answer', sdp: 'private-answer' }]);
        expect(events).toContainEqual(expect.objectContaining({ disposition: 'remote-description-returned', currentPeerConnection: true }));
        expect(events).toContainEqual(expect.objectContaining({ kind: 'signal-caller-release', disposition: 'application-returned' }));
        expect(JSON.stringify(events)).not.toContain('private-');
    });

    it('records retirement as the accepted release while observing late rejection without replacing the peer', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const { peer, native, runtime } = createObservedPeer((event) => events.push(event), () => 0, true);
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        const started = Promise.withResolvers<void>();
        const application = Promise.withResolvers<void>();
        onTestFinished(() => application.resolve());
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(native, 'setRemoteDescription').mockImplementationOnce(() => {
            started.resolve();
            return application.promise;
        });
        const applying = peer.handleSignal(answer('offer-1'));
        await started.promise;
        const queued = peer.handleSignal(answer('offer-1'));
        peer.reset();
        peer.connect();
        await Promise.all([applying, queued]);
        const replacement = runtime.createdConnections[1];
        expect(peer.status.pc).toBe(replacement);
        expect(native.connectionState).toBe('closed');
        expect(replacement.receivedDescriptions).toEqual([]);
        expect(peer.readDiagnostics().inboundSignalingErrorCount).toBe(0);
        expect(events.filter((event) => isRelease(event, 'lifetime-retired'))).toHaveLength(2);
        application.reject(new Error('private-native-error'));
        await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ disposition: 'application-threw', currentPeerConnection: false })));
        expect(peer.status.pc).toBe(replacement);
        expect(peer.readDiagnostics().inboundSignalingErrorCount).toBe(0);
        expect(events).toContainEqual(expect.objectContaining({ disposition: 'retired-before-application', currentPeerConnection: false }));
        expect(JSON.stringify(events)).not.toContain('private-');
    });

    it('records a late native return on the retired capture without applying it to its replacement', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const { peer, native, runtime } = createObservedPeer((event) => events.push(event), () => 2, true);
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        onTestFinished(() => release.resolve());
        const apply = native.setRemoteDescription.bind(native);
        vi.spyOn(native, 'setRemoteDescription').mockImplementationOnce(async (description) => {
            started.resolve();
            await release.promise;
            await apply(description);
        });
        const caller = peer.handleSignal(answer('offer-1'));
        await started.promise;
        peer.reset();
        peer.connect();
        await caller;
        const replacement = runtime.createdConnections[1];
        expect(native.receivedDescriptions).toEqual([]);
        expect(events.filter((event) => isRelease(event, 'lifetime-retired'))).toHaveLength(1);
        release.resolve();
        await vi.waitFor(() =>
            expect(events).toContainEqual(expect.objectContaining({ disposition: 'retired-after-remote-description', currentPeerConnection: false }))
        );
        expect(native.receivedDescriptions).toEqual([{ type: 'answer', sdp: 'private-answer' }]);
        expect(events).toContainEqual(
            expect.objectContaining({ disposition: 'remote-description-returned', capturedPeerConnection: true, currentPeerConnection: false })
        );
        expect(replacement.receivedDescriptions).toEqual([]);
        expect(peer.status.pc).toBe(replacement);
        expect(peer.readDiagnostics().inboundSignalingErrorCount).toBe(0);
        expect(events.filter((event) => isRelease(event, 'application-returned'))).toHaveLength(0);
        expect(JSON.stringify(events)).not.toContain('private-');
    });

    it('does not relabel an accepted application release when reset reenters before listener cleanup', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const record = vi.fn<RtcSignalingDiagnostics['record']>();
        const fixture = createObservedPeer(record, () => 1, true);
        const { peer } = fixture;
        record.mockImplementation((event) => {
            events.push(event);
            if (isRelease(event, 'application-returned')) {
                peer.reset();
            }
        });
        await fixture.native.onnegotiationneeded?.call(fixture.native, new Event('negotiationneeded'));
        await peer.handleSignal(answer('offer-1'));
        expect(fixture.native.receivedDescriptions).toEqual([{ type: 'answer', sdp: 'private-answer' }]);
        expect(events.filter((event) => isRelease(event, 'application-returned'))).toHaveLength(1);
        expect(events.filter((event) => isRelease(event, 'lifetime-retired'))).toHaveLength(0);
        expect(fixture.native.connectionState).toBe('closed');
        expect(peer.readDiagnostics().inboundSignalingErrorCount).toBe(0);
    });

    it('retains the actual combined answer eligibility without exposing the outstanding offer', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const { peer, native } = createObservedPeer((event) => events.push(event), () => 12, true);
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await peer.handleSignal(answer('stale-offer'));
        expect(native.receivedDescriptions).toEqual([]);
        expect(native.signalingState).toBe('have-local-offer');
        expect(events).toContainEqual(
            expect.objectContaining({ disposition: 'answer-ineligible', currentPeerConnection: true, offerMatches: false, signalingState: 'have-local-offer' })
        );
        expect(JSON.stringify(events)).not.toContain('outstandingOfferId');
        await peer.handleSignal(answer('offer-1'));
        expect(native.receivedDescriptions).toHaveLength(1);
    });

    it('distinguishes queued ICE and ignored collision from native application success', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const { peer, native } = createObservedPeer((event) => events.push(event), () => 10, false);
        await peer.handleSignal({ signalType: 'IceCandidate', payload: { description: null, candidate: { candidate: 'private-ice' } } });
        expect(native.receivedCandidates).toEqual([]);
        expect(events).toContainEqual(expect.objectContaining({ disposition: 'ice-queued', signalType: 'IceCandidate' }));
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await peer.handleSignal({ signalType: 'Offer', offerId: 'remote', payload: { description: { type: 'offer', sdp: 'private-offer' }, candidate: null } });
        expect(native.receivedDescriptions).toEqual([]);
        expect(events).toContainEqual(expect.objectContaining({ disposition: 'impolite-offer-ignored' }));
        expect(JSON.stringify(events)).not.toContain('private-');
    });

    it('keeps business error identity when the supplemental clock or sink fails', async () => {
        for (const failurePort of ['clock', 'sink'] as const) {
            const { peer, native } = createObservedPeer(() => {
                if (failurePort === 'sink') {
                    throw new Error('private-sink');
                }
            }, () => {
                if (failurePort === 'clock') {
                    throw new Error('private-clock');
                }
                return 3;
            }, true);
            await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
            const original = new Error('original-native-failure');
            vi.spyOn(console, 'error').mockImplementation(() => {});
            vi.spyOn(native, 'setRemoteDescription').mockRejectedValueOnce(original);
            await expect(peer.handleSignal(answer('offer-1'))).rejects.toBe(original);
            expect(peer.readDiagnostics().inboundSignalingErrorCount).toBe(1);
        }
    });

    it('records real service admission and reuse without publishing policy reason or envelope secrets', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const { service, runtime, sent, receive } = createObservedService((event) => events.push(event));
        await service.connectSignaler();
        service.setInboundPeerCreationPolicy(() => ({ decision: 'retry', reason: 'private-policy' }));
        expect(await receive({ resource: JSON.stringify(offer()), senderId: 'peer', sessionId: 'self', recipientId: 'self' })).toBe('retry');
        expect(runtime.createdConnections).toHaveLength(0);
        expect(events).toContainEqual(expect.objectContaining({ kind: 'service-signal-route', disposition: 'policy-retry' }));
        service.setInboundPeerCreationPolicy(() => true);
        await receive({ resource: JSON.stringify(offer()), senderId: 'peer', sessionId: 'self', recipientId: 'self' });
        expect(runtime.createdConnections[0].receivedDescriptions).toHaveLength(1);
        expect(sent).toMatchObject([{ signalType: 'Answer', offerId: 'remote' }]);
        service.setInboundPeerCreationPolicy(() => false);
        await receive({ resource: JSON.stringify(offer()), senderId: 'peer', sessionId: 'self', recipientId: 'self' });
        expect(runtime.createdConnections).toHaveLength(1);
        expect(events).toContainEqual(expect.objectContaining({ disposition: 'reuse-selected' }));
        expect(JSON.stringify(events)).not.toContain('private-');
    });

    it('rejects invalid service entries and denies missing peers before native allocation', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const { service, runtime, receive } = createObservedService((event) => events.push(event));
        await service.connectSignaler();
        await expect(receive({ resource: JSON.stringify(offer()), senderId: 'peer', sessionId: 'other', recipientId: 'self' })).rejects.toThrow(
            'wrong session'
        );
        await expect(receive({ resource: '{"private-token": BROKEN}', senderId: 'peer', sessionId: 'self', recipientId: 'self' })).rejects.toBeInstanceOf(
            TypeError
        );
        await receive({ resource: JSON.stringify({ ...offer(), ...answer('offer') }), senderId: 'peer', sessionId: 'self', recipientId: 'self' });
        service.setInboundPeerCreationPolicy(() => ({ decision: 'deny', reason: 'private-policy' }));
        await receive({ resource: JSON.stringify(offer()), senderId: 'peer', sessionId: 'self', recipientId: 'self' });
        service.setInboundPeerCreationPolicy(() => {
            throw new Error('private-policy');
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await receive({ resource: JSON.stringify(offer()), senderId: 'peer', sessionId: 'self', recipientId: 'self' });
        expect(runtime.createdConnections).toHaveLength(0);
        for (const disposition of ['wrong-session', 'decode-rejected', 'missing-peer-answer', 'policy-deny', 'policy-threw']) {
            expect(events).toContainEqual(expect.objectContaining({ kind: 'service-signal-route', disposition }));
        }
        expect(JSON.stringify(events)).not.toContain('private-');
    });

    it('drops decoded wrong-target and self signals before admission and stops new peers at the cap', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const { service, runtime, receive } = createObservedService((event) => events.push(event));
        await service.connectSignaler();
        const admittedPeerIds: string[] = [];
        service.setInboundPeerCreationPolicy(({ peerId }) => {
            admittedPeerIds.push(peerId);
            return true;
        });
        await receive({ resource: JSON.stringify({ ...offer(), toId: 'other' }), senderId: 'peer', sessionId: 'self', recipientId: 'other' });
        await receive({ resource: JSON.stringify({ ...offer(), fromId: 'self' }), senderId: 'self', sessionId: 'self', recipientId: 'self' });
        expect(runtime.createdConnections).toHaveLength(0);
        expect(admittedPeerIds).toEqual([]);
        expect(events).toContainEqual(expect.objectContaining({ disposition: 'wrong-target' }));
        expect(events).toContainEqual(expect.objectContaining({ disposition: 'self' }));
        for (let index = 0; index < 10; index++) {
            const peerId = `peer-${index}`;
            await receive({ resource: JSON.stringify({ ...offer(), fromId: peerId }), senderId: peerId, sessionId: 'self', recipientId: 'self' });
        }
        expect(runtime.createdConnections).toHaveLength(10);
        expect(admittedPeerIds).toHaveLength(10);
        await receive({ resource: JSON.stringify({ ...offer(), fromId: 'overflow' }), senderId: 'overflow', sessionId: 'self', recipientId: 'self' });
        expect(runtime.createdConnections).toHaveLength(10);
        expect(service.readPeer('overflow')).toBeUndefined();
        expect(admittedPeerIds).toHaveLength(10);
        expect(events).toContainEqual(expect.objectContaining({ disposition: 'peer-cap', peerSessionId: 'overflow' }));
    });

    it('preserves the accepted-peer Either result and reused-peer rejection identity', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const { service, runtime, receive } = createObservedService((event) => events.push(event));
        await service.connectSignaler();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const firstFailure = new Error('private-native-failure');
        vi.spyOn(SimulatedNativeRtcPeerConnection.prototype, 'setRemoteDescription').mockRejectedValueOnce(firstFailure);
        await receive({ resource: JSON.stringify(offer()), senderId: 'peer', sessionId: 'self', recipientId: 'self' });
        expect(service.readPeer('peer')).toBeDefined();
        expect(events).toContainEqual(expect.objectContaining({ disposition: 'accepted-peer-result', result: 'signal-handle-failed' }));
        const reusedFailure = new Error('private-reused-failure');
        vi.spyOn(runtime.createdConnections[0], 'setRemoteDescription').mockRejectedValueOnce(reusedFailure);
        await expect(receive({ resource: JSON.stringify(offer()), senderId: 'peer', sessionId: 'self', recipientId: 'self' })).rejects.toBe(reusedFailure);
        expect(events).toContainEqual(expect.objectContaining({ disposition: 'reuse-threw' }));
        expect(JSON.stringify(events)).not.toContain('private-');
    });

    it('observes no native PC without converting a returned call into native application', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const { peer } = createObservedPeer((event) => events.push(event), () => 0, true);
        peer.reset();
        await peer.handleSignal(answer('offer'));
        expect(peer.status.pc).toBeUndefined();
        expect(events).toContainEqual(
            expect.objectContaining({ disposition: 'no-native-peer', capturedPeerConnection: false, currentPeerConnection: undefined })
        );
        expect(events).not.toContainEqual(expect.objectContaining({ disposition: 'remote-description-returned' }));
        expect(events).toContainEqual(expect.objectContaining({ kind: 'signal-caller-release', disposition: 'application-returned' }));
    });

    it('records the actual rollback pair, local answer and direct ICE return without retaining native data', async () => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const { peer, native } = createObservedPeer((event) => events.push(event), () => 7, true);
        await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
        await peer.handleSignal({ signalType: 'Offer', offerId: 'remote', payload: { description: { type: 'offer', sdp: 'private-offer' }, candidate: null } });
        await peer.handleSignal({ signalType: 'IceCandidate', payload: { description: null, candidate: { candidate: 'private-ice' } } });
        expect(native.receivedDescriptions).toEqual([{ type: 'offer', sdp: 'private-offer' }]);
        expect(native.localDescription?.type).toBe('answer');
        expect(native.receivedCandidates).toEqual([{ candidate: 'private-ice' }]);
        for (const disposition of ['rollback-and-remote-description-returned', 'local-answer-description-returned', 'ice-added']) {
            expect(events).toContainEqual(expect.objectContaining({ disposition, currentPeerConnection: true }));
        }
        expect(JSON.stringify(events)).not.toContain('private-');
    });

    it('supports diagnostics disabled and drops invalid supplemental clocks without changing native work', async () => {
        const runtime = installNativeRtcRuntime();
        const peer = new QRtcPeerConnection({ send: async () => {} }, {
            sessionId: 'self',
            token: 'private-token',
            peerSessionId: 'peer',
            iceCandidates: { iceServers: [], expiresAtEpochMs: 100 },
            isPolite: true
        }, new DeterministicRtcOfferIds());
        onTestFinished(() => {
            try {
                peer.reset();
            }
            finally {
                runtime.dispose();
            }
        });
        peer.connect();
        await peer.handleSignal({ signalType: 'Offer', offerId: 'remote', payload: { description: { type: 'offer', sdp: 'private-offer' }, candidate: null } });
        expect(runtime.createdConnections[0].receivedDescriptions).toHaveLength(1);
        const events: RtcSignalingDiagnostics.Event[] = [];
        const enabled = createObservedPeer((event) => events.push(event), () => Number.NaN, true);
        await enabled.peer.handleSignal({
            signalType: 'Offer',
            offerId: 'remote',
            payload: { description: { type: 'offer', sdp: 'private-offer' }, candidate: null }
        });
        expect(enabled.native.receivedDescriptions).toHaveLength(1);
        expect(events).toEqual([]);
    });
});

interface ObservedPeerFixture {
    readonly peer: QRtcPeerConnection;
    readonly native: SimulatedNativeRtcPeerConnection;
    readonly runtime: NativeRtcRuntime;
}

interface SignalingReceiptInput {
    readonly resource: string;
    readonly senderId: string;
    readonly sessionId: string;
    readonly recipientId: string;
}

interface ObservedServiceFixture {
    readonly service: WebRtcConnectionService;
    readonly runtime: NativeRtcRuntime;
    readonly sent: readonly QRtcSignalingMessage[];
    receive(input: SignalingReceiptInput): Promise<void | 'retry'>;
}

function isRelease(event: RtcSignalingDiagnostics.Event, disposition: RtcSignalingDiagnostics.CallerRelease): boolean {
    return event.kind === 'signal-caller-release' && event.disposition === disposition;
}

function answer(offerId: string) {
    return { signalType: 'Answer', offerId, payload: { description: { type: 'answer', sdp: 'private-answer' }, candidate: null } } as const;
}

function createObservedPeer(record: RtcSignalingDiagnostics['record'], nowEpochMs: () => number, isPolite: boolean): ObservedPeerFixture {
    const runtime = installNativeRtcRuntime();
    const dependencies = { createOfferId: new DeterministicRtcOfferIds().createOfferId, signalingDiagnostics: { nowEpochMs, record } };
    const peer = new QRtcPeerConnection({ send: async () => {} }, {
        sessionId: 'self',
        token: 'private-token',
        peerSessionId: 'peer',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 100 },
        isPolite
    }, dependencies);
    onTestFinished(() => {
        try {
            peer.reset();
        }
        finally {
            runtime.dispose();
        }
    });
    peer.connect();
    return { peer, native: runtime.createdConnections[0], runtime };
}

function offer() {
    return {
        channel: 'RtcSignal',
        type: 'Signal',
        fromId: 'peer',
        toId: 'self',
        sessionId: 'peer',
        token: 'private-token',
        signalType: 'Offer',
        offerId: 'remote',
        payload: { description: { type: 'offer', sdp: 'private-offer' }, candidate: null }
    } as const;
}

function createObservedService(record: RtcSignalingDiagnostics['record']): ObservedServiceFixture {
    const runtime = installNativeRtcRuntime();
    let registered: QRtcSignalingTransportInput | undefined;
    const sent: QRtcSignalingMessage[] = [];
    const nowEpochMs = () => 20;
    const dependencies = {
        faultPort: createPassThroughTransportFaultPort(),
        createOfferId: new DeterministicRtcOfferIds().createOfferId,
        nowEpochMs,
        signalingDiagnostics: { nowEpochMs, record }
    };
    const service = new WebRtcConnectionService({
        connect: async (input) => {
            registered = input;
        },
        send: async (message) => {
            sent.push(message);
        }
    }, {
        sessionId: 'self',
        token: 'private-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 100 },
        dataChannelName: 'rtc',
        rtcSignalingTopicId: 'rtc'
    }, dependencies);
    onTestFinished(() => {
        try {
            for (const peerId of service.knownPeerIds()) {
                service.removePeerIfPresent(peerId);
            }
        }
        finally {
            runtime.dispose();
        }
    });
    const receive = async ({ resource, senderId, sessionId, recipientId }: SignalingReceiptInput): Promise<void | 'retry'> => {
        if (!registered) {
            throw new Error('Expected registered signaling port');
        }
        const envelope = newALUnicastMessage(senderId, newALEventRoute('rtc', recipientId), recipientId, 'rtc', null);
        return await registered.callbacks.onMessage(sessionId, 'private-token', { ...envelope, payload: { ...envelope.payload, resource } });
    };
    return { service, runtime, sent, receive };
}
