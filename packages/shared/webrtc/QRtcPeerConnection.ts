import { IceConfig } from '../api/api-config.ts';
import {
    QRtcSignalingChannel,
    QRtcSignalingMsgType,
    QRtcSignalingSender,
    QRtcSignalingType
} from './QRtcSignalingContracts.ts';

enum QRtcSessionState {
    Idle = 'Idle',
    Connecting = 'Connecting',
    Open = 'Open',
    Closed = 'Closed',
    Failed = 'Failed',
}

export type QRtcDataExchanged = {
    description: RTCSessionDescription | null
    candidate: RTCIceCandidateInit | null
}

export type QRtcOnDataChannelCallback = (event: RTCDataChannelEvent) => Promise<void>;
export type QRtcOnTrackCallback = (event: RTCTrackEvent) => Promise<void>;
export type QRtcOnRemoteStreamCallback = (stream: MediaStream, event: RTCTrackEvent) => Promise<void>;

export type QRtcPeerConnectionStateCallbacks = {
    onConnected?: () => Promise<void>
    onDisconnected?: () => Promise<void>
    onFailed?: () => Promise<void>
    onClosed?: (peerId: string) => Promise<void>
    onOffer?: (offer: RTCSessionDescriptionInit) => Promise<void>
    onAnswer?: (answer: RTCSessionDescriptionInit) => Promise<void>
    onIceCandidate?: (candidate: RTCIceCandidateInit) => Promise<void>
    onDataChannel?: (channel: RTCDataChannel) => Promise<void>
    onTrack?: (track: MediaStreamTrack) => Promise<void>
    onRemoteStream?: (stream: MediaStream) => Promise<void>
}

export type RtcCodecMimeType = string;

export type QRtcMediaPolicy = {
    // Bitrate caps (bps)
    readonly maxAudioBitrateBps?: number;
    readonly maxVideoBitrateBps?: number;

    // Video scaling/framerate (best-effort via sender parameters)
    readonly maxVideoFramerate?: number;
    readonly scaleResolutionDownBy?: number;

    // Browser adaptation preference (best-effort)
    readonly degradationPreference?: 'maintain-framerate' | 'maintain-resolution' | 'balanced';

    // Codec preferences in priority order (best-effort)
    readonly preferredVideoCodecs?: readonly RtcCodecMimeType[]; // e.g. ['video/H264','video/VP8']
    readonly preferredAudioCodecs?: readonly RtcCodecMimeType[]; // e.g. ['audio/opus']
};

export type QRtcPeerConnectionInputDto = {
    readonly sessionId: string
    readonly token: string
    readonly peerSessionId: string
    readonly iceCandidates: IceConfig
    readonly isPolite: boolean
}

type QRtcPeerConnectionStatus = {
    state: QRtcSessionState | undefined
    pc: RTCPeerConnection | undefined
    localStream: MediaStream | undefined
    localSenders: Map<string, RTCRtpSender>
    remoteStreams: Map<string, MediaStream>
    mediaPolicy: QRtcMediaPolicy | undefined
    makingOffer: boolean
    ignoreOffer: boolean
    iceCandidateQueue: RTCIceCandidateInit[]
    reconnectAttempts: number
    reconnectTimer: ReturnType<typeof setTimeout> | undefined
    disconnectTimer: ReturnType<typeof setTimeout> | undefined
    callbacks: QRtcPeerConnectionStateCallbacks
}

export class QRtcPeerConnection {
    private readonly MAX_RECONNECT_ATTEMPTS: number = 5;
    private readonly DISCONNECT_TIMEOUT_MSECS: number = 5000;

    private signalingChain = Promise.resolve();
    private outboundSignalingChain = Promise.resolve();

    private readonly configuration;
    public status: QRtcPeerConnectionStatus;

    private readonly onDataChannelCallbacks = new Map<string, QRtcOnDataChannelCallback>();
    private readonly onTrackCallbacks = new Map<string, QRtcOnTrackCallback>();
    private readonly onRemoteStreamCallbacks = new Map<string, QRtcOnRemoteStreamCallback>();

    constructor(
        public readonly signaler: QRtcSignalingSender,
        public readonly input: QRtcPeerConnectionInputDto
    ) {
        this.configuration = {
            iceServers: [...this.input.iceCandidates.iceServers]
        };

        this.status = this.toInitialStatus();
    }

    reset(): QRtcPeerConnectionStatus {
        this.closePeerConnectionIfPresent();
        this.status = this.toInitialStatus();

        return this.status;
    }

    private toInitialStatus(): QRtcPeerConnectionStatus {
        return {
            state: QRtcSessionState.Idle,
            pc: undefined,
            localStream: undefined,
            localSenders: new Map<string, RTCRtpSender>(),
            remoteStreams: new Map<string, MediaStream>(),
            mediaPolicy: undefined,
            makingOffer: false,
            ignoreOffer: false,
            iceCandidateQueue: [],
            reconnectAttempts: 0,
            reconnectTimer: undefined,
            disconnectTimer: undefined,
            callbacks: {}
        };
    }

    private closePeerConnectionIfPresent() {
        if (this.status?.pc) {
            try {
                console.log('Closing peer connection for peer: ' + this.input.peerSessionId + ' (state: ' + this.status.state + ')');

                const pc = this.status.pc;

                // Stop all Transceivers/Tracks associated with this peer
                pc.getTransceivers()
                    .forEach(transceiver => {
                        if (transceiver.stop) {
                            transceiver.stop();
                        }
                    });

                // Remove event listeners to prevent memory leaks
                pc.onicecandidate = null;
                pc.onnegotiationneeded = null;
                pc.onconnectionstatechange = null;
                pc.ontrack = null;

                // Close the PeerConnection itself
                if (pc.connectionState !== 'closed') {
                    pc.close();
                }

                if (this.status.reconnectTimer) {
                    clearTimeout(this.status.reconnectTimer);
                }
                if (this.status.disconnectTimer) {
                    clearTimeout(this.status.disconnectTimer);
                }

            } catch (e) {
                console.error('Error closing peer connection. Ignoring ...', e);
            }
        }
    }

    // ----------------------------------------
    // Callback registry
    // ----------------------------------------

    onDataChannelDo(id: string, onDataChannel: QRtcOnDataChannelCallback): QRtcPeerConnection {
        this.onDataChannelCallbacks.set(id, onDataChannel);
        return this;
    }

    removeDataChannelCallbackById(id: string): boolean {
        return this.onDataChannelCallbacks.delete(id);
    }

    onTrackDo(id: string, onTrack: QRtcOnTrackCallback): QRtcPeerConnection {
        this.onTrackCallbacks.set(id, onTrack);
        return this;
    }

    removeOnTrackCallbackById(id: string): boolean {
        return this.onTrackCallbacks.delete(id);
    }

    onRemoteStreamDo(id: string, cb: QRtcOnRemoteStreamCallback): QRtcPeerConnection {
        this.onRemoteStreamCallbacks.set(id, cb);
        return this;
    }

    removeOnRemoteStreamCallbackById(id: string): boolean {
        return this.onRemoteStreamCallbacks.delete(id);
    }

    // ----------------------------------------
    // Connect logic
    // ----------------------------------------

    connect(callbacks: QRtcPeerConnectionStateCallbacks = {}) {
        if (this.isOpen() || !this.isReadyToConnect()) {
            console.log('Ignore connect, peer connection in state: ' + this.status.state);
            console.log('Peer connection is not ready to current peer connection state: ' + this.status.pc?.connectionState + ' current pc signaling state ' + this.status?.pc?.signalingState);
            return;
        }

        if (this.status.pc) {
            console.log('Peer connection already exists. Resetting peer connection.');
            this.reset();
        }

        this.status.state = QRtcSessionState.Connecting;

        const pc = new RTCPeerConnection(this.configuration);

        this.status.pc = pc;

        // When pc.createDataChannel is called, it will trigger this event
        pc.onnegotiationneeded = async () => {
            try {
                // 1. GATE-KEEPER: If we are already negotiating or not in a stable state,
                // we must abort. Perfect Negotiation will re-trigger this event
                // automatically once the state returns to 'stable'.
                if (this.status.makingOffer || pc.signalingState !== 'stable') {
                    console.log('Ignoring negotiation needed because we are already negotiating or not in a stable state');
                    return;
                }

                this.status.makingOffer = true;
                await pc.setLocalDescription();

                console.log('Offer negotiation: ' + JSON.stringify(pc.localDescription));

                await this.sendSignal(
                    QRtcSignalingType.Offer,
                    {
                        description: pc.localDescription,
                        candidate: null
                    }
                );
            } catch (err) {
                console.error('Negotiation error', err);
            } finally {
                this.status.makingOffer = false;
            }
        };

        pc.onicecandidate = async event => {
            if (event.candidate) {
                try {
                    await this.sendSignal(
                        QRtcSignalingType.IceCandidate,
                        {
                            description: null,
                            candidate: event.candidate
                        }
                    );
                } catch (err) {
                    console.error('ICE candidate signaling error', err);
                }
            } else {
                console.log('ICE Gathering Complete');
            }
        };

        pc.ondatachannel =
            async event => {
                console.log('Data channel created: ' + event.channel.label);

                for (const callback of this.onDataChannelCallbacks.values()) {
                    try {
                        await callback(event);
                    } catch (e) {
                        console.error('Callback onDataChannel failed:', e);
                    }
                }
            };

        pc.ontrack = async (event) => {
            const stream: MediaStream | undefined =
                event.streams && event.streams.length > 0
                    ? event.streams[0]
                    : undefined;

            if (stream) {
                this.status.remoteStreams.set(stream.id, stream);

                for (const cb of this.onRemoteStreamCallbacks.values()) {
                    try {
                        await cb(stream, event);
                    } catch (e) {
                        console.error('Callback onRemoteStream failed:', e);
                    }
                }
            }

            for (const cb of this.onTrackCallbacks.values()) {
                try {
                    await cb(event);
                } catch (e) {
                    console.error('Callback onTrack failed:', e);
                }
            }
        };

        this.setupStateChangeCallbacks(pc, callbacks);

        this.status.callbacks = callbacks;
    }

    private setupStateChangeCallbacks(pc: RTCPeerConnection, callbacks: QRtcPeerConnectionStateCallbacks) {
        pc.oniceconnectionstatechange = () => {
            console.log('ICE Connection State: ' + pc.iceConnectionState);
        };

        pc.onsignalingstatechange = () => console.log('Signaling', pc.signalingState);

        pc.onconnectionstatechange = () => {
            console.log('Peer Connection State: ' + pc.connectionState);

            switch (pc.connectionState) {
                case 'connected': {
                    this.status.state = QRtcSessionState.Open;
                    this.status.reconnectAttempts = 0;

                    if (this.status.reconnectTimer) {
                        clearTimeout(this.status.reconnectTimer);
                        this.status.reconnectTimer = undefined;
                    }

                    callbacks.onConnected?.();
                    break;
                }
                case 'disconnected':

                    this.status.disconnectTimer =
                        setTimeout(
                            () => {
                                if (pc.connectionState === 'disconnected') {
                                    this.handleReconnect()
                                        .catch(err => console.error('Error handling reconnect', err));
                                }
                            },
                            this.DISCONNECT_TIMEOUT_MSECS
                        );

                    callbacks.onDisconnected?.();
                    break;
                case 'failed':
                    this.status.state = QRtcSessionState.Failed;

                    this.handleReconnect()
                        .catch(err => console.error('Error handling reconnect', err));

                    callbacks.onFailed?.();
                    break;
                case 'closed':
                    this.status.state = QRtcSessionState.Closed;

                    callbacks.onClosed?.(this.input.peerSessionId);
                    break;
                case 'connecting':
                case 'new':
                    break;
            }
        };

        pc.addEventListener(
            'icegatheringstatechange',
            _ => {
                switch (pc.iceGatheringState) {
                    case 'new':
                        console.log('ICE Gathering State: New');
                        break;
                    case 'gathering':
                        console.log('ICE Gathering State: Gathering');
                        break;
                    case 'complete':
                        console.log('ICE Gathering State: Complete');
                        break;
                }
            }
        );
    }

    createDataChannel(
        label: string,
        dataChannelDict?: RTCDataChannelInit,
    ): RTCDataChannel {
        const pc = this.status.pc;
        if (!pc) {
            throw new Error('PeerConnection not initialized');
        }

        return dataChannelDict === undefined
            ? pc.createDataChannel(label)
            : pc.createDataChannel(label, dataChannelDict);
    }

    async handleSignal(signal: QRtcSignalingType, msg: QRtcDataExchanged) {
        const run =
            this.signalingChain
                .then(
                    async () => await this.processSignal(signal, msg)
                );
        this.signalingChain = run.catch(err => {
            console.error('Signaling chain error', err);
        });
        await run;
    }

    private async processSignal(signal: QRtcSignalingType, msg: QRtcDataExchanged) {
        const pc = this.status.pc;
        if (!pc) {
            return Promise.reject('PeerConnection not initialized');
        }

        console.log('Handling signal: ' + signal + ': ' + JSON.stringify(msg));

        switch (signal) {
            case QRtcSignalingType.Answer: {
                if (!msg.description) {
                    return Promise.reject(new Error('signal answer should have description'));
                }

                await pc.setRemoteDescription(msg.description);
                await this.flushIceCandidateQueue(pc);
                this.status.makingOffer = false;
                this.status.ignoreOffer = false;
                break;
            }
            case QRtcSignalingType.Offer: {
                if (!msg.description) {
                    return Promise.reject(new Error('signal answer should have description'));
                }

                const offerCollision = this.status.makingOffer || pc.signalingState !== 'stable';
                this.status.ignoreOffer = !this.input.isPolite && offerCollision;

                if (this.status.ignoreOffer) {
                    console.log('Ignoring offer from ' + this.input.peerSessionId + ' because we are not polite');
                    return;
                }

                if (offerCollision) {
                    console.log('Accepting offer from ' + this.input.peerSessionId + ' because we are polite = ' + this.input.isPolite);
                    await Promise.all([
                        pc.setLocalDescription({ type: 'rollback' }),
                        pc.setRemoteDescription(msg.description)
                    ]);
                } else {
                    await pc.setRemoteDescription(msg.description);
                }

                await this.flushIceCandidateQueue(pc);
                await pc.setLocalDescription(); // Automatically creates an answer

                this.status.makingOffer = false;
                this.status.ignoreOffer = false;

                await this.sendSignal(
                    QRtcSignalingType.Answer,
                    {
                        description: pc.localDescription,
                        candidate: null,
                    }
                );
                break;
            }

            case QRtcSignalingType.IceCandidate: {
                if (!msg.candidate) {
                    return Promise.reject(new Error('signal ice candidate should have candidate'));
                }

                if (this.status.ignoreOffer) {
                    console.log('Ignoring ICE candidate from ' + this.input.peerSessionId + ' because we are not polite');
                    return;
                }

                try {
                    if (pc.remoteDescription && pc.remoteDescription.type) {
                        await pc.addIceCandidate(msg.candidate);
                    } else {
                        this.status.iceCandidateQueue.push(msg.candidate);
                    }
                } catch (err) {
                    if (!this.status.ignoreOffer) {
                        throw err;
                    }
                }
                break;
            }
        }

        return Promise.resolve();
    }

    private async flushIceCandidateQueue(pc: RTCPeerConnection) {
        while (this.status.iceCandidateQueue.length > 0) {
            const candidate = this.status.iceCandidateQueue.shift();
            try {
                await pc.addIceCandidate(candidate);
            } catch (e) {
                console.warn('Failed to add queued candidate:', e);
            }
        }
    }

    async handleReconnect() {
        if (this.status.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            console.warn(`Gitt opp etter ${this.status.reconnectAttempts} forsøk. Lukker peeren.`);
            this.reset(); // Funksjon som lukker PC og fjerner UI
            return;
        }

        // 2. Already reconnecting?
        if (this.status.reconnectTimer) {
            return;
        }

        this.status.reconnectAttempts++;

        // Exponential backoffs: 2s, 4s, 8s, 16s...
        const delay = Math.pow(2, this.status.reconnectAttempts) * 1000;
        console.log(`Try again ${this.status.reconnectAttempts} in ${delay / 1000} seconds...`);

        this.status.reconnectTimer =
            setTimeout(
                async () => {
                    this.status.reconnectTimer = undefined;

                    try {
                        // Sjekk om vi ble koblet til i ventetiden (f.eks. ved et innkommende anrop)
                        if (this.isConnectedOrInProgress(this.status.pc)) {
                            this.status.reconnectAttempts = 0;
                            return;
                        }

                        console.log('Performing ICE restart...');

                        // Enqueue to avoid race conditions
                        this.signalingChain =
                            this.signalingChain
                                .then(
                                    async () => {
                                        if (this.isConnectedOrInProgress(this.status.pc)) {
                                            this.status.reconnectAttempts = 0;
                                            return;
                                        }

                                        this.status?.pc?.restartIce();
                                    }
                                );

                    } catch (err) {
                        console.error('Error during reconnect:', err);
                    }
                },
                delay
            );
    }

    private isConnectedOrInProgress(pc: RTCPeerConnection | undefined): boolean {
        return pc !== undefined && (
            pc.connectionState === 'connected' ||
            pc.connectionState === 'connecting' ||
            pc.connectionState === 'new'
        );
    }

    private async sendSignal(signalType: QRtcSignalingType, payload: QRtcDataExchanged): Promise<void> {
        const signal = {
            channel: QRtcSignalingChannel.RtcSignal,
            type: QRtcSignalingMsgType.Signal,
            fromId: this.input.sessionId,
            toId: this.input.peerSessionId,
            sessionId: this.input.sessionId,
            token: this.input.token,
            signalType: signalType,
            payload: payload
        };

        const run =
            this.outboundSignalingChain
                .then(async () => {
                    console.log('Sending signal: ' + JSON.stringify(signal));
                    await this.signaler.send(signal);
                });

        this.outboundSignalingChain = run.catch(err => {
            console.error('Outbound signaling chain error', err);
        });
        await run;
    }

    isOpen() {
        return this.status.state === QRtcSessionState.Open;
    }

    isReadyToConnect() {
        return this.status.state === QRtcSessionState.Idle ||
            this.status.state === QRtcSessionState.Failed ||
            this.status.state === QRtcSessionState.Closed;
    }

    isAlreadyActiveOrConnecting() {
        return this.status.state === QRtcSessionState.Open ||
            this.status.state === QRtcSessionState.Connecting ||
            this.status.pc?.connectionState === 'connecting' ||
            this.status.pc?.connectionState === 'connected';
    }

    isPeerActive() {
        return this.status.pc &&
            this.status.pc.connectionState !== 'closed' &&
            this.status.pc.connectionState !== 'failed';
    }

    private stopReconnectTimer() {
        if (this.status.disconnectTimer) {
            clearTimeout(this.status.disconnectTimer);
            this.status.disconnectTimer = undefined;
        }
    }

    async setLocalMediaStream(stream: MediaStream): Promise<void> {
        const pc = this.status.pc;
        if (!pc) {
            throw new Error('PeerConnection not initialized');
        }

        // Replace local stream reference
        this.status.localStream = stream;

        // Add or replace tracks per kind (audio/video). ReplaceTrack supports device switching.
        for (const track of stream.getTracks()) {
            const key = track.kind;
            const sender = this.status.localSenders.get(key);

            if (sender) {
                await sender.replaceTrack(track);
            } else {
                const newSender = pc.addTrack(track, stream);
                this.status.localSenders.set(key, newSender);
            }
        }

        if (this.status.mediaPolicy) {
            this.applyMediaPolicy(this.status.mediaPolicy);
        }
    }

    setLocalAudioEnabled(enabled: boolean): void {
        const stream = this.status.localStream;
        if (!stream) {
            return;
        }

        for (const t of stream.getAudioTracks()) {
            t.enabled = enabled;
        }
    }

    setLocalVideoEnabled(enabled: boolean): void {
        const stream = this.status.localStream;
        if (!stream) {
            return;
        }

        for (const t of stream.getVideoTracks()) {
            t.enabled = enabled;
        }
    }

    stopLocalMedia(kind: 'audio' | 'video' | 'all'): void {
        const stream = this.status.localStream;
        if (!stream) {
            return;
        }

        const tracks = kind === 'all'
            ? stream.getTracks()
            : kind === 'audio'
                ? stream.getAudioTracks()
                : stream.getVideoTracks();

        for (const t of tracks) {
            try {
                t.stop();
            } catch {
                // ignore
            }
        }
    }

    applyMediaPolicy(policy: QRtcMediaPolicy): void {
        this.status.mediaPolicy = policy;

        const pc = this.status.pc;
        if (!pc) {
            return;
        }

        // Ensure transceivers exist before setting codec preferences.
        this.ensureTransceiversForPolicy(policy);

        if (policy.preferredVideoCodecs && policy.preferredVideoCodecs.length > 0) {
            this.applyCodecPreferences('video', policy.preferredVideoCodecs);
        }
        if (policy.preferredAudioCodecs && policy.preferredAudioCodecs.length > 0) {
            this.applyCodecPreferences('audio', policy.preferredAudioCodecs);
        }

        if (
            policy.maxVideoBitrateBps ||
            policy.maxVideoFramerate ||
            policy.scaleResolutionDownBy ||
            policy.degradationPreference
        ) {
            void this.applySenderEncodingParams(
                'video',
                {
                    maxBitrateBps: policy.maxVideoBitrateBps,
                    maxFramerate: policy.maxVideoFramerate,
                    scaleResolutionDownBy: policy.scaleResolutionDownBy,
                    degradationPreference: policy.degradationPreference,
                }
            );
        }

        if (policy.maxAudioBitrateBps) {
            void this.applySenderEncodingParams(
                'audio',
                {
                    maxBitrateBps: policy.maxAudioBitrateBps,
                }
            );
        }
    }

    private ensureTransceiversForPolicy(policy: QRtcMediaPolicy): void {
        const pc = this.status.pc;
        if (!pc) return;

        const needAudio = !!(policy.preferredAudioCodecs && policy.preferredAudioCodecs.length > 0);
        const needVideo = !!(policy.preferredVideoCodecs && policy.preferredVideoCodecs.length > 0);

        if (needAudio && !pc.getTransceivers().some(t => t.receiver?.track?.kind === 'audio')) {
            pc.addTransceiver('audio', { direction: 'sendrecv' });
        }
        if (needVideo && !pc.getTransceivers().some(t => t.receiver?.track?.kind === 'video')) {
            pc.addTransceiver('video', { direction: 'sendrecv' });
        }
    }

    private applyCodecPreferences(
        kind: 'audio' | 'video',
        preferredMimeTypes: readonly RtcCodecMimeType[]
    ): void {
        const pc = this.status.pc;
        if (!pc) {
            return;
        }

        const caps = RTCRtpSender.getCapabilities(kind);
        if (!caps) {
            return;
        }

        const codecs = caps.codecs
            .filter(
                c => preferredMimeTypes.includes(c.mimeType)
            )
            .sort(
                (a, b) =>
                    preferredMimeTypes.indexOf(a.mimeType) - preferredMimeTypes.indexOf(b.mimeType)
            );

        const transceiver = pc.getTransceivers().find(t => t.receiver?.track?.kind === kind);
        if (!transceiver || codecs.length === 0) {
            return;
        }

        try {
            transceiver.setCodecPreferences(codecs);
        } catch (e) {
            console.warn('setCodecPreferences not supported or failed', e);
        }
    }

    private async applySenderEncodingParams(
        kind: 'audio' | 'video',
        args: {
            maxBitrateBps?: number;
            maxFramerate?: number;
            scaleResolutionDownBy?: number;
            degradationPreference?: 'maintain-framerate' | 'maintain-resolution' | 'balanced';
        }
    ): Promise<void> {
        const pc = this.status.pc;
        if (!pc) {
            return;
        }

        const sender = pc.getSenders().find(s => s.track?.kind === kind);
        if (!sender) {
            return;
        }

        const params = sender.getParameters();
        params.encodings = params.encodings && params.encodings.length > 0 ? params.encodings : [{}];

        const enc = params.encodings[0] as RTCRtpEncodingParameters;

        if (args.maxBitrateBps !== undefined) {
            enc.maxBitrate = args.maxBitrateBps;
        }

        if (kind === 'video') {
            if (args.maxFramerate !== undefined) enc.maxFramerate = args.maxFramerate;
            if (args.scaleResolutionDownBy !== undefined) enc.scaleResolutionDownBy = args.scaleResolutionDownBy;

            if (args.degradationPreference !== undefined) {
                // Best-effort: supported in many browsers but not always typed
                params.degradationPreference = args.degradationPreference;
            }
        }

        try {
            await sender.setParameters(params);
        } catch (e) {
            console.warn('setParameters failed', e);
        }
    }
}
