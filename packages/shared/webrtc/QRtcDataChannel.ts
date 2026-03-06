import {OnQRtcMessageCallback, QRtcClientCallbacks} from "./QRtcClientCallbacks.ts";
import {QRtcPeerConnection} from "./QRtcPeerConnection.ts";

enum RtcSessionState {
    Idle = 'Idle',
    Connecting = 'Connecting',
    Open = 'Open',
    Closed = 'Closed',
    Failed = 'Failed',
}

export type RtcDataChannelInputDto = {
    readonly peerId: string
    readonly dataChannelName: string
}

type QRtcDataChannelStatus = {
    state: RtcSessionState | undefined
    dc: RTCDataChannel | undefined
}

export type QRtcDataExchanged = {
    description: RTCSessionDescription | null
    candidate: RTCIceCandidateInit | null
}

export class QRtcDataChannel {
    public readonly status: QRtcDataChannelStatus;

    private readonly clientCallbacks = new Map<string, QRtcClientCallbacks>();
    private readonly onMessageCallbacks = new Map<string, OnQRtcMessageCallback>();

    constructor(
        public readonly peerConnection: QRtcPeerConnection,
        public readonly input: RtcDataChannelInputDto
    ) {
        this.status = {
            state: RtcSessionState.Idle,
            dc: undefined
        }
    }

    reset() {
        this.closeDataChannelIfPresent();
        this.status.state = RtcSessionState.Idle;
    }

    private closeDataChannelIfPresent() {
        if (this.status?.dc) {
            try {
                this.status?.dc?.close?.()
                this.status.dc = undefined
            } catch (e) {
                console.error("Error closing data channel. Ignoring ...", e)
            }
        }
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

    async connect(isInitiator: boolean) {
        if (this.isOpen()) {
            console.log("Data connection already open")
            return
        } else if (!this.isReadyToConnect()) {
            console.log("Data connection is in progress and not ready to connect")
            return
        }

        this.status.state = RtcSessionState.Connecting;

        this.peerConnection
            .onDataChannelDo(
                this.input.peerId,
                event => {
                    this.closeDataChannelIfPresent()

                    this.status.dc = event.channel;

                    this.setupDataChannelCallbacks(this.status.dc);
                    console.log("Data channel created: " + this.status.dc.label)

                    return Promise.resolve()
                }
            )

        await this.peerConnection.connect()

        // TODO: If I am accepting do I need to create the data channel?
        if (isInitiator) {
            this.status.dc = this.peerConnection.createDataChannel(this.input.dataChannelName);

            console.log("Data channel created: " + this.status.dc.label)

            this.setupDataChannelCallbacks(this.status.dc);
        }
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
            console.log("WebRTC Received: " + JSON.stringify(event.data))

            for (const callback of this.onMessageCallbacks.values()) {
                try {
                    if (typeof event.data == "string") {
                        await callback.onMessage(JSON.parse(event.data), event)
                    } else {
                        await callback.onMessage(event.data, event)
                    }
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

    isOpen() {
        return this.status.state === RtcSessionState.Open;
    }

    isReadyToConnect() {
        return this.status.state === RtcSessionState.Idle ||
            this.status.state === RtcSessionState.Failed ||
            this.status.state === RtcSessionState.Closed;
    }
}
