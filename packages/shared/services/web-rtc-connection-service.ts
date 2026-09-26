import { IceConfig, PeerId } from '../api/api-config.ts';
import { AsyncCommand, type AsyncCommandTimeoutEvent } from '../cache/AsyncCommand.ts';
import { PullPushCommand } from '../cache/PullPushCommand.ts';
import { Either } from '../resilience/Either.ts';
import { toError } from '../resilience/to-error.ts';
import type { TransportFaultPort } from '../transport-faults/transport-fault-port.ts';
import {
    decodeRtcSignal,
    decodeRtcSignalingEnvelope
} from '../webrtc/decode-rtc-signaling-message.ts';
import {
    QRtcDataChannel,
    type RtcDataChannelFlowControlPolicy,
    type RtcDataChannelHealth
} from '../webrtc/qrtc-data-channel.ts';
import { QRtcMediaChannel } from '../webrtc/qrtc-media-channel.ts';
import { QRtcPeerConnection } from '../webrtc/qrtc-peer-connection.ts';
import {
    QRtcSignalingMessage,
    QRtcSignalingTransport,
    QRtcSignalingTransportCallbacks,
    QRtcSignalingType
} from '../webrtc/qrtc-signaling-contracts.ts';
import { RtcPeerConnectionAttemptBudget } from './rtc-peer-connection-attempt-budget.ts';
import { toPeerLaneOpenResultFromError, waitForRtcPeerLane } from './wait-for-rtc-peer-lane.ts';

export const DEFAULT_WEB_RTC_PEER_ESTABLISHMENT_TIMEOUT_POLICY: WebRtcConnectionService.PeerEstablishmentTimeoutPolicy =
    {
        enabled: false,
        timeoutMs: 30_000
    };

export const DEFAULT_WEB_RTC_PEER_CONNECTION_ATTEMPT_BUDGET_POLICY:
    WebRtcConnectionService.PeerConnectionAttemptBudgetPolicy = {
        enabled: false,
        maxAttempts: 6,
        maxTotalDurationMs: 180_000,
        cooldownMs: 30_000
    };

export const DEFAULT_WEB_RTC_MAX_PEER_CONNECTIONS = 10;
export const RTC_CONNECT_ATTEMPT_BUDGET_EXHAUSTED_REASON = 'rtc-connect-attempt-budget-exhausted';

export interface RtcDataChannelLaneConfig {
    readonly id: string;
    readonly label: string;
    readonly init?: RTCDataChannelInit;
    readonly binaryType?: BinaryType;
    readonly flowControl?: RtcDataChannelFlowControlPolicy;
}

export const DEFAULT_RTC_DATA_CHANNEL_LANE_ID = 'reliable';

export interface RtcPeerChannelHealth {
    readonly peerId: PeerId;
    readonly laneId: string;
    readonly channel: RtcDataChannelHealth;
}

export interface RtcPeerHealth {
    readonly peerId: PeerId;
    readonly channels: readonly RtcPeerChannelHealth[];
}

type ComputedPeerConnection = Readonly<
    | {
        decision: 'use-peer';
        peer: WebRtcConnectionService.Peer;
        shouldConnect: boolean;
        outcome: WebRtcConnectionService.PeerConnectionEnsureOutcome;
    }
    | {
        decision: 'deny';
        reason?: string;
    }
>;

type UsablePeerConnection = Extract<ComputedPeerConnection, { decision: 'use-peer'; }>;

interface PeerEntry {
    readonly peer: WebRtcConnectionService.Peer;
    /** Replaced exactly once, when the setup first reports established. */
    setup: WebRtcConnectionService.PeerSetup;
}

interface PeerCreationAdmission {
    readonly allowed: boolean;
    readonly reason?: string;
    readonly retryInboundSignal?: true;
}

class WebRtcPeerConnectionAttemptExhaustedError extends Error {
    public readonly event: WebRtcConnectionService.PeerConnectionAttemptExhaustedEvent;

    constructor(
        event: WebRtcConnectionService.PeerConnectionAttemptExhaustedEvent
    ) {
        super(RTC_CONNECT_ATTEMPT_BUDGET_EXHAUSTED_REASON);
        this.event = event;
        this.name = 'WebRtcPeerConnectionAttemptExhaustedError';
    }
}

export namespace WebRtcConnectionService {
    export interface Peer {
        peerId: PeerId;
        connection: QRtcPeerConnection;
        channel: QRtcDataChannel;
        channels: ReadonlyMap<string, QRtcDataChannel>;
        media: QRtcMediaChannel;
    }

    export interface Dependencies extends QRtcPeerConnection.Dependencies {
        readonly faultPort: TransportFaultPort;
    }

    export interface InputDto {
        readonly sessionId: string;
        readonly token: string;
        readonly iceCandidates: IceConfig;
        readonly dataChannelName: string;
        readonly dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
        readonly rtcSignalingTopicId: string;
        readonly peerEstablishmentTimeout?: PeerEstablishmentTimeoutPolicy;
        readonly peerConnectionAttemptBudget?: PeerConnectionAttemptBudgetPolicy;
        readonly maxPeerConnections?: number;
    }

    export interface PeerEstablishmentTimeoutPolicy {
        readonly enabled: boolean;
        readonly timeoutMs: number;
    }

    export interface PeerEstablishmentTimeoutEvent {
        readonly peerId: PeerId;
        readonly timeoutMs: number;
        readonly startedAtEpochMs: number;
        readonly timedOutAtEpochMs: number;
        readonly reason: 'peer-establishment-timeout';
    }

    export interface PeerConnectionAttemptBudgetPolicy {
        readonly enabled: boolean;
        readonly maxAttempts: number;
        readonly maxTotalDurationMs: number;
        readonly cooldownMs: number;
    }

    export interface PeerConnectionAttemptDiagnostics {
        readonly peerId: PeerId;
        readonly attempts: number;
        readonly firstAttemptAtEpochMs: number;
        readonly lastAttemptAtEpochMs: number;
        readonly maxAttempts: number;
        readonly maxTotalDurationMs: number;
        readonly cooldownMs: number;
        readonly exhaustedAtEpochMs?: number;
        readonly retryAfterEpochMs?: number;
    }

    export interface PeerConnectionAttemptExhaustedEvent extends PeerConnectionAttemptDiagnostics {
        exhaustedAtEpochMs: number;
        retryAfterEpochMs: number;
        readonly reason: 'peer-connection-attempt-budget-exhausted';
    }

    export interface PeerConnectionAttemptBudgetDiagnostics {
        readonly consumedCount: number;
        readonly resetOnSuccessCount: number;
        readonly resetOnRemovalCount: number;
        readonly cooldownExpiredClearCount: number;
        readonly exhaustedCount: number;
    }

    export interface PeerSetupInFlight {
        readonly phase: 'in-flight';
        readonly peerId: PeerId;
        readonly startedAtEpochMs: number;
    }

    export interface PeerSetupEstablished {
        readonly phase: 'established';
        readonly peerId: PeerId;
        readonly startedAtEpochMs: number;
        readonly establishedAtEpochMs: number;
    }

    /**
     * One RTC setup: from the native connection attempt this service started
     * until the peer first reports open (product decision 18). A later repair
     * cycle on the same peer is the connection's own reconnect state, never a
     * second setup; removal ends the setup whether or not it was established.
     */
    export type PeerSetup =
        | PeerSetupInFlight
        | PeerSetupEstablished;

    export type PeerConnectionEnsureOutcome =
        | 'setup-started'
        | 'setup-in-flight'
        | 'setup-established';

    export interface PeerConnectionEnsured {
        readonly peer: WebRtcConnectionService.Peer;
        readonly outcome: PeerConnectionEnsureOutcome;
    }

    export type PeerConnectionLeft = Readonly<
        | {
            kind: 'self';
            peerId: PeerId;
        }
        | {
            kind: 'dial-denied';
            peerId: PeerId;
            reason?: string;
        }
        | {
            kind: 'connect-failed';
            peerId: PeerId;
            error: Error;
            /** True when this call created the peer and the same failure ended its setup. */
            startedSetup: boolean;
        }
        | {
            kind: 'connect-exhausted';
            peerId: PeerId;
            event: PeerConnectionAttemptExhaustedEvent;
            error: Error;
        }
        | {
            kind: 'signal-handle-failed';
            peerId: PeerId;
            error: Error;
        }
    >;

    export type PeerConnectionResult = Either<PeerConnectionLeft, PeerConnectionEnsured>;

    export type PeerLaneOpenStatus =
        | 'open'
        | 'timeout'
        | 'aborted'
        | 'self'
        | 'connect-failed'
        | 'exhausted'
        | 'no-peer'
        | 'no-lane'
        | 'closed'
        | 'failed';

    export interface PeerLaneOpenOptions {
        readonly isInitiator?: boolean;
        readonly timeoutMs?: number;
        readonly signal?: AbortSignal;
        readonly cleanupOnFailure?: boolean;
    }

    export interface PeerLaneOpenResult {
        readonly status: PeerLaneOpenStatus;
        readonly peerId: PeerId;
        readonly laneId: string;
        readonly peer?: WebRtcConnectionService.Peer;
        readonly channel?: QRtcDataChannel;
        readonly error?: Error;
    }

    export interface RemovePeerOptions {
        readonly resetAttemptBudget?: boolean;
    }

    export type PeerCreationDecision =
        | boolean
        | 'allow'
        | 'deny'
        | Readonly<{
            decision: 'allow' | 'deny';
            reason?: string;
        }>;

    export type InboundPeerCreationDecision =
        | PeerCreationDecision
        | Readonly<{
            decision: 'retry';
            reason?: string;
        }>;

    export interface PeerLifecycleCallback {
        onCreated(peer: WebRtcConnectionService.Peer): void;

        onDeleted(peer: WebRtcConnectionService.Peer): void;

        onEstablished?(
            peer: WebRtcConnectionService.Peer,
            setup: PeerSetupEstablished
        ): void;

        onConnectTimeout?(
            peer: WebRtcConnectionService.Peer,
            event: PeerEstablishmentTimeoutEvent
        ): void;

        onConnectExhausted?(
            event: PeerConnectionAttemptExhaustedEvent
        ): void;

        /** A signal the peer could not hand to the transport; a lost offer strands that peer. */
        onSignalingFailed?(peer: WebRtcConnectionService.Peer, failure: QRtcPeerConnection.SignalingFailure): void;
    }

    export interface InboundPeerCreationPolicyInput {
        readonly peerId: PeerId;
        readonly signalType: QRtcSignalingMessage['signalType'];
        readonly message: QRtcSignalingMessage;
    }

    export type InboundPeerCreationPolicy = (
        input: InboundPeerCreationPolicyInput
    ) => InboundPeerCreationDecision;

    export interface OutboundDialPolicyInput {
        readonly peerId: PeerId;
    }

    export type OutboundDialPolicy = (
        input: OutboundDialPolicyInput
    ) => PeerCreationDecision;
}

export class WebRtcConnectionService {
    private static readonly PEER_ESTABLISHMENT_CALLBACK_ID = 'web-rtc-connection-service:peer-establishment';

    private readonly onRtcPeerLifecycleCallbacks: Map<string, WebRtcConnectionService.PeerLifecycleCallback> =
        new Map();

    private readonly peerEntryByPeerId = new Map<PeerId, PeerEntry>();
    private readonly peerEstablishmentWatchdog = new AsyncCommand<PeerId, WebRtcConnectionService.Peer>();
    private readonly attemptBudget = new RtcPeerConnectionAttemptBudget({
        readPolicy: () => this.peerConnectionAttemptBudgetPolicy(),
        onExhausted: (event) =>
            this.notifyPeerLifecycle('onConnectExhausted', (callback) => callback.onConnectExhausted?.(event))
    });

    private inboundPeerCreationPolicy: WebRtcConnectionService.InboundPeerCreationPolicy | undefined;
    private outboundDialPolicy: WebRtcConnectionService.OutboundDialPolicy | undefined;

    public readonly signaler: QRtcSignalingTransport;
    public readonly input: WebRtcConnectionService.InputDto;
    private readonly dependencies: WebRtcConnectionService.Dependencies;

    constructor(
        signaler: QRtcSignalingTransport,
        input: WebRtcConnectionService.InputDto,
        dependencies: WebRtcConnectionService.Dependencies
    ) {
        this.signaler = signaler;
        this.input = input;
        this.dependencies = dependencies;
    }

    setInboundPeerCreationPolicy(
        policy?: WebRtcConnectionService.InboundPeerCreationPolicy
    ): WebRtcConnectionService {
        this.inboundPeerCreationPolicy = policy;
        return this;
    }

    setOutboundDialPolicy(
        policy?: WebRtcConnectionService.OutboundDialPolicy
    ): WebRtcConnectionService {
        this.outboundDialPolicy = policy;
        return this;
    }

    peerConnectionAttemptDiagnostics(
        peerId: PeerId
    ): WebRtcConnectionService.PeerConnectionAttemptDiagnostics | undefined {
        return this.attemptBudget.readPeer(peerId);
    }

    readPeerConnectionAttemptBudgetDiagnostics(): WebRtcConnectionService.PeerConnectionAttemptBudgetDiagnostics {
        return this.attemptBudget.readDiagnostics();
    }

    onRtcPeerLifecycleDo(id: string, cb: WebRtcConnectionService.PeerLifecycleCallback): WebRtcConnectionService {
        this.onRtcPeerLifecycleCallbacks.set(id, cb);
        return this;
    }

    removeRtcPeerLifecycleById(id: string): boolean {
        return this.onRtcPeerLifecycleCallbacks.delete(id);
    }

    removePeerIfPresent(
        peerId: string,
        options: WebRtcConnectionService.RemovePeerOptions = {}
    ): boolean {
        console.log(`Cleaning up peer: ${peerId}`);
        const entry = this.peerEntryByPeerId.get(peerId);
        if (entry === undefined) {
            console.log(`Peer ${peerId} not found. Ignoring`);
            if (options.resetAttemptBudget !== false) {
                this.attemptBudget.clear(peerId, 'removal');
            }
            return false;
        }

        if (options.resetAttemptBudget !== false) {
            this.attemptBudget.clear(peerId, 'removal');
        }
        this.releasePeer(entry.peer);

        this.notifyPeerLifecycle('onDeleted', (callback) => callback.onDeleted(entry.peer));
        return true;
    }

    private releasePeer(peer: WebRtcConnectionService.Peer): void {
        this.clearPeerEstablishmentTimeout(peer.peerId);
        this.peerEntryByPeerId.delete(peer.peerId);
        peer.media.reset();
        for (const channel of peer.channels.values()) {
            channel.removeRtcCallbackById(
                WebRtcConnectionService.PEER_ESTABLISHMENT_CALLBACK_ID
            );
            channel.reset();
        }
        peer.connection.reset();
    }

    async connectSignaler(): Promise<WebRtcConnectionService> {
        await this.signaler.connect(
            {
                sessionId: this.input.sessionId,
                token: this.input.token,
                callbacks: this.toSignalingProtocol()
            }
        );

        return this;
    }

    peerIdsWithNoReconnectableLanes(): readonly string[] {
        return this.livePeers()
            .filter((peer) => !this.hasReconnectableDataChannels(peer))
            .map((peer) => peer.peerId);
    }

    knownPeerIds(): readonly string[] {
        return Array.from(this.peerEntryByPeerId.keys());
    }

    activePeerIds(): readonly string[] {
        return this.livePeers().map((peer) => peer.peerId);
    }

    readyPeerIdsForLane(
        laneId: string = DEFAULT_RTC_DATA_CHANNEL_LANE_ID
    ): readonly string[] {
        return this.livePeers()
            .filter((peer) => peer.channels.get(laneId)?.readHealth().readyState === 'open')
            .map((peer) => peer.peerId);
    }

    /** Peers whose setup has started and not yet established, on a native connection that is still alive. */
    inFlightPeerIds(): readonly string[] {
        return Array.from(this.peerEntryByPeerId.values())
            .filter((entry) =>
                entry.setup.phase === 'in-flight' &&
                this.isPeerConnectedOrInProgress(entry.peer)
            )
            .map((entry) => entry.peer.peerId);
    }

    readPeer(peerId: string): WebRtcConnectionService.Peer | undefined {
        return this.peerEntryByPeerId.get(peerId)?.peer;
    }

    readPeerChannel(
        peerId: string,
        laneId: string = DEFAULT_RTC_DATA_CHANNEL_LANE_ID
    ): QRtcDataChannel | undefined {
        return this.readPeer(peerId)?.channels.get(laneId);
    }

    readPeerHealth(peerId: string): RtcPeerHealth | undefined {
        const peer = this.readPeer(peerId);
        if (!peer) {
            return undefined;
        }

        return {
            peerId,
            channels: Array.from(peer.channels.entries())
                .map(([laneId, channel]) => ({
                    peerId,
                    laneId,
                    channel: channel.readHealth()
                }))
        };
    }

    readAllPeerHealth(): readonly RtcPeerHealth[] {
        return Array.from(this.peerEntryByPeerId.keys())
            .map((peerId) => this.readPeerHealth(peerId))
            .filter((health): health is RtcPeerHealth => health !== undefined);
    }

    disconnectPeer(peerId: string, options: WebRtcConnectionService.RemovePeerOptions = {}): boolean {
        return this.removePeerIfPresent(peerId, options);
    }

    private toSignalingProtocol(): QRtcSignalingTransportCallbacks {
        return {
            onOpen: async () => {},
            onClose: async () => {},
            onError: async () => {
                console.error('Signaling transport error');
            },
            onMessage: async (sessionId, _token, message) => {
                if (this.input.sessionId !== sessionId) {
                    throw new Error('Message received for wrong session id');
                }
                const signal = decodeRtcSignalingEnvelope(message);
                if (signal.left) {
                    throw new TypeError(signal.left.message);
                }
                if (signal.right) {
                    return await this.receiveSignal(signal.right);
                }
            }
        };
    }

    private async receiveSignal(message: QRtcSignalingMessage): Promise<void | 'retry'> {
        const peerId = message.fromId;
        if (message.toId !== this.input.sessionId || peerId === this.input.sessionId) {
            return;
        }
        const entry = this.reuseOrRemovePeer(peerId);
        if (entry) {
            await entry.peer.connection.handleSignal(message);
            return;
        }
        const admission = this.shouldCreatePeerFromInboundSignal(peerId, message);
        if (!admission.allowed) {
            return admission.retryInboundSignal ? 'retry' : undefined;
        }
        const accepted = await this.acceptPeerIfAbsent(peerId, message);
        if (accepted.left) {
            this.logPeerConnectionLeft(peerId, accepted.left);
        }
    }

    private shouldCreatePeerFromInboundSignal(
        peerId: PeerId,
        message: QRtcSignalingMessage
    ): PeerCreationAdmission {
        if (message.signalType === QRtcSignalingType.Answer) {
            return { allowed: false, reason: 'missing-peer-answer' };
        }
        if (this.peerEntryByPeerId.size >= this.maxPeerConnections()) {
            return { allowed: false, reason: 'max-peer-connections' };
        }
        if (!this.inboundPeerCreationPolicy) {
            return { allowed: true };
        }

        try {
            return this.toPeerCreationAdmission(
                this.inboundPeerCreationPolicy({
                    peerId,
                    signalType: message.signalType,
                    message
                })
            );
        }
        catch (caught) {
            const error = toError(caught);
            console.error(
                `Inbound RTC peer creation policy failed for ${peerId}`,
                error
            );
            return {
                allowed: false,
                reason: 'policy-error'
            };
        }
    }

    private shouldCreatePeerFromOutboundDial(
        peerId: PeerId
    ): PeerCreationAdmission {
        if (!this.outboundDialPolicy) {
            return { allowed: true };
        }

        try {
            return this.toPeerCreationAdmission(
                this.outboundDialPolicy({ peerId })
            );
        }
        catch (caught) {
            const error = toError(caught);
            console.error(
                `Outbound RTC dial policy failed for ${peerId}`,
                error
            );
            return {
                allowed: false,
                reason: 'policy-error'
            };
        }
    }

    private toPeerCreationAdmission(
        decision: WebRtcConnectionService.InboundPeerCreationDecision
    ): PeerCreationAdmission {
        if (decision === true || decision === 'allow') {
            return { allowed: true };
        }

        if (decision === false || decision === 'deny') {
            return { allowed: false };
        }

        if (decision.decision === 'retry') {
            return { allowed: false, reason: decision.reason, retryInboundSignal: true };
        }

        return { allowed: decision.decision === 'allow', reason: decision.reason };
    }

    async acceptPeerIfAbsent(
        peerId: string,
        message: QRtcSignalingMessage
    ): Promise<WebRtcConnectionService.PeerConnectionResult> {
        try {
            const signal = decodeRtcSignal(message);
            const connected = this.ensurePeerConnectionStarted(peerId);
            if (connected.left) {
                return connected;
            }
            const ensured = connected.right;
            if (!ensured) {
                return Either.ofLeft({
                    kind: 'connect-failed',
                    peerId,
                    error: new Error(`Peer ${peerId} missing after successful connection`),
                    startedSetup: false
                });
            }
            await ensured.peer.connection.handleSignal(signal);
            return Either.ofRight(ensured);
        }
        catch (caught) {
            const error = toError(caught);
            return Either.ofLeft({
                kind: 'signal-handle-failed',
                peerId,
                error
            });
        }
    }

    ensurePeerConnectionStarted(
        peerId: string,
        isInitiator: boolean = !this.isPolite(peerId)
    ): WebRtcConnectionService.PeerConnectionResult {
        if (peerId === this.input.sessionId) {
            return Either.ofLeft({
                kind: 'self',
                peerId
            });
        }

        let computed: ComputedPeerConnection;
        try {
            computed = this.createRtcPeerIfAbsent(peerId);
        }
        catch (caught) {
            return Either.ofLeft(toPeerCreationFailure(peerId, toError(caught)));
        }
        if (computed.decision === 'deny') {
            return Either.ofLeft({
                kind: 'dial-denied',
                peerId,
                reason: computed.reason
            });
        }
        if (!computed.shouldConnect) {
            return Either.ofRight({ peer: computed.peer, outcome: computed.outcome });
        }
        return this.startEnsuredPeerChannels(computed, isInitiator);
    }

    private startEnsuredPeerChannels(
        computed: UsablePeerConnection,
        isInitiator: boolean
    ): WebRtcConnectionService.PeerConnectionResult {
        const peerId = computed.peer.peerId;
        try {
            this.startPeerChannels(computed.peer, isInitiator);
            return Either.ofRight({ peer: computed.peer, outcome: computed.outcome });
        }
        catch (caught) {
            const error = toError(caught);
            // A lane that failed to start on a live native connection leaves the setup
            // dialing: the next ensure retries the lane, and a lane wait reports it as
            // timed out or closed.
            if (this.isPeerConnectedOrInProgress(computed.peer)) {
                return Either.ofRight({ peer: computed.peer, outcome: computed.outcome });
            }
            const replacement = this.reuseOrRemovePeer(peerId);
            if (replacement) {
                return Either.ofRight({ peer: replacement.peer, outcome: resolveSetupOutcome(replacement.setup) });
            }
            return Either.ofLeft({
                kind: 'connect-failed',
                peerId,
                error,
                startedSetup: computed.outcome === 'setup-started'
            });
        }
    }

    private startPeerConnection(peer: WebRtcConnectionService.Peer): void {
        this.watchPeerEstablishmentIfEnabled(peer);
        peer.connection.connect({
            onConnected: async () => {
                this.markPeerEstablished(peer);
            },
            onClosed: async () => {
                this.clearPeerEstablishmentTimeout(peer.peerId);
                // Churn must not refund the consumed establishment attempts.
                this.removePeerIfPresent(peer.peerId, { resetAttemptBudget: false });
            },
            onSignalingFailed: (failure) =>
                this.notifyPeerLifecycle('onSignalingFailed', (listener) => listener.onSignalingFailed?.(peer, failure))
        });
    }

    private startPeerChannels(peer: WebRtcConnectionService.Peer, isInitiator: boolean): void {
        for (const channel of peer.channels.values()) {
            channel.connect(isInitiator);
        }
        peer.media.connect();
    }

    async ensurePeerLaneOpen(
        peerId: string,
        laneId: string = DEFAULT_RTC_DATA_CHANNEL_LANE_ID,
        options: WebRtcConnectionService.PeerLaneOpenOptions = {}
    ): Promise<WebRtcConnectionService.PeerLaneOpenResult> {
        const lane = { peerId, laneId };
        let started:
            | WebRtcConnectionService.PeerConnectionResult
            | undefined;
        try {
            const result = await new PullPushCommand<WebRtcConnectionService.PeerConnectionResult, QRtcDataChannel>(
                () => this.ensurePeerConnectionStarted(peerId, options.isInitiator),
                (connected, signal) =>
                    waitForRtcPeerLane({
                        ...lane,
                        connected,
                        existingPeer: this.readPeer(peerId),
                        timeoutMs: options.timeoutMs,
                        signal
                    }),
                {
                    signal: options.signal,
                    timeoutMs: options.timeoutMs,
                    hooks: {
                        onPullSuccess: (value) => {
                            started = value;
                        }
                    }
                }
            ).run();
            return { status: 'open', ...lane, peer: result.pulled.right?.peer, channel: result.pushed };
        }
        catch (caught) {
            const error = toError(caught);
            const result = toPeerLaneOpenResultFromError(error, lane, started?.right?.peer);
            if (options.cleanupOnFailure && result.peer) {
                this.removePeerIfPresent(result.peer.peerId, { resetAttemptBudget: false });
            }
            return result;
        }
    }

    private isPeerConnectedOrInProgress(existingPeer: WebRtcConnectionService.Peer): boolean {
        const pc = existingPeer.connection.status.pc;
        if (pc?.connectionState === 'connected') {
            // A remote close ends the SCTP association at once, while the native connection
            // keeps reporting connected until its consent checks fail seconds later.
            return pc.sctp?.state !== 'closed';
        }
        return pc?.connectionState === 'connecting' || pc?.connectionState === 'new';
    }

    private hasReconnectableDataChannels(existingPeer: WebRtcConnectionService.Peer): boolean {
        return Array.from(existingPeer.channels.values())
            .some((channel) => channel.isReadyToConnect());
    }

    private createRtcPeerIfAbsent(peerId: string): ComputedPeerConnection {
        const existing = this.reuseOrRemovePeer(peerId);
        if (existing) {
            return {
                decision: 'use-peer',
                peer: existing.peer,
                shouldConnect: this.hasReconnectableDataChannels(existing.peer),
                outcome: resolveSetupOutcome(existing.setup)
            };
        }
        const admission = this.shouldCreatePeerFromOutboundDial(peerId);
        if (!admission.allowed) {
            return {
                decision: 'deny',
                reason: admission.reason
            };
        }

        const exhaustedEvent = this.attemptBudget.consume(peerId);
        if (exhaustedEvent) {
            throw new WebRtcPeerConnectionAttemptExhaustedError(exhaustedEvent);
        }

        return {
            decision: 'use-peer',
            peer: this.createPeer(peerId),
            shouldConnect: true,
            outcome: 'setup-started'
        };
    }

    private reuseOrRemovePeer(peerId: PeerId): PeerEntry | undefined {
        let entry = this.peerEntryByPeerId.get(peerId);
        while (entry && !this.isPeerConnectedOrInProgress(entry.peer)) {
            // A retained DTO does not authorize a replacement native connection.
            // Teardown precedes admission/capacity checks without refunding attempts.
            this.removePeerIfPresent(peerId, { resetAttemptBudget: false });
            // A deletion observer may have created another admitted peer.
            entry = this.peerEntryByPeerId.get(peerId);
        }
        return entry;
    }

    private livePeers(): readonly WebRtcConnectionService.Peer[] {
        return Array.from(this.peerEntryByPeerId.values())
            .map((entry) => entry.peer)
            .filter((peer) => this.isPeerConnectedOrInProgress(peer));
    }

    private createPeer(peerId: PeerId): WebRtcConnectionService.Peer {
        const peer = this.createPeerHandle(peerId);
        this.peerEntryByPeerId.set(peerId, {
            peer,
            setup: { phase: 'in-flight', peerId, startedAtEpochMs: Date.now() }
        });
        this.registerPeerEstablishmentCallbacks(peer);
        try {
            this.startPeerConnection(peer);
        }
        catch (caught) {
            // A peer whose native start threw was never observable: no creation or
            // deletion notice, while the consumed attempt still counts against the budget.
            this.releasePeer(peer);
            throw caught;
        }

        this.notifyPeerLifecycle('onCreated', (callback) => callback.onCreated(peer));

        return peer;
    }

    private createPeerHandle(peerId: PeerId): WebRtcConnectionService.Peer {
        const connection = new QRtcPeerConnection(
            this.signaler,
            {
                sessionId: this.input.sessionId,
                token: this.input.token,
                peerSessionId: peerId,
                iceCandidates: this.input.iceCandidates,
                isPolite: this.isPolite(peerId)
            },
            this.dependencies
        );
        const channels = this.createDataChannels(connection, peerId);
        const reliableChannel = channels.get(DEFAULT_RTC_DATA_CHANNEL_LANE_ID);
        if (!reliableChannel) {
            throw new Error('No RTC data channel lanes configured');
        }

        return {
            peerId,
            connection,
            channel: reliableChannel,
            channels,
            media: new QRtcMediaChannel(connection, { peerId })
        };
    }

    private notifyPeerLifecycle(
        callbackName: keyof WebRtcConnectionService.PeerLifecycleCallback,
        invoke: (callback: WebRtcConnectionService.PeerLifecycleCallback) => void
    ): void {
        for (const callback of this.onRtcPeerLifecycleCallbacks.values()) {
            try {
                invoke(callback);
            }
            catch (caught) {
                console.error(`Error calling onRtcPeerLifecycleCallbacks.${callbackName}`, toError(caught));
            }
        }
    }

    private registerPeerEstablishmentCallbacks(peer: WebRtcConnectionService.Peer): void {
        for (const channel of peer.channels.values()) {
            channel.onRtcCallbacksDo(
                WebRtcConnectionService.PEER_ESTABLISHMENT_CALLBACK_ID,
                {
                    onOpen: async () => {
                        this.markPeerEstablished(peer);
                    }
                }
            );
        }
    }

    private watchPeerEstablishmentIfEnabled(peer: WebRtcConnectionService.Peer): void {
        const policy = this.peerEstablishmentTimeoutPolicy();
        if (
            !policy.enabled ||
            policy.timeoutMs <= 0 ||
            this.isPeerEstablished(peer)
        ) {
            return;
        }

        this.peerEstablishmentWatchdog.watch({
            key: peer.peerId,
            resource: peer,
            timeoutMs: policy.timeoutMs,
            isComplete: (watchedPeer) =>
                this.peerEntryByPeerId.get(watchedPeer.peerId)?.peer !== watchedPeer ||
                this.isPeerEstablished(watchedPeer),
            onTimeout: (watchedPeer, event) => this.handlePeerEstablishmentTimeout(watchedPeer, event),
            onError: (error) => {
                console.error(
                    'Error handling RTC peer establishment timeout',
                    error
                );
            }
        });
    }

    private clearPeerEstablishmentTimeout(peerId: PeerId): void {
        this.peerEstablishmentWatchdog.complete(peerId);
    }

    private markPeerEstablished(peer: WebRtcConnectionService.Peer): void {
        const entry = this.peerEntryByPeerId.get(peer.peerId);
        if (!entry || entry.peer !== peer || entry.setup.phase === 'established') {
            return;
        }
        this.clearPeerEstablishmentTimeout(peer.peerId);
        this.attemptBudget.clear(peer.peerId, 'established');

        const established: WebRtcConnectionService.PeerSetupEstablished = {
            ...entry.setup,
            phase: 'established',
            establishedAtEpochMs: Date.now()
        };
        entry.setup = established;
        this.notifyPeerLifecycle('onEstablished', (callback) => callback.onEstablished?.(peer, established));
    }

    private handlePeerEstablishmentTimeout(
        peer: WebRtcConnectionService.Peer,
        timeoutEvent: AsyncCommandTimeoutEvent<PeerId>
    ): void {
        if (this.peerEntryByPeerId.get(peer.peerId)?.peer !== peer) {
            return;
        }

        if (this.isPeerEstablished(peer)) {
            return;
        }

        const event: WebRtcConnectionService.PeerEstablishmentTimeoutEvent = {
            peerId: peer.peerId,
            timeoutMs: timeoutEvent.timeoutMs,
            startedAtEpochMs: timeoutEvent.startedAtEpochMs,
            timedOutAtEpochMs: timeoutEvent.timedOutAtEpochMs,
            reason: 'peer-establishment-timeout'
        };

        console.warn(
            `RTC peer establishment timed out for ${peer.peerId} after ${event.timeoutMs}ms`
        );

        this.notifyPeerLifecycle('onConnectTimeout', (callback) => callback.onConnectTimeout?.(peer, event));

        this.removePeerIfPresent(peer.peerId, { resetAttemptBudget: false });
    }

    private peerEstablishmentTimeoutPolicy(): WebRtcConnectionService.PeerEstablishmentTimeoutPolicy {
        const policy = this.input.peerEstablishmentTimeout ??
            DEFAULT_WEB_RTC_PEER_ESTABLISHMENT_TIMEOUT_POLICY;
        return {
            enabled: policy.enabled,
            timeoutMs: Math.max(0, Math.floor(policy.timeoutMs))
        };
    }

    private peerConnectionAttemptBudgetPolicy(): WebRtcConnectionService.PeerConnectionAttemptBudgetPolicy {
        const policy = this.input.peerConnectionAttemptBudget ??
            DEFAULT_WEB_RTC_PEER_CONNECTION_ATTEMPT_BUDGET_POLICY;
        return {
            enabled: policy.enabled,
            maxAttempts: Math.max(1, Math.floor(policy.maxAttempts)),
            maxTotalDurationMs: Math.max(1, Math.floor(policy.maxTotalDurationMs)),
            cooldownMs: Math.max(0, Math.floor(policy.cooldownMs))
        };
    }

    private maxPeerConnections(): number {
        const requested = this.input.maxPeerConnections;
        if (
            requested === undefined ||
            !Number.isFinite(requested) ||
            requested <= 0
        ) {
            return DEFAULT_WEB_RTC_MAX_PEER_CONNECTIONS;
        }

        return Math.max(1, Math.floor(requested));
    }

    private isPeerEstablished(peer: WebRtcConnectionService.Peer): boolean {
        return peer.connection.status.pc?.connectionState === 'connected' ||
            peer.connection.isOpen() ||
            Array.from(peer.channels.values()).some((channel) => {
                const health = channel.readHealth();
                return health.readyState === 'open' || health.state === 'Open';
            });
    }

    private createDataChannels(
        connection: QRtcPeerConnection,
        peerId: string
    ): Map<string, QRtcDataChannel> {
        const channels = new Map<string, QRtcDataChannel>();

        for (const lane of this.dataChannelLanes()) {
            channels.set(
                lane.id,
                new QRtcDataChannel(
                    connection,
                    {
                        peerId,
                        dataChannelName: lane.label,
                        faultPort: this.dependencies.faultPort,
                        dataChannelInit: lane.init,
                        binaryType: lane.binaryType,
                        flowControl: lane.flowControl
                    }
                )
            );
        }

        return channels;
    }

    private dataChannelLanes(): readonly RtcDataChannelLaneConfig[] {
        const explicit = this.input.dataChannelLanes ?? [];
        const hasReliable = explicit.some((lane) => lane.id === DEFAULT_RTC_DATA_CHANNEL_LANE_ID);

        if (hasReliable) {
            return explicit;
        }

        return [
            {
                id: DEFAULT_RTC_DATA_CHANNEL_LANE_ID,
                label: this.input.dataChannelName
            },
            ...explicit
        ];
    }

    private isPolite(peerId: string) {
        return this.input.sessionId < peerId;
    }

    private logPeerConnectionLeft(
        peerId: string,
        left: WebRtcConnectionService.PeerConnectionLeft
    ): void {
        if (left.kind === 'self') {
            console.warn(`Ignoring self-connection attempt for peer ${peerId}`);
            return;
        }

        if (left.kind === 'connect-exhausted') {
            console.warn(
                `RTC peer ${peerId} connection attempt budget exhausted until ${left.event.retryAfterEpochMs}`
            );
            return;
        }

        if (left.kind === 'dial-denied') {
            console.warn(
                `RTC peer creation denied for ${peerId}${left.reason ? `: ${left.reason}` : ''}`
            );
            return;
        }

        console.error(`Failed to connect peer ${peerId}: ${left.kind}`, left.error);
    }
}

/** Whether the ensure started a setup: it created the peer, even when the same call already ended it. */
export function isPeerSetupStarted(result: WebRtcConnectionService.PeerConnectionResult): boolean {
    return result.right?.outcome === 'setup-started' ||
        (result.left?.kind === 'connect-failed' && result.left.startedSetup);
}

function resolveSetupOutcome(
    setup: WebRtcConnectionService.PeerSetup
): WebRtcConnectionService.PeerConnectionEnsureOutcome {
    return setup.phase === 'in-flight' ? 'setup-in-flight' : 'setup-established';
}

function toPeerCreationFailure(peerId: PeerId, error: Error): WebRtcConnectionService.PeerConnectionLeft {
    if (error instanceof WebRtcPeerConnectionAttemptExhaustedError) {
        return { kind: 'connect-exhausted', peerId, event: error.event, error };
    }
    return { kind: 'connect-failed', peerId, error, startedSetup: false };
}
