import {
    QRtcSignalingClientMessage,
    QRtcSignalingTransport,
    QRtcSignalingTransportInputDto
} from "./QRtcSignalingContracts.ts";
import {JsonWebSocketClient} from "../websocket/JsonWebSocketClient.ts";

export class WsRtcSignalingTransport implements QRtcSignalingTransport {

    private readonly id: string = "signaling-ws-" + crypto.randomUUID().toString();

    constructor(
        public readonly socket: JsonWebSocketClient
    ) {
    }

    connect(input: QRtcSignalingTransportInputDto): Promise<void> {
        this.socket.onWebsocketCallbacksDo(
            this.id,
            {
                onOpen: async () => {
                    try {
                        await input.callbacks.onOpen(input.sessionId, input.token);
                    } catch (e) {
                        console.error("Error in onOpen handler", e)
                    }
                },
                onClose: async () => {
                    try {
                        await input.callbacks.onClose(input.sessionId, input.token);
                    } catch (e) {
                        console.error("Error in onClose handler", e)
                    }
                },
                onError: async (error: Event) => {
                    try {
                        await input.callbacks.onError(input.sessionId, input.token, error.toString());
                    } catch (e) {
                        console.error("Error in onError handler", e)
                    }
                }
            }
        )

        this.socket.onWebSocketMessageDo(
            this.id,
            {
                onMessage: async (data: unknown, _: MessageEvent): Promise<void> => {
                    try {
                        await input.callbacks.onMessage(input.sessionId, input.token, data)
                    } catch (e) {
                        console.error("Error in onMessage handler", e)
                    }

                    return Promise.resolve();
                }
            }
        )

        return this.socket.connect()
    }

    send(payload: QRtcSignalingClientMessage): void {
        this.socket.send(payload)
    }
}