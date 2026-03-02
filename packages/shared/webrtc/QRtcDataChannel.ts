import {OnQRtcMessageCallback, QRtcClientCallbacks} from "./QRtcClientCallbacks.ts";
import {
    QRtcSignalingChannel,
    QRtcSignalingMessage,
    QRtcSignalingMsgType,
    QRtcSignalingTransport,
    QRtcSignalingTransportCallbacks,
    QRtcSignalingTransportInputDto,
    QRtcSignalingType
} from "./QRtcSignalingContracts.ts";
import {IceConfig} from "../api/api-config.ts";
import {ALMessage} from "../al-contracts/al-contract.ts";

enum RtcSessionState {
    Idle = 'Idle',
    Connecting = 'Connecting',
    Open = 'Open',
    Closed = 'Closed',
    Failed = 'Failed',
}

export type RtcDataChannelInputDto = {
    readonly clientId: string,
    readonly sessionId: string
    readonly token: string
    readonly remoteClientId: string
    readonly iceCandidates: IceConfig
    readonly dataChannelName: string
}

type QRtcDataChannelStatus = {
    state: RtcSessionState | undefined
    pc: RTCPeerConnection | undefined
    dc: RTCDataChannel | undefined
    isPolite: boolean
    makingOffer: boolean
    ignoreOffer: boolean
    readonly signalerInput: QRtcSignalingTransportInputDto
}

type QRtcDataExchanged = {
    description: RTCSessionDescription | null
    candidate: RTCIceCandidateInit | null
}


export class QRtcDataChannel {
    private readonly configuration;
    private readonly status: QRtcDataChannelStatus;

    private readonly clientCallbacks = new Map<string, QRtcClientCallbacks>();
    private readonly onMessageCallbacks = new Map<string, OnQRtcMessageCallback>();

    constructor(
        public readonly signaler: QRtcSignalingTransport,
        public readonly input: RtcDataChannelInputDto
    ) {
        this.configuration = {
            iceServers: [...this.input.iceCandidates.iceServers]
        };

        this.status = {
            state: RtcSessionState.Idle,
            pc: undefined,
            dc: undefined,
            isPolite: this.input.clientId < this.input.remoteClientId,
            makingOffer: false,
            ignoreOffer: false,
            signalerInput: {
                sessionId: this.input.sessionId,
                token: this.input.token,
                callbacks: this.toSignalingProtocol()
            }
        }
    }

    private toSignalingProtocol(): QRtcSignalingTransportCallbacks {
        return {
            onOpen: async (sessionId: string, token: string) => {
                console.log(`Signaling transport open for ${sessionId} and ${token}`)
            },

            onError: async (_: string, __: string, message: string) => {
                console.error("Signaling transport error: " + message)
            },

            onClose: async (sessionId: string, token: string) => {
                console.log(`Signaling transport closed for ${sessionId} and ${token}`)
            },

            onMessage: async (sessionId: string, token: string, message: ALMessage) => {
                console.log(`Message received for ${sessionId} and ${token} ${message.payload.resource}`)

                const msg: QRtcSignalingMessage = JSON.parse(message.payload.resource) as QRtcSignalingMessage

                if (msg.toId !== this.input.clientId) {
                    console.log("Message not for us, ignoring: " + message.payload.resource)
                    return
                }

                await this.handleSignal(
                    msg.signalType,
                    msg.payload as QRtcDataExchanged
                )
            }
        };
    }

    async connect() {
        await this.signaler.connect(this.status.signalerInput)

        this.initialiseRtc()
    }

    // ----------------------------------------
    // Callback registry
    // ----------------------------------------

    onRtcCallbacksDo(
        id: string,
        clientCallbacks: QRtcClientCallbacks
    ) {
        this.clientCallbacks.set(id, clientCallbacks);
        return this
    }

    onRtcMessageDo(
        id: string,
        onMessage: OnQRtcMessageCallback
    ) {
        this.onMessageCallbacks.set(id, onMessage);
        return this
    }

    removeRtcCallbackById(id: string): boolean {
        return this.clientCallbacks.delete(id);
    }

    removeOnRtcMessageCallbackById(id: string): boolean {
        return this.onMessageCallbacks.delete(id);
    }

    // ----------------------------------------
    // Send data on data channel
    // ----------------------------------------
    sendAsJsonString(data: string): Promise<void> {
        if (!this.status.dc) {
            throw new Error("Data channel not open");
        }

        this.status.dc.send(data)

        return Promise.resolve()
    }


    // ----------------------------------------
    // Connection logic
    // ----------------------------------------

    initialiseRtc() {
        this.status.state = RtcSessionState.Connecting;

        const pc = new RTCPeerConnection(this.configuration);
        this.status.pc = pc

        // When pc.createDataChannel is called, it will trigger this event
        pc.onnegotiationneeded = async () => {
            try {
                this.status.makingOffer = true;
                await pc.setLocalDescription();

                const description: RTCSessionDescription | null = pc.localDescription;
                this.sendSignal(
                    QRtcSignalingType.Offer,
                    {
                        description: description,
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
                console.log("ICE Candidate: " + JSON.stringify(event.candidate))

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

        this.setupStateChangeCallbacks(pc);

        // Handle incoming Data Channels
        pc.ondatachannel =
            event => {
                this.status.dc = event.channel;

                this.setupDataChannelCallbacks(event.channel);
            };

        // Create the initial channel if we are the one initiating
        this.status.dc = pc.createDataChannel(this.input.dataChannelName);

        this.setupDataChannelCallbacks(this.status.dc);
    }

    async handleSignal(signal: QRtcSignalingType, msg: QRtcDataExchanged) {

        const pc = this.status.pc;
        if (!pc) {
            return Promise.reject("PeerConnection not initialized");
        }

        if (msg.description) {

            const offerCollision =
                signal === QRtcSignalingType.Offer && (this.status.makingOffer || pc.signalingState !== "stable");

            this.status.ignoreOffer = !this.status.isPolite && offerCollision;

            if (this.status.ignoreOffer) {
                return;
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

            if (signal === QRtcSignalingType.Offer) {
                await pc.setLocalDescription();

                this.sendSignal(
                    QRtcSignalingType.Answer,
                    {
                        description: pc.localDescription,
                        candidate: null,
                    }
                );
            }
        }


        if (msg.candidate) {
            try {
                await pc.addIceCandidate(msg.candidate);

            } catch (err) {
                if (!this.status.ignoreOffer) {
                    throw err;
                }
            }
        }
    }

    isOpen() {
        return this.status.state === RtcSessionState.Open;
    }

    sendSignal(signalType: QRtcSignalingType, payload: QRtcDataExchanged): void {
        this.signaler.send(
            {
                channel: QRtcSignalingChannel.RtcSignal,
                type: QRtcSignalingMsgType.Signal,
                fromId: this.input.clientId,
                toId: this.input.remoteClientId,
                sessionId: this.input.sessionId,
                token: this.input.token,
                signalType: signalType,
                payload: payload
            }
        );
    }

    private setupStateChangeCallbacks(pc: RTCPeerConnection) {
        pc.oniceconnectionstatechange = () => {
            console.log("ICE Connection State: " + pc.iceConnectionState)
        }

        pc.onconnectionstatechange = () => {
            switch (pc.connectionState) {
                case "connected":
                    this.status.state = RtcSessionState.Open;
                    break;
                case "closed":
                    this.status.state = RtcSessionState.Closed;
                    break;
                case "failed":
                    this.status.state = RtcSessionState.Failed;
                    break;
                case "connecting":
                case "disconnected":
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

    private setupDataChannelCallbacks(dc: RTCDataChannel) {
        dc.onopen = () => {
            this.status.state = RtcSessionState.Open

            for (const callback of this.clientCallbacks.values()) {
                try {
                    callback.onOpen?.()
                } catch (e) {
                    console.error("Callback onOpen failed:", e);
                }
            }
        };

        dc.onmessage = async event => {
            for (const callback of this.onMessageCallbacks.values()) {
                try {
                    await callback.onMessage(event.data, event)
                } catch (e) {
                    console.error("Callback onMessage failed:", e);
                }
            }
        };

        dc.onclose = async () => {
            this.status.state = RtcSessionState.Closed;

            for (const callback of this.clientCallbacks.values()) {
                try {
                    await callback.onClose?.()
                } catch (e) {
                    console.error("Callback onClose failed:", e);
                }
            }
        };

        dc.onerror = async () => {
            this.status.state = RtcSessionState.Failed;

            for (const callback of this.clientCallbacks.values()) {
                try {
                    await callback.onError?.()
                } catch (e) {
                    console.error("Callback onError failed:", e);
                }
            }
        };
    }
}