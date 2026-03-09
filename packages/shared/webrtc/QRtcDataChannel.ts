import { OnQRtcMessageCallback, QRtcClientCallbacks } from "./QRtcClientCallbacks.ts";
import { QRtcPeerConnection } from "./QRtcPeerConnection.ts";

enum RtcSessionState {
    Idle = 'Idle',
    Connecting = 'Connecting',
    Open = 'Open',
    Closed = 'Closed',
    Failed = 'Failed',
}

enum RtcRole {
    None = 'None',
    Initiator = 'Initiator',
    Receiver = 'Receiver',
}

export type RtcDataChannelInputDto = {
    readonly peerId: string
    readonly dataChannelName: string
}

type QRtcDataChannelStatus = {
    state: RtcSessionState | undefined
    role: RtcRole
    dc: RTCDataChannel | undefined
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
            role: RtcRole.None,
            dc: undefined
        }
    }

    reset() {
        this.closeDataChannelIfPresent();
        this.status.state = RtcSessionState.Idle;
    }

    clearCallbacks() {
        this.clientCallbacks.clear();
        this.onMessageCallbacks.clear();
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

        if (this.status.dc.readyState !== "open") {
            console.error("Data channel not open for " + this.input.dataChannelName + " and " + this.input.peerId + " peer", new Error().stack ?? "")
            throw new Error("Data channel not open");
        }

        this.status.dc.send(data)

        return Promise.resolve()
    }

    // ----------------------------------------
    // Connection logic
    // ----------------------------------------

    connect(isInitiator: boolean) {
        if (this.isOpen() || (!this.isReadyToConnect() && !this.peerConnection.isReadyToConnect())) {
            console.log("Ignoring connect, data connection is in progress and not ready to connect: " + this.status.state + " role " + this.status.role +
                " peerId " + this.input.peerId + " dataChannelName " + this.input.dataChannelName)
            return
        }

        this.status.state = RtcSessionState.Connecting;
        this.status.role = isInitiator ? RtcRole.Initiator : RtcRole.Receiver;

        this.peerConnection
            .onDataChannelDo(
                this.input.peerId,
                event => {

                    if (event.channel.label !== this.input.dataChannelName) {
                        console.error("Received data channel for different data channel name: " + event.channel.label + " vs " + this.input.dataChannelName)
                        return Promise.resolve()
                    }
                    if (this.status.dc && this.status.dc !== event.channel) {
                        this.closeDataChannelIfPresent()
                    }

                    this.status.dc = event.channel;

                    this.setupDataChannelCallbacks(this.status.dc);
                    console.log("Data channel created: " + this.status.dc.label)

                    return Promise.resolve()
                }
            )

        if (isInitiator) {
            this.status.dc = this.peerConnection.createDataChannel(this.input.dataChannelName);

            console.log("Data channel created: " + this.status.dc.label)

            this.setupDataChannelCallbacks(this.status.dc);
        } else {
            console.log("Waiting for data channel to be created for " + this.input.dataChannelName + " and " + this.input.peerId + " peer")
        }
    }

    private setupDataChannelCallbacks(dc: RTCDataChannel) {
        dc.onopen = () => {
            if (this.status.dc !== dc) {
                console.warn("Received data channel open event for different data channel: " + dc.label + " vs " + this.status.dc?.label)
                return
            }

            console.log("Data channel open for " + this.input.dataChannelName + " and " + this.input.peerId + " peer")

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
            if (this.status.dc !== dc) {
                console.warn("Received data message for a different channel: " + dc.label + " vs " + this.status.dc?.label)
                return
            }

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
            if (this.status.dc !== dc) {
                console.warn("Received data channel close event for different data channel: " + dc.label + " vs " + this.status.dc?.label)
                return
            }

            console.error("Data channel closed for " + this.input.dataChannelName + " and " + this.input.peerId + " peer", new Error().stack ?? "")

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
            if (this.status.dc !== dc) {
                console.warn("Received data channel error event for different data channel: " + dc.label + " vs " + this.status.dc?.label)
                return
            }

            console.log("Data channel error for " + this.input.dataChannelName + " and " + this.input.peerId + " peer")

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
