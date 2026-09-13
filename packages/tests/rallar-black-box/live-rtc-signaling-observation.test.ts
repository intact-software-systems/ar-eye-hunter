import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { newALEventRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import type { QRtcSignalingMessage } from '@shared/webrtc/qrtc-signaling-contracts.ts';

import { LiveRtcSignalingObservation } from '../../../tests/playwright/rallar-black-box/live-rtc-signaling-observation.ts';

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
}

function installObserver(clock: Pick<Performance, 'timeOrigin' | 'now'> = performance): void {
    vi.stubGlobal('window', { WebSocket: NativeSocket, RTCPeerConnection: NativePeer });
    runInNewContext(`(${LiveRtcSignalingObservation.toString()}).install()`, {
        window,
        crypto,
        performance: clock
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
        return { available: false, received: [], attempts: [], droppedReceived: 0, droppedAttempts: 0 };
    }
    return observation.read();
}

describe('live RTC signaling observation', () => {
    afterEach(() => vi.unstubAllGlobals());

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
