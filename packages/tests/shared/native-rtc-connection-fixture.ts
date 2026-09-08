import { vi } from 'vitest';

import { newALEventRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { QRtcPeerDto, WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import {
    QRtcSignalingMessage,
    QRtcSignalingTransport,
    QRtcSignalingTransportInputDto
} from '@shared/webrtc/QRtcSignalingContracts.ts';

export interface NativeRtcRuntime {
    readonly createdConnections: readonly SimulatedNativeRtcPeerConnection[];
    dispose(): void;
}

export function installNativeRtcRuntime(): NativeRtcRuntime {
    const createdConnections: SimulatedNativeRtcPeerConnection[] = [];
    class NativePeer extends SimulatedNativeRtcPeerConnection {
        constructor(configuration?: RTCConfiguration) {
            super(configuration);
            createdConnections.push(this);
        }
    }
    vi.stubGlobal('RTCPeerConnection', NativePeer);
    return {
        createdConnections,
        dispose: () => {
            for (const connection of createdConnections) {
                connection.close();
            }
            vi.unstubAllGlobals();
        }
    };
}

export interface NativeRtcConnectionFixture {
    readonly service: WebRtcConnectionService;
    readonly signaler: QRtcSignalingTransport;
    readonly sentSignals: readonly QRtcSignalingMessage[];
    receive(message: QRtcSignalingMessage): Promise<void>;
    receiveResource(resource: string, senderId?: string): Promise<void>;
    nativePeer(peerId: string): SimulatedNativeRtcPeerConnection;
    createdPeerIds(): readonly string[];
    dispose(): void;
}

export function createNativeRtcConnectionFixture(
    input: WebRtcConnectionService.InputDto,
    runtime: NativeRtcRuntime
): NativeRtcConnectionFixture {
    let connected: QRtcSignalingTransportInputDto | undefined;
    const sentSignals: QRtcSignalingMessage[] = [];
    const signaler: QRtcSignalingTransport = {
        connect: async (value) => {
            connected = value;
        },
        send: async (message) => {
            sentSignals.push(message);
        }
    };
    const service = new WebRtcConnectionService(signaler, input);
    const allocatedPeers: QRtcPeerDto[] = [];
    service.onRtcPeerLifecycleDo('native-fixture', {
        onCreated: (peer) => {
            allocatedPeers.push(peer);
        },
        onDeleted: () => {}
    });
    const receiveResource = async (resource: string, senderId = 'z-peer'): Promise<void> => {
        if (!connected) {
            throw new Error('Connect the signaling transport before receiving');
        }
        const envelope = newALUnicastMessage(senderId, newALEventRoute(input.rtcSignalingTopicId, input.sessionId), input.sessionId, 'rtc', null);
        await connected.callbacks.onMessage(input.sessionId, input.token, { ...envelope, payload: { ...envelope.payload, resource } });
    };
    return {
        service,
        signaler,
        sentSignals,
        receiveResource,
        receive: (message) => receiveResource(JSON.stringify(message), message.fromId),
        createdPeerIds: () =>
            allocatedPeers.filter((peer) => runtime.createdConnections.some((native) => native === peer.connection.status.pc)).map((peer) => peer.peerId),
        nativePeer: (peerId) => {
            const pc = service.readPeer(peerId)?.connection.status.pc;
            const native = runtime.createdConnections.find((candidate) => candidate === pc);
            if (!native) {
                throw new Error(`No native peer for ${peerId}`);
            }
            return native;
        },
        dispose: () => {
            for (const peerId of service.knownPeerIds()) {
                service.removePeerIfPresent(peerId);
            }
        }
    };
}

export class SimulatedNativeRtcDataChannel extends EventTarget implements RTCDataChannel {
    readonly label: string;
    readonly id = 1;
    readonly protocol: string;
    readonly negotiated: boolean;
    readonly ordered: boolean;
    readonly maxPacketLifeTime: number | null;
    readonly maxRetransmits: number | null;
    bufferedAmount = 0;
    bufferedAmountLowThreshold = 0;
    binaryType: BinaryType = 'arraybuffer';
    readyState: RTCDataChannelState = 'connecting';
    onopen: RTCDataChannel['onopen'] = null;
    onclose: RTCDataChannel['onclose'] = null;
    onclosing: RTCDataChannel['onclosing'] = null;
    onerror: RTCDataChannel['onerror'] = null;
    onmessage: RTCDataChannel['onmessage'] = null;
    onbufferedamountlow: RTCDataChannel['onbufferedamountlow'] = null;
    readonly sent: (string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>)[] = [];

    constructor(label: string, init: RTCDataChannelInit = {}) {
        super();
        this.label = label;
        this.protocol = init.protocol ?? '';
        this.negotiated = init.negotiated ?? false;
        this.ordered = init.ordered ?? true;
        this.maxPacketLifeTime = init.maxPacketLifeTime ?? null;
        this.maxRetransmits = init.maxRetransmits ?? null;
    }

    async open(): Promise<void> {
        this.readyState = 'open';
        await this.onopen?.call(this, new Event('open'));
    }

    async close(): Promise<void> {
        if (this.readyState === 'closed') {
            return;
        }
        this.readyState = 'closed';
        await this.onclose?.call(this, new Event('close'));
    }

    async fail(): Promise<void> {
        this.readyState = 'closed';
        await this.onerror?.call(this, new NativeRtcErrorEvent());
    }

    async receive(data: string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>): Promise<void> {
        await this.onmessage?.call(this, new MessageEvent('message', { data }));
    }

    async drain(): Promise<void> {
        await this.onbufferedamountlow?.call(this, new Event('bufferedamountlow'));
    }

    send(data: string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>): void {
        if (this.readyState !== 'open') {
            throw new Error('Native channel is not open');
        }
        this.sent.push(data);
    }
}

class NativeRtcErrorEvent extends Event implements RTCErrorEvent {
    readonly error: RTCError = Object.assign(new DOMException('Native data channel failed', 'OperationError'), {
        errorDetail: 'data-channel-failure' as const,
        receivedAlert: null,
        sctpCauseCode: null,
        sdpLineNumber: null,
        sentAlert: null
    });

    constructor() {
        super('error');
    }
}

class NativeDataChannelEvent extends Event implements RTCDataChannelEvent {
    readonly channel: RTCDataChannel;
    constructor(channel: RTCDataChannel) {
        super('datachannel');
        this.channel = channel;
    }
}

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

export class SimulatedNativeRtcPeerConnection extends EventTarget implements RTCPeerConnection {
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
    readonly channels: SimulatedNativeRtcDataChannel[] = [];
    readonly receivedDescriptions: RTCSessionDescriptionInit[] = [];
    readonly receivedCandidates: (RTCIceCandidateInit | null)[] = [];
    private configuration: RTCConfiguration;

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

    createDataChannel(label: string, init?: RTCDataChannelInit): SimulatedNativeRtcDataChannel {
        const channel = new SimulatedNativeRtcDataChannel(label, init);
        this.channels.push(channel);
        return channel;
    }

    async receiveDataChannel(label: string): Promise<SimulatedNativeRtcDataChannel> {
        const channel = this.createDataChannel(label);
        await this.ondatachannel?.call(this, new NativeDataChannelEvent(channel));
        return channel;
    }

    async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
        this.receivedDescriptions.push(description);
        this.remoteDescription = new NativeSessionDescription(description);
        this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    }

    async setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void> {
        const type = description?.type ?? (this.remoteDescription?.type === 'offer' ? 'answer' : 'offer');
        this.localDescription = new NativeSessionDescription({ type, sdp: description?.sdp ?? `${type}-sdp` });
        this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
    }

    async addIceCandidate(candidate: RTCIceCandidateInit | null = null): Promise<void> {
        this.receivedCandidates.push(candidate);
    }

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
    restartIce(): void {}
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
    async createOffer(success?: RTCOfferOptions | RTCSessionDescriptionCallback): Promise<RTCSessionDescriptionInit | void> {
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
    async createAnswer(success?: RTCAnswerOptions | RTCSessionDescriptionCallback): Promise<RTCSessionDescriptionInit | void> {
        const description: RTCSessionDescriptionInit = { type: 'answer', sdp: 'answer-sdp' };
        if (typeof success === 'function') {
            success(description);
        }
        else {
            return description;
        }
    }
}
