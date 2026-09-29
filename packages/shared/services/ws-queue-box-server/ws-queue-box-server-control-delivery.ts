import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodePersistedALMessageValue } from '../../al-contracts/al-message-persistence-validation.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime
} from '../../alm/outbound/al-outbound-message-runtime.ts';
import type { WsQueueBoxServerClusterPublication } from './ws-queue-box-server-cluster-publication.ts';
import type { WsQueueBoxServerLiveDelivery } from './ws-queue-box-server-live-delivery.ts';
import type { WsQueueBoxServerPreparedMessage } from './ws-queue-box-server-outbound-planning.ts';

/** Bounds an outbox row whose cluster publication keeps failing; a delivered row completes on its first dequeue. */
const WS_QUEUE_BOX_SERVER_HANDED_OFF_CONTROL_LIFETIME_MS = 30_000;

export namespace WsQueueBoxServerControlDelivery {
    export interface Dependencies {
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly liveDelivery: WsQueueBoxServerLiveDelivery;
        readonly clusterPublication: Pick<WsQueueBoxServerClusterPublication, 'hasPublisher'>;
        readonly outbound: Pick<ALOutboundMessageRuntime<WsQueueBoxServerPreparedMessage>, 'enqueueIfAbsent'>;
    }
}

/**
 * Sends the controls this instance's inbound work produces. Any instance may claim that work, so a
 * control whose target has no socket here goes to the outbox, whose dequeue publishes it to every
 * instance once; without a cluster publisher no other instance exists and the control is dropped.
 */
export class WsQueueBoxServerControlDelivery {
    readonly #dependencies: WsQueueBoxServerControlDelivery.Dependencies;

    constructor(dependencies: WsQueueBoxServerControlDelivery.Dependencies) {
        this.#dependencies = dependencies;
    }

    async sendControlMessages(messages: readonly ALMessage[]): Promise<void> {
        for (const message of messages) {
            await this.sendControlMessage(message);
        }
    }

    async sendControlMessage(message: ALMessage): Promise<void> {
        const toPeerId = message.targets?.mode === 'unicast' ? message.targets.toPeerId : undefined;
        if (!toPeerId) {
            console.warn(`Cannot send WS server control message without unicast target: ${message.payload.typeId}`);
            return;
        }
        if (this.#dependencies.liveDelivery.sendToResolvedPeer({ peerId: toPeerId, message }) > 0) {
            return;
        }
        if (!this.#dependencies.clusterPublication.hasPublisher()) {
            console.warn(`Cannot resolve WS server control target ${toPeerId} for ${message.payload.typeId}`);
            return;
        }
        await this.writeClusterOutboxRow(message, toPeerId);
    }

    private async writeClusterOutboxRow(message: ALMessage, toPeerId: string): Promise<void> {
        const handedOff = toWsQueueBoxServerHandedOffControl(message, this.#dependencies.clock.nowMs());
        const result = await this.#dependencies.outbound.enqueueIfAbsent(
            handedOff,
            toWsQueueBoxServerHandedOffControlPlan(handedOff)
        );
        console.log(
            `WS server control ${message.payload.typeId} ${message.id.msgId} has no socket for ${toPeerId} here; ` +
                `handed to the cluster outbox (${result.verdict.kind})`
        );
    }
}

function toWsQueueBoxServerHandedOffControl(message: ALMessage, nowMs: number): ALMessage {
    return decodePersistedALMessageValue({
        ...message,
        constraints: {
            ...message.constraints,
            expiresAtMs: message.constraints?.expiresAtMs ?? nowMs + WS_QUEUE_BOX_SERVER_HANDED_OFF_CONTROL_LIFETIME_MS
        }
    });
}

/** As a receipt's: a durable row whose immediate phase sends nothing, so its dequeue publishes it. */
function toWsQueueBoxServerHandedOffControlPlan(
    message: ALMessage
): ALOutboundDispatchPlan<WsQueueBoxServerPreparedMessage> {
    return { msg: message, dropReasonCode: undefined, persist: true, preparedMessages: [] };
}
