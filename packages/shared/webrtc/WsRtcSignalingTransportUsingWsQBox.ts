import { ALMessage, toALMessage } from "../al-contracts/al-contract.ts";
import {
    QRtcSignalingMessage,
    QRtcSignalingTransport,
    QRtcSignalingTransportInputDto
} from "./QRtcSignalingContracts.ts";
import { WsQueueBoxClientService } from "../services/WsQueueBoxClientService.ts";

export class WsRtcSignalingTransportUsingWsQBox implements QRtcSignalingTransport {

    private readonly id: string = "signaling-ws-" + crypto.randomUUID().toString();

    constructor(
        public readonly qbox: WsQueueBoxClientService,
        public readonly typeId: string
    ) {
    }

    connect(input: QRtcSignalingTransportInputDto): Promise<void> {
        this.qbox.socket.onWebsocketCallbacksDo(
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

        this.qbox.onInboxMessageDo(
            this.id,
            {
                onMessage: async (entry) => {
                    try {
                        const message = JSON.parse(entry.resource) as ALMessage;
                        if (message.payload.typeId !== this.typeId) {
                            console.log("Ignoring message for typeId: ", message.payload.typeId)
                            return
                        }

                        await input.callbacks.onMessage(input.sessionId, input.token, message)
                    } catch (e) {
                        console.error("Error in onMessage handler", e)
                    }

                    return Promise.resolve();
                }
            }
        )

        return this.qbox.socket.connect()
    }

    async send(payload: QRtcSignalingMessage): Promise<void> {
        await this.qbox.enqueueOutboxIfAbsent(
            toALMessage(
                payload.fromId,
                this.typeId,
                payload
            )
        )
    }
}