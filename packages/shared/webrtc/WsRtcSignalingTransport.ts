import { ALMessage, newALEventRoute, newALUnicastMessage } from '../al-contracts/al-contract.ts';
import { JsonWebSocketClient } from '../websocket/JsonWebSocketClient.ts';
import {
    QRtcSignalingMessage,
    QRtcSignalingTransport,
    QRtcSignalingTransportInputDto
} from './QRtcSignalingContracts.ts';

export class WsRtcSignalingTransport implements QRtcSignalingTransport {
    private readonly id: string = 'signaling-ws-' + crypto.randomUUID().toString();

    public readonly socket: JsonWebSocketClient;
    public readonly typeId: string;

    constructor(
        socket: JsonWebSocketClient,
        typeId: string
    ) {
        this.socket = socket;
        this.typeId = typeId;
    }

    connect(input: QRtcSignalingTransportInputDto): Promise<void> {
        this.socket.onWebsocketCallbacksDo(
            this.id,
            {
                onOpen: async () => {
                    try {
                        await input.callbacks.onOpen(input.sessionId, input.token);
                    }
                    catch (e) {
                        console.error('Error in onOpen handler', e);
                    }
                },
                onClose: async () => {
                    try {
                        await input.callbacks.onClose(input.sessionId, input.token);
                    }
                    catch (e) {
                        console.error('Error in onClose handler', e);
                    }
                },
                onError: async (error: Event) => {
                    try {
                        await input.callbacks.onError(input.sessionId, input.token, error.toString());
                    }
                    catch (e) {
                        console.error('Error in onError handler', e);
                    }
                }
            }
        );

        this.socket.onWebSocketMessageDo(
            this.id,
            {
                onMessage: async (data: unknown, _: MessageEvent): Promise<void> => {
                    try {
                        const message = data as ALMessage;

                        if (message.payload.typeId !== this.typeId) {
                            console.log('Ignoring message for typeId: ', message.payload.typeId);
                            return;
                        }

                        await input.callbacks.onMessage(input.sessionId, input.token, message);
                    }
                    catch (e) {
                        console.error('Error in onMessage handler', e);
                    }

                    return Promise.resolve();
                }
            }
        );

        return this.socket.connect();
    }

    send(payload: QRtcSignalingMessage) {
        this.socket.send(
            newALUnicastMessage(
                payload.fromId,
                newALEventRoute(this.typeId, payload.toId),
                payload.toId,
                this.typeId,
                payload
            )
        );
        return Promise.resolve();
    }
}
