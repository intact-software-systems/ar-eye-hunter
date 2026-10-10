import { describe, expect, it, onTestFinished } from 'vitest';

import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';
import type { QRtcSignal } from '@shared/webrtc/qrtc-signaling-contracts.ts';

import { installNativeRtcRuntime } from '../native-rtc-connection-fixture.ts';
import { DeterministicRtcOfferIds } from './deterministic-rtc-offer-ids.ts';

describe('native signal ownership after synchronous diagnostics', () => {
    describe.each(['sink', 'clock'] as const)('%s reset', (port) => {
        it.each(['queued-ice', 'direct-ice', 'offer', 'answer'] as const)('retires %s before its native or queue effects', async (kind) => {
            const runtime = installNativeRtcRuntime();
            let onObservation = (): void => {};
            const peer = new QRtcPeerConnection({ send: async () => {} }, {
                sessionId: 'self',
                token: 'test',
                peerSessionId: 'peer',
                iceCandidates: { iceServers: [], expiresAtEpochMs: 100 },
                isPolite: true
            }, {
                createOfferId: new DeterministicRtcOfferIds().createOfferId,
                signalingDiagnostics: {
                    nowEpochMs: () => {
                        if (port === 'clock') {
                            onObservation();
                        }
                        return 0;
                    },
                    record: (event) => {
                        if (port === 'sink' && event.kind === 'native-signal-decision' && event.disposition === 'application-started') {
                            onObservation();
                        }
                    }
                }
            });
            onTestFinished(() => {
                peer.reset();
                runtime.dispose();
            });
            peer.connect();
            const retired = runtime.createdConnections[0];
            if (kind === 'answer') {
                await retired.onnegotiationneeded?.call(retired, new Event('negotiationneeded'));
            }
            if (kind === 'direct-ice') {
                await peer.handleSignal({ signalType: 'Offer', offerId: 'setup', payload: { description: { type: 'offer', sdp: 'setup' }, candidate: null } });
            }
            const descriptionsBefore = [...retired.receivedDescriptions];
            onObservation = () => {
                onObservation = () => {};
                peer.reset();
                peer.connect();
            };
            const signal: QRtcSignal = kind === 'answer'
                ? { signalType: 'Answer', offerId: 'offer-1', payload: { description: { type: 'answer', sdp: 'old-answer' }, candidate: null } }
                : kind === 'offer'
                ? { signalType: 'Offer', offerId: 'old-offer', payload: { description: { type: 'offer', sdp: 'old-offer' }, candidate: null } }
                : { signalType: 'IceCandidate', payload: { description: null, candidate: { candidate: 'old-candidate' } } };
            await peer.handleSignal(signal);
            const replacement = runtime.createdConnections[1];
            expect.soft(peer.status.pc).toBe(replacement);
            expect.soft(peer.status.iceCandidateQueue).toEqual([]);
            expect.soft(retired.receivedDescriptions).toEqual(descriptionsBefore);
            expect.soft(retired.receivedCandidates).toEqual([]);
            expect.soft(peer.readDiagnostics().inboundSignalingErrorCount).toBe(0);
            await peer.handleSignal({
                signalType: 'Offer',
                offerId: 'current-offer',
                payload: { description: { type: 'offer', sdp: 'current-offer' }, candidate: null }
            });
            expect(replacement.receivedDescriptions).toEqual([{ type: 'offer', sdp: 'current-offer' }]);
            expect(replacement.receivedCandidates).toEqual([]);
        });
    });
});
