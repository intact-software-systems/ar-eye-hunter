import { IceConfig } from '../api/api-config.ts';
import { toError } from '../resilience/to-error.ts';
import { flushRtcIceCandidateQueue } from './flush-rtc-ice-candidate-queue.ts';
import {
    QRtcSignalingChannel,
    QRtcSignalingMsgType,
    QRtcSignalingSender,
    QRtcSignalingType
} from './QRtcSignalingContracts.ts';

const QRtcSessionState = {
    Idle: 'Idle',
    Connecting: 'Connecting',
    Open: 'Open',
    Closed: 'Closed',
    Failed: 'Failed'
} as const;

type QRtcSessionState = (typeof QRtcSessionState)[keyof typeof QRtcSessionState];

export interface QRtcDataExchanged {
    description: RTCSessionDescriptionInit | null;
    candidate: RTCIceCandidateInit | null;
}

export type QRtcOnDataChannelCallback = (event: RTCDataChannelEvent) => Promise<void>;
export type QRtcOnTrackCallback = (event: RTCTrackEvent) => Promise<void>;
export type QRtcOnRemoteStreamCallback = (stream: MediaStream, event: RTCTrackEvent) => Promise<void>;

export interface QRtcMediaPolicy {
    // Bitrate caps (bps)
    readonly maxAudioBitrateBps?: number;
    readonly maxVideoBitrateBps?: number;

    // Video scaling/framerate (best-effort via sender parameters)
    readonly maxVideoFramerate?: number;
    readonly scaleResolutionDownBy?: number;

    // Browser adaptation preference (best-effort)
    readonly degradationPreference?: 'maintain-framerate' | 'maintain-resolution' | 'balanced';

    // Codec preferences in priority order (best-effort)
    readonly preferredVideoCodecs?: readonly string[]; // e.g. ['video/H264','video/VP8']
    readonly preferredAudioCodecs?: readonly string[]; // e.g. ['audio/opus']
}

type QRtcPeerConnectionDiagnosticCounters = {
    -readonly [
        Key in Exclude<
            keyof QRtcPeerConnection.Diagnostics,
            'pendingIceCandidateQueueLength' | 'reconnectAttemptsInFlight' | 'hasReconnectTimer'
        >
    ]: QRtcPeerConnection.Diagnostics[Key];
};

interface SenderEncodingPolicy {
    readonly maxBitrateBps?: number;
    readonly maxFramerate?: number;
    readonly scaleResolutionDownBy?: number;
    readonly degradationPreference?: RTCDegradationPreference;
}

export namespace QRtcPeerConnection {
    export interface StateCallbacks {
        onConnected?: () => Promise<void>;
        onDisconnected?: () => Promise<void>;
        onFailed?: () => Promise<void>;
        onClosed?: (peerId: string) => Promise<void>;
    }

    export interface InputDto {
        readonly sessionId: string;
        readonly token: string;
        readonly peerSessionId: string;
        readonly iceCandidates: IceConfig;
        readonly isPolite: boolean;
    }

    export interface Diagnostics {
        readonly connectCallCount: number;
        readonly connectIgnoredCount: number;
        readonly resetCount: number;
        readonly closedPeerConnectionCount: number;
        readonly negotiationNeededCount: number;
        readonly negotiationSkippedCount: number;
        readonly offerCreatedCount: number;
        readonly inboundOfferCount: number;
        readonly inboundAnswerCount: number;
        readonly inboundIceCandidateCount: number;
        readonly staleAnswerIgnoredCount: number;
        readonly offerCollisionCount: number;
        readonly ignoredOfferCollisionCount: number;
        readonly politeOfferRollbackCount: number;
        readonly outboundOfferCount: number;
        readonly outboundAnswerCount: number;
        readonly outboundIceCandidateCount: number;
        readonly queuedIceCandidateCount: number;
        readonly addedIceCandidateCount: number;
        readonly flushedIceCandidateCount: number;
        readonly ignoredIceCandidateForIgnoredOfferCount: number;
        readonly reconnectAttemptCount: number;
        readonly reconnectTimerAlreadyActiveCount: number;
        readonly reconnectExhaustedCount: number;
        readonly iceRestartCount: number;
        readonly iceRestartSkippedConnectedCount: number;
        readonly disconnectTimerScheduledCount: number;
        readonly disconnectTimerAlreadyActiveCount: number;
        readonly disconnectTimerClearedCount: number;
        readonly disconnectTimerFiredCount: number;
        readonly outboundSignalingErrorCount: number;
        readonly inboundSignalingErrorCount: number;
        readonly pendingIceCandidateQueueLength: number;
        readonly reconnectAttemptsInFlight: number;
        readonly hasReconnectTimer: boolean;
    }

    export interface Status {
        state: QRtcSessionState | undefined;
        pc: RTCPeerConnection | undefined;
        localStream: MediaStream | undefined;
        localSenders: Map<string, RTCRtpSender>;
        remoteStreams: Map<string, MediaStream>;
        mediaPolicy: QRtcMediaPolicy | undefined;
        makingOffer: boolean;
        ignoreOffer: boolean;
        iceCandidateQueue: RTCIceCandidateInit[];
        reconnectAttempts: number;
        reconnectTimer: ReturnType<typeof setTimeout> | undefined;
        disconnectTimer: ReturnType<typeof setTimeout> | undefined;
    }
}

export class QRtcPeerConnection {
    private readonly MAX_RECONNECT_ATTEMPTS: number = 5;
    private readonly DISCONNECT_TIMEOUT_MSECS: number = 5000;

    private signalingChain = Promise.resolve();
    private outboundSignalingChain = Promise.resolve();

    private readonly configuration: RTCConfiguration;
    public status: QRtcPeerConnection.Status;

    private readonly onDataChannelCallbacks = new Map<string, QRtcOnDataChannelCallback>();
    private readonly onTrackCallbacks = new Map<string, QRtcOnTrackCallback>();
    private readonly onRemoteStreamCallbacks = new Map<string, QRtcOnRemoteStreamCallback>();
    private iceGatheringStateChangeListener: ((event: Event) => void) | undefined;
    private diagnostics: QRtcPeerConnectionDiagnosticCounters = createInitialDiagnostics();

    public readonly signaler: QRtcSignalingSender;
    public readonly input: QRtcPeerConnection.InputDto;

    constructor(
        signaler: QRtcSignalingSender,
        input: QRtcPeerConnection.InputDto
    ) {
        this.signaler = signaler;
        this.input = input;
        this.configuration = {
            iceServers: [...this.input.iceCandidates.iceServers]
        };

        this.status = this.toInitialStatus();
    }

    reset(): QRtcPeerConnection.Status {
        this.diagnostics.resetCount++;
        this.closePeerConnectionIfPresent();
        this.status = this.toInitialStatus();

        return this.status;
    }

    readDiagnostics(): QRtcPeerConnection.Diagnostics {
        return {
            ...this.diagnostics,
            pendingIceCandidateQueueLength: this.status.iceCandidateQueue.length,
            reconnectAttemptsInFlight: this.status.reconnectAttempts,
            hasReconnectTimer: this.status.reconnectTimer !== undefined
        };
    }

    resetDiagnostics(): void {
        this.diagnostics = createInitialDiagnostics();
    }

    private toInitialStatus(): QRtcPeerConnection.Status {
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
            disconnectTimer: undefined
        };
    }

    private closePeerConnectionIfPresent() {
        if (this.status.pc) {
            try {
                console.log(
                    'Closing peer connection for peer: ' + this.input.peerSessionId + ' (state: ' + this.status.state +
                        ')'
                );

                const pc = this.status.pc;
                this.diagnostics.closedPeerConnectionCount++;

                // Stop all Transceivers/Tracks associated with this peer
                pc.getTransceivers()
                    .forEach((transceiver) => {
                        transceiver.stop();
                    });

                // Remove event listeners to prevent memory leaks
                pc.onicecandidate = null;
                pc.onnegotiationneeded = null;
                pc.ondatachannel = null;
                pc.onconnectionstatechange = null;
                pc.oniceconnectionstatechange = null;
                pc.onsignalingstatechange = null;
                pc.ontrack = null;
                if (this.iceGatheringStateChangeListener) {
                    pc.removeEventListener(
                        'icegatheringstatechange',
                        this.iceGatheringStateChangeListener
                    );
                    this.iceGatheringStateChangeListener = undefined;
                }

                // Close the PeerConnection itself
                if (pc.connectionState !== 'closed') {
                    pc.close();
                }

                if (this.status.reconnectTimer) {
                    clearTimeout(this.status.reconnectTimer);
                }
                this.clearDisconnectTimer();
            }
            catch (caught) {
                console.error('Error closing peer connection. Ignoring ...', toError(caught));
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

    connect(callbacks: QRtcPeerConnection.StateCallbacks = {}): void {
        this.diagnostics.connectCallCount++;
        if (this.isOpen() || !this.isReadyToConnect()) {
            this.diagnostics.connectIgnoredCount++;
            return;
        }
        if (this.status.pc) {
            this.reset();
        }
        this.status.state = QRtcSessionState.Connecting;
        const pc = new RTCPeerConnection(this.configuration);
        this.status.pc = pc;
        pc.onnegotiationneeded = () => this.handleNegotiationNeeded(pc);
        pc.onicecandidate = (event) => this.handleIceCandidate(event);
        pc.ondatachannel = (event) => this.notifyDataChannel(event);
        pc.ontrack = (event) => this.notifyTrack(event);
        this.setupStateChangeCallbacks(pc, callbacks);
    }

    private async handleNegotiationNeeded(pc: RTCPeerConnection): Promise<void> {
        this.diagnostics.negotiationNeededCount++;
        try {
            if (this.status.makingOffer || pc.signalingState !== 'stable') {
                this.diagnostics.negotiationSkippedCount++;
                return;
            }
            this.status.makingOffer = true;
            await pc.setLocalDescription();
            this.diagnostics.offerCreatedCount++;
            await this.sendSignal(QRtcSignalingType.Offer, { description: pc.localDescription, candidate: null });
        }
        catch (caught) {
            console.error('RTC negotiation failed', toError(caught));
        }
        finally {
            this.status.makingOffer = false;
        }
    }

    private async handleIceCandidate(event: RTCPeerConnectionIceEvent): Promise<void> {
        if (!event.candidate) {
            return;
        }
        try {
            await this.sendSignal(QRtcSignalingType.IceCandidate, { description: null, candidate: event.candidate });
        }
        catch (caught) {
            console.error('RTC ICE candidate signaling failed', toError(caught));
        }
    }

    private async notifyDataChannel(event: RTCDataChannelEvent): Promise<void> {
        for (const callback of this.onDataChannelCallbacks.values()) {
            try {
                await callback(event);
            }
            catch (caught) {
                console.error('RTC data-channel callback failed', toError(caught));
            }
        }
    }

    private async notifyTrack(event: RTCTrackEvent): Promise<void> {
        const stream = event.streams[0];
        if (stream) {
            this.status.remoteStreams.set(stream.id, stream);
            for (const callback of this.onRemoteStreamCallbacks.values()) {
                try {
                    await callback(stream, event);
                }
                catch (caught) {
                    console.error('RTC remote-stream callback failed', toError(caught));
                }
            }
        }
        for (const callback of this.onTrackCallbacks.values()) {
            try {
                await callback(event);
            }
            catch (caught) {
                console.error('RTC track callback failed', toError(caught));
            }
        }
    }

    private setupStateChangeCallbacks(pc: RTCPeerConnection, callbacks: QRtcPeerConnection.StateCallbacks) {
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
                    this.clearDisconnectTimer();

                    if (this.status.reconnectTimer) {
                        clearTimeout(this.status.reconnectTimer);
                        this.status.reconnectTimer = undefined;
                    }

                    callbacks.onConnected?.();
                    break;
                }
                case 'disconnected':
                    this.scheduleDisconnectTimer(pc);

                    callbacks.onDisconnected?.();
                    break;
                case 'failed':
                    this.status.state = QRtcSessionState.Failed;
                    this.clearDisconnectTimer();

                    this.handleReconnect()
                        .catch((caught) => console.error('Error handling reconnect', toError(caught)));

                    callbacks.onFailed?.();
                    break;
                case 'closed':
                    this.status.state = QRtcSessionState.Closed;
                    this.clearDisconnectTimer();

                    callbacks.onClosed?.(this.input.peerSessionId);
                    break;
                case 'connecting':
                case 'new':
                    break;
            }
        };

        this.observeIceGatheringState(pc);
    }

    private observeIceGatheringState(pc: RTCPeerConnection): void {
        this.iceGatheringStateChangeListener = () => {
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
        };
        pc.addEventListener(
            'icegatheringstatechange',
            this.iceGatheringStateChangeListener
        );
    }

    createDataChannel(
        label: string,
        dataChannelDict?: RTCDataChannelInit
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
        const run = this.signalingChain
            .then(
                async () => await this.processSignal(signal, msg)
            );
        this.signalingChain = run.catch((caught) => {
            this.diagnostics.inboundSignalingErrorCount++;
            console.error('Signaling chain error', toError(caught));
        });
        await run;
    }

    private async processSignal(signal: QRtcSignalingType, message: QRtcDataExchanged): Promise<void> {
        const pc = this.status.pc;
        if (!pc) {
            throw new Error('Peer connection is not initialized');
        }
        if (signal === QRtcSignalingType.Answer) {
            await this.handleAnswer(pc, message);
        }
        else if (signal === QRtcSignalingType.Offer) {
            await this.handleOffer(pc, message);
        }
        else {
            await this.handleInboundIceCandidate(pc, message);
        }
    }

    private async handleAnswer(pc: RTCPeerConnection, message: QRtcDataExchanged): Promise<void> {
        this.diagnostics.inboundAnswerCount++;
        if (!message.description) {
            throw new Error('RTC answer is missing its description');
        }
        if (pc.signalingState !== 'have-local-offer') {
            this.diagnostics.staleAnswerIgnoredCount++;
            return;
        }
        await pc.setRemoteDescription(message.description);
        await flushRtcIceCandidateQueue({
            queue: this.status.iceCandidateQueue,
            peerConnection: pc,
            onCandidateAdded: () => {
                this.diagnostics.addedIceCandidateCount++;
                this.diagnostics.flushedIceCandidateCount++;
            }
        });
        this.status.makingOffer = false;
        this.status.ignoreOffer = false;
    }

    private async handleOffer(pc: RTCPeerConnection, message: QRtcDataExchanged): Promise<void> {
        this.diagnostics.inboundOfferCount++;
        if (!message.description) {
            throw new Error('RTC offer is missing its description');
        }
        const collision = this.status.makingOffer || pc.signalingState !== 'stable';
        if (collision) {
            this.diagnostics.offerCollisionCount++;
        }
        this.status.ignoreOffer = !this.input.isPolite && collision;
        if (this.status.ignoreOffer) {
            this.diagnostics.ignoredOfferCollisionCount++;
            return;
        }
        if (collision) {
            this.diagnostics.politeOfferRollbackCount++;
            await Promise.all([
                pc.setLocalDescription({ type: 'rollback' }),
                pc.setRemoteDescription(message.description)
            ]);
        }
        else {
            await pc.setRemoteDescription(message.description);
        }
        await flushRtcIceCandidateQueue({
            queue: this.status.iceCandidateQueue,
            peerConnection: pc,
            onCandidateAdded: () => {
                this.diagnostics.addedIceCandidateCount++;
                this.diagnostics.flushedIceCandidateCount++;
            }
        });
        await pc.setLocalDescription();
        this.status.makingOffer = false;
        this.status.ignoreOffer = false;
        await this.sendSignal(QRtcSignalingType.Answer, { description: pc.localDescription, candidate: null });
    }

    private async handleInboundIceCandidate(pc: RTCPeerConnection, message: QRtcDataExchanged): Promise<void> {
        this.diagnostics.inboundIceCandidateCount++;
        if (!message.candidate) {
            throw new Error('RTC ICE signal is missing its candidate');
        }
        if (this.status.ignoreOffer) {
            this.diagnostics.ignoredIceCandidateForIgnoredOfferCount++;
            return;
        }
        try {
            if (pc.remoteDescription?.type) {
                await pc.addIceCandidate(message.candidate);
                this.diagnostics.addedIceCandidateCount++;
            }
            else {
                this.status.iceCandidateQueue.push(message.candidate);
                this.diagnostics.queuedIceCandidateCount++;
            }
        }
        catch (caught) {
            const error = toError(caught);
            if (!this.status.ignoreOffer) {
                throw error;
            }
        }
    }

    async handleReconnect() {
        if (this.status.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            this.diagnostics.reconnectExhaustedCount++;
            console.warn(`RTC reconnect exhausted after ${this.status.reconnectAttempts} attempts`);
            this.reset();
            return;
        }

        // An active retry timer already owns this reconnect attempt.
        if (this.status.reconnectTimer) {
            this.diagnostics.reconnectTimerAlreadyActiveCount++;
            return;
        }

        this.status.reconnectAttempts++;
        this.diagnostics.reconnectAttemptCount++;

        // Exponential backoffs: 2s, 4s, 8s, 16s...
        const delay = Math.pow(2, this.status.reconnectAttempts) * 1000;
        console.log(`Try again ${this.status.reconnectAttempts} in ${delay / 1000} seconds...`);

        this.status.reconnectTimer = setTimeout(
            async () => {
                this.status.reconnectTimer = undefined;

                try {
                    // An incoming signal may have connected the peer during backoff.
                    if (this.isConnectedOrInProgress(this.status.pc)) {
                        this.diagnostics.iceRestartSkippedConnectedCount++;
                        this.status.reconnectAttempts = 0;
                        return;
                    }

                    console.log('Performing ICE restart...');

                    // Enqueue to avoid race conditions
                    this.signalingChain = this.signalingChain
                        .then(
                            async () => {
                                if (this.isConnectedOrInProgress(this.status.pc)) {
                                    this.diagnostics.iceRestartSkippedConnectedCount++;
                                    this.status.reconnectAttempts = 0;
                                    return;
                                }

                                this.status.pc?.restartIce();
                                this.diagnostics.iceRestartCount++;
                            }
                        );
                }
                catch (caught) {
                    console.error('Error during reconnect:', toError(caught));
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
        this.recordOutboundSignal(signalType);

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

        const run = this.outboundSignalingChain
            .then(async () => {
                await this.signaler.send(signal);
            });

        this.outboundSignalingChain = run.catch((caught) => {
            this.diagnostics.outboundSignalingErrorCount++;
            console.error('Outbound signaling chain error', toError(caught));
        });
        await run;
    }

    private recordOutboundSignal(signalType: QRtcSignalingType): void {
        switch (signalType) {
            case QRtcSignalingType.Offer:
                this.diagnostics.outboundOfferCount++;
                break;
            case QRtcSignalingType.Answer:
                this.diagnostics.outboundAnswerCount++;
                break;
            case QRtcSignalingType.IceCandidate:
                this.diagnostics.outboundIceCandidateCount++;
                break;
        }
    }

    isOpen() {
        return this.status.state === QRtcSessionState.Open;
    }

    isReadyToConnect() {
        return this.status.state === QRtcSessionState.Idle ||
            this.status.state === QRtcSessionState.Failed ||
            this.status.state === QRtcSessionState.Closed;
    }

    private scheduleDisconnectTimer(pc: RTCPeerConnection): void {
        if (this.status.disconnectTimer) {
            this.diagnostics.disconnectTimerAlreadyActiveCount++;
            return;
        }

        this.diagnostics.disconnectTimerScheduledCount++;
        this.status.disconnectTimer = setTimeout(
            () => {
                this.status.disconnectTimer = undefined;
                this.diagnostics.disconnectTimerFiredCount++;
                if (pc.connectionState === 'disconnected') {
                    this.handleReconnect()
                        .catch((caught) => console.error('Error handling reconnect', toError(caught)));
                }
            },
            this.DISCONNECT_TIMEOUT_MSECS
        );
    }

    private clearDisconnectTimer(): void {
        if (this.status.disconnectTimer) {
            clearTimeout(this.status.disconnectTimer);
            this.status.disconnectTimer = undefined;
            this.diagnostics.disconnectTimerClearedCount++;
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
            }
            else {
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
            }
            catch {
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
                    degradationPreference: policy.degradationPreference
                }
            );
        }

        if (policy.maxAudioBitrateBps) {
            void this.applySenderEncodingParams(
                'audio',
                {
                    maxBitrateBps: policy.maxAudioBitrateBps
                }
            );
        }
    }

    private ensureTransceiversForPolicy(policy: QRtcMediaPolicy): void {
        const pc = this.status.pc;
        if (!pc) {
            return;
        }

        const needAudio = !!(policy.preferredAudioCodecs && policy.preferredAudioCodecs.length > 0);
        const needVideo = !!(policy.preferredVideoCodecs && policy.preferredVideoCodecs.length > 0);

        if (needAudio && !pc.getTransceivers().some((t) => t.receiver.track.kind === 'audio')) {
            pc.addTransceiver('audio', { direction: 'sendrecv' });
        }
        if (needVideo && !pc.getTransceivers().some((t) => t.receiver.track.kind === 'video')) {
            pc.addTransceiver('video', { direction: 'sendrecv' });
        }
    }

    private applyCodecPreferences(
        kind: 'audio' | 'video',
        preferredMimeTypes: readonly string[]
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
                (c) => preferredMimeTypes.includes(c.mimeType)
            )
            .sort(
                (a, b) => preferredMimeTypes.indexOf(a.mimeType) - preferredMimeTypes.indexOf(b.mimeType)
            );

        const transceiver = pc.getTransceivers().find((t) => t.receiver.track.kind === kind);
        if (!transceiver || codecs.length === 0) {
            return;
        }

        try {
            transceiver.setCodecPreferences(codecs);
        }
        catch (caught) {
            console.warn('setCodecPreferences not supported or failed', toError(caught));
        }
    }

    private async applySenderEncodingParams(
        kind: 'audio' | 'video',
        args: SenderEncodingPolicy
    ): Promise<void> {
        const pc = this.status.pc;
        if (!pc) {
            return;
        }

        const sender = pc.getSenders().find((s) => s.track?.kind === kind);
        if (!sender) {
            return;
        }

        const params = sender.getParameters();
        params.encodings = params.encodings && params.encodings.length > 0 ? params.encodings : [{}];

        const enc = params.encodings[0];

        if (args.maxBitrateBps !== undefined) {
            enc.maxBitrate = args.maxBitrateBps;
        }

        if (kind === 'video') {
            if (args.maxFramerate !== undefined) {
                enc.maxFramerate = args.maxFramerate;
            }
            if (args.scaleResolutionDownBy !== undefined) {
                enc.scaleResolutionDownBy = args.scaleResolutionDownBy;
            }

            if (args.degradationPreference !== undefined) {
                // Best-effort: supported in many browsers but not always typed
                params.degradationPreference = args.degradationPreference;
            }
        }

        try {
            await sender.setParameters(params);
        }
        catch (caught) {
            console.warn('setParameters failed', toError(caught));
        }
    }
}

function createInitialDiagnostics(): QRtcPeerConnectionDiagnosticCounters {
    return {
        connectCallCount: 0,
        connectIgnoredCount: 0,
        resetCount: 0,
        closedPeerConnectionCount: 0,
        negotiationNeededCount: 0,
        negotiationSkippedCount: 0,
        offerCreatedCount: 0,
        inboundOfferCount: 0,
        inboundAnswerCount: 0,
        inboundIceCandidateCount: 0,
        staleAnswerIgnoredCount: 0,
        offerCollisionCount: 0,
        ignoredOfferCollisionCount: 0,
        politeOfferRollbackCount: 0,
        outboundOfferCount: 0,
        outboundAnswerCount: 0,
        outboundIceCandidateCount: 0,
        queuedIceCandidateCount: 0,
        addedIceCandidateCount: 0,
        flushedIceCandidateCount: 0,
        ignoredIceCandidateForIgnoredOfferCount: 0,
        reconnectAttemptCount: 0,
        reconnectTimerAlreadyActiveCount: 0,
        reconnectExhaustedCount: 0,
        iceRestartCount: 0,
        iceRestartSkippedConnectedCount: 0,
        disconnectTimerScheduledCount: 0,
        disconnectTimerAlreadyActiveCount: 0,
        disconnectTimerClearedCount: 0,
        disconnectTimerFiredCount: 0,
        outboundSignalingErrorCount: 0,
        inboundSignalingErrorCount: 0
    };
}
