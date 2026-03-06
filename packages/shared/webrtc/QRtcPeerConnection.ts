import {IceConfig} from "../api/api-config.ts";
import {
    QRtcSignalingChannel,
    QRtcSignalingMessage,
    QRtcSignalingMsgType,
    QRtcSignalingTransport,
    QRtcSignalingTransportCallbacks,
    QRtcSignalingTransportInputDto,
    QRtcSignalingType
} from "./QRtcSignalingContracts.ts";
import {ALMessage} from "../al-contracts/al-contract.ts";


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
}

type QRtcPeerConnectionStatus = {
    state: QRtcSessionState | undefined
    pc: RTCPeerConnection | undefined
    localStream: MediaStream | undefined
    localSenders: Map<string, RTCRtpSender>
    remoteStreams: Map<string, MediaStream>
    mediaPolicy: QRtcMediaPolicy | undefined
    isPolite: boolean
    makingOffer: boolean
    ignoreOffer: boolean
    iceCandidateQueue: RTCIceCandidateInit[]
    readonly signalerInput: QRtcSignalingTransportInputDto
}

export class QRtcPeerConnection {
    private readonly configuration;
    public status: QRtcPeerConnectionStatus;

    private readonly onDataChannelCallbacks = new Map<string, QRtcOnDataChannelCallback>()
    private readonly onTrackCallbacks = new Map<string, QRtcOnTrackCallback>()
    private readonly onRemoteStreamCallbacks = new Map<string, QRtcOnRemoteStreamCallback>()

    constructor(
        public readonly signaler: QRtcSignalingTransport,
        public readonly input: QRtcPeerConnectionInputDto
    ) {
        this.configuration = {
            iceServers: [...this.input.iceCandidates.iceServers]
        };

        this.status = this.toInitialStatus()
    }

    reset(): QRtcPeerConnectionStatus {
        this.closePeerConnectionIfPresent();
        this.status = this.toInitialStatus();

        return this.status;
    }

    clearCallbacks() {
        this.onDataChannelCallbacks.clear();
        this.onTrackCallbacks.clear();
        this.onRemoteStreamCallbacks.clear();
    }

    private toInitialStatus(): QRtcPeerConnectionStatus {
        return {
            state: QRtcSessionState.Idle,
            pc: undefined,
            localStream: undefined,
            localSenders: new Map<string, RTCRtpSender>(),
            remoteStreams: new Map<string, MediaStream>(),
            mediaPolicy: undefined,
            isPolite: this.input.sessionId < this.input.peerSessionId,
            makingOffer: false,
            ignoreOffer: false,
            iceCandidateQueue: [],
            signalerInput: {
                sessionId: this.input.sessionId,
                token: this.input.token,
                callbacks: this.toSignalingProtocol()
            }
        };
    }

    private closePeerConnectionIfPresent() {
        if (this.status?.pc) {
            try {
                this.status?.pc?.close?.()
            } catch (e) {
                console.error("Error closing peer connection. Ignoring ...", e)
            }
        }
    }

    private toSignalingProtocol(): QRtcSignalingTransportCallbacks {
        return {
            onOpen: (sessionId: string, token: string) => {
                console.log(`Signaling transport open for ${sessionId} and ${token}`)
                return Promise.resolve()
            },

            onError: (_: string, __: string, message: string) => {
                console.error("Signaling transport error: " + message)
                return Promise.resolve()
            },

            onClose: (sessionId: string, token: string) => {
                console.log(`Signaling transport closed for ${sessionId} and ${token}`)
                return Promise.resolve()
            },

            onMessage: async (sessionId: string, token: string, message: ALMessage) => {
                console.log(`Message received for ${sessionId} and ${token} ${message.payload.resource}`)

                const msg: QRtcSignalingMessage = JSON.parse(message.payload.resource) as QRtcSignalingMessage

                if (msg.toId !== this.input.sessionId) {
                    console.log("Message not for us, ignoring: " + message.payload.resource)
                    return Promise.resolve()
                }

                await this.handleSignal(
                    msg.signalType,
                    msg.payload as QRtcDataExchanged
                )

                return Promise.resolve()
            }
        };
    }

    onDataChannelDo(id: string, onDataChannel: QRtcOnDataChannelCallback): QRtcPeerConnection {
        this.onDataChannelCallbacks.set(id, onDataChannel);
        return this
    }

    removeDataChannelCallbackById(id: string): boolean {
        return this.onDataChannelCallbacks.delete(id);
    }

    onTrackDo(id: string, onTrack: QRtcOnTrackCallback): QRtcPeerConnection {
        this.onTrackCallbacks.set(id, onTrack);
        return this
    }

    removeOnTrackCallbackById(id: string): boolean {
        return this.onTrackCallbacks.delete(id);
    }

    onRemoteStreamDo(id: string, cb: QRtcOnRemoteStreamCallback): QRtcPeerConnection {
        this.onRemoteStreamCallbacks.set(id, cb);
        return this
    }

    removeOnRemoteStreamCallbackById(id: string): boolean {
        return this.onRemoteStreamCallbacks.delete(id);
    }

    async connect() {
        await this.signaler.connect(this.status.signalerInput)

        this.initialiseRtc()
    }

    createDataChannel(label: string): RTCDataChannel {
        const pc = this.status.pc;
        if (!pc) {
            throw new Error("PeerConnection not initialized");
        }

        return pc.createDataChannel(label);
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
            pc.addTransceiver('audio', {direction: 'sendrecv'});
        }
        if (needVideo && !pc.getTransceivers().some(t => t.receiver?.track?.kind === 'video')) {
            pc.addTransceiver('video', {direction: 'sendrecv'});
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

    private initialiseRtc() {
        if (this.isOpen()) {
            console.log("Peer connection already open")
            return
        } else if (!this.isReadyToConnect()) {
            console.log("Peer connection is in progress and not ready to connect")
            return
        }

        this.status.state = QRtcSessionState.Connecting;

        const pc = new RTCPeerConnection(this.configuration);
        this.status.pc = pc

        // When pc.createDataChannel is called, it will trigger this event
        pc.onnegotiationneeded = async () => {
            try {
                if (pc.signalingState !== 'stable') {
                    // Avoid creating offers while not stable; perfect negotiation resolves convergence.
                    return;
                }

                this.status.makingOffer = true;
                await pc.setLocalDescription();

                console.log("Offer negotiation: " + JSON.stringify(pc.localDescription))

                this.sendSignal(
                    QRtcSignalingType.Offer,
                    {
                        description: pc.localDescription,
                        candidate: null
                    }
                );
            } catch (err) {
                console.error("Negotiation error", err);
            } finally {
                this.status.makingOffer = false;
            }
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendSignal(
                    QRtcSignalingType.IceCandidate,
                    {
                        description: null,
                        candidate: event.candidate
                    }
                )
            } else {
                console.log("ICE Gathering Complete")
            }
        }

        pc.ondatachannel =
            async event => {
                console.log("Data channel created: " + event.channel.label)

                for (const callback of this.onDataChannelCallbacks.values()) {
                    try {
                        await callback(event)
                    } catch (e) {
                        console.error("Callback onDataChannel failed:", e);
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
        }

        this.setupStateChangeCallbacks(pc);
    }

    async handleSignal(signal: QRtcSignalingType, msg: QRtcDataExchanged) {
        const pc = this.status.pc;
        if (!pc) {
            return Promise.reject("PeerConnection not initialized");
        }

        console.log("Handling signal: " + signal + ": " + JSON.stringify(msg))

        switch (signal) {
            case QRtcSignalingType.Answer: {
                if (!msg.description) {
                    return Promise.reject(new Error("signal answer should have description"));
                }

                if (pc.signalingState !== 'have-local-offer') {
                    console.warn("Received answer in wrong state: " + pc.signalingState + " expected have-local-offer. Ignoring....")
                    return Promise.resolve()
                }

                try {
                    await pc.setRemoteDescription(msg.description);
                } catch (err) {
                    console.error("Error setting remote description", err);
                    return Promise.reject(err);
                }

                while (this.status.iceCandidateQueue.length) {
                    const queuedCandidate = this.status.iceCandidateQueue.shift();
                    await pc.addIceCandidate(queuedCandidate);
                }

                break
            }
            case QRtcSignalingType.Offer: {
                if (!msg.description) {
                    return Promise.reject(new Error("signal answer should have description"))
                }

                const offerCollision = this.status.makingOffer || pc.signalingState !== "stable";

                this.status.ignoreOffer = !this.status.isPolite && offerCollision;

                if (this.status.ignoreOffer) {
                    console.log("Ignoring offer from " + this.input.peerSessionId + " because we are not polite")
                    return Promise.resolve()
                }

                if (offerCollision) {
                    await Promise.all(
                        [
                            pc.setLocalDescription({type: "rollback"}),
                            pc.setRemoteDescription(msg.description)
                        ]
                    );
                } else {
                    await pc.setRemoteDescription(msg.description);
                }

                while (this.status.iceCandidateQueue.length) {
                    const queuedCandidate = this.status.iceCandidateQueue.shift();
                    await pc.addIceCandidate(queuedCandidate);
                }

                await pc.setLocalDescription();

                this.sendSignal(
                    QRtcSignalingType.Answer,
                    {
                        description: pc.localDescription,
                        candidate: null,
                    }
                );
                break
            }

            case QRtcSignalingType.IceCandidate: {
                if (!msg.candidate) {
                    return Promise.reject(new Error("signal ice candidate should have candidate"))
                }

                try {
                    if (pc.remoteDescription && pc.remoteDescription.type) {
                        await pc.addIceCandidate(msg.candidate);
                    } else {
                        this.status.iceCandidateQueue.push(msg.candidate);
                    }
                } catch (err) {
                    if (!this.status.ignoreOffer) {
                        return Promise.reject(err);
                    }
                }
                break
            }
        }

        return Promise.resolve()
    }

    private sendSignal(signalType: QRtcSignalingType, payload: QRtcDataExchanged): void {
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

        console.log("Sending signal: " + JSON.stringify(signal))

        this.signaler.send(signal);
    }

    private setupStateChangeCallbacks(pc: RTCPeerConnection) {
        pc.oniceconnectionstatechange = () => {
            console.log("ICE Connection State: " + pc.iceConnectionState)
        }

        pc.onconnectionstatechange = () => {
            switch (pc.connectionState) {
                case "connected":
                    this.status.state = QRtcSessionState.Open;
                    break;
                case "disconnected":
                case "closed":
                    this.status.state = QRtcSessionState.Closed;
                    break;
                case "failed":
                    this.status.state = QRtcSessionState.Failed;
                    break;
                case "connecting":
                case "new":
                    break;
            }
        };

        pc.addEventListener(
            "icegatheringstatechange",
            _ => {
                switch (pc.iceGatheringState) {
                    case "new":
                        console.log("ICE Gathering State: New")
                        break;
                    case "gathering":
                        console.log("ICE Gathering State: Gathering")
                        break;
                    case "complete":
                        console.log("ICE Gathering State: Complete")
                        break;
                }
            }
        );
    }

    isOpen() {
        return this.status.state === QRtcSessionState.Open;
    }

    isReadyToConnect() {
        return this.status.state === QRtcSessionState.Idle ||
            this.status.state === QRtcSessionState.Failed ||
            this.status.state === QRtcSessionState.Closed;
    }
}