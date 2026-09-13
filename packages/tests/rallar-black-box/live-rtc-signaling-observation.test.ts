import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { newALEventRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import type { QRtcSignalingMessage } from '@shared/webrtc/qrtc-signaling-contracts.ts';

import {
    decodeLiveRtcSignalingObservationSnapshot,
    installLiveRtcSignalingObservation,
    type LiveRtcSignalingObservation
} from '../../../tests/playwright/rallar-black-box/live-rtc-signaling-observation.ts';
import { installLiveRtcWireObservation } from '../../../tests/playwright/rallar-black-box/live-rtc-wire-observation.ts';

class NativeSocket extends EventTarget {
    static readonly OPEN = 1;
    readonly protocols: string | string[] | undefined;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(_url: string | URL, protocols?: string | string[]) {
        super();
        this.protocols = protocols;
        this.addEventListener('message', (event) => this.onmessage?.(event as MessageEvent));
    }
}

class NativePeer extends EventTarget {
    static completion: Promise<void> = Promise.resolve();
    signalingState = 'stable';
    connectionState = 'new';
    iceConnectionState = 'new';

    setRemoteDescription(_description: RTCSessionDescriptionInit): Promise<void> {
        return NativePeer.completion;
    }

    close(): void {
        this.signalingState = 'closed';
        this.connectionState = 'closed';
        this.iceConnectionState = 'closed';
    }

    createDataChannel(): EventTarget {
        return new EventTarget();
    }
}

class CollectableReference<T extends WeakKey> extends WeakRef<T> {
    static collected = false;
    static reads = 0;

    override deref(): T | undefined {
        CollectableReference.reads++;
        return CollectableReference.collected ? undefined : super.deref();
    }
}

function installObserver(clock: Pick<Performance, 'timeOrigin' | 'now'> = performance, reference = WeakRef): void {
    vi.stubGlobal('window', { WebSocket: NativeSocket, RTCPeerConnection: NativePeer });
    runInNewContext(`(${installLiveRtcSignalingObservation.toString()})()`, {
        window,
        crypto,
        performance: clock,
        WeakRef: reference
    });
}

function signalFrame(msgId: string, signalType: 'Offer' | 'Answer' | 'IceCandidate', sdp = 'secret-sdp'): string {
    const signal: QRtcSignalingMessage = {
        channel: 'RtcSignal',
        type: 'Signal',
        fromId: 'sender-a',
        toId: 'receiver-b',
        sessionId: 'sender-a',
        token: 'secret-token',
        ...(signalType === 'IceCandidate'
            ? { signalType, payload: { description: null, candidate: { candidate: 'secret-candidate' } } }
            : signalType === 'Offer'
            ? { signalType, offerId: 'offer-a', payload: { description: { type: 'offer', sdp }, candidate: null } }
            : { signalType, offerId: 'offer-a', payload: { description: { type: 'answer', sdp }, candidate: null } })
    };
    const envelope = newALUnicastMessage('sender-a', newALEventRoute('rtc-signaling', 'receiver-b'), 'receiver-b', 'rtc-signaling', signal);
    return JSON.stringify({ ...envelope, id: { ...envelope.id, msgId } });
}

function readSnapshot(): LiveRtcSignalingObservation.Snapshot {
    const observation = window.__liveRtcSignalingObservation;
    if (!observation) {
        return decodeLiveRtcSignalingObservationSnapshot(null);
    }
    return observation.read();
}

describe('live RTC signaling observation', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('captures old native retirement and replacement creation without another description attempt', async () => {
        let now = 1;
        installObserver({ timeOrigin: 1_000, now: () => now });
        NativePeer.completion = Promise.resolve();
        const socket = new window.WebSocket('ws://localhost');
        socket.dispatchEvent(new MessageEvent('message', { data: signalFrame('retired-offer', 'Offer') }));
        const first = new window.RTCPeerConnection();
        await first.setRemoteDescription({ type: 'offer', sdp: 'secret-sdp' });
        now = 2;
        expect(first.close()).toBeUndefined();
        now = 3;
        const replacement = new window.RTCPeerConnection();
        Object.assign(replacement, { connectionState: 'connecting' });
        now = 4;
        const snapshot = decodeLiveRtcSignalingObservationSnapshot(readSnapshot());
        expect(snapshot.attempts).toMatchObject([{ nativeInstanceOrdinal: 1, msgId: 'retired-offer', settlement: 'applied' }]);
        expect(snapshot).toMatchObject({
            nativeLifetimes: [
                {
                    nativeInstanceOrdinal: 1,
                    createdAtEpochMs: 1_001,
                    closedAtEpochMs: 1_002,
                    creationState: { connectionState: 'new' },
                    closeState: { connectionState: 'closed' },
                    observation: 'live',
                    observedAtEpochMs: 1_004,
                    state: { connectionState: 'closed' }
                },
                {
                    nativeInstanceOrdinal: 2,
                    createdAtEpochMs: 1_003,
                    closedAtEpochMs: null,
                    closeState: null,
                    observation: 'live',
                    observedAtEpochMs: 1_004,
                    state: { connectionState: 'connecting' }
                }
            ],
            droppedNativeLifetimes: 0
        });
    });

    it('keeps only a bounded weak lifetime window and exposes collection without stale current state', () => {
        CollectableReference.collected = false;
        CollectableReference.reads = 0;
        installObserver(performance, CollectableReference);
        const first = new window.RTCPeerConnection();
        for (let index = 1; index < 300; index++) {
            new window.RTCPeerConnection();
        }
        first.close();
        CollectableReference.collected = true;
        const snapshot = readSnapshot();
        expect(snapshot.nativeLifetimes).toHaveLength(128);
        expect(snapshot.droppedNativeLifetimes).toBe(172);
        expect(CollectableReference.reads).toBe(128);
        expect(snapshot.nativeLifetimes[0]).toMatchObject({ nativeInstanceOrdinal: 173, closedAtEpochMs: null });
        expect(snapshot.nativeLifetimes.every((lifetime) => lifetime.observation === 'collected')).toBe(true);
        expect(snapshot.nativeLifetimes[0].state).toEqual({ signalingState: null, connectionState: null, iceConnectionState: null });
        expect(JSON.stringify(snapshot)).not.toMatch(/reference|deref|secret-/);
    });

    it('preserves close return and throw identity and marks unreadable current state unavailable', () => {
        installObserver();
        const peer = new window.RTCPeerConnection();
        const failure = new Error('secret-native-close');
        vi.spyOn(NativePeer.prototype, 'close').mockImplementationOnce(() => {
            throw failure;
        });
        try {
            peer.close();
            expect.fail('Expected native close rejection');
        }
        catch (cause) {
            expect(cause).toBe(failure);
        }
        expect(readSnapshot().nativeLifetimes[0].closedAtEpochMs).toBeNull();
        vi.spyOn(NativePeer.prototype, 'close').mockImplementationOnce(() => 42);
        expect(peer.close()).toBe(42);
        Object.defineProperty(peer, 'connectionState', {
            get: () => {
                throw failure;
            }
        });
        const snapshot = readSnapshot();
        expect(snapshot.nativeLifetimes[0]).toMatchObject({ observation: 'unavailable', observedAtEpochMs: null });
        expect(snapshot.nativeLifetimes[0].state.connectionState).toBeNull();
        expect(JSON.stringify(snapshot)).not.toContain('secret-');
    });

    it.each(['wire-first', 'signaling-first'])('preserves data-channel observation and native lifetimes in %s order', async (order) => {
        if (order === 'wire-first') {
            vi.stubGlobal('window', { WebSocket: NativeSocket, RTCPeerConnection: NativePeer });
            runInNewContext(`(${installLiveRtcWireObservation.toString()})()`, { window });
            runInNewContext(`(${installLiveRtcSignalingObservation.toString()})()`, { window, crypto, performance });
        }
        else {
            installObserver();
            runInNewContext(`(${installLiveRtcWireObservation.toString()})()`, { window });
        }
        NativePeer.completion = Promise.resolve();
        const peer = new window.RTCPeerConnection();
        const channel = peer.createDataChannel('test');
        window.__liveRtcWireObservation?.start();
        channel.dispatchEvent(new MessageEvent('message', { data: 'safe-wire-frame' }));
        await peer.setRemoteDescription({ type: 'offer', sdp: 'secret-sdp' });
        peer.close();
        new window.RTCPeerConnection();
        expect(window.__liveRtcWireObservation?.read()).toEqual(['safe-wire-frame']);
        expect(readSnapshot().attempts[0]).toMatchObject({ nativeInstanceOrdinal: 1, settlement: 'applied' });
        expect(readSnapshot().nativeLifetimes).toMatchObject([
            { nativeInstanceOrdinal: 1, state: { connectionState: 'closed' } },
            { nativeInstanceOrdinal: 2, closedAtEpochMs: null }
        ]);
        window.__liveRtcWireObservation?.stop();
    });

    it('does not resurrect evicted native lifetimes or attempts when pending descriptions settle', async () => {
        installObserver();
        let complete = () => {};
        NativePeer.completion = new Promise<void>((resolve) => {
            complete = resolve;
        });
        const completions: Promise<void>[] = [];
        for (let index = 0; index < 300; index++) {
            completions.push(new window.RTCPeerConnection().setRemoteDescription({ type: 'offer', sdp: 'secret-sdp' }));
        }
        expect(readSnapshot().attempts.every((attempt) => attempt.settlement === 'attempted')).toBe(true);
        complete();
        await Promise.all(completions);
        const snapshot = readSnapshot();
        expect(snapshot.attempts).toHaveLength(128);
        expect(snapshot.nativeLifetimes).toHaveLength(128);
        expect(snapshot.droppedAttempts).toBe(172);
        expect(snapshot.droppedNativeLifetimes).toBe(172);
        expect(snapshot.attempts[0]).toMatchObject({ nativeInstanceOrdinal: 173, settlement: 'applied' });
        expect(snapshot.nativeLifetimes[0].nativeInstanceOrdinal).toBe(173);
    });

    it('bounds and sanitizes native lifetime artifacts and rejects malformed lifetime evidence', () => {
        installObserver();
        new window.RTCPeerConnection();
        const observed = readSnapshot();
        const lifetime = {
            ...observed.nativeLifetimes[0],
            state: { signalingState: 'stable', connectionState: 'secret-state', iceConnectionState: 'new', token: 'secret-token' },
            reference: { secret: 'secret-peer' },
            description: 'secret-sdp'
        };
        const decoded = decodeLiveRtcSignalingObservationSnapshot({ ...observed, nativeLifetimes: Array(300).fill(lifetime) });
        expect(decoded.nativeLifetimes).toHaveLength(128);
        expect(decoded.droppedNativeLifetimes).toBe(172);
        expect(decoded.nativeLifetimes[0].state.connectionState).toBeNull();
        expect(JSON.stringify(decoded)).not.toMatch(/secret-|reference|description|token/);
        for (
            const invalid of [{ ...lifetime, nativeInstanceOrdinal: 0 }, { ...lifetime, observation: 'secret-state' }, {
                ...lifetime,
                closedAtEpochMs: Infinity
            }]
        ) {
            expect(decodeLiveRtcSignalingObservationSnapshot({ ...observed, nativeLifetimes: [invalid] }).available).toBe(false);
        }
    });

    it('marks an observer runtime failure unavailable while preserving delivery', () => {
        installObserver({
            timeOrigin: 0,
            now: () => {
                throw new Error('secret-clock-failure');
            }
        });
        const socket = new window.WebSocket('ws://localhost');
        const delivered: string[] = [];
        socket.addEventListener('message', (event) => delivered.push(event.data));
        const frame = signalFrame('message-offer', 'Offer');
        socket.dispatchEvent(new MessageEvent('message', { data: frame }));
        expect(delivered).toEqual([frame]);
        expect(readSnapshot().available).toBe(false);
    });

    it('joins actual AL descriptions to native instances without changing delivery or promise identity', async () => {
        installObserver();
        const socket = new window.WebSocket('ws://localhost', ['protocol']);
        const delivered: string[] = [];
        socket.addEventListener('message', (event) => delivered.push(event.data));
        socket.onmessage = (event) => delivered.push(event.data);
        const firstFrame = signalFrame('message-offer', 'Offer');
        const secondFrame = signalFrame('message-answer', 'Answer', 'answer-sdp');
        socket.dispatchEvent(new MessageEvent('message', { data: firstFrame }));
        socket.dispatchEvent(new MessageEvent('message', { data: secondFrame }));
        socket.dispatchEvent(new MessageEvent('message', { data: signalFrame('message-ice', 'IceCandidate') }));
        const first = new window.RTCPeerConnection();
        const replacement = new window.RTCPeerConnection();
        let complete = () => {};
        NativePeer.completion = new Promise<void>((resolve) => {
            complete = resolve;
        });
        const pending = first.setRemoteDescription({ type: 'offer', sdp: 'secret-sdp' });
        expect(pending).toBe(NativePeer.completion);
        expect(readSnapshot().attempts).toMatchObject([{ msgId: 'message-offer', nativeInstanceOrdinal: 1, settlement: 'attempted' }]);
        complete();
        await pending;
        await replacement.setRemoteDescription({ type: 'answer', sdp: 'answer-sdp' });
        const snapshot = readSnapshot();
        expect(snapshot.received).toMatchObject([
            { msgId: 'message-offer', signalType: 'Offer', offerId: 'offer-a', fromId: 'sender-a', toId: 'receiver-b' },
            { msgId: 'message-answer', signalType: 'Answer' },
            { msgId: 'message-ice', signalType: 'IceCandidate', offerId: null }
        ]);
        expect(snapshot.attempts).toMatchObject([
            {
                msgId: 'message-offer',
                signalType: 'Offer',
                offerId: 'offer-a',
                fromId: 'sender-a',
                toId: 'receiver-b',
                nativeInstanceOrdinal: 1,
                settlement: 'applied',
                match: 'unique'
            },
            { msgId: 'message-answer', nativeInstanceOrdinal: 2, settlement: 'applied', match: 'unique' }
        ]);
        expect(snapshot.attempts[0].settledAtEpochMs).toBeGreaterThanOrEqual(snapshot.attempts[0].attemptedAtEpochMs);
        expect(snapshot.attempts[0].state).toEqual({ signalingState: 'stable', connectionState: 'new', iceConnectionState: 'new' });
        expect(delivered.slice(0, 4)).toEqual([firstFrame, firstFrame, secondFrame, secondFrame]);
        expect(window.WebSocket.OPEN).toBe(1);
        expect(JSON.stringify(snapshot)).not.toMatch(/secret-|answer-sdp|fingerprint|candidate|token|description/);
    });

    it('records native rejection without retaining its sensitive error or changing it', async () => {
        installObserver();
        const socket = new window.WebSocket('ws://localhost');
        socket.dispatchEvent(new MessageEvent('message', { data: signalFrame('rejected-offer', 'Offer') }));
        const failure = new Error('secret-sdp token=secret-token');
        NativePeer.completion = Promise.reject(failure);
        await expect(new window.RTCPeerConnection().setRemoteDescription({ type: 'offer', sdp: 'secret-sdp' })).rejects.toBe(failure);
        expect(readSnapshot().attempts).toMatchObject([{ msgId: 'rejected-offer', settlement: 'rejected' }]);
        expect(JSON.stringify(readSnapshot())).not.toContain('secret-');
    });

    it('does not guess a message for duplicate descriptions or an unobserved description', async () => {
        installObserver();
        NativePeer.completion = Promise.resolve();
        const socket = new window.WebSocket('ws://localhost');
        for (const messageId of ['first-message', 'second-message']) {
            socket.dispatchEvent(new MessageEvent('message', { data: signalFrame(messageId, 'Offer') }));
        }
        const peer = new window.RTCPeerConnection();
        await peer.setRemoteDescription({ type: 'offer', sdp: 'secret-sdp' });
        await peer.setRemoteDescription({ type: 'offer', sdp: 'different-sdp' });
        expect(readSnapshot().attempts).toMatchObject([
            { msgId: null, match: 'ambiguous', settlement: 'applied' },
            { msgId: null, match: 'unmatched', settlement: 'applied' }
        ]);
    });

    it('does not attribute a native description to an envelope with inconsistent routing or signal kind', async () => {
        installObserver();
        NativePeer.completion = Promise.resolve();
        const socket = new window.WebSocket('ws://localhost');
        const wrongSender = JSON.parse(signalFrame('wrong-sender', 'Offer'));
        wrongSender.id.senderId = 'another-sender';
        const wrongKind = JSON.parse(signalFrame('wrong-kind', 'Offer'));
        const signal = JSON.parse(wrongKind.payload.resource);
        signal.signalType = 'Answer';
        wrongKind.payload.resource = JSON.stringify(signal);
        for (const envelope of [wrongSender, wrongKind]) {
            socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(envelope) }));
        }
        await new window.RTCPeerConnection().setRemoteDescription({ type: 'offer', sdp: 'secret-sdp' });
        expect(readSnapshot().attempts).toMatchObject([{ msgId: null, match: 'unmatched' }]);
    });

    it('bounds received summaries, transient joins and attempts, and exposes eviction', async () => {
        installObserver();
        NativePeer.completion = Promise.resolve();
        const socket = new window.WebSocket('ws://localhost');
        const peer = new window.RTCPeerConnection();
        for (let index = 0; index < 300; index++) {
            socket.dispatchEvent(new MessageEvent('message', { data: signalFrame(`message-${index}`, 'Offer', `sdp-${index}`) }));
            await peer.setRemoteDescription({ type: 'offer', sdp: `sdp-${index}` });
        }
        await peer.setRemoteDescription({ type: 'offer', sdp: 'sdp-0' });
        const snapshot = readSnapshot();
        expect(snapshot.received.length).toBeLessThan(300);
        expect(snapshot.attempts.length).toBeLessThan(300);
        expect(snapshot.droppedReceived).toBeGreaterThan(0);
        expect(snapshot.droppedAttempts).toBeGreaterThan(0);
        expect(snapshot.attempts.at(-1)).toMatchObject({ msgId: null, match: 'unmatched' });
        expect(JSON.stringify(snapshot)).not.toContain('sdp-');
    });

    it('ignores malformed and unrelated envelopes while preserving their downstream delivery', () => {
        installObserver();
        const socket = new window.WebSocket('ws://localhost');
        const delivered: string[] = [];
        socket.addEventListener('message', (event) => delivered.push(event.data));
        const frames = ['secret-invalid-json', '{"payload":{"typeId":"other","resource":"secret-token"}}'];
        for (const frame of frames) {
            socket.dispatchEvent(new MessageEvent('message', { data: frame }));
        }
        expect(delivered).toEqual(frames);
        expect(readSnapshot()).toMatchObject({ available: true, received: [], attempts: [] });
    });

    it('retains matched signal identity after unrelated receives evict its receive summary', async () => {
        installObserver();
        NativePeer.completion = Promise.resolve();
        const socket = new window.WebSocket('ws://localhost');
        socket.dispatchEvent(new MessageEvent('message', { data: signalFrame('matched-offer', 'Offer') }));
        await new window.RTCPeerConnection().setRemoteDescription({ type: 'offer', sdp: 'secret-sdp' });
        for (let index = 0; index < 300; index++) {
            socket.dispatchEvent(new MessageEvent('message', { data: signalFrame(`ice-${index}`, 'IceCandidate') }));
        }
        expect(readSnapshot().attempts).toMatchObject([{
            msgId: 'matched-offer',
            signalType: 'Offer',
            offerId: 'offer-a',
            fromId: 'sender-a',
            toId: 'receiver-b',
            settlement: 'applied'
        }]);
    });
});
