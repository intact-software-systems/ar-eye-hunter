import { ALMessage, newALEventRoute, newALUnicastMessage } from '../al-contracts/al-contract.ts';
import {
    QRtcSignalingMessage,
    QRtcSignalingTransport,
    QRtcSignalingTransportInputDto
} from './QRtcSignalingContracts.ts';
import WsQueueBoxClientService from '../services/WsQueueBoxClientService.ts';
import { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import {
    emitRtcSignalingTrace,
    type RtcSignalingTraceOptions,
} from './RtcSignalingTrace.ts';

export class WsRtcSignalingTransportUsingWsQBox implements QRtcSignalingTransport {

    private readonly id: string = 'signaling-ws-' + crypto.randomUUID().toString();

    constructor(
        public readonly qbox: WsQueueBoxClientService,
        public readonly typeId: string,
        private readonly wakeOutbox?: () => void,
        private readonly rtcSignalingTrace: RtcSignalingTraceOptions = {},
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

                        const traced = emitRtcSignalingTrace(
                            message,
                            'rtc-dispatched',
                            this.rtcSignalingTrace,
                        );
                        await input.callbacks.onMessage(
                            input.sessionId,
                            input.token,
                            traced.message,
                        );
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
        const message = newALUnicastMessage(
            payload.fromId,
            newALEventRoute(this.typeId, payload.toId),
            payload.toId,
            this.typeId,
            payload,
        );
        const result = await this.qbox.enqueueOutboxIfAbsent(
            message,
        );
        emitRtcSignalingTrace(
            message,
            'client-outbox-enqueued',
            this.rtcSignalingTrace,
        );
        if (result.status === 'enqueued' || result.status === 'duplicate') {
            this.wakeOutbox?.();
        }
    }
}
