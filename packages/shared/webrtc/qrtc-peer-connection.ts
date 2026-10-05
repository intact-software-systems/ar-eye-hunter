import { IceConfig } from '../api/api-config.ts';
import { toError } from '../resilience/to-error.ts';
import { applyRtcMediaPolicy } from './apply-rtc-media-policy.ts';
import {
    flushRtcIceCandidateQueue,
    type FlushRtcIceCandidateQueueObservation
} from './flush-rtc-ice-candidate-queue.ts';
import { toQRtcSignalingAdmission, type QRtcSignalingAdmission } from './qrtc-signaling-admission.ts';
import {
    QRtcSignal,
    QRtcSignalingChannel,
    QRtcSignalingMsgType,
    QRtcSignalingSender,
    QRtcSignalingType
} from './qrtc-signaling-contracts.ts';
import {
    attachRtcNativeListener,
    createRtcNativeBinding,
    detachRtcNativeListeners,
    readRtcNativeChannelSnapshot,
    readRtcNativeSnapshot,
    toRtcRetiredNativeSnapshot,
    toRtcUnavailableNativeState,
    type RtcNativeChannelSnapshotInput,
    type RtcNativeListener
} from './rtc-native-observation-boundary.ts';
import { toRtcCandidateApplication } from './rtc-native-observation-rows.ts';
import type { RtcNativeObservationScope } from './rtc-native-observation-scope.ts';
import {
    readRtcCandidateFragments,
    readRtcNativeErrorFacts,
    readRtcNativeEventError,
    readRtcTransportAttachmentGap,
    readRtcTransportChain,
    readRtcTypedErrorUnavailableReason,
    toRtcNativeErrorIsTyped,
    toRtcUnavailable
} from './rtc-native-observation-values.ts';
import {
    recordRtcNativeObservation,
    recordRtcSignalingObservation,
    type RtcSignalingDiagnostics
} from './rtc-signaling-diagnostics.ts';

const QRtcSessionState = {
    Idle: 'Idle',
    Connecting: 'Connecting',
    Open: 'Open',
    Closed: 'Closed',
    Failed: 'Failed'
} as const;

type QRtcSessionState = (typeof QRtcSessionState)[keyof typeof QRtcSessionState];

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

export namespace QRtcPeerConnection {
    export interface NativeObservationBatch {
        readonly observations: NativeObservationCapture[];
        readonly kind: 'synchronous' | 'operation';
        readonly parent: NativeObservationBatch | undefined;
        readonly binding: NativeBinding | undefined;
        closed: boolean;
    }
    export interface NativeObservationCapture {
        readonly binding: NativeBinding;
        readonly row: RtcSignalingDiagnostics.NativeObservation;
    }
    export interface SignalCapture {
        readonly nativeBatch: NativeObservationBatch;
        readonly pc: RTCPeerConnection | undefined;
        readonly nativeIdentity: RtcSignalingDiagnostics.NativeIdentity;
    }
    export interface NativeSignalCapture extends SignalCapture {
        readonly pc: RTCPeerConnection;
    }
    export interface CandidateOperation {
        readonly nativeBatch: NativeObservationBatch;
        readonly binding: NativeBinding;
        readonly operationOrdinal: number;
        readonly source: 'direct' | 'queue-drain';
    }

    export interface NativeListenerInput {
        readonly event: string;
        readonly listener: EventListener;
        readonly transport: boolean;
    }
    export interface NativeBinding {
        readonly pc: RTCPeerConnection;
        readonly admission: RtcNativeObservationScope.Admission;
        readonly identity: RtcSignalingDiagnostics.NativeIdentity;
        readonly detach: RtcNativeListener[];
        readonly transportDetach: RtcNativeListener[];
        sctp: RTCSctpTransport | undefined;
        dtls: RTCDtlsTransport | undefined;
        ice: RTCIceTransport | undefined;
        transportOrdinal: number;
        attachmentGap: boolean;
        listenerCoverage: 'attached' | 'partial' | 'unavailable';
        transportReason: RtcSignalingDiagnostics.ReadoutUnavailableReason;
        firstError: RtcSignalingDiagnostics.NativeError | undefined;
        firstTypedError: RtcSignalingDiagnostics.NativeError | undefined;
        typedReadUnavailableReason: 'read-failed' | 'unsupported' | undefined;
        lastState: string;
        retired: boolean;
        capturing: boolean;
        errorCapturing: boolean;
        errorWindowAttached: boolean;
    }
    export interface ChannelObservationBinding {
        readonly parent: NativeBinding;
        readonly admission: RtcNativeObservationScope.Admission;
        readonly identity: RtcSignalingDiagnostics.NativeIdentity;
    }
    export interface Dependencies {
        createOfferId(): string;
        readonly signalingDiagnostics?: RtcSignalingDiagnostics;
    }

    export interface StateCallbacks {
        onConnected?: () => Promise<void>;
        onDisconnected?: () => Promise<void>;
        onFailed?: () => Promise<void>;
        onClosed?: (peerId: string) => Promise<void>;
        /**
         * A signal this peer could not hand to the transport. A terminal admission strands the
         * peer -- an offer that never left leaves it in `have-local-offer`, where
         * `onnegotiationneeded` cannot fire again -- so the hop that failed is reported rather
         * than logged and dropped.
         */
        onSignalingFailed?: (failure: QRtcPeerConnection.SignalingFailure) => void;
    }

    /** One outbound signal that never reached the transport, named by the hop that produced it. */
    export interface SignalingFailure {
        readonly peerSessionId: string;
        readonly signalType: QRtcSignalingType;
        readonly admission: QRtcSignalingAdmission;
        readonly error: Error;
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

    private signalingChain: Promise<void | RtcSignalingDiagnostics.CallerRelease> = Promise.resolve();
    private signalingLifetime = new AbortController();
    private outboundSignalingChain = Promise.resolve();
    private outstandingOfferId: string | undefined;

    private nativeObservation: QRtcPeerConnection.NativeBinding | undefined;
    private nativeObservationBatch: QRtcPeerConnection.NativeObservationBatch | undefined;
    private nativeOperationOrdinal = 0;
    private nativeUnavailableReason: RtcSignalingDiagnostics.ErrorUnavailableReason = 'no-native-object';

    private readonly configuration: RTCConfiguration;
    public status: QRtcPeerConnection.Status;

    private readonly onDataChannelCallbacks = new Map<string, QRtcOnDataChannelCallback>();
    private readonly onTrackCallbacks = new Map<string, QRtcOnTrackCallback>();
    private readonly onRemoteStreamCallbacks = new Map<string, QRtcOnRemoteStreamCallback>();
    private diagnostics: QRtcPeerConnectionDiagnosticCounters = createInitialDiagnostics();
    private stateCallbacks: QRtcPeerConnection.StateCallbacks = {};

    public readonly signaler: QRtcSignalingSender;
    public readonly input: QRtcPeerConnection.InputDto;
    private readonly dependencies: QRtcPeerConnection.Dependencies;

    constructor(
        signaler: QRtcSignalingSender,
        input: QRtcPeerConnection.InputDto,
        dependencies: QRtcPeerConnection.Dependencies
    ) {
        this.signaler = signaler;
        this.input = input;
        this.dependencies = dependencies;
        this.configuration = {
            iceServers: [...this.input.iceCandidates.iceServers]
        };

        this.status = this.toInitialStatus();
    }

    reset(): QRtcPeerConnection.Status {
        this.diagnostics.resetCount++;
        const retired = this.status;
        const binding = this.nativeObservation;
        const final = this.captureNativeRetirement(binding, 'reset');
        if (this.status !== retired) {
            return this.status;
        }
        this.nativeObservation = undefined;
        this.nativeUnavailableReason = 'no-native-object';
        this.status = this.toInitialStatus();
        this.signalingLifetime.abort();
        this.signalingLifetime = new AbortController();
        this.signalingChain = Promise.resolve();
        this.outboundSignalingChain = Promise.resolve();
        this.outstandingOfferId = undefined;
        // The callbacks belong to the session that just ended; a `connect()` this reset re-opens
        // installs its own, and one that never comes must not still reach the previous owner.
        this.stateCallbacks = {};
        this.closePeerConnectionIfPresent(retired);
        if (final && binding) {
            this.publishNativeObservation(final, this.nativeObservationBatch, binding);
        }

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

    private closePeerConnectionIfPresent(retired: QRtcPeerConnection.Status) {
        if (retired.reconnectTimer) {
            clearTimeout(retired.reconnectTimer);
        }
        if (retired.disconnectTimer) {
            clearTimeout(retired.disconnectTimer);
            this.diagnostics.disconnectTimerClearedCount++;
        }
        const pc = retired.pc;
        if (!pc) {
            return;
        }
        pc.onicecandidate = null;
        pc.onnegotiationneeded = null;
        pc.ondatachannel = null;
        pc.onconnectionstatechange = null;
        pc.ontrack = null;
        this.stopTransceivers(pc);
        try {
            if (pc.connectionState !== 'closed') {
                pc.close();
            }
            this.diagnostics.closedPeerConnectionCount++;
        }
        catch (caught) {
            console.error('RTC cleanup failed', toError(caught));
        }
    }

    private stopTransceivers(pc: RTCPeerConnection): void {
        let transceivers: RTCRtpTransceiver[];
        try {
            transceivers = pc.getTransceivers();
        }
        catch (caught) {
            console.error('RTC cleanup failed', toError(caught));
            return;
        }
        for (const transceiver of transceivers) {
            try {
                transceiver.stop();
            }
            catch (caught) {
                console.error('RTC cleanup failed', toError(caught));
            }
        }
    }

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

    onRemoteStreamDo(id: string, onRemoteStream: QRtcOnRemoteStreamCallback): QRtcPeerConnection {
        this.onRemoteStreamCallbacks.set(id, onRemoteStream);
        return this;
    }

    removeOnRemoteStreamCallbackById(id: string): boolean {
        return this.onRemoteStreamCallbacks.delete(id);
    }

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
        this.stateCallbacks = callbacks;
        const pc = new RTCPeerConnection(this.configuration);
        this.status.pc = pc;
        pc.onnegotiationneeded = () => {
            const run = this.signalingChain.then(() => this.handleNegotiationNeeded(pc));
            this.signalingChain = run.catch((caught) => {
                console.error('Signaling chain error', toError(caught));
            });
            return run;
        };
        pc.onicecandidate = (event) => this.handleIceCandidate(pc, event);
        pc.ondatachannel = (event) => this.notifyDataChannel(pc, event);
        pc.ontrack = (event) => this.notifyTrack(pc, event);
        this.setupStateChangeCallbacks(pc, callbacks);
        this.startNativeObservation(pc);
    }

    beginNativeObservationBatch(): QRtcPeerConnection.NativeObservationBatch {
        const batch: QRtcPeerConnection.NativeObservationBatch = {
            observations: [],
            parent: this.nativeObservationBatch,
            binding: undefined,
            kind: 'synchronous',
            closed: false
        };
        this.nativeObservationBatch = batch;
        return batch;
    }

    endNativeObservationBatch(batch: QRtcPeerConnection.NativeObservationBatch): void {
        if (batch.closed) {
            return;
        }
        batch.closed = true;
        if (this.nativeObservationBatch === batch) {
            this.nativeObservationBatch = batch.parent;
        }
        for (const capture of batch.observations.splice(0)) {
            this.publishNativeObservation(capture.row, batch.parent, capture.binding);
        }
    }

    private createNativeOperationBatch(): QRtcPeerConnection.NativeObservationBatch {
        return {
            observations: [],
            parent: this.nativeObservationBatch,
            binding: this.nativeObservation,
            kind: 'operation',
            closed: false
        };
    }

    private captureNativeInvocation<T>(batch: QRtcPeerConnection.NativeObservationBatch, invoke: () => T): T {
        const previous = this.nativeObservationBatch;
        this.nativeObservationBatch = batch;
        try {
            return invoke();
        }
        finally {
            this.nativeObservationBatch = previous;
        }
    }

    getNativeObservationScope(): RtcNativeObservationScope | undefined {
        const capability = this.dependencies.signalingDiagnostics?.nativeObservation;
        return capability?.status === 'available' ? capability.scope : undefined;
    }

    getNativeIdentity(): RtcSignalingDiagnostics.NativeIdentity {
        return this.nativeObservation?.identity ??
            Object.freeze({
                peerConnectionId: toRtcUnavailable(
                    this.getNativeUnavailableReason()
                ),
                channelId: toRtcUnavailable('not-applicable')
            });
    }

    private getNativeUnavailableReason(): RtcSignalingDiagnostics.ErrorUnavailableReason {
        const capability = this.dependencies.signalingDiagnostics?.nativeObservation;
        if (!capability) {
            return 'disabled';
        }
        if (capability.status === 'unavailable') {
            return capability.reason;
        }
        return capability.scope.getActive() ? this.nativeUnavailableReason : 'scope-disposed';
    }

    readNativeSnapshot(): RtcSignalingDiagnostics.NativeSnapshot {
        return this.captureNativeSnapshot(this.nativeObservation);
    }

    readNativeChannelSnapshot(input: RtcNativeChannelSnapshotInput): RtcSignalingDiagnostics.NativeSnapshot {
        const parent = input.observation.binding.parent;
        const previousCapture = parent.capturing;
        if (previousCapture || parent.retired) {
            return readRtcNativeChannelSnapshot({ ...input, readFailed: true });
        }
        parent.capturing = true;
        try {
            const snapshot = readRtcNativeChannelSnapshot(input);
            return parent.retired
                ? Object.freeze({ ...snapshot, state: toRtcUnavailableNativeState('read-failed') })
                : snapshot;
        }
        finally {
            parent.capturing = previousCapture;
        }
    }

    disposeNativeObservations(): void {
        const binding = this.nativeObservation;
        if (binding) {
            this.detachNativeObservation(binding);
        }
        const batch = this.nativeObservationBatch;
        if (batch) {
            batch.closed = true;
            batch.observations.length = 0;
            this.nativeObservationBatch = batch.parent;
        }
    }

    createChannelObservationBinding(): QRtcPeerConnection.ChannelObservationBinding | undefined {
        const parent = this.nativeObservation;
        const scope = this.getNativeObservationScope();
        if (!parent || parent.retired || !scope || !parent.admission.admitted) {
            return undefined;
        }
        this.bindNativeTransports(parent);
        if (parent.retired) {
            return undefined;
        }
        const admission = scope.allocate('channel');
        if (!admission.admitted) {
            return undefined;
        }
        return Object.freeze({
            parent,
            admission,
            identity: Object.freeze({ peerConnectionId: parent.identity.peerConnectionId, channelId: admission.id })
        });
    }

    retainChannelNativeError(
        binding: QRtcPeerConnection.ChannelObservationBinding,
        error: RtcSignalingDiagnostics.NativeError
    ): void {
        if (binding.parent.retired) {
            return;
        }
        binding.parent.errorWindowAttached = true;
        binding.parent.firstError ??= error;
        binding.parent.typedReadUnavailableReason = readRtcTypedErrorUnavailableReason(
            error,
            binding.parent.typedReadUnavailableReason
        );
        if (toRtcNativeErrorIsTyped(error)) {
            binding.parent.firstTypedError ??= error;
        }
    }

    recordChannelObservation(
        binding: QRtcPeerConnection.ChannelObservationBinding,
        observation: RtcSignalingDiagnostics.NativeObservation
    ): void {
        this.publishNativeObservation(observation, this.nativeObservationBatch, binding.parent);
    }

    private startNativeObservation(pc: RTCPeerConnection): void {
        const scope = this.getNativeObservationScope();
        if (!scope) {
            return;
        }
        const admission = scope.allocate('pc');
        if (!admission.admitted) {
            this.nativeUnavailableReason = scope.getActive() ? 'admission-limit' : 'scope-disposed';
            return;
        }
        const binding = createRtcNativeBinding(pc, admission);
        this.nativeObservation = binding;
        for (
            const [event, trigger] of [
                ['iceconnectionstatechange', 'ice-connection'],
                ['icegatheringstatechange', 'ice-gathering'],
                ['signalingstatechange', 'signaling'],
                ['connectionstatechange', 'connection']
            ] as const
        ) {
            this.attachNativeListener(binding, pc, {
                event,
                listener: () => this.observeNativeState(binding, trigger),
                transport: false
            });
        }
        this.attachNativeListener(binding, pc, {
            event: 'icecandidateerror',
            listener: (event) => this.observeNativeError(binding, event, 'ice-candidate-error'),
            transport: false
        });
        this.bindNativeTransports(binding);
        if (!binding.retired && scope.consumeOrdinary()) {
            const native = this.captureNativeSnapshot(binding);
            if (!binding.retired) {
                this.publishNativeObservation(
                    {
                        ...this.nativeSignalIdentity(),
                        kind: 'native-lifetime',
                        action: 'created',
                        native
                    },
                    this.nativeObservationBatch,
                    binding
                );
            }
        }
    }

    private attachNativeListener(
        binding: QRtcPeerConnection.NativeBinding,
        target: EventTarget,
        input: QRtcPeerConnection.NativeListenerInput
    ): void {
        if (binding.retired) {
            return;
        }
        const listener = { target, event: input.event, listener: input.listener };
        const attached = attachRtcNativeListener(listener);
        if (binding.retired) {
            detachRtcNativeListeners([listener]);
            return;
        }
        if (attached) {
            (input.transport ? binding.transportDetach : binding.detach).push(listener);
            binding.errorWindowAttached ||= input.event === 'error' || input.event === 'icecandidateerror';
        }
        else {
            binding.listenerCoverage = 'partial';
        }
    }

    private bindNativeTransports(binding: QRtcPeerConnection.NativeBinding): void {
        if (binding.retired || binding.capturing) {
            return;
        }
        binding.capturing = true;
        try {
            const chain = readRtcTransportChain(binding.pc);
            if (binding.retired) {
                return;
            }
            binding.transportReason = chain.reason;
            if (chain.sctp === binding.sctp && chain.dtls === binding.dtls && chain.ice === binding.ice) {
                return;
            }
            detachRtcNativeListeners(binding.transportDetach.splice(0));
            if (binding.retired) {
                return;
            }
            binding.sctp = chain.sctp;
            binding.dtls = chain.dtls;
            binding.ice = chain.ice;
            binding.transportOrdinal++;
            binding.attachmentGap ||= readRtcTransportAttachmentGap(chain);
            for (
                const [target, trigger] of [[chain.sctp, 'sctp'], [chain.dtls, 'dtls'], [
                    chain.ice,
                    'ice-transport'
                ]] as const
            ) {
                if (target) {
                    this.attachNativeListener(binding, target, {
                        event: 'statechange',
                        listener: () => this.observeNativeState(binding, trigger),
                        transport: true
                    });
                }
            }
            if (chain.dtls) {
                this.attachNativeListener(binding, chain.dtls, {
                    event: 'error',
                    listener: (event) => this.observeNativeError(binding, event, 'dtls-error'),
                    transport: true
                });
            }
        }
        finally {
            binding.capturing = false;
        }
    }

    private observeNativeState(
        binding: QRtcPeerConnection.NativeBinding,
        trigger: RtcSignalingDiagnostics.NativeTrigger,
        nativeBatch: QRtcPeerConnection.NativeObservationBatch | undefined = this.nativeObservationBatch
    ): void {
        const scope = this.getNativeObservationScope();
        if (binding.retired || binding.capturing || !scope?.getActive()) {
            return;
        }
        if (!scope.getOrdinaryAvailable()) {
            scope.consumeOrdinary();
            return;
        }
        this.bindNativeTransports(binding);
        const native = this.captureNativeSnapshot(binding);
        const state = JSON.stringify(native.state);
        if (binding.retired || state === binding.lastState) {
            return;
        }
        binding.lastState = state;
        if (scope.consumeOrdinary()) {
            this.publishNativeObservation(
                { ...this.nativeSignalIdentity(), kind: 'native-state', trigger, native },
                nativeBatch,
                binding
            );
        }
    }

    private observeNativeError(
        binding: QRtcPeerConnection.NativeBinding,
        event: Event,
        source: RtcSignalingDiagnostics.NativeError['source']
    ): void {
        const scope = this.getNativeObservationScope();
        if (binding.retired || !scope?.getActive() || (binding.firstError && binding.firstTypedError)) {
            return;
        }
        const previousErrorCapture = binding.errorCapturing;
        binding.errorCapturing = true;
        let facts: RtcSignalingDiagnostics.NativeErrorFacts;
        try {
            facts = readRtcNativeEventError(event);
        }
        finally {
            binding.errorCapturing = previousErrorCapture;
        }
        const error = Object.freeze({
            ...facts,
            source,
            identity: binding.identity,
            nativeSequence: scope.nextSequence()
        });
        this.retainNativeError(binding, error);
    }

    private observeNativeOperationError(
        binding: QRtcPeerConnection.NativeBinding,
        caught: unknown,
        source: 'description-rejection' | 'candidate-rejection',
        nativeBatch: QRtcPeerConnection.NativeObservationBatch
    ): void {
        const scope = this.getNativeObservationScope();
        if (binding.retired || !scope?.getActive() || (binding.firstError && binding.firstTypedError)) {
            return;
        }
        const facts = this.readNativeErrorFacts(binding, caught);
        this.retainNativeError(
            binding,
            Object.freeze({ ...facts, source, identity: binding.identity, nativeSequence: scope.nextSequence() }),
            nativeBatch
        );
    }

    private readNativeErrorFacts(
        binding: QRtcPeerConnection.NativeBinding,
        caught: unknown
    ): RtcSignalingDiagnostics.NativeErrorFacts {
        const previousErrorCapture = binding.errorCapturing;
        binding.errorCapturing = true;
        try {
            return readRtcNativeErrorFacts(caught);
        }
        finally {
            binding.errorCapturing = previousErrorCapture;
        }
    }

    private retainNativeError(
        binding: QRtcPeerConnection.NativeBinding,
        error: RtcSignalingDiagnostics.NativeError,
        nativeBatch: QRtcPeerConnection.NativeObservationBatch | undefined = this.nativeObservationBatch
    ): void {
        if (binding.retired) {
            return;
        }
        const first = !binding.firstError;
        const typed = !binding.firstTypedError && toRtcNativeErrorIsTyped(error);
        binding.firstError ??= error;
        binding.typedReadUnavailableReason = readRtcTypedErrorUnavailableReason(
            error,
            binding.typedReadUnavailableReason
        );
        if (typed) {
            binding.firstTypedError = error;
        }
        if ((first || typed) && this.getNativeObservationScope()?.consumeOrdinary()) {
            const native = this.captureNativeSnapshot(binding);
            if (!binding.retired) {
                this.publishNativeObservation(
                    {
                        ...this.nativeSignalIdentity(),
                        kind: 'native-first-error',
                        first: first && typed ? 'both' : first ? 'observed' : 'typed',
                        error,
                        native
                    },
                    nativeBatch,
                    binding
                );
            }
        }
    }

    private captureNativeSnapshot(
        binding: QRtcPeerConnection.NativeBinding | undefined
    ): RtcSignalingDiagnostics.NativeSnapshot {
        const scope = this.getNativeObservationScope();
        const input = {
            binding,
            unavailableReason: this.getNativeUnavailableReason(),
            identity: binding?.identity ?? this.getNativeIdentity(),
            nativeSequence: scope?.nextSequence() ?? 0,
            capture: scope?.getCaptureStatus() ??
                Object.freeze({
                    scopeId: toRtcUnavailable(this.getNativeUnavailableReason()),
                    scope: 'unavailable' as const,
                    ordinaryRowsSuppressed: false,
                    admissionLimited: false,
                    payloadLimited: false
                }),
            readFailed: binding?.capturing ?? false
        };
        if (!binding || input.readFailed) {
            return readRtcNativeSnapshot(input);
        }
        binding.capturing = true;
        try {
            const native = readRtcNativeSnapshot(input);
            return binding.retired
                ? Object.freeze({ ...native, state: toRtcUnavailableNativeState('read-failed') })
                : native;
        }
        finally {
            binding.capturing = false;
        }
    }

    private captureNativeRetirement(
        binding: QRtcPeerConnection.NativeBinding | undefined,
        retirement: RtcSignalingDiagnostics.Retirement
    ): RtcSignalingDiagnostics.NativeObservation | undefined {
        if (!binding || binding.retired) {
            return undefined;
        }
        const captured = this.captureNativeSnapshot(binding);
        if (binding.retired) {
            return undefined;
        }
        binding.retired = true;
        const native = toRtcRetiredNativeSnapshot(captured);
        this.detachNativeObservation(binding);
        return this.getNativeObservationScope()?.consumeTerminal(binding.admission, 'final')
            ? Object.freeze({
                ...this.nativeSignalIdentity(),
                kind: 'native-lifetime',
                action: 'retiring',
                retirement,
                native
            })
            : undefined;
    }

    private detachNativeObservation(binding: QRtcPeerConnection.NativeBinding): void {
        binding.retired = true;
        detachRtcNativeListeners([...binding.detach.splice(0), ...binding.transportDetach.splice(0)]);
    }

    private nativeSignalIdentity(): RtcSignalingDiagnostics.SignalIdentity {
        return {
            localSessionId: this.input.sessionId,
            peerSessionId: this.input.peerSessionId,
            signalType: undefined,
            offerId: undefined
        };
    }

    private publishNativeObservation(
        observation: RtcSignalingDiagnostics.NativeObservation,
        batch: QRtcPeerConnection.NativeObservationBatch | undefined,
        binding: QRtcPeerConnection.NativeBinding
    ): void {
        const belongs = batch?.kind === 'synchronous' ||
            (binding === batch?.binding &&
                !(observation.kind === 'native-lifetime' && observation.action === 'retiring'));
        if (batch && !batch.closed && belongs) {
            batch.observations.push(Object.freeze({ binding, row: Object.freeze(observation) }));
        }
        else if (batch?.parent) {
            this.publishNativeObservation(observation, batch.parent, binding);
        }
        else {
            recordRtcNativeObservation(this.dependencies.signalingDiagnostics, Object.freeze(observation));
        }
    }

    private async applyLocalDescription(
        pc: RTCPeerConnection,
        nativeBatch: QRtcPeerConnection.NativeObservationBatch,
        description?: RTCLocalSessionDescriptionInit
    ): Promise<void> {
        const binding = this.nativeObservation?.pc === pc ? this.nativeObservation : undefined;
        try {
            await this.captureNativeInvocation(nativeBatch, () => pc.setLocalDescription(description));
            if (binding && !binding.retired) {
                this.observeNativeState(binding, 'transport-attached', nativeBatch);
            }
        }
        catch (caught) {
            if (binding) {
                this.observeNativeOperationError(binding, caught, 'description-rejection', nativeBatch);
            }
            throw caught;
        }
    }

    private async applyRemoteDescription(
        pc: RTCPeerConnection,
        description: RTCSessionDescriptionInit,
        nativeBatch: QRtcPeerConnection.NativeObservationBatch
    ): Promise<void> {
        const binding = this.nativeObservation?.pc === pc ? this.nativeObservation : undefined;
        try {
            await this.captureNativeInvocation(nativeBatch, () => pc.setRemoteDescription(description));
            if (binding && !binding.retired) {
                this.observeNativeState(binding, 'transport-attached', nativeBatch);
            }
        }
        catch (caught) {
            if (binding) {
                this.observeNativeOperationError(binding, caught, 'description-rejection', nativeBatch);
            }
            throw caught;
        }
    }

    private async handleNegotiationNeeded(pc: RTCPeerConnection): Promise<void> {
        if (this.status.pc !== pc) {
            return;
        }
        this.diagnostics.negotiationNeededCount++;
        const nativeBatch = this.createNativeOperationBatch();
        try {
            if (this.status.makingOffer || pc.signalingState !== 'stable') {
                this.diagnostics.negotiationSkippedCount++;
                return;
            }
            this.status.makingOffer = true;
            await this.applyLocalDescription(pc, nativeBatch);
            if (this.status.pc !== pc) {
                return;
            }
            const description = pc.localDescription;
            if (description?.type !== 'offer') {
                throw new Error('Native RTC offer was not created');
            }
            const offerId = this.dependencies.createOfferId();
            this.outstandingOfferId = offerId;
            this.diagnostics.offerCreatedCount++;
            await this.sendSignal(pc, {
                signalType: 'Offer',
                offerId,
                payload: {
                    description: { type: 'offer', sdp: description.sdp },
                    candidate: null
                }
            });
        }
        catch (caught) {
            if (this.status.pc === pc) {
                this.notifySignalingFailure(QRtcSignalingType.Offer, toError(caught));
            }
        }
        finally {
            if (this.status.pc === pc) {
                this.status.makingOffer = false;
            }
            this.endNativeObservationBatch(nativeBatch);
        }
    }

    private async handleIceCandidate(pc: RTCPeerConnection, event: RTCPeerConnectionIceEvent): Promise<void> {
        if (this.status.pc !== pc || !event.candidate) {
            return;
        }
        try {
            await this.sendSignal(pc, {
                signalType: 'IceCandidate',
                payload: { description: null, candidate: event.candidate }
            });
        }
        catch (caught) {
            if (this.status.pc === pc) {
                this.notifySignalingFailure(QRtcSignalingType.IceCandidate, toError(caught));
            }
        }
    }

    /**
     * The peer's own report that a hop is lost, carrying the transport's verdict on the message it
     * lost. A composition that registers no listener keeps only the diagnostic counters.
     */
    private notifySignalingFailure(signalType: QRtcSignalingType, error: Error): void {
        this.stateCallbacks.onSignalingFailed?.({
            peerSessionId: this.input.peerSessionId,
            signalType,
            admission: toQRtcSignalingAdmission(error),
            error
        });
    }

    private async notifyDataChannel(pc: RTCPeerConnection, event: RTCDataChannelEvent): Promise<void> {
        const nativeBatch = this.createNativeOperationBatch();
        try {
            for (const callback of this.onDataChannelCallbacks.values()) {
                if (this.status.pc !== pc) {
                    return;
                }
                try {
                    await this.captureNativeInvocation(nativeBatch, () => callback(event));
                }
                catch (caught) {
                    console.error('RTC data-channel callback failed', toError(caught));
                }
            }
        }
        finally {
            this.endNativeObservationBatch(nativeBatch);
        }
    }

    private async notifyTrack(pc: RTCPeerConnection, event: RTCTrackEvent): Promise<void> {
        if (this.status.pc !== pc) {
            return;
        }
        const stream = event.streams[0];
        if (stream) {
            this.status.remoteStreams.set(stream.id, stream);
            for (const callback of this.onRemoteStreamCallbacks.values()) {
                if (this.status.pc !== pc) {
                    return;
                }
                try {
                    await callback(stream, event);
                }
                catch (caught) {
                    console.error('RTC remote-stream callback failed', toError(caught));
                }
            }
        }
        for (const callback of this.onTrackCallbacks.values()) {
            if (this.status.pc !== pc) {
                return;
            }
            try {
                await callback(event);
            }
            catch (caught) {
                console.error('RTC track callback failed', toError(caught));
            }
        }
    }

    private setupStateChangeCallbacks(pc: RTCPeerConnection, callbacks: QRtcPeerConnection.StateCallbacks) {
        pc.onconnectionstatechange = () => {
            if (this.status.pc !== pc) {
                return;
            }
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

    async handleSignal(signal: QRtcSignal): Promise<void> {
        const nativeBatch = this.createNativeOperationBatch();
        const pc = this.status.pc;
        const binding = this.nativeObservation?.pc === pc ? this.nativeObservation : undefined;
        const capture: QRtcPeerConnection.SignalCapture = { pc, nativeIdentity: this.getNativeIdentity(), nativeBatch };
        const application = this.signalingChain
            .then(async () => {
                if (!pc || this.status.pc !== pc) {
                    this.observeNativeSignal(pc ? 'retired-before-application' : 'no-native-peer', capture, signal);
                    return;
                }
                this.observeNativeSignal('application-started', capture, signal);
                try {
                    await this.processSignal({ ...capture, pc }, signal);
                    if (binding && !binding.retired) {
                        this.observeNativeState(binding, 'transport-attached', nativeBatch);
                    }
                    this.observeNativeSignal('application-returned', capture, signal);
                }
                catch (caught) {
                    this.observeNativeSignal('application-threw', capture, signal);
                    throw caught;
                }
            });
        const lifetime = this.signalingLifetime.signal;
        const run = new Promise<RtcSignalingDiagnostics.CallerRelease>((resolve, reject) => {
            const retire = () => resolve('lifetime-retired');
            lifetime.addEventListener('abort', retire, { once: true });
            void application.then(() => resolve('application-returned'), reject).then(() => {
                lifetime.removeEventListener('abort', retire);
            });
        });
        this.signalingChain = run.catch((caught) => {
            this.diagnostics.inboundSignalingErrorCount++;
            console.error('Signaling chain error', toError(caught));
        });
        try {
            const release = await run;
            this.observeCallerRelease(release, capture, signal);
        }
        catch (caught) {
            this.observeCallerRelease('application-threw', capture, signal);
            throw caught;
        }
        finally {
            this.endNativeObservationBatch(nativeBatch);
        }
    }

    private observeNativeSignal(
        disposition: RtcSignalingDiagnostics.NativeDisposition,
        capture: QRtcPeerConnection.SignalCapture,
        signal: QRtcSignal
    ): void {
        const pc = capture.pc;
        recordRtcSignalingObservation(this.dependencies.signalingDiagnostics, {
            kind: 'native-signal-decision',
            disposition,
            localSessionId: this.input.sessionId,
            peerSessionId: this.input.peerSessionId,
            signalType: signal.signalType,
            offerId: signal.signalType === 'IceCandidate' ? undefined : signal.offerId,
            nativeIdentity: capture.nativeIdentity,
            capturedPeerConnection: pc !== undefined,
            currentPeerConnection: pc === undefined ? undefined : this.status.pc === pc,
            offerMatches: undefined,
            signalingState: undefined
        });
    }

    private observeCallerRelease(
        disposition: RtcSignalingDiagnostics.CallerRelease,
        capture: QRtcPeerConnection.SignalCapture,
        signal: QRtcSignal
    ): void {
        const pc = capture.pc;
        recordRtcSignalingObservation(this.dependencies.signalingDiagnostics, {
            kind: 'signal-caller-release',
            disposition,
            localSessionId: this.input.sessionId,
            peerSessionId: this.input.peerSessionId,
            signalType: signal.signalType,
            offerId: signal.signalType === 'IceCandidate' ? undefined : signal.offerId,
            nativeIdentity: capture.nativeIdentity,
            capturedPeerConnection: pc !== undefined,
            currentPeerConnection: pc === undefined ? undefined : this.status.pc === pc
        });
    }

    private async processSignal(capture: QRtcPeerConnection.NativeSignalCapture, signal: QRtcSignal): Promise<void> {
        if (signal.signalType === QRtcSignalingType.Answer) {
            await this.handleAnswer(capture, signal);
        }
        else if (signal.signalType === QRtcSignalingType.Offer) {
            await this.handleOffer(capture, signal);
        }
        else {
            await this.handleInboundIceCandidate(capture, signal);
        }
    }

    private async handleAnswer(
        capture: QRtcPeerConnection.NativeSignalCapture,
        signal: Extract<QRtcSignal, { signalType: 'Answer'; }>
    ): Promise<void> {
        const pc = capture.pc;
        this.diagnostics.inboundAnswerCount++;
        const currentPeerConnection = this.status.pc === pc;
        const offerMatches = signal.offerId === this.outstandingOfferId;
        const signalingState = pc.signalingState;
        if (!currentPeerConnection || !offerMatches || signalingState !== 'have-local-offer') {
            this.diagnostics.staleAnswerIgnoredCount++;
            recordRtcSignalingObservation(this.dependencies.signalingDiagnostics, {
                kind: 'native-signal-decision',
                disposition: 'answer-ineligible',
                localSessionId: this.input.sessionId,
                peerSessionId: this.input.peerSessionId,
                signalType: signal.signalType,
                offerId: signal.offerId,
                nativeIdentity: capture.nativeIdentity,
                capturedPeerConnection: true,
                currentPeerConnection,
                offerMatches,
                signalingState
            });
            return;
        }
        await this.applyRemoteDescription(pc, signal.payload.description, capture.nativeBatch);
        this.observeNativeSignal('remote-description-returned', capture, signal);
        if (this.status.pc !== pc) {
            this.observeNativeSignal('retired-after-remote-description', capture, signal);
            return;
        }
        this.outstandingOfferId = undefined;
        await this.flushIceCandidates(pc, capture.nativeBatch);
        if (this.status.pc !== pc) {
            this.observeNativeSignal('retired-after-ice-flush', capture, signal);
            return;
        }
        this.status.makingOffer = false;
        this.status.ignoreOffer = false;
    }

    private async handleOffer(
        capture: QRtcPeerConnection.NativeSignalCapture,
        signal: Extract<QRtcSignal, { signalType: 'Offer'; }>
    ): Promise<void> {
        const pc = capture.pc;
        this.diagnostics.inboundOfferCount++;
        const collision = this.status.makingOffer || pc.signalingState !== 'stable';
        if (collision) {
            this.diagnostics.offerCollisionCount++;
        }
        this.status.ignoreOffer = !this.input.isPolite && collision;
        if (this.status.ignoreOffer) {
            this.diagnostics.ignoredOfferCollisionCount++;
            this.observeNativeSignal('impolite-offer-ignored', capture, signal);
            return;
        }
        if (collision) {
            this.diagnostics.politeOfferRollbackCount++;
            this.outstandingOfferId = undefined;
            await Promise.all([
                this.applyLocalDescription(pc, capture.nativeBatch, { type: 'rollback' }),
                this.applyRemoteDescription(pc, signal.payload.description, capture.nativeBatch)
            ]);
            this.observeNativeSignal('rollback-and-remote-description-returned', capture, signal);
        }
        else {
            await this.applyRemoteDescription(pc, signal.payload.description, capture.nativeBatch);
            this.observeNativeSignal('remote-description-returned', capture, signal);
        }
        if (this.status.pc !== pc) {
            this.observeNativeSignal('retired-after-remote-description', capture, signal);
            return;
        }
        await this.flushIceCandidates(pc, capture.nativeBatch);
        if (this.status.pc !== pc) {
            this.observeNativeSignal('retired-after-ice-flush', capture, signal);
            return;
        }
        await this.applyLocalDescription(pc, capture.nativeBatch);
        this.observeNativeSignal('local-answer-description-returned', capture, signal);
        if (this.status.pc !== pc) {
            this.observeNativeSignal('retired-after-local-description', capture, signal);
            return;
        }
        this.status.makingOffer = false;
        this.status.ignoreOffer = false;
        await this.sendAnswer(pc, signal.offerId);
    }

    private async flushIceCandidates(
        pc: RTCPeerConnection,
        nativeBatch: QRtcPeerConnection.NativeObservationBatch
    ): Promise<void> {
        const binding = this.nativeObservation?.pc === pc ? this.nativeObservation : undefined;
        const operationOrdinal = binding ? ++this.nativeOperationOrdinal : 0;
        await flushRtcIceCandidateQueue({
            readCandidateError: binding ? (caught) => this.readNativeErrorFacts(binding, caught) : undefined,
            onCandidateObservation: binding
                ? (observation) =>
                    this.observeCandidateApplication(
                        { binding, operationOrdinal, source: 'queue-drain', nativeBatch },
                        observation
                    )
                : undefined,
            queue: this.status.iceCandidateQueue,
            peerConnection: {
                addIceCandidate: (candidate) =>
                    this.captureNativeInvocation(nativeBatch, () => pc.addIceCandidate(candidate))
            },
            onCandidateAdded: () => {
                if (this.status.pc === pc) {
                    this.diagnostics.addedIceCandidateCount++;
                    this.diagnostics.flushedIceCandidateCount++;
                }
            }
        });
    }

    /**
     * The answer is the inbound chain's only outbound hop, and losing it strands the offerer in
     * `have-local-offer` exactly as a lost offer does -- so it reports like one, and still rejects,
     * because the inbound chain owns the log and the counter for what it could not complete.
     */
    private async sendAnswer(pc: RTCPeerConnection, offerId: string): Promise<void> {
        try {
            const description = pc.localDescription;
            if (description?.type !== 'answer') {
                throw new Error('Native RTC answer was not created');
            }
            await this.sendSignal(pc, {
                signalType: 'Answer',
                offerId,
                payload: {
                    description: { type: 'answer', sdp: description.sdp },
                    candidate: null
                }
            });
        }
        catch (caught) {
            if (this.status.pc === pc) {
                this.notifySignalingFailure(QRtcSignalingType.Answer, toError(caught));
            }
            throw caught;
        }
    }

    private async handleInboundIceCandidate(
        capture: QRtcPeerConnection.NativeSignalCapture,
        signal: Extract<QRtcSignal, { signalType: 'IceCandidate'; }>
    ): Promise<void> {
        const pc = capture.pc;
        this.diagnostics.inboundIceCandidateCount++;
        if (this.status.ignoreOffer) {
            this.diagnostics.ignoredIceCandidateForIgnoredOfferCount++;
            this.observeNativeSignal('ice-ignored', capture, signal);
            return;
        }
        try {
            if (pc.remoteDescription?.type) {
                await this.applyNativeCandidate(pc, signal.payload.candidate, capture.nativeBatch);
                this.observeNativeSignal('ice-added', capture, signal);
                if (this.status.pc === pc) {
                    this.diagnostics.addedIceCandidateCount++;
                }
            }
            else {
                this.status.iceCandidateQueue.push(signal.payload.candidate);
                this.diagnostics.queuedIceCandidateCount++;
                this.observeNativeSignal('ice-queued', capture, signal);
            }
        }
        catch (caught) {
            const error = toError(caught);
            if (this.status.pc === pc && !this.status.ignoreOffer) {
                throw error;
            }
        }
    }

    private async applyNativeCandidate(
        pc: RTCPeerConnection,
        candidate: RTCIceCandidateInit,
        nativeBatch: QRtcPeerConnection.NativeObservationBatch
    ): Promise<void> {
        const binding = this.nativeObservation?.pc === pc ? this.nativeObservation : undefined;
        const operation = binding
            ? { binding, operationOrdinal: ++this.nativeOperationOrdinal, source: 'direct' as const, nativeBatch }
            : undefined;
        let submitted = false;
        try {
            const addition = this.captureNativeInvocation(nativeBatch, () => pc.addIceCandidate(candidate));
            submitted = true;
            if (operation) {
                this.observeCandidateApplication(operation, { candidate, index: 0, stage: 'submitted' });
            }
            await addition;
        }
        catch (caught) {
            if (operation && !submitted) {
                this.observeCandidateApplication(operation, { candidate, index: 0, stage: 'submitted' });
            }
            if (operation) {
                this.observeCandidateApplication(operation, {
                    candidate,
                    index: 0,
                    stage: 'rejected',
                    error: this.readNativeErrorFacts(operation.binding, caught)
                });
            }
            throw caught;
        }
        if (operation) {
            this.observeCandidateApplication(operation, { candidate, index: 0, stage: 'returned' });
        }
    }

    private observeCandidateApplication(
        operation: QRtcPeerConnection.CandidateOperation,
        observation: FlushRtcIceCandidateQueueObservation
    ): void {
        const scope = this.getNativeObservationScope();
        if (scope?.getActive() && observation.stage === 'rejected') {
            this.retainNativeError(
                operation.binding,
                Object.freeze({
                    ...observation.error,
                    source: 'candidate-rejection',
                    identity: operation.binding.identity,
                    nativeSequence: scope.nextSequence()
                }),
                operation.nativeBatch
            );
        }
        if (!scope?.consumeOrdinary()) {
            return;
        }
        const fragments = readRtcCandidateFragments(observation.candidate, {
            ice: operation.binding.ice,
            reason: operation.binding.transportReason
        });
        const candidate = toRtcCandidateApplication({
            operation,
            observation,
            fragments,
            currentPeerConnection: this.status.pc === operation.binding.pc,
            nativeSequence: scope.nextSequence(),
            capture: scope.getCaptureStatus()
        });
        this.publishNativeObservation(
            {
                ...this.nativeSignalIdentity(),
                signalType: 'IceCandidate',
                kind: 'native-candidate-application',
                candidate
            },
            operation.nativeBatch,
            operation.binding
        );
    }

    async handleReconnect(): Promise<void> {
        const pc = this.status.pc;
        if (!pc) {
            return;
        }
        if (this.status.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            this.diagnostics.reconnectExhaustedCount++;
            console.warn(`RTC reconnect exhausted after ${this.status.reconnectAttempts} attempts`);
            this.reset();
            return;
        }
        if (this.status.reconnectTimer) {
            this.diagnostics.reconnectTimerAlreadyActiveCount++;
            return;
        }
        this.status.reconnectAttempts++;
        this.diagnostics.reconnectAttemptCount++;
        const delay = Math.pow(2, this.status.reconnectAttempts) * 1000;
        this.status.reconnectTimer = setTimeout(() => this.restartIceAfterBackoff(pc), delay);
    }

    private restartIceAfterBackoff(pc: RTCPeerConnection): void {
        if (this.status.pc !== pc) {
            return;
        }
        this.status.reconnectTimer = undefined;
        this.signalingChain = this.signalingChain.then(() => {
            if (this.status.pc !== pc) {
                return;
            }
            if (this.isConnectedOrInProgress(pc)) {
                this.diagnostics.iceRestartSkippedConnectedCount++;
                this.status.reconnectAttempts = 0;
                return;
            }
            pc.restartIce();
            this.diagnostics.iceRestartCount++;
        }).catch((caught) => {
            console.error('Error during reconnect:', toError(caught));
        });
    }

    private isConnectedOrInProgress(pc: RTCPeerConnection | undefined): boolean {
        return pc !== undefined && (
            pc.connectionState === 'connected' ||
            pc.connectionState === 'connecting' ||
            pc.connectionState === 'new'
        );
    }

    private async sendSignal(pc: RTCPeerConnection, signal: QRtcSignal): Promise<void> {
        const message = {
            channel: QRtcSignalingChannel.RtcSignal,
            type: QRtcSignalingMsgType.Signal,
            fromId: this.input.sessionId,
            toId: this.input.peerSessionId,
            sessionId: this.input.sessionId,
            token: this.input.token,
            ...signal
        };

        const run = this.outboundSignalingChain
            .then(async () => {
                if (this.status.pc !== pc) {
                    return;
                }
                this.recordOutboundSignal(signal.signalType);
                await this.signaler.send(message);
            });

        // The chain must stay settled for the next signal; the caller awaiting `run` still receives
        // the rejection and reports it, so this end of it only records the count.
        this.outboundSignalingChain = run.catch(() => {
            this.diagnostics.outboundSignalingErrorCount++;
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
                if (this.status.pc !== pc) {
                    return;
                }
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

        this.status.localStream = stream;

        // Add or replace tracks per kind (audio/video). ReplaceTrack supports device switching.
        for (const track of stream.getTracks()) {
            const key = track.kind;
            const sender = this.status.localSenders.get(key);

            if (sender) {
                await sender.replaceTrack(track);
                if (this.status.pc !== pc) {
                    return;
                }
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

        for (const track of stream.getAudioTracks()) {
            track.enabled = enabled;
        }
    }

    setLocalVideoEnabled(enabled: boolean): void {
        const stream = this.status.localStream;
        if (!stream) {
            return;
        }

        for (const track of stream.getVideoTracks()) {
            track.enabled = enabled;
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

        for (const track of tracks) {
            try {
                track.stop();
            }
            catch {
                // ignore
            }
        }
    }

    applyMediaPolicy(policy: QRtcMediaPolicy): void {
        this.status.mediaPolicy = policy;
        const pc = this.status.pc;
        if (pc) {
            applyRtcMediaPolicy(pc, policy);
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
