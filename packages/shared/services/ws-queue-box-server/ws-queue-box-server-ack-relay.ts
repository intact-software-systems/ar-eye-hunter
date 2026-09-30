import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodeALControlMessage, type ALAckPayload } from '../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import type { Either } from '../../resilience/Either.ts';
import type { WsQueueBoxServerReceiptAggregation } from './ws-queue-box-server-receipt-aggregation.ts';

/** Carries one receiver ACK to the other server instances; the left value names why it could not be sent. */
export type WsServerAckRelayPublisher = (
    message: ALMessage
) => Promise<Either<string, 'published'>>;

export namespace WsQueueBoxServerAckRelay {
    export interface Dependencies {
        readonly serverPeerId: string;
        readonly receipts: WsQueueBoxServerReceiptAggregation;
        readonly publishRelayedAck: WsServerAckRelayPublisher | undefined;
    }
}

/**
 * A receiver ACK counts only on the instance whose socket admitted the message, where its receipt aggregate
 * lives. An instance that holds no aggregate for the ACK hands it once to the others, and an instance that
 * receives a handed-over ACK counts it only against an aggregate of its own: it never hands it on again.
 */
export class WsQueueBoxServerAckRelay {
    readonly #serverPeerId: string;
    readonly #receipts: WsQueueBoxServerReceiptAggregation;
    readonly #publishRelayedAck: WsServerAckRelayPublisher | undefined;

    constructor(dependencies: WsQueueBoxServerAckRelay.Dependencies) {
        this.#serverPeerId = dependencies.serverPeerId;
        this.#receipts = dependencies.receipts;
        this.#publishRelayedAck = dependencies.publishRelayedAck;
    }

    /** The ingress check; an ACK this instance will hand over is checked only for what needs no aggregate. */
    readRelayedAckRejection(ack: ALAckPayload): ALMessageRejection | undefined {
        if (this.#publishRelayedAck === undefined || this.#receipts.holdsReceiptFor(ack)) {
            return this.#receipts.readRelayedAckRejection(ack);
        }
        const issues = validateRelayableAck(ack);
        return issues.length === 0
            ? undefined
            : { code: 'unauthorized', message: issues.join('; ') };
    }

    /** Whether the admitted ACK left for the instance that aggregates it; this instance then admits nothing. */
    async relayUnownedAck(message: ALMessage): Promise<boolean> {
        const ack = this.readUnownedAck(message);
        if (ack === undefined || this.#publishRelayedAck === undefined) {
            return false;
        }
        const published = await this.#publishRelayedAck(message);
        if (published.left !== undefined) {
            console.warn(
                `AL acknowledgement ${message.id.msgId} for ${ack.originPeerId} was not relayed: ${published.left}`
            );
        }
        return true;
    }

    /** A handed-over ACK: counted against this instance's aggregate, or dropped without an answer. */
    async acceptRelayedAck(message: ALMessage): Promise<void> {
        const control = decodeALControlMessage(message).right;
        if (
            control?.type !== 'ack' || control.payload.toPeerId === this.#serverPeerId ||
            message.id.senderId !== control.payload.fromPeerId ||
            validateRelayableAck(control.payload).length > 0 ||
            !this.#receipts.holdsReceiptFor(control.payload)
        ) {
            return;
        }
        await this.#receipts.acceptControlMessage(message);
    }

    private readUnownedAck(message: ALMessage): ALAckPayload | undefined {
        const control = decodeALControlMessage(message).right;
        return control?.type === 'ack' && control.payload.toPeerId !== this.#serverPeerId &&
                !this.#receipts.holdsReceiptFor(control.payload)
            ? control.payload
            : undefined;
    }
}

function validateRelayableAck(ack: ALAckPayload): readonly string[] {
    const issues: string[] = [];
    if (ack.toPeerId !== ack.originPeerId) {
        issues.push('AL acknowledgement is not addressed to the origin it names');
    }
    if (ack.fromPeerId !== ack.logicalRecipientPeerId) {
        issues.push('AL acknowledgement speaks for another recipient than its sender');
    }
    return issues;
}
