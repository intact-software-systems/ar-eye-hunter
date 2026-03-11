import { ALMessage } from '../al-contracts/al-contract.ts';
import { IceConfig, PeerId } from '../api/api-config.ts';
import {
    QRtcDataChannel,
    type RtcDataChannelFlowControlPolicy,
    type RtcDataChannelHealth,
} from '../webrtc/QRtcDataChannel.ts';
import { QRtcMediaChannel } from '../webrtc/QRtcMediaChannel.ts';
import { QRtcDataExchanged, QRtcPeerConnection } from '../webrtc/QRtcPeerConnection.ts';
import {
    QRtcSignalingMessage,
    QRtcSignalingTransport,
    QRtcSignalingTransportCallbacks
} from '../webrtc/QRtcSignalingContracts.ts';
import { Either } from '../resilience/Either.ts';

export type WebRtcQueueBoxClientServiceInputDto = {
    readonly sessionId: string
    readonly token: string
    readonly iceCandidates: IceConfig
    readonly dataChannelName: string
    readonly dataChannelLanes?: readonly RtcDataChannelLaneConfig[]
    readonly rtcSignalingTopicId: string
}

export type RtcDataChannelLaneConfig = Readonly<{
    id: string;
    label: string;
    init?: RTCDataChannelInit;
    binaryType?: BinaryType;
    flowControl?: RtcDataChannelFlowControlPolicy;
}>;

export type QRtcPeerDto = {
    peerId: PeerId
    connection: QRtcPeerConnection
    channel: QRtcDataChannel
    channels: ReadonlyMap<string, QRtcDataChannel>
    media: QRtcMediaChannel
}

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
    kind: 'signal-handle-failed';
    peerId: PeerId;
    error: Error;
}
>;

type ComputedPeerConnection = Readonly<{
    peerDto: QRtcPeerDto;
    shouldConnect: boolean;
}>;

export interface OnRtcPeerLifecycleCallback {
    onCreated(peerDto: QRtcPeerDto): void;

    onDeleted(peerDto: QRtcPeerDto): void;
}

export class WebRtcConnectionService {

    private readonly onRtcPeerLifecycleCallbacks: Map<string, OnRtcPeerLifecycleCallback> = new Map();

    private readonly peerDtoByPeerId = new Map<PeerId, QRtcPeerDto>();
    private readonly pendingConnections = new Map<PeerId, Promise<Either<WebRtcPeerConnectionLeft, QRtcPeerDto>>>();

    constructor(
        public readonly signaler: QRtcSignalingTransport,
        public readonly input: WebRtcQueueBoxClientServiceInputDto
    ) {
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

    removePeerIfPresent(peerId: string): boolean {
        console.log(`Cleaning up peer: ${peerId}`);
        const rtcPeer: QRtcPeerDto | undefined = this.peerDtoByPeerId.get(peerId);
        if (rtcPeer === undefined) {
            console.log(`Peer ${peerId} not found. Ignoring`);
            return false;
        }

        for (const [_, cb] of this.onRtcPeerLifecycleCallbacks.entries()) {
            cb.onDeleted(rtcPeer);
        }

        rtcPeer.media?.reset();
        for (const channel of rtcPeer.channels.values()) {
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

    connectedPeerIds(): readonly string[] {
        return Array.from(this.peerDtoByPeerId.entries())
            .filter(([, peerDto]) =>
                this.isPeerConnectedOrInProgress(peerDto) &&
                !this.hasReconnectableDataChannels(peerDto)
            )
            .map(([peerId]) => peerId);
    }

    readPeer(peerId: string): QRtcPeerDto | undefined {
        return this.peerDtoByPeerId.get(peerId);
    }

    readPeerChannel(
        peerId: string,
        laneId: string = DEFAULT_RTC_DATA_CHANNEL_LANE_ID,
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
                    channel: channel.readHealth(),
                })),
        };
    }

    readAllPeerHealth(): readonly RtcPeerHealth[] {
        return Array.from(this.peerDtoByPeerId.keys())
            .map((peerId) => this.readPeerHealth(peerId))
            .filter((health): health is RtcPeerHealth => health !== undefined);
    }

    disconnectPeer(peerId: string): boolean {
        return this.removePeerIfPresent(peerId);
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
                    throw new Error('Message received for wrong session id: ' + sessionId + ' expected: ' + this.input.sessionId);
                }

                const msg: QRtcSignalingMessage = JSON.parse(message.payload.resource) as QRtcSignalingMessage;

                const peerId = msg.fromId;

                if (msg.toId !== sessionId) {
                    console.log('Message not for us, ignoring: ' + message.payload.resource);
                    return Promise.resolve();
                } else if (peerId === sessionId) {
                    console.log('Ignoring message from self msg.fromId' + peerId + ' my session id' + sessionId, new Error().stack);
                    return Promise.resolve();
                }

                const peerDto = this.peerDtoByPeerId.get(peerId);
                if (!peerDto) {
                    const accepted = await this.acceptPeerIfAbsent(peerId, msg);
                    if (accepted.left) {
                        this.logPeerConnectionLeft(peerId, accepted.left);
                    }
                } else {
                    await peerDto.connection.handleSignal(
                        msg.signalType,
                        msg.payload as QRtcDataExchanged
                    );
                }

                return Promise.resolve();
            }
        };
    }

    async acceptPeerIfAbsent(
        peerId: string,
        message: QRtcSignalingMessage,
    ): Promise<Either<WebRtcPeerConnectionLeft, QRtcPeerDto>> {
        const connected = await this.connectToPeerIfAbsent(peerId);
        if (connected.left) {
            return connected;
        }

        const peerDto = connected.right;
        if (!peerDto) {
            return Either.ofLeft<WebRtcPeerConnectionLeft, QRtcPeerDto>({
                kind: 'connect-failed',
                peerId,
                error: new Error(`Peer ${peerId} missing after successful connection`),
            });
        }

        try {
            await peerDto.connection.handleSignal(
                message.signalType,
                message.payload as QRtcDataExchanged,
            );
            return Either.ofRight<WebRtcPeerConnectionLeft, QRtcPeerDto>(peerDto);
        } catch (error) {
            return Either.ofLeft<WebRtcPeerConnectionLeft, QRtcPeerDto>({
                kind: 'signal-handle-failed',
                peerId,
                error: WebRtcConnectionService.toError(error),
            });
        }
    }

    async connectToPeerIfAbsent(
        peerId: string,
        isInitiator: boolean = !this.isPolite(peerId),
    ): Promise<Either<WebRtcPeerConnectionLeft, QRtcPeerDto>> {
        if (peerId === this.input.sessionId) {
            return Either.ofLeft<WebRtcPeerConnectionLeft, QRtcPeerDto>({
                kind: 'self',
                peerId,
            });
        }

        const previousAttempt: Promise<unknown> = this.pendingConnections.get(peerId) ?? Promise.resolve();
        const newPromise: Promise<Either<WebRtcPeerConnectionLeft, QRtcPeerDto>> =
            previousAttempt
                .catch((error) => {
                    console.error(`Error during previous connect to peer ${peerId}`, error);
                })
                .then(() => this._connectToPeerIfAbsent(peerId, isInitiator));

        this.pendingConnections.set(peerId, newPromise);

        try {
            return await newPromise;
        } finally {
            if (this.pendingConnections.get(peerId) === newPromise) {
                this.pendingConnections.delete(peerId);
            }
        }
    }

    private _connectToPeerIfAbsent(
        peerId: string,
        isInitiator: boolean,
    ): Either<WebRtcPeerConnectionLeft, QRtcPeerDto> {
        try {
            const computed = this.computeRtcPeerDtoIfAbsent(peerId);
            if (computed.shouldConnect) {
                computed.peerDto.connection.connect(
                    {
                        onClosed: (peerId: string) => {
                            console.log(`Connection to peer ${peerId} closed, removing from queue box`);
                            this.removePeerIfPresent(peerId);
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
        } catch (error) {
            const existingPeerDto = this.peerDtoByPeerId.get(peerId);
            if (existingPeerDto && this.isPeerConnectedOrInProgress(existingPeerDto)) {
                return Either.ofRight<WebRtcPeerConnectionLeft, QRtcPeerDto>(existingPeerDto);
            }

            return Either.ofLeft<WebRtcPeerConnectionLeft, QRtcPeerDto>({
                kind: 'connect-failed',
                peerId,
                error: WebRtcConnectionService.toError(error),
            });
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

    private computeRtcPeerDtoIfAbsent(peerId: string): ComputedPeerConnection {
        const existingPeerDto: QRtcPeerDto | undefined = this.peerDtoByPeerId.get(peerId);
        if (existingPeerDto !== undefined) {
            const connectionState = existingPeerDto.connection.status.pc?.connectionState;

            if (this.isPeerConnectedOrInProgress(existingPeerDto)) {
                if (this.hasReconnectableDataChannels(existingPeerDto)) {
                    console.log(`Peer ${peerId} has reconnectable data channels. Reusing connection and reconnecting channels`);
                    return {
                        peerDto: existingPeerDto,
                        shouldConnect: true,
                    };
                }

                // console.log(`Peer ${peerId} already in ${existingPeerDto.connection.status.state}/${connectionState}. Reuse existing connection`);
                return {
                    peerDto: existingPeerDto,
                    shouldConnect: false,
                };
            }

            if (existingPeerDto.connection.isReadyToConnect()) {
                console.log(`Peer connection to ${peerId} already exists in state ${connectionState}. Reuse existing connection`);
                return {
                    peerDto: existingPeerDto,
                    shouldConnect: true,
                };
            }

            console.log(`Peer connection to ${peerId} exists in state ${connectionState}. Removing existing connection`);
            this.removePeerIfPresent(peerId);
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
            ),
        };

        this.peerDtoByPeerId.set(peerId, rtcPeerDto);

        for (const [_, cb] of this.onRtcPeerLifecycleCallbacks.entries()) {
            try {
                cb.onCreated(rtcPeerDto);
            } catch (e) {
                console.error('Error calling onRtcPeerLifecycleCallbacks.onCreated', e);
            }
        }

        return {
            peerDto: rtcPeerDto,
            shouldConnect: true,
        };
    }

    private createDataChannels(
        connection: QRtcPeerConnection,
        peerId: string,
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
                        flowControl: lane.flowControl,
                    },
                ),
            );
        }

        return channels;
    }

    private dataChannelLanes(): readonly RtcDataChannelLaneConfig[] {
        const explicit = this.input.dataChannelLanes ?? [];
        const hasReliable = explicit.some((lane) =>
            lane.id === DEFAULT_RTC_DATA_CHANNEL_LANE_ID
        );

        if (hasReliable) {
            return explicit;
        }

        return [
            {
                id: DEFAULT_RTC_DATA_CHANNEL_LANE_ID,
                label: this.input.dataChannelName,
            },
            ...explicit,
        ];
    }

    private isPolite(peerId: string) {
        return this.input.sessionId < peerId;
    }

    private logPeerConnectionLeft(
        peerId: string,
        left: WebRtcPeerConnectionLeft,
    ): void {
        if (left.kind === 'self') {
            console.warn(`Ignoring self-connection attempt for peer ${peerId}`);
            return;
        }

        console.error(`Failed to connect peer ${peerId}: ${left.kind}`, left.error);
    }

    private static toError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
    }
}
