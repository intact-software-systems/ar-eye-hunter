import { ALMessage, newALEventRoute, newALUnicastMessage } from '../al-contracts/al-contract.ts';
import {
    QRtcSignalingMessage,
    QRtcSignalingTransport,
    QRtcSignalingTransportInputDto
} from './QRtcSignalingContracts.ts';
import WsQueueBoxClientService from '../services/WsQueueBoxClientService.ts';
import { ResourceEntry } from '../queuebox/ResourceEntry.ts';

export class WsRtcSignalingTransportUsingWsQBox implements QRtcSignalingTransport {

    private readonly id: string = 'signaling-ws-' + crypto.randomUUID().toString();

    public readonly qbox: WsQueueBoxClientService;
    public readonly typeId: string;
    private readonly wakeOutbox?: () => void;

    constructor(
        qbox: WsQueueBoxClientService,
        typeId: string,
        wakeOutbox?: () => void,
    ) {
        this.qbox = qbox;
        this.typeId = typeId;
        this.wakeOutbox = wakeOutbox;
    }

    connect(input: QRtcSignalingTransportInputDto): Promise<void> {
        this.qbox.socket.onWebsocketCallbacksDo(
            this.id,
            {
                onOpen: async () => {
                    try {
                        await input.callbacks.onOpen(input.sessionId, input.token);
                    } catch (e) {
                        console.error('Error in onOpen handler', e);
                    }
                },
                onClose: async () => {
                    try {
                        await input.callbacks.onClose(input.sessionId, input.token);
                    } catch (e) {
                        console.error('Error in onClose handler', e);
                    }
                },
                onError: async (error: Event) => {
                    try {
                        await input.callbacks.onError(input.sessionId, input.token, error.toString());
                    } catch (e) {
                        console.error('Error in onError handler', e);
                    }
                }
            }
        );

        this.qbox.onInboxMessageDo(
            this.typeId,
            {
                onMessage: async (message: ALMessage, _: ResourceEntry) => {
                    try {
                        if (message.payload.typeId !== this.typeId) {
                            throw new Error(`Unexpected message type: ${message.payload.typeId}`);
                        }

                        await input.callbacks.onMessage(input.sessionId, input.token, message);
                    } catch (e) {
                        console.error('Error in onMessage handler', e);
                    }

                    return Promise.resolve();
                }
            }
        );

        return this.qbox.socket.connect();
    }

    async send(payload: QRtcSignalingMessage): Promise<void> {
        const result = await this.qbox.enqueueOutboxIfAbsent(
            newALUnicastMessage(
                payload.fromId,
                newALEventRoute(this.typeId, payload.toId),
                payload.toId,
                this.typeId,
                payload
            )
        );
        if (result.status === 'enqueued' || result.status === 'duplicate') {
            this.wakeOutbox?.();
        }
    }
}
