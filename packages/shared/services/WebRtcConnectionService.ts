import { ALMessage } from '../al-contracts/al-contract.ts';
import { IceConfig, PeerId } from '../api/api-config.ts';
import { AsyncCommand, type AsyncCommandTimeoutEvent } from '../cache/AsyncCommand.ts';
import { CommandCancelledError, CommandTimedOutError } from '../cache/Command.ts';
import { PullPushCommand } from '../cache/PullPushCommand.ts';
import { Either } from '../resilience/Either.ts';
import {
    QRtcDataChannel,
    type RtcDataChannelFlowControlPolicy,
    type RtcDataChannelHealth
} from '../webrtc/QRtcDataChannel.ts';
import { QRtcMediaChannel } from '../webrtc/QRtcMediaChannel.ts';
import { QRtcDataExchanged, QRtcPeerConnection } from '../webrtc/QRtcPeerConnection.ts';
import {
    QRtcSignalingMessage,
    QRtcSignalingTransport,
    QRtcSignalingTransportCallbacks,
    QRtcSignalingType
} from '../webrtc/QRtcSignalingContracts.ts';

export type WebRtcQueueBoxClientServiceInputDto = {
    readonly sessionId: string;
    readonly token: string;
    readonly iceCandidates: IceConfig;
    readonly dataChannelName: string;
    readonly dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
    readonly rtcSignalingTopicId: string;
    readonly peerEstablishmentTimeout?: WebRtcPeerEstablishmentTimeoutPolicy;
    readonly peerConnectionAttemptBudget?: WebRtcPeerConnectionAttemptBudgetPolicy;
    readonly maxPeerConnections?: number;
};

export type WebRtcPeerEstablishmentTimeoutPolicy = Readonly<{
    enabled: boolean;
    timeoutMs: number;
}>;

export type WebRtcPeerEstablishmentTimeoutEvent = Readonly<{
    peerId: PeerId;
    timeoutMs: number;
    startedAtEpochMs: number;
    timedOutAtEpochMs: number;
    reason: 'peer-establishment-timeout';
}>;

export const DEFAULT_WEB_RTC_PEER_ESTABLISHMENT_TIMEOUT_POLICY: WebRtcPeerEstablishmentTimeoutPolicy = {
    enabled: false,
    timeoutMs: 30_000
};

export type WebRtcPeerConnectionAttemptBudgetPolicy = Readonly<{
    enabled: boolean;
    maxAttempts: number;
    maxTotalDurationMs: number;
    cooldownMs: number;
}>;

export type WebRtcPeerConnectionAttemptDiagnostics = Readonly<{
    peerId: PeerId;
    attempts: number;
    firstAttemptAtEpochMs: number;
    lastAttemptAtEpochMs: number;
    maxAttempts: number;
    maxTotalDurationMs: number;
    cooldownMs: number;
    exhaustedAtEpochMs?: number;
    retryAfterEpochMs?: number;
}>;

export type WebRtcPeerConnectionAttemptExhaustedEvent =
    & WebRtcPeerConnectionAttemptDiagnostics
    & Readonly<{
        exhaustedAtEpochMs: number;
        retryAfterEpochMs: number;
        reason: 'peer-connection-attempt-budget-exhausted';
    }>;

export type WebRtcPeerConnectionAttemptBudgetDiagnostics = Readonly<{
    consumedCount: number;
    resetOnSuccessCount: number;
    resetOnRemovalCount: number;
    cooldownExpiredClearCount: number;
    exhaustedCount: number;
}>;

export const DEFAULT_WEB_RTC_PEER_CONNECTION_ATTEMPT_BUDGET_POLICY: WebRtcPeerConnectionAttemptBudgetPolicy = {
    enabled: false,
    maxAttempts: 6,
    maxTotalDurationMs: 180_000,
    cooldownMs: 30_000
};

export const DEFAULT_WEB_RTC_MAX_PEER_CONNECTIONS = 10;
export const RTC_CONNECT_ATTEMPT_BUDGET_EXHAUSTED_REASON = 'rtc-connect-attempt-budget-exhausted';

export type RtcDataChannelLaneConfig = Readonly<{
    id: string;
    label: string;
    init?: RTCDataChannelInit;
    binaryType?: BinaryType;
    flowControl?: RtcDataChannelFlowControlPolicy;
}>;

export type QRtcPeerDto = {
    peerId: PeerId;
    connection: QRtcPeerConnection;
    channel: QRtcDataChannel;
    channels: ReadonlyMap<string, QRtcDataChannel>;
    media: QRtcMediaChannel;
};

export const DEFAULT_RTC_DATA_CHANNEL_LANE_ID = 'reliable';

export type RtcPeerChannelHealth = Readonly<{
    peerId: PeerId;
    laneId: string;
    channel: RtcDataChannelHealth;
}>;

export type RtcPeerHealth = Readonly<{
    peerId: PeerId;
    channels: readonly RtcPeerChannelHealth[];
}>;

export type WebRtcPeerConnectionLeft = Readonly<
    | {
        kind: 'self';
        peerId: PeerId;
    }
    | {
        kind: 'connect-failed';
        peerId: PeerId;
        error: Error;
    }
    | {
        kind: 'connect-exhausted';
        peerId: PeerId;
        event: WebRtcPeerConnectionAttemptExhaustedEvent;
        error: Error;
    }
    | {
        kind: 'signal-handle-failed';
        peerId: PeerId;
        error: Error;
    }
>;

export type WebRtcPeerLaneOpenStatus =
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

export type WebRtcPeerLaneOpenOptions = Readonly<{
    isInitiator?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    cleanupOnFailure?: boolean;
}>;

export type WebRtcPeerLaneOpenResult = Readonly<{
    status: WebRtcPeerLaneOpenStatus;
    peerId: PeerId;
    laneId: string;
    peer?: QRtcPeerDto;
    channel?: QRtcDataChannel;
    error?: Error;
}>;

export type WebRtcRemovePeerOptions = Readonly<{
    resetAttemptBudget?: boolean;
}>;

type ComputedPeerConnection = Readonly<{
    peerDto: QRtcPeerDto;
    shouldConnect: boolean;
}>;

type WebRtcPeerConnectionAttemptState = Readonly<{
    peerId: PeerId;
    attempts: number;
    firstAttemptAtEpochMs: number;
    lastAttemptAtEpochMs: number;
    exhaustedAtEpochMs?: number;
    retryAfterEpochMs?: number;
}>;

type InboundPeerCreationDecision = Readonly<{
    allowed: boolean;
    tentative: boolean;
    reason?: string;
}>;

export type WebRtcInboundPeerCreationDecision =
    | boolean
    | 'allow'
    | 'deny'
    | 'tentative'
    | Readonly<{
        decision: 'allow' | 'deny' | 'tentative';
        reason?: string;
    }>;

class WebRtcPeerLaneOpenFailure extends Error {
    public readonly status: Exclude<WebRtcPeerLaneOpenStatus, 'open'>;
    public readonly peerId: PeerId;
    public readonly laneId: string;

    constructor(
        status: Exclude<WebRtcPeerLaneOpenStatus, 'open'>,
        peerId: PeerId,
        laneId: string,
        message: string,
        options?: ErrorOptions
    ) {
        super(message, options);
        this.status = status;
        this.peerId = peerId;
        this.laneId = laneId;
        this.name = 'WebRtcPeerLaneOpenFailure';
    }
}

class WebRtcPeerConnectionAttemptExhaustedError extends Error {
    public readonly event: WebRtcPeerConnectionAttemptExhaustedEvent;

    constructor(
        event: WebRtcPeerConnectionAttemptExhaustedEvent
    ) {
        super(RTC_CONNECT_ATTEMPT_BUDGET_EXHAUSTED_REASON);
        this.event = event;
        this.name = 'WebRtcPeerConnectionAttemptExhaustedError';
    }
}

export interface OnRtcPeerLifecycleCallback {
    onCreated(peerDto: QRtcPeerDto): void;

    onDeleted(peerDto: QRtcPeerDto): void;

    onConnectTimeout?(
        peerDto: QRtcPeerDto,
        event: WebRtcPeerEstablishmentTimeoutEvent
    ): void;

    onConnectExhausted?(
        event: WebRtcPeerConnectionAttemptExhaustedEvent
    ): void;
}

export type WebRtcInboundPeerCreationPolicyInput = Readonly<{
    peerId: PeerId;
    signalType: QRtcSignalingMessage['signalType'];
    message: QRtcSignalingMessage;
}>;

export type WebRtcInboundPeerCreationPolicy = (
    input: WebRtcInboundPeerCreationPolicyInput
) => WebRtcInboundPeerCreationDecision;

export class WebRtcConnectionService {
    private static readonly PEER_ESTABLISHMENT_CALLBACK_ID = 'web-rtc-connection-service:peer-establishment';

    private readonly onRtcPeerLifecycleCallbacks: Map<string, OnRtcPeerLifecycleCallback> = new Map();

    private readonly peerDtoByPeerId = new Map<PeerId, QRtcPeerDto>();
    private readonly peerEstablishmentWatchdog = new AsyncCommand<PeerId, QRtcPeerDto>();
    private readonly peerConnectionAttemptStateByPeerId = new Map<PeerId, WebRtcPeerConnectionAttemptState>();
    private readonly attemptBudgetDiagnostics = {
        consumedCount: 0,
        resetOnSuccessCount: 0,
        resetOnRemovalCount: 0,
        cooldownExpiredClearCount: 0,
        exhaustedCount: 0
    };
    private readonly tentativePeerIds = new Set<PeerId>();
    private inboundPeerCreationPolicy: WebRtcInboundPeerCreationPolicy | undefined;

    public readonly signaler: QRtcSignalingTransport;
    public readonly input: WebRtcQueueBoxClientServiceInputDto;

    constructor(
        signaler: QRtcSignalingTransport,
        input: WebRtcQueueBoxClientServiceInputDto
    ) {
        this.signaler = signaler;
        this.input = input;
    }

    setInboundPeerCreationPolicy(
        policy?: WebRtcInboundPeerCreationPolicy
    ): WebRtcConnectionService {
        this.inboundPeerCreationPolicy = policy;
        return this;
    }

    peerConnectionAttemptDiagnostics(
        peerId: PeerId
    ): WebRtcPeerConnectionAttemptDiagnostics | undefined {
        const state = this.peerConnectionAttemptStateByPeerId.get(peerId);
        if (!state) {
            return undefined;
        }

        return this.toPeerConnectionAttemptDiagnostics(state);
    }

    readPeerConnectionAttemptBudgetDiagnostics(): WebRtcPeerConnectionAttemptBudgetDiagnostics {
        return { ...this.attemptBudgetDiagnostics };
    }

    // --------------------------------------------------
    // Callbacks
    // --------------------------------------------------

    onRtcPeerLifecycleDo(id: string, cb: OnRtcPeerLifecycleCallback): WebRtcConnectionService {
        this.onRtcPeerLifecycleCallbacks.set(id, cb);
        return this;
    }

    removeRtcPeerLifecycleById(id: string): boolean {
        return this.onRtcPeerLifecycleCallbacks.delete(id);
    }

    // --------------------------------------------------
    // Peer management
    // --------------------------------------------------

    removePeerIfPresent(
        peerId: string,
        options: WebRtcRemovePeerOptions = {}
    ): boolean {
        console.log(`Cleaning up peer: ${peerId}`);
        const rtcPeer: QRtcPeerDto | undefined = this.peerDtoByPeerId.get(peerId);
        if (rtcPeer === undefined) {
            console.log(`Peer ${peerId} not found. Ignoring`);
            if (options.resetAttemptBudget !== false) {
                this.clearPeerConnectionAttemptBudget(peerId, 'removal');
            }
            return false;
        }

        this.clearPeerEstablishmentTimeout(peerId);
        this.tentativePeerIds.delete(peerId);
        if (options.resetAttemptBudget !== false) {
            this.clearPeerConnectionAttemptBudget(peerId, 'removal');
        }

        for (const [_, cb] of this.onRtcPeerLifecycleCallbacks.entries()) {
            cb.onDeleted(rtcPeer);
        }

        rtcPeer.media?.reset();
        for (const channel of rtcPeer.channels.values()) {
            channel.removeRtcCallbackById(
                WebRtcConnectionService.PEER_ESTABLISHMENT_CALLBACK_ID
            );
            channel.reset();
        }
        rtcPeer.connection.reset();

        this.peerDtoByPeerId.delete(peerId);

        return true;
    }

    async connectSignaler(): Promise<WebRtcConnectionService> {
        await this.signaler.connect(
            {
                sessionId: this.input.sessionId,
                token: this.input.token,
                callbacks: this.toSignalingProtocol()
            }
        );

        console.log(`Signaling transport connected for ${this.input.sessionId} and ${this.input.token}`);
        return this;
    }

    peerIdsWithNoReconnectableLanes(): readonly string[] {
        return Array.from(this.peerDtoByPeerId.entries())
            .filter(([, peerDto]) =>
                this.isPeerConnectedOrInProgress(peerDto) &&
                !this.hasReconnectableDataChannels(peerDto)
            )
            .map(([peerId]) => peerId);
    }

    knownPeerIds(): readonly string[] {
        return Array.from(this.peerDtoByPeerId.keys());
    }

    activePeerIds(): readonly string[] {
        return Array.from(this.peerDtoByPeerId.entries())
            .filter(([, peerDto]) => this.isPeerConnectedOrInProgress(peerDto))
            .map(([peerId]) => peerId);
    }

    readyPeerIdsForLane(
        laneId: string = DEFAULT_RTC_DATA_CHANNEL_LANE_ID
    ): readonly string[] {
        return Array.from(this.peerDtoByPeerId.entries())
            .filter(([, peerDto]) => {
                if (!this.isPeerConnectedOrInProgress(peerDto)) {
                    return false;
                }

                const channel = peerDto.channels.get(laneId);
                return channel?.readHealth().readyState === 'open';
            })
            .map(([peerId]) => peerId);
    }

    readPeer(peerId: string): QRtcPeerDto | undefined {
        return this.peerDtoByPeerId.get(peerId);
    }

    readPeerChannel(
        peerId: string,
        laneId: string = DEFAULT_RTC_DATA_CHANNEL_LANE_ID
    ): QRtcDataChannel | undefined {
        return this.peerDtoByPeerId.get(peerId)?.channels.get(laneId);
    }

    readPeerHealth(peerId: string): RtcPeerHealth | undefined {
        const peer = this.peerDtoByPeerId.get(peerId);
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
        return Array.from(this.peerDtoByPeerId.keys())
            .map((peerId) => this.readPeerHealth(peerId))
            .filter((health): health is RtcPeerHealth => health !== undefined);
    }

    disconnectPeer(peerId: string, options: WebRtcRemovePeerOptions = {}): boolean {
        return this.removePeerIfPresent(peerId, options);
    }

    private toSignalingProtocol(): QRtcSignalingTransportCallbacks {
        return {
            onOpen: (sessionId: string, token: string) => {
                console.log(`Signaling transport open for ${sessionId} and ${token}`);
                return Promise.resolve();
            },

            onError: (_: string, __: string, message: string) => {
                console.error('Signaling transport error: ' + message);
                return Promise.resolve();
            },

            onClose: (sessionId: string, token: string) => {
                console.log(`Signaling transport closed for ${sessionId} and ${token}`);
                return Promise.resolve();
            },

            onMessage: async (sessionId: string, token: string, message: ALMessage) => {
                console.log(`Message received for ${sessionId} and ${token} ${message.payload.resource}`);
                if (this.input.sessionId !== sessionId) {
                    throw new Error(
                        'Message received for wrong session id: ' + sessionId + ' expected: ' + this.input.sessionId
                    );
                }

                const msg: QRtcSignalingMessage = JSON.parse(message.payload.resource) as QRtcSignalingMessage;

                const peerId = msg.fromId;

                if (msg.toId !== sessionId) {
                    console.log('Message not for us, ignoring: ' + message.payload.resource);
                    return Promise.resolve();
                }
                else if (peerId === sessionId) {
                    console.log(
                        'Ignoring message from self msg.fromId' + peerId + ' my session id' + sessionId,
                        new Error().stack
                    );
                    return Promise.resolve();
                }

                const peerDto = this.peerDtoByPeerId.get(peerId);
                if (!peerDto) {
                    const inboundDecision = this.shouldCreatePeerFromInboundSignal(peerId, msg);
                    if (!inboundDecision.allowed) {
                        console.log(
                            `Ignoring inbound RTC signaling from ${peerId}: peer creation denied${
                                inboundDecision.reason ? ` (${inboundDecision.reason})` : ''
                            }`
                        );
                        return Promise.resolve();
                    }

                    const accepted = await this.acceptPeerIfAbsent(peerId, msg);
                    if (accepted.left) {
                        this.logPeerConnectionLeft(peerId, accepted.left);
                    }
                    else if (inboundDecision.tentative) {
                        this.tentativePeerIds.add(peerId);
                    }
                }
                else {
                    await peerDto.connection.handleSignal(
                        msg.signalType,
                        msg.payload as QRtcDataExchanged
                    );
                }

                return Promise.resolve();
            }
        };
    }

    private shouldCreatePeerFromInboundSignal(
        peerId: PeerId,
        message: QRtcSignalingMessage
    ): InboundPeerCreationDecision {
        const plausible = this.isPlausibleMissingPeerSignal(message);
        if (!plausible.allowed) {
            return plausible;
        }

        const capDecision = this.canAcceptAdditionalPeer(peerId);
        if (!capDecision.allowed) {
            return capDecision;
        }

        if (!this.inboundPeerCreationPolicy) {
            return plausible;
        }

        try {
            return this.normalizeInboundPeerCreationDecision(
                this.inboundPeerCreationPolicy({
                    peerId,
                    signalType: message.signalType,
                    message
                })
            );
        }
        catch (error) {
            console.error(
                `Inbound RTC peer creation policy failed for ${peerId}`,
                error
            );
            return {
                allowed: false,
                tentative: false,
                reason: 'policy-error'
            };
        }
    }

    private isPlausibleMissingPeerSignal(
        message: QRtcSignalingMessage
    ): InboundPeerCreationDecision {
        if (message.signalType === QRtcSignalingType.Answer) {
            return {
                allowed: false,
                tentative: false,
                reason: 'missing-peer-answer'
            };
        }

        if (
            message.signalType === QRtcSignalingType.Offer &&
            !isRtcSignalPayloadWithDescription(message.payload)
        ) {
            return {
                allowed: false,
                tentative: false,
                reason: 'malformed-offer'
            };
        }

        if (
            message.signalType === QRtcSignalingType.IceCandidate &&
            !isRtcSignalPayloadWithCandidate(message.payload)
        ) {
            return {
                allowed: false,
                tentative: false,
                reason: 'malformed-ice-candidate'
            };
        }

        return {
            allowed: true,
            tentative: false
        };
    }

    private canAcceptAdditionalPeer(peerId: PeerId): InboundPeerCreationDecision {
        if (this.peerDtoByPeerId.has(peerId)) {
            return {
                allowed: true,
                tentative: false
            };
        }

        if (this.peerDtoByPeerId.size < this.maxPeerConnections()) {
            return {
                allowed: true,
                tentative: false
            };
        }

        return {
            allowed: false,
            tentative: false,
            reason: 'max-peer-connections'
        };
    }

    private normalizeInboundPeerCreationDecision(
        decision: WebRtcInboundPeerCreationDecision
    ): InboundPeerCreationDecision {
        if (decision === true || decision === 'allow') {
            return {
                allowed: true,
                tentative: false
            };
        }

        if (decision === 'tentative') {
            return {
                allowed: true,
                tentative: true
            };
        }

        if (decision === false || decision === 'deny') {
            return {
                allowed: false,
                tentative: false
            };
        }

        if (decision.decision === 'tentative') {
            return {
                allowed: true,
                tentative: true,
                reason: decision.reason
            };
        }

        if (decision.decision === 'allow') {
            return {
                allowed: true,
                tentative: false,
                reason: decision.reason
            };
        }

        return {
            allowed: false,
            tentative: false,
            reason: decision.reason
        };
    }

    async acceptPeerIfAbsent(
        peerId: string,
        message: QRtcSignalingMessage
    ): Promise<Either<WebRtcPeerConnectionLeft, QRtcPeerDto>> {
        const connected = this.ensurePeerConnectionStarted(peerId);
        if (connected.left) {
            return connected;
        }

        const peerDto = connected.right;
        if (!peerDto) {
            return Either.ofLeft<WebRtcPeerConnectionLeft, QRtcPeerDto>({
                kind: 'connect-failed',
                peerId,
                error: new Error(`Peer ${peerId} missing after successful connection`)
            });
        }

        try {
            await peerDto.connection.handleSignal(
                message.signalType,
                message.payload as QRtcDataExchanged
            );
            return Either.ofRight<WebRtcPeerConnectionLeft, QRtcPeerDto>(peerDto);
        }
        catch (error) {
            return Either.ofLeft<WebRtcPeerConnectionLeft, QRtcPeerDto>({
                kind: 'signal-handle-failed',
                peerId,
                error: WebRtcConnectionService.toError(error)
            });
        }
    }

    ensurePeerConnectionStarted(
        peerId: string,
        isInitiator: boolean = !this.isPolite(peerId)
    ): Either<WebRtcPeerConnectionLeft, QRtcPeerDto> {
        if (peerId === this.input.sessionId) {
            return Either.ofLeft<WebRtcPeerConnectionLeft, QRtcPeerDto>({
                kind: 'self',
                peerId
            });
        }

        try {
            const computed = this.computeRtcPeerDtoIfAbsent(peerId);
            if (computed.shouldConnect) {
                this.watchPeerEstablishmentIfEnabled(computed.peerDto);

                computed.peerDto.connection.connect(
                    {
                        onConnected: () => {
                            this.markPeerEstablished(peerId);
                            return Promise.resolve();
                        },
                        onClosed: (peerId: string) => {
                            console.log(`Connection to peer ${peerId} closed, removing from queue box`);
                            this.clearPeerEstablishmentTimeout(peerId);
                            // A closed connection is churn evidence, not success:
                            // the attempt budget survives so a flapping overlay
                            // cannot mint fresh dial budgets by closing edges.
                            this.removePeerIfPresent(peerId, { resetAttemptBudget: false });
                            return Promise.resolve();
                        }
                    }
                );

                for (const channel of computed.peerDto.channels.values()) {
                    channel.connect(isInitiator);
                }

                computed.peerDto.media.connect();
            }

            return Either.ofRight<WebRtcPeerConnectionLeft, QRtcPeerDto>(computed.peerDto);
        }
        catch (error) {
            const existingPeerDto = this.peerDtoByPeerId.get(peerId);
            if (existingPeerDto && this.isPeerConnectedOrInProgress(existingPeerDto)) {
                return Either.ofRight<WebRtcPeerConnectionLeft, QRtcPeerDto>(existingPeerDto);
            }

            if (error instanceof WebRtcPeerConnectionAttemptExhaustedError) {
                return Either.ofLeft<WebRtcPeerConnectionLeft, QRtcPeerDto>({
                    kind: 'connect-exhausted',
                    peerId,
                    event: error.event,
                    error
                });
            }

            return Either.ofLeft<WebRtcPeerConnectionLeft, QRtcPeerDto>({
                kind: 'connect-failed',
                peerId,
                error: WebRtcConnectionService.toError(error)
            });
        }
    }

    async ensurePeerLaneOpen(
        peerId: string,
        laneId: string = DEFAULT_RTC_DATA_CHANNEL_LANE_ID,
        options: WebRtcPeerLaneOpenOptions = {}
    ): Promise<WebRtcPeerLaneOpenResult> {
        let started: Either<WebRtcPeerConnectionLeft, QRtcPeerDto> | undefined;

        try {
            const result = await new PullPushCommand<Either<WebRtcPeerConnectionLeft, QRtcPeerDto>, QRtcDataChannel>(
                () =>
                    this.ensurePeerConnectionStarted(
                        peerId,
                        options.isInitiator ?? !this.isPolite(peerId)
                    ),
                async (connected, signal) => {
                    if (connected.left) {
                        throw this.toPeerLaneOpenFailureFromConnectLeft(
                            connected.left,
                            laneId
                        );
                    }

                    const peer = connected.right ?? this.readPeer(peerId);
                    if (!peer) {
                        throw new WebRtcPeerLaneOpenFailure(
                            'no-peer',
                            peerId,
                            laneId,
                            `RTC peer ${peerId} missing after connection start`
                        );
                    }

                    const channel = peer.channels.get(laneId);
                    if (!channel) {
                        throw new WebRtcPeerLaneOpenFailure(
                            'no-lane',
                            peerId,
                            laneId,
                            `RTC peer ${peerId} has no lane ${laneId}`
                        );
                    }

                    const initialHealth = channel.readHealth();
                    if (isOpenRtcChannelHealth(initialHealth)) {
                        return channel;
                    }

                    if (isClosedRtcChannelHealth(initialHealth)) {
                        throw new WebRtcPeerLaneOpenFailure(
                            'closed',
                            peerId,
                            laneId,
                            `RTC lane ${laneId} for peer ${peerId} is closed`
                        );
                    }

                    const opened = await waitForRtcChannelOpenOrAbort(
                        channel,
                        options.timeoutMs,
                        signal
                    );
                    if (opened) {
                        return channel;
                    }

                    const currentHealth = channel.readHealth();
                    throw new WebRtcPeerLaneOpenFailure(
                        isClosedRtcChannelHealth(currentHealth)
                            ? 'closed'
                            : 'timeout',
                        peerId,
                        laneId,
                        `RTC lane ${laneId} for peer ${peerId} did not open`
                    );
                },
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

            return {
                status: 'open',
                peerId,
                laneId,
                peer: result.pulled.right,
                channel: result.pushed
            };
        }
        catch (error) {
            const result = this.toPeerLaneOpenResultFromError(
                error,
                peerId,
                laneId,
                started?.right
            );
            if (options.cleanupOnFailure && result.peer) {
                // A failed lane open consumed budget; cleaning up the peer
                // must not refund it.
                this.removePeerIfPresent(result.peer.peerId, { resetAttemptBudget: false });
            }

            return result;
        }
    }

    private isPeerConnectedOrInProgress(existingPeerDto: QRtcPeerDto): boolean {
        return existingPeerDto.connection.status.pc?.connectionState === 'connected' ||
            existingPeerDto.connection.status.pc?.connectionState === 'connecting' ||
            existingPeerDto.connection.status.pc?.connectionState === 'new';
    }

    private hasReconnectableDataChannels(existingPeerDto: QRtcPeerDto): boolean {
        return Array.from(existingPeerDto.channels.values())
            .some((channel) => channel.isReadyToConnect());
    }

    private toPeerLaneOpenFailureFromConnectLeft(
        left: WebRtcPeerConnectionLeft,
        laneId: string
    ): WebRtcPeerLaneOpenFailure {
        if (left.kind === 'self') {
            return new WebRtcPeerLaneOpenFailure(
                'self',
                left.peerId,
                laneId,
                `Ignoring self-connection attempt for peer ${left.peerId}`
            );
        }

        if (left.kind === 'connect-exhausted') {
            return new WebRtcPeerLaneOpenFailure(
                'exhausted',
                left.peerId,
                laneId,
                RTC_CONNECT_ATTEMPT_BUDGET_EXHAUSTED_REASON,
                { cause: left.error }
            );
        }

        return new WebRtcPeerLaneOpenFailure(
            'connect-failed',
            left.peerId,
            laneId,
            `Failed to start RTC peer ${left.peerId}: ${left.kind}`,
            { cause: left.error }
        );
    }

    private toPeerLaneOpenResultFromError(
        error: unknown,
        peerId: PeerId,
        laneId: string,
        peer: QRtcPeerDto | undefined
    ): WebRtcPeerLaneOpenResult {
        if (error instanceof WebRtcPeerLaneOpenFailure) {
            return {
                status: error.status,
                peerId: error.peerId,
                laneId: error.laneId,
                peer,
                error
            };
        }

        if (error instanceof CommandTimedOutError) {
            return {
                status: 'timeout',
                peerId,
                laneId,
                peer,
                error
            };
        }

        if (error instanceof CommandCancelledError) {
            return {
                status: 'aborted',
                peerId,
                laneId,
                peer,
                error
            };
        }

        return {
            status: 'failed',
            peerId,
            laneId,
            peer,
            error: WebRtcConnectionService.toError(error)
        };
    }

    private computeRtcPeerDtoIfAbsent(peerId: string): ComputedPeerConnection {
        const existingPeerDto: QRtcPeerDto | undefined = this.peerDtoByPeerId.get(peerId);
        if (existingPeerDto !== undefined) {
            const connectionState = existingPeerDto.connection.status.pc?.connectionState;

            if (this.isPeerConnectedOrInProgress(existingPeerDto)) {
                if (this.hasReconnectableDataChannels(existingPeerDto)) {
                    console.log(
                        `Peer ${peerId} has reconnectable data channels. Reusing connection and reconnecting channels`
                    );
                    return {
                        peerDto: existingPeerDto,
                        shouldConnect: true
                    };
                }

                // console.log(`Peer ${peerId} already in ${existingPeerDto.connection.status.state}/${connectionState}. Reuse existing connection`);
                return {
                    peerDto: existingPeerDto,
                    shouldConnect: false
                };
            }

            if (existingPeerDto.connection.isReadyToConnect()) {
                console.log(
                    `Peer connection to ${peerId} already exists in state ${connectionState}. Reuse existing connection`
                );
                return {
                    peerDto: existingPeerDto,
                    shouldConnect: true
                };
            }

            console.log(
                `Peer connection to ${peerId} exists in state ${connectionState}. Removing existing connection`
            );
            this.removePeerIfPresent(peerId, { resetAttemptBudget: false });
        }

        const exhaustedEvent = this.consumePeerConnectionAttempt(peerId);
        if (exhaustedEvent) {
            throw new WebRtcPeerConnectionAttemptExhaustedError(exhaustedEvent);
        }

        console.log(`Creating peer connection for ${peerId}`);

        const connection = new QRtcPeerConnection(
            this.signaler,
            {
                sessionId: this.input.sessionId,
                token: this.input.token,
                peerSessionId: peerId,
                iceCandidates: this.input.iceCandidates,
                isPolite: this.isPolite(peerId)
            }
        );

        const channels = this.createDataChannels(connection, peerId);
        const reliableChannel = channels.get(DEFAULT_RTC_DATA_CHANNEL_LANE_ID) ??
            channels.values().next().value;

        if (!reliableChannel) {
            throw new Error('No RTC data channel lanes configured');
        }

        const rtcPeerDto: QRtcPeerDto = {
            peerId: peerId,
            connection: connection,
            channel: reliableChannel,
            channels,
            media: new QRtcMediaChannel(
                connection,
                {
                    peerId: peerId
                }
            )
        };

        this.peerDtoByPeerId.set(peerId, rtcPeerDto);

        for (const [_, cb] of this.onRtcPeerLifecycleCallbacks.entries()) {
            try {
                cb.onCreated(rtcPeerDto);
            }
            catch (e) {
                console.error('Error calling onRtcPeerLifecycleCallbacks.onCreated', e);
            }
        }

        this.registerPeerEstablishmentCallbacks(rtcPeerDto);

        return {
            peerDto: rtcPeerDto,
            shouldConnect: true
        };
    }

    private registerPeerEstablishmentCallbacks(peerDto: QRtcPeerDto): void {
        for (const channel of peerDto.channels.values()) {
            channel.onRtcCallbacksDo(
                WebRtcConnectionService.PEER_ESTABLISHMENT_CALLBACK_ID,
                {
                    onOpen: async () => {
                        this.markPeerEstablished(peerDto.peerId);
                    }
                }
            );
        }
    }

    private watchPeerEstablishmentIfEnabled(peerDto: QRtcPeerDto): void {
        const policy = this.peerEstablishmentTimeoutPolicy();
        if (
            !policy.enabled ||
            policy.timeoutMs <= 0 ||
            this.isPeerEstablished(peerDto)
        ) {
            return;
        }

        this.peerEstablishmentWatchdog.watch({
            key: peerDto.peerId,
            resource: peerDto,
            timeoutMs: policy.timeoutMs,
            isComplete: (watchedPeer) =>
                this.peerDtoByPeerId.get(watchedPeer.peerId) !== watchedPeer ||
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

    private markPeerEstablished(peerId: PeerId): void {
        this.clearPeerEstablishmentTimeout(peerId);
        this.clearPeerConnectionAttemptBudget(peerId, 'established');
        this.tentativePeerIds.delete(peerId);
    }

    private handlePeerEstablishmentTimeout(
        peerDto: QRtcPeerDto,
        timeoutEvent: AsyncCommandTimeoutEvent<PeerId>
    ): void {
        const currentPeerDto = this.peerDtoByPeerId.get(peerDto.peerId);
        if (!currentPeerDto || currentPeerDto !== peerDto) {
            return;
        }

        if (this.isPeerEstablished(peerDto)) {
            return;
        }

        const event: WebRtcPeerEstablishmentTimeoutEvent = {
            peerId: peerDto.peerId,
            timeoutMs: timeoutEvent.timeoutMs,
            startedAtEpochMs: timeoutEvent.startedAtEpochMs,
            timedOutAtEpochMs: timeoutEvent.timedOutAtEpochMs,
            reason: 'peer-establishment-timeout'
        };

        console.warn(
            `RTC peer establishment timed out for ${peerDto.peerId} after ${event.timeoutMs}ms`
        );

        for (const [_, cb] of this.onRtcPeerLifecycleCallbacks.entries()) {
            try {
                cb.onConnectTimeout?.(peerDto, event);
            }
            catch (e) {
                console.error(
                    'Error calling onRtcPeerLifecycleCallbacks.onConnectTimeout',
                    e
                );
            }
        }

        this.removePeerIfPresent(peerDto.peerId, { resetAttemptBudget: false });
    }

    private peerEstablishmentTimeoutPolicy(): WebRtcPeerEstablishmentTimeoutPolicy {
        const policy = this.input.peerEstablishmentTimeout ??
            DEFAULT_WEB_RTC_PEER_ESTABLISHMENT_TIMEOUT_POLICY;
        return {
            enabled: policy.enabled,
            timeoutMs: Math.max(0, Math.floor(policy.timeoutMs))
        };
    }

    private consumePeerConnectionAttempt(
        peerId: PeerId
    ): WebRtcPeerConnectionAttemptExhaustedEvent | undefined {
        const policy = this.peerConnectionAttemptBudgetPolicy();
        if (!policy.enabled) {
            return undefined;
        }

        const now = Date.now();
        const current = this.peerConnectionAttemptStateByPeerId.get(peerId);
        if (
            current?.retryAfterEpochMs !== undefined &&
            current.exhaustedAtEpochMs !== undefined
        ) {
            if (now < current.retryAfterEpochMs) {
                return this.toPeerConnectionAttemptExhaustedEvent(
                    current,
                    policy
                );
            }

            this.peerConnectionAttemptStateByPeerId.delete(peerId);
            this.attemptBudgetDiagnostics.cooldownExpiredClearCount += 1;
        }
        else if (
            current &&
            this.isPeerConnectionAttemptBudgetExhausted(current, policy, now)
        ) {
            return this.markPeerConnectionAttemptExhausted(
                peerId,
                current,
                policy,
                now
            );
        }

        const latest = this.peerConnectionAttemptStateByPeerId.get(peerId);
        const next: WebRtcPeerConnectionAttemptState = latest
            ? {
                ...latest,
                attempts: latest.attempts + 1,
                lastAttemptAtEpochMs: now
            }
            : {
                peerId,
                attempts: 1,
                firstAttemptAtEpochMs: now,
                lastAttemptAtEpochMs: now
            };
        this.peerConnectionAttemptStateByPeerId.set(peerId, next);
        this.attemptBudgetDiagnostics.consumedCount += 1;
        return undefined;
    }

    private isPeerConnectionAttemptBudgetExhausted(
        state: WebRtcPeerConnectionAttemptState,
        policy: WebRtcPeerConnectionAttemptBudgetPolicy,
        now: number
    ): boolean {
        return state.attempts >= policy.maxAttempts ||
            now - state.firstAttemptAtEpochMs >= policy.maxTotalDurationMs;
    }

    private markPeerConnectionAttemptExhausted(
        peerId: PeerId,
        state: WebRtcPeerConnectionAttemptState,
        policy: WebRtcPeerConnectionAttemptBudgetPolicy,
        exhaustedAtEpochMs: number
    ): WebRtcPeerConnectionAttemptExhaustedEvent {
        const exhausted: WebRtcPeerConnectionAttemptState = {
            ...state,
            exhaustedAtEpochMs,
            retryAfterEpochMs: exhaustedAtEpochMs + policy.cooldownMs
        };
        this.peerConnectionAttemptStateByPeerId.set(peerId, exhausted);
        this.attemptBudgetDiagnostics.exhaustedCount += 1;
        const event = this.toPeerConnectionAttemptExhaustedEvent(
            exhausted,
            policy
        );
        this.emitPeerConnectionAttemptExhausted(event);
        return event;
    }

    private toPeerConnectionAttemptExhaustedEvent(
        state: WebRtcPeerConnectionAttemptState,
        policy: WebRtcPeerConnectionAttemptBudgetPolicy
    ): WebRtcPeerConnectionAttemptExhaustedEvent {
        return {
            ...this.toPeerConnectionAttemptDiagnostics(state, policy),
            exhaustedAtEpochMs: state.exhaustedAtEpochMs ??
                state.lastAttemptAtEpochMs,
            retryAfterEpochMs: state.retryAfterEpochMs ??
                state.lastAttemptAtEpochMs + policy.cooldownMs,
            reason: 'peer-connection-attempt-budget-exhausted'
        };
    }

    private toPeerConnectionAttemptDiagnostics(
        state: WebRtcPeerConnectionAttemptState,
        policy: WebRtcPeerConnectionAttemptBudgetPolicy = this.peerConnectionAttemptBudgetPolicy()
    ): WebRtcPeerConnectionAttemptDiagnostics {
        return {
            peerId: state.peerId,
            attempts: state.attempts,
            firstAttemptAtEpochMs: state.firstAttemptAtEpochMs,
            lastAttemptAtEpochMs: state.lastAttemptAtEpochMs,
            maxAttempts: policy.maxAttempts,
            maxTotalDurationMs: policy.maxTotalDurationMs,
            cooldownMs: policy.cooldownMs,
            exhaustedAtEpochMs: state.exhaustedAtEpochMs,
            retryAfterEpochMs: state.retryAfterEpochMs
        };
    }

    private emitPeerConnectionAttemptExhausted(
        event: WebRtcPeerConnectionAttemptExhaustedEvent
    ): void {
        for (const [_, cb] of this.onRtcPeerLifecycleCallbacks.entries()) {
            try {
                cb.onConnectExhausted?.(event);
            }
            catch (e) {
                console.error(
                    'Error calling onRtcPeerLifecycleCallbacks.onConnectExhausted',
                    e
                );
            }
        }
    }

    private clearPeerConnectionAttemptBudget(
        peerId: PeerId,
        reason: 'established' | 'removal'
    ): void {
        if (!this.peerConnectionAttemptStateByPeerId.delete(peerId)) {
            return;
        }
        if (reason === 'established') {
            this.attemptBudgetDiagnostics.resetOnSuccessCount += 1;
        }
        else {
            this.attemptBudgetDiagnostics.resetOnRemovalCount += 1;
        }
    }

    private peerConnectionAttemptBudgetPolicy(): WebRtcPeerConnectionAttemptBudgetPolicy {
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

    private isPeerEstablished(peerDto: QRtcPeerDto): boolean {
        return peerDto.connection.status.pc?.connectionState === 'connected' ||
            peerDto.connection.isOpen() ||
            Array.from(peerDto.channels.values()).some((channel) => {
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
        left: WebRtcPeerConnectionLeft
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

        console.error(`Failed to connect peer ${peerId}: ${left.kind}`, left.error);
    }

    private static toError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
    }
}

function isRtcSignalPayloadWithDescription(
    payload: unknown
): payload is QRtcDataExchanged {
    return isRecord(payload) && payload.description !== null &&
        payload.description !== undefined;
}

function isRtcSignalPayloadWithCandidate(
    payload: unknown
): payload is QRtcDataExchanged {
    return isRecord(payload) && payload.candidate !== null &&
        payload.candidate !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isOpenRtcChannelHealth(
    health: RtcDataChannelHealth | undefined
): boolean {
    return health?.readyState === 'open' || health?.state === 'Open';
}

function isClosedRtcChannelHealth(
    health: RtcDataChannelHealth | undefined
): boolean {
    return health?.readyState === 'closing' ||
        health?.readyState === 'closed' ||
        health?.state === 'Closed' ||
        health?.state === 'Failed';
}

async function waitForRtcChannelOpenOrAbort(
    channel: QRtcDataChannel,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined
): Promise<boolean> {
    const waitUntilOpen = timeoutMs === undefined
        ? channel.waitUntilOpen()
        : channel.waitUntilOpen(timeoutMs);

    if (!signal) {
        return await waitUntilOpen;
    }

    if (signal.aborted) {
        throw signal.reason;
    }

    return await new Promise<boolean>((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(signal.reason);
        };

        signal.addEventListener('abort', onAbort, { once: true });
        waitUntilOpen
            .then((opened) => {
                signal.removeEventListener('abort', onAbort);
                resolve(opened);
            })
            .catch((error) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            });
    });
}
