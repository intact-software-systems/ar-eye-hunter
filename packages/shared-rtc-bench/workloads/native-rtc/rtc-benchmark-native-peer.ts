import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';

import { RtcBenchmarkNativeChannel } from './rtc-benchmark-native-channel.ts';

class NativeSessionDescription implements RTCSessionDescription {
    readonly type: RTCSdpType;
    readonly sdp: string;
    constructor(input: RTCSessionDescriptionInit) {
        this.type = input.type;
        this.sdp = input.sdp ?? '';
    }
    toJSON(): RTCSessionDescriptionInit {
        return { type: this.type, sdp: this.sdp };
    }
}

export class RtcBenchmarkNativePeer extends EventTarget implements RTCPeerConnection {
    readonly canTrickleIceCandidates = true;
    readonly sctp = null;
    readonly pendingLocalDescription = null;
    readonly pendingRemoteDescription = null;
    connectionState: RTCPeerConnectionState = 'new';
    iceConnectionState: RTCIceConnectionState = 'new';
    iceGatheringState: RTCIceGatheringState = 'new';
    signalingState: RTCSignalingState = 'stable';
    localDescription: RTCSessionDescription | null = null;
    remoteDescription: RTCSessionDescription | null = null;
    onconnectionstatechange: RTCPeerConnection['onconnectionstatechange'] = null;
    ondatachannel: RTCPeerConnection['ondatachannel'] = null;
    onicecandidate: RTCPeerConnection['onicecandidate'] = null;
    onicecandidateerror: RTCPeerConnection['onicecandidateerror'] = null;
    oniceconnectionstatechange: RTCPeerConnection['oniceconnectionstatechange'] = null;
    onicegatheringstatechange: RTCPeerConnection['onicegatheringstatechange'] = null;
    onnegotiationneeded: RTCPeerConnection['onnegotiationneeded'] = null;
    onsignalingstatechange: RTCPeerConnection['onsignalingstatechange'] = null;
    ontrack: RTCPeerConnection['ontrack'] = null;
    readonly channels: RtcBenchmarkNativeChannel[] = [];
    private configuration: RTCConfiguration;
    readonly pendingChannels: RtcBenchmarkNativeChannel[] = [];
    private iceRestartCompleted = false;
    private readonly iceRestartWaiters = new Set<() => void>();
    private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

    constructor(configuration: RTCConfiguration = {}) {
        super();
        this.configuration = configuration;
    }

    get currentLocalDescription(): RTCSessionDescription | null {
        return this.localDescription;
    }
    get currentRemoteDescription(): RTCSessionDescription | null {
        return this.remoteDescription;
    }

    setConnected(): void {
        this.connectionState = 'connected';
        this.onconnectionstatechange?.call(this, new Event('connectionstatechange'));
    }

    createDataChannel(label: string, init?: RTCDataChannelInit): RtcBenchmarkNativeChannel {
        const channel = this.pendingChannels.shift() ?? new RtcBenchmarkNativeChannel(label, init);
        this.channels.push(channel);
        return channel;
    }

    async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
        this.remoteDescription = new NativeSessionDescription(description);
        this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    }

    async setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void> {
        const type = description?.type ?? (this.remoteDescription?.type === 'offer' ? 'answer' : 'offer');
        this.localDescription = new NativeSessionDescription({ type, sdp: description?.sdp ?? `${type}-sdp` });
        this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
    }

    async addIceCandidate(_candidate: RTCIceCandidateInit | null = null): Promise<void> {}

    close(): void {
        if (this.connectionState === 'closed') {
            return;
        }
        this.connectionState = 'closed';
        this.signalingState = 'closed';
        for (const channel of this.channels) {
            channel.close();
        }
        this.onconnectionstatechange?.call(this, new Event('connectionstatechange'));
    }

    override addEventListener(
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: AddEventListenerOptions | boolean
    ): void {
        super.addEventListener(type, callback, options);
        if (callback) {
            const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
            listeners.add(callback);
            this.listeners.set(type, listeners);
        }
    }
    override removeEventListener(
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: EventListenerOptions | boolean
    ): void {
        super.removeEventListener(type, callback, options);
        if (callback) {
            const listeners = this.listeners.get(type);
            listeners?.delete(callback);
            if (listeners?.size === 0) {
                this.listeners.delete(type);
            }
        }
    }
    listenerCount(type: string): number {
        return this.listeners.get(type)?.size ?? 0;
    }
    unclearedHandlerSlotCount(): number {
        return [
            this.onnegotiationneeded,
            this.onicecandidate,
            this.ondatachannel,
            this.ontrack,
            this.oniceconnectionstatechange,
            this.onsignalingstatechange,
            this.onconnectionstatechange
        ]
            .filter((handler) => handler !== null).length;
    }

    getConfiguration(): RTCConfiguration {
        return this.configuration;
    }
    setConfiguration(configuration: RTCConfiguration = {}): void {
        this.configuration = configuration;
    }
    getTransceivers(): RTCRtpTransceiver[] {
        return [];
    }
    getSenders(): RTCRtpSender[] {
        return [];
    }
    getReceivers(): RTCRtpReceiver[] {
        return [];
    }
    async getStats(): Promise<RTCStatsReport> {
        return new Map();
    }
    restartIce(): void {
        this.iceRestartCompleted = true;
        for (const resolve of this.iceRestartWaiters) {
            resolve();
        }
        this.iceRestartWaiters.clear();
    }
    whenIceRestarted(): Promise<void> {
        if (this.iceRestartCompleted) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.iceRestartWaiters.add(resolve);
        });
    }
    removeTrack(_sender: RTCRtpSender): void {
        throw new Error('Media tracks are outside this native fixture');
    }
    addTrack(_track: MediaStreamTrack, ..._streams: MediaStream[]): RTCRtpSender {
        throw new Error('Media tracks are outside this native fixture');
    }
    addTransceiver(): RTCRtpTransceiver {
        throw new Error('Media tracks are outside this native fixture');
    }
    createOffer(): Promise<RTCSessionDescriptionInit>;
    createOffer(success: RTCSessionDescriptionCallback, failure: RTCPeerConnectionErrorCallback): Promise<void>;
    async createOffer(
        success?: RTCOfferOptions | RTCSessionDescriptionCallback
    ): Promise<RTCSessionDescriptionInit | void> {
        const description: RTCSessionDescriptionInit = { type: 'offer', sdp: 'offer-sdp' };
        if (typeof success === 'function') {
            success(description);
        }
        else {
            return description;
        }
    }
    createAnswer(): Promise<RTCSessionDescriptionInit>;
    createAnswer(success: RTCSessionDescriptionCallback, failure: RTCPeerConnectionErrorCallback): Promise<void>;
    async createAnswer(
        success?: RTCAnswerOptions | RTCSessionDescriptionCallback
    ): Promise<RTCSessionDescriptionInit | void> {
        const description: RTCSessionDescriptionInit = { type: 'answer', sdp: 'answer-sdp' };
        if (typeof success === 'function') {
            success(description);
        }
        else {
            return description;
        }
    }
}

export interface RtcBenchmarkNativeRuntime {
    readonly peers: RtcBenchmarkNativePeer[];
    restore(): void;
}

export function installRtcBenchmarkNativeRuntime(): RtcBenchmarkNativeRuntime {
    const peers: RtcBenchmarkNativePeer[] = [];
    const original = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection');
    class NativePeer extends RtcBenchmarkNativePeer {
        constructor(configuration?: RTCConfiguration) {
            super(configuration);
            peers.push(this);
        }
    }
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, writable: true, value: NativePeer });
    return {
        peers,
        restore: () => {
            if (original) {
                Object.defineProperty(globalThis, 'RTCPeerConnection', original);
            }
            else {
                Reflect.deleteProperty(globalThis, 'RTCPeerConnection');
            }
        }
    };
}

export interface RtcBenchmarkPeerConnection {
    readonly peer: QRtcPeerConnection;
    readonly native: RtcBenchmarkNativePeer;
    dispose(): void;
}

export function createRtcBenchmarkPeerConnection(peerSessionId: string): RtcBenchmarkPeerConnection {
    const runtime = installRtcBenchmarkNativeRuntime();
    try {
        const peer = new QRtcPeerConnection({ send: async () => {} }, {
            sessionId: 'self',
            token: 'benchmark-token',
            peerSessionId,
            iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 },
            isPolite: true
        });
        peer.connect();
        const native = runtime.peers[0];
        if (!native) {
            throw new Error('Expected a native peer after connecting');
        }
        return {
            peer,
            native,
            dispose: () => {
                peer.reset();
            }
        };
    }
    finally {
        runtime.restore();
    }
}
