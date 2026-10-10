import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { toRtcNativeObservationProjection } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';
import { RtcNativeObservationScope } from '@shared/webrtc/rtc-native-observation-scope.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';
import { installNativeRtcRuntime } from '../native-rtc-connection-fixture.ts';

interface FragmentCase {
    readonly name: string;
    readonly candidate: string | number | null | undefined;
    readonly remote: string | number | null | undefined;
    readonly presence: 'present' | 'absent' | 'unavailable';
    readonly comparison: 'equal' | 'different' | 'unknown';
    readonly reason: RtcSignalingDiagnostics.ReadoutUnavailableReason | undefined;
}

const cases: readonly FragmentCase[] = [
    { name: 'missing candidate', candidate: undefined, remote: 'private-remote', presence: 'absent', comparison: 'unknown', reason: 'absent' },
    { name: 'null candidate', candidate: null, remote: 'private-remote', presence: 'absent', comparison: 'unknown', reason: 'absent' },
    { name: 'empty candidate', candidate: '', remote: 'private-remote', presence: 'absent', comparison: 'unknown', reason: 'absent' },
    { name: 'invalid candidate', candidate: 17, remote: 'private-remote', presence: 'unavailable', comparison: 'unknown', reason: 'unrecognized' },
    {
        name: 'oversized candidate',
        candidate: 'x'.repeat(257),
        remote: 'private-remote',
        presence: 'unavailable',
        comparison: 'unknown',
        reason: 'unrecognized'
    },
    { name: 'throwing candidate', candidate: 'private-local', remote: 'private-remote', presence: 'unavailable', comparison: 'unknown', reason: 'read-failed' },
    { name: 'bounded equal', candidate: 'x'.repeat(256), remote: 'x'.repeat(256), presence: 'present', comparison: 'equal', reason: undefined },
    { name: 'different', candidate: 'private-local', remote: 'private-remote', presence: 'present', comparison: 'different', reason: undefined },
    { name: 'missing remote', candidate: 'private-local', remote: undefined, presence: 'present', comparison: 'unknown', reason: 'absent' },
    { name: 'null remote', candidate: 'private-local', remote: null, presence: 'present', comparison: 'unknown', reason: 'absent' },
    { name: 'empty remote', candidate: 'private-local', remote: '', presence: 'present', comparison: 'unknown', reason: 'absent' },
    { name: 'invalid remote', candidate: 'private-local', remote: 17, presence: 'present', comparison: 'unknown', reason: 'unrecognized' },
    { name: 'oversized remote', candidate: 'private-local', remote: 'x'.repeat(257), presence: 'present', comparison: 'unknown', reason: 'unrecognized' },
    { name: 'throwing remote', candidate: 'private-local', remote: 'private-remote', presence: 'present', comparison: 'unknown', reason: 'read-failed' },
    { name: 'missing method', candidate: 'private-local', remote: undefined, presence: 'present', comparison: 'unknown', reason: 'unsupported' },
    { name: 'throwing method getter', candidate: 'private-local', remote: undefined, presence: 'present', comparison: 'unknown', reason: 'read-failed' },
    { name: 'throwing method', candidate: 'private-local', remote: undefined, presence: 'present', comparison: 'unknown', reason: 'read-failed' },
    { name: 'missing parameters', candidate: 'private-local', remote: undefined, presence: 'present', comparison: 'unknown', reason: 'absent' },
    { name: 'null parameters', candidate: 'private-local', remote: undefined, presence: 'present', comparison: 'unknown', reason: 'absent' },
    { name: 'invalid parameters', candidate: 'private-local', remote: undefined, presence: 'present', comparison: 'unknown', reason: 'unrecognized' }
];

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

it.each(cases)('observes $name at the real direct and spliced-drain invocations without changing native outcomes', async (fixture) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = installNativeRtcRuntime();
    for (const source of ['direct', 'queue-drain'] as const) {
        const capability = RtcNativeObservationScope.create({ createScopeId: () => 'candidate-matrix' });
        const events: RtcSignalingDiagnostics.Event[] = [];
        const peer = new QRtcPeerConnection({ send: async () => {} }, {
            sessionId: 'a-self',
            peerSessionId: 'z-peer',
            token: 'test',
            iceCandidates: { iceServers: [], expiresAtEpochMs: 1000 },
            isPolite: true
        }, { createOfferId: () => 'offer', signalingDiagnostics: { nativeObservation: capability, nowEpochMs: () => 1, record: (row) => events.push(row) } });
        onTestFinished(() => {
            peer.reset();
            peer.disposeNativeObservations();
            if (capability.status === 'available') {
                capability.scope.dispose();
            }
        });
        peer.connect();
        const native = runtime.createdConnections.at(-1);
        if (!native) {
            throw new Error('Expected native peer');
        }
        native.setConnected();
        const ice = native.sctp?.transport.iceTransport;
        if (!ice) {
            throw new Error('Expected native data ICE transport');
        }
        installParameters(ice, fixture);
        native.dispatchEvent(new Event('connectionstatechange'));
        const candidate: RTCIceCandidateInit = { candidate: 'private-candidate-address' };
        Object.defineProperty(
            candidate,
            'usernameFragment',
            fixture.name === 'throwing candidate'
                ? {
                    get: () => {
                        throw new Error('private-fragment-getter');
                    }
                }
                : { value: fixture.candidate }
        );
        const failure = new DOMException('private-rejection', 'OperationError');
        native.addIceCandidate = async (value) => {
            native.receivedCandidates.push(value ?? null);
            if (native.receivedCandidates.length === 2) {
                throw failure;
            }
        };
        if (source === 'direct') {
            await native.setRemoteDescription({ type: 'offer' });
        }
        for (let index = 0; index < 3; index++) {
            const applying = peer.handleSignal({ signalType: 'IceCandidate', payload: { description: null, candidate } });
            if (source === 'direct' && index === 1) {
                await expect(applying).rejects.toBe(failure);
            }
            else {
                await applying;
            }
        }
        if (source === 'queue-drain') {
            expect(native.receivedCandidates).toEqual([]);
            await peer.handleSignal({
                signalType: 'Offer',
                offerId: 'offer',
                payload: { description: { type: 'offer', sdp: 'private-offer' }, candidate: null }
            });
        }
        expect(native.receivedCandidates).toEqual([candidate, candidate, candidate]);
        expect(peer.readDiagnostics().addedIceCandidateCount).toBe(2);
        expect(peer.readDiagnostics().flushedIceCandidateCount).toBe(source === 'queue-drain' ? 2 : 0);
        const rows = events.filter((row) => row.kind === 'native-candidate-application');
        expect(rows.map((row) => row.candidate.stage)).toEqual(['submitted', 'returned', 'submitted', 'rejected', 'submitted', 'returned']);
        expect(rows.map((row) => row.candidate.applicationOrdinal)).toEqual(source === 'queue-drain' ? [0, 0, 1, 1, 2, 2] : [0, 0, 0, 0, 0, 0]);
        for (const row of rows) {
            expect(row.candidate).toMatchObject({
                source,
                fragmentPresence: fixture.presence,
                dataIceFragmentComparison: fixture.comparison,
                comparisonReadout: fixture.reason ? { status: 'unavailable', reason: fixture.reason } : { status: 'observed', value: 'available' },
                targetTransportAssociation: 'unknown',
                iceGenerationAssociation: 'unknown'
            });
            expect(toRtcNativeObservationProjection(JSON.parse(JSON.stringify(row))).event).toBeDefined();
        }
        expect(JSON.stringify(rows)).not.toContain('private-');
        expect(JSON.stringify(rows)).not.toContain('x'.repeat(256));
        peer.reset();
    }
    runtime.dispose();
});

it.each(
    [
        { effect: 'sink', eventIndex: 0 },
        { effect: 'sink', eventIndex: 1 },
        { effect: 'sink', eventIndex: 2 },
        { effect: 'clock', eventIndex: 0 },
        { effect: 'clock', eventIndex: 1 },
        { effect: 'clock', eventIndex: 2 }
    ] as const
)('defers $effect reentry from queued native invocation $eventIndex until successful accounting', async ({ effect, eventIndex }) => {
    const runtime = installNativeRtcRuntime();
    const capability = RtcNativeObservationScope.create({ createScopeId: () => 'queued-invocation' });
    const events: RtcSignalingDiagnostics.Event[] = [];
    const trace: string[] = [];
    const receivers: RTCPeerConnection[] = [];
    const failures: unknown[] = [];
    let armed = false;
    let countsAtEffect: { added: number; flushed: number; } | undefined;
    const reenter = () => {
        armed = false;
        trace.push(`${effect}-reset`);
        const diagnostics = peer.readDiagnostics();
        countsAtEffect = { added: diagnostics.addedIceCandidateCount, flushed: diagnostics.flushedIceCandidateCount };
        peer.reset();
        peer.connect();
    };
    const peer = new QRtcPeerConnection({ send: async () => {} }, {
        sessionId: 'a-self',
        peerSessionId: 'z-peer',
        token: 'test',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 1000 },
        isPolite: true
    }, {
        createOfferId: () => 'offer',
        signalingDiagnostics: {
            nativeObservation: capability,
            nowEpochMs: () => {
                if (armed && effect === 'clock') {
                    reenter();
                }
                return 1;
            },
            record: (row) => {
                events.push(row);
                if (armed && effect === 'sink' && row.kind === 'native-first-error') {
                    reenter();
                }
            }
        }
    });
    onTestFinished(() => {
        peer.reset();
        peer.disposeNativeObservations();
        if (capability.status === 'available') {
            capability.scope.dispose();
        }
        runtime.dispose();
    });
    vi.spyOn(console, 'warn').mockImplementation((_label, failure) => {
        failures.push(failure);
        trace.push('rejection-warning');
    });
    peer.connect();
    const original = runtime.createdConnections[0];
    const originalIdentity = peer.getNativeIdentity();
    const candidates: RTCIceCandidateInit[] = [{ candidate: 'first' }, { candidate: 'rejected' }, { candidate: 'last' }];
    const rejection = new Error('original queued rejection');
    original.addIceCandidate = function (this: RTCPeerConnection, candidate) {
        receivers.push(this);
        const index = original.receivedCandidates.length;
        original.receivedCandidates.push(candidate ?? null);
        trace.push(`native-enter:${index}`);
        if (index === eventIndex) {
            armed = true;
            const error = new Event('icecandidateerror');
            Object.defineProperty(error, 'errorCode', { value: 701 });
            original.dispatchEvent(error);
        }
        trace.push(`native-return:${index}`);
        return index === 1 ? Promise.reject(rejection) : Promise.resolve();
    };
    for (const candidate of candidates) {
        await peer.handleSignal({ signalType: 'IceCandidate', payload: { description: null, candidate } });
    }
    expect(original.receivedCandidates).toEqual([]);
    await peer.handleSignal({
        signalType: 'Offer',
        offerId: 'offer',
        payload: { description: { type: 'offer', sdp: 'offer' }, candidate: null }
    });
    expect(original.connectionState).toBe('closed');
    expect(peer.status.pc).not.toBe(original);
    expect({ trace, countsAtEffect }).toEqual({
        trace: [
            'native-enter:0',
            'native-return:0',
            'native-enter:1',
            'native-return:1',
            'rejection-warning',
            'native-enter:2',
            'native-return:2',
            `${effect}-reset`
        ],
        countsAtEffect: { added: 2, flushed: 2 }
    });
    expect(original.receivedCandidates).toEqual(candidates);
    candidates.forEach((candidate, index) => expect(original.receivedCandidates[index]).toBe(candidate));
    expect(receivers).toEqual([original, original, original]);
    expect(failures).toEqual([rejection]);
    expect(failures[0]).toBe(rejection);
    expect(peer.readDiagnostics()).toMatchObject({ addedIceCandidateCount: 2, flushedIceCandidateCount: 2 });
    const applications = events.filter((row) => row.kind === 'native-candidate-application');
    expect(applications.map((row) => row.candidate.stage)).toEqual(['submitted', 'returned', 'submitted', 'rejected', 'submitted', 'returned']);
    expect(applications.map((row) => row.candidate.applicationOrdinal)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(applications.every((row) => JSON.stringify(row.candidate.identity) === JSON.stringify(originalIdentity))).toBe(true);
    const replacementIdentity = peer.getNativeIdentity();
    const replacementError = new Event('icecandidateerror');
    Object.defineProperty(replacementError, 'errorCode', { value: 702 });
    peer.status.pc?.dispatchEvent(replacementError);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'native-first-error', native: expect.objectContaining({ identity: replacementIdentity }) }));
    for (const row of applications) {
        expect(toRtcNativeObservationProjection(JSON.parse(JSON.stringify(row))).event).toBeDefined();
    }
});

it.each(['observed', 'unavailable'] as const)('restores synchronous context while an original queued promise remains pending with %s IDs', async (identity) => {
    const runtime = installNativeRtcRuntime();
    const capability = RtcNativeObservationScope.create(identity === 'observed' ? { createScopeId: () => 'held-queue' } : {});
    const events: RtcSignalingDiagnostics.Event[] = [];
    let release = () => {};
    let entered = () => {};
    let finished = () => {};
    let awaitingOriginalCompletion = false;
    const pending = new Promise<void>((resolve) => {
        release = resolve;
    });
    const invocation = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const completion = new Promise<void>((resolve) => {
        finished = resolve;
    });
    const peer = new QRtcPeerConnection({ send: async () => {} }, {
        sessionId: 'a-self',
        peerSessionId: 'z-peer',
        token: 'test',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 1000 },
        isPolite: true
    }, {
        createOfferId: () => 'offer',
        signalingDiagnostics: {
            nativeObservation: capability,
            nowEpochMs: () => 1,
            record: (row) => {
                events.push(row);
                if (awaitingOriginalCompletion && row.kind === 'native-signal-decision' && row.disposition === 'application-returned') {
                    finished();
                }
            }
        }
    });
    onTestFinished(() => {
        release();
        peer.reset();
        peer.disposeNativeObservations();
        if (capability.status === 'available') {
            capability.scope.dispose();
        }
        runtime.dispose();
    });
    peer.connect();
    const original = runtime.createdConnections[0];
    const originalIdentity = peer.getNativeIdentity();
    const candidate: RTCIceCandidateInit = { candidate: 'held' };
    let receiver: RTCPeerConnection | undefined;
    original.addIceCandidate = function (this: RTCPeerConnection, value) {
        receiver = this;
        original.receivedCandidates.push(value ?? null);
        entered();
        return pending;
    };
    await peer.handleSignal({ signalType: 'IceCandidate', payload: { description: null, candidate } });
    awaitingOriginalCompletion = true;
    const applying = peer.handleSignal({ signalType: 'Offer', offerId: 'offer', payload: { description: { type: 'offer', sdp: 'offer' }, candidate: null } });
    await invocation;
    expect(receiver).toBe(original);
    expect(original.receivedCandidates[0]).toBe(candidate);
    expect(peer.readDiagnostics().addedIceCandidateCount).toBe(0);
    peer.reset();
    peer.connect();
    const replacement = peer.status.pc;
    const replacementIdentity = peer.getNativeIdentity();
    const error = new Event('icecandidateerror');
    Object.defineProperty(error, 'errorCode', { value: 702 });
    replacement?.dispatchEvent(error);
    expect(original.connectionState).toBe('closed');
    expect(replacement).not.toBe(original);
    expect(events).toContainEqual(
        expect.objectContaining({ kind: 'native-lifetime', action: 'retiring', native: expect.objectContaining({ identity: originalIdentity }) })
    );
    expect(events).toContainEqual(expect.objectContaining({ kind: 'native-first-error', native: expect.objectContaining({ identity: replacementIdentity }) }));
    expect(peer.readDiagnostics().addedIceCandidateCount).toBe(0);
    peer.disposeNativeObservations();
    if (capability.status === 'available') {
        capability.scope.dispose();
    }
    const atDisposal = events.map((row) => toRtcNativeObservationProjection(row).event).filter(Boolean);
    release();
    await applying;
    await completion;
    expect(events.map((row) => toRtcNativeObservationProjection(row).event).filter(Boolean)).toEqual(atDisposal);
    expect(peer.status.pc).toBe(replacement);
    expect(peer.readDiagnostics()).toMatchObject({ addedIceCandidateCount: 0, flushedIceCandidateCount: 0 });
});

function installParameters(ice: RTCIceTransport, fixture: FragmentCase): void {
    if (fixture.name === 'missing method') {
        return;
    }
    if (fixture.name === 'throwing method getter') {
        Object.defineProperty(ice, 'getRemoteParameters', {
            get: () => {
                throw new Error('private-method-getter');
            }
        });
        return;
    }
    Object.defineProperty(ice, 'getRemoteParameters', {
        value: () => {
            if (fixture.name === 'throwing method') {
                throw new Error('private-method');
            }
            if (fixture.name === 'missing parameters') {
                return undefined;
            }
            if (fixture.name === 'null parameters') {
                return null;
            }
            if (fixture.name === 'invalid parameters') {
                return 17;
            }
            return Object.defineProperty(
                {},
                'usernameFragment',
                fixture.name === 'throwing remote'
                    ? {
                        get: () => {
                            throw new Error('private-remote-getter');
                        }
                    }
                    : { value: fixture.remote }
            );
        }
    });
}
