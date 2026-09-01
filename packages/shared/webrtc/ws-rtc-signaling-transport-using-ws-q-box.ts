import { newALEventRoute, newALUnicastMessage } from '../al-contracts/al-contract.ts';
import { toError } from '../resilience/to-error.ts';
import { WsQueueBoxClientService } from '../services/ws-queue-box-client-service.ts';
import {
    QRtcSignalingMessage,
    QRtcSignalingTransport,
    QRtcSignalingTransportInputDto
} from './QRtcSignalingContracts.ts';

export class WsRtcSignalingTransportUsingWsQBox implements QRtcSignalingTransport {
    private readonly id: string = 'signaling-ws-' + crypto.randomUUID();

    public readonly qbox: WsQueueBoxClientService;
    public readonly typeId: string;
    private readonly wakeOutbox?: () => void;

    constructor(
        qbox: WsQueueBoxClientService,
        typeId: string,
        wakeOutbox?: () => void
    ) {
        this.qbox = qbox;
        this.typeId = typeId;
        this.wakeOutbox = wakeOutbox;
    }

    connect(input: QRtcSignalingTransportInputDto): Promise<void> {
        this.registerSocketLifecycle(input);
        this.registerInboxReceiver(input);
        return this.qbox.socket.connect();
    }

    private registerSocketLifecycle(input: QRtcSignalingTransportInputDto): void {
        this.qbox.socket.onWebsocketCallbacksDo(
            this.id,
            {
                onOpen: async () => {
                    try {
                        await input.callbacks.onOpen(input.sessionId, input.token);
                    }
                    catch (error) {
                        console.error('Error in onOpen handler', toError(error));
                    }
                },
                onClose: async () => {
                    try {
                        await input.callbacks.onClose(input.sessionId, input.token);
                    }
                    catch (error) {
                        console.error('Error in onClose handler', toError(error));
                    }
                },
                onError: async (error: Event) => {
                    try {
                        await input.callbacks.onError(input.sessionId, input.token, error.toString());
                    }
                    catch (error) {
                        console.error('Error in onError handler', toError(error));
                    }
                }
            }
        );
    }

    private registerInboxReceiver(input: QRtcSignalingTransportInputDto): void {
        this.qbox.onInboxMessageDo(
            this.typeId,
            {
                onMessage: async (message) => {
                    try {
                        await input.callbacks.onMessage(input.sessionId, input.token, message);
                    }
                    catch (error) {
                        console.error('Error in onMessage handler', toError(error));
                    }
                }
            }
        );
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
