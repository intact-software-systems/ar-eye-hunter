import { newALEventRoute, newALUnicastMessage, type ALMessage } from '../al-contracts/al-contract.ts';
import type { ALOutboundEnqueueResult, ALOutboundEnqueueStatus } from '../alm/outbound/al-outbound-message-runtime.ts';
import { toError } from '../resilience/to-error.ts';
import { WsQueueBoxClientService } from '../services/ws-queue-box-client-service.ts';
import {
    QRtcSignalingMessage,
    QRtcSignalingTransport,
    QRtcSignalingTransportInputDto
} from './QRtcSignalingContracts.ts';

/** What one admission of a signaling message means for the peer that is waiting on it. */
type SignalAdmissionOutcome = 'accepted' | 'retryable' | 'terminal';

/**
 * How long a rejected signal waits before its one re-send. The gates that produce a retryable status
 * -- a rate limit, a tripped dequeue circuit, a route that is not up yet -- clear on their own; this
 * is long enough for that and short enough to stay well inside a peer's readiness budget.
 */
const SIGNAL_ADMISSION_RETRY_DELAY_MS = 250;

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
                        return await input.callbacks.onMessage(input.sessionId, input.token, message);
                    }
                    catch (error) {
                        console.error('Error in onMessage handler', toError(error));
                    }
                }
            }
        );
    }

    /**
     * A rejected signal is re-admitted once, as the same message rather than a new negotiation: the
     * peer that produced it is already in `have-local-offer`, where `onnegotiationneeded` cannot fire
     * again, so a dropped offer strands that peer for the rest of its life. Re-admitting the same
     * message id is idempotent, and a status that will never clear is thrown immediately instead.
     */
    async send(payload: QRtcSignalingMessage): Promise<void> {
        const message = newALUnicastMessage(
            payload.fromId,
            newALEventRoute(this.typeId, payload.toId),
            payload.toId,
            this.typeId,
            payload
        );
        const admitted = await this.admitSignal(message);
        if (toSignalAdmissionOutcome(admitted.status) === 'accepted') {
            return;
        }
        if (toSignalAdmissionOutcome(admitted.status) === 'terminal') {
            throw toSignalAdmissionError(admitted);
        }
        await pauseFor(SIGNAL_ADMISSION_RETRY_DELAY_MS);
        const readmitted = await this.admitSignal(message);
        if (toSignalAdmissionOutcome(readmitted.status) !== 'accepted') {
            throw toSignalAdmissionError(readmitted);
        }
    }

    private async admitSignal(message: ALMessage): Promise<ALOutboundEnqueueResult> {
        const result = await this.qbox.enqueueOutboxIfAbsent(message);
        if (result.status === 'enqueued' || result.status === 'duplicate' || result.status === 'pending-admission') {
            this.wakeOutbox?.();
        }
        return result;
    }
}

function toSignalAdmissionOutcome(status: ALOutboundEnqueueStatus): SignalAdmissionOutcome {
    switch (status) {
        case 'enqueued':
        case 'duplicate':
        case 'pending-admission':
        case 'accepted':
            return 'accepted';
        case 'no-route':
        case 'rate-limited':
        case 'circuit-open':
            return 'retryable';
        case 'skipped':
        case 'superseded':
        case 'expired':
        case 'failed':
            return 'terminal';
    }
}

function toSignalAdmissionError(result: ALOutboundEnqueueResult): Error {
    return new Error(result.reason ?? `Signaling admission returned ${result.status}`);
}

function pauseFor(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}
