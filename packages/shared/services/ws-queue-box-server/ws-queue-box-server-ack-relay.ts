import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodeALControlMessage, type ALAckPayload } from '../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import { Either } from '../../resilience/Either.ts';
import type { WsQueueBoxServerReceiptAggregation } from './ws-queue-box-server-receipt-aggregation.ts';

/** Carries one receiver ACK to the other server instances; the left value names why it could not be sent. */
export type WsServerAckRelayPublisher = (
    message: ALMessage
) => Promise<Either<string, 'published'>>;

const RELAY_BUDGET_WINDOW_MS = 60_000;
const RELAY_BUDGET_PER_SESSION = 60;
const RELAY_BUDGET_SWEEP_SIZE = 1_024;

export namespace WsQueueBoxServerAckRelay {
    export interface Dependencies {
        readonly serverPeerId: string;
        readonly clock: { nowMs(): number; };
        /** The audience the origin's message was frozen to, read from the admission store every instance shares. */
        readonly readIngressAudience: (msgId: string, originPeerId: string) => Promise<readonly string[] | undefined>;
        readonly receipts: WsQueueBoxServerReceiptAggregation;
        readonly publishRelayedAck: WsServerAckRelayPublisher | undefined;
    }
}

/**
 * A receiver ACK counts only on the instance whose socket admitted the message, where its receipt aggregate
 * lives. An instance that holds no aggregate for the ACK hands it once to the others, and an instance that
 * receives a handed-over ACK counts it only against an aggregate of its own: it never hands it on again.
 * A notice costs one NOTIFY, so it is bounded twice before it is published: the inbound admission store must
 * hold the origin's message with the ACK's sender in its frozen audience, and each session may hand over a
 * fixed number of ACKs per window.
 */
export class WsQueueBoxServerAckRelay {
    readonly #serverPeerId: string;
    readonly #receipts: WsQueueBoxServerReceiptAggregation;
    readonly #publishRelayedAck: WsServerAckRelayPublisher | undefined;
    readonly #clock: { nowMs(): number; };
    readonly #readIngressAudience: WsQueueBoxServerAckRelay.Dependencies['readIngressAudience'];
    readonly #budgets = new Map<string, { windowEndsAtMs: number; used: number; }>();

    constructor(dependencies: WsQueueBoxServerAckRelay.Dependencies) {
        this.#serverPeerId = dependencies.serverPeerId;
        this.#clock = dependencies.clock;
        this.#readIngressAudience = dependencies.readIngressAudience;
        this.#receipts = dependencies.receipts;
        this.#publishRelayedAck = dependencies.publishRelayedAck;
    }

    /** The ingress check; an ACK this instance will hand over is checked only for what needs no aggregate. */
    readRelayedAckRejection(ack: ALAckPayload): ALMessageRejection | undefined {
        if (this.#publishRelayedAck === undefined || this.#receipts.holdsReceiptFor(ack)) {
            return this.#receipts.readRelayedAckRejection(ack);
        }
        return ack.toPeerId === ack.originPeerId ? undefined : {
            code: 'unauthorized',
            message: 'AL acknowledgement is not addressed to the origin it names'
        };
    }

    /**
     * Whether the admitted ACK left for the instance that aggregates it, in which case this instance admits
     * nothing; refused when its session has used its relay budget.
     */
    async relayUnownedAck(message: ALMessage): Promise<Either<ALMessageRejection, boolean>> {
        const publish = this.#publishRelayedAck;
        const ack = publish === undefined ? undefined : this.readUnownedAck(message);
        if (publish === undefined || ack === undefined) {
            return Either.ofRight(false);
        }
        if (!await this.isAdmittedTo(ack)) {
            return Either.ofLeft({
                code: 'unauthorized',
                message: 'AL acknowledgement names no message its origin admitted to this sender'
            });
        }
        if (!this.takeRelayBudget(message.id.senderId)) {
            return Either.ofLeft({
                code: 'unauthorized',
                message: 'AL acknowledgement relay budget of this session is used up'
            });
        }
        const published = await publish(message);
        if (published.left !== undefined) {
            console.warn(
                `AL acknowledgement ${message.id.msgId} for ${ack.originPeerId} was not relayed: ${published.left}`
            );
        }
        return Either.ofRight(true);
    }

    /** A handed-over ACK: counted against this instance's aggregate, or dropped without an answer. */
    async acceptRelayedAck(message: ALMessage): Promise<void> {
        const control = decodeALControlMessage(message).right;
        if (
            control?.type !== 'ack' || control.payload.toPeerId === this.#serverPeerId ||
            message.id.senderId !== control.payload.fromPeerId
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

    /** Fails closed: a missing row, another origin, a sender outside the audience or an unreadable store all refuse. */
    private async isAdmittedTo(ack: ALAckPayload): Promise<boolean> {
        try {
            const audience = await this.#readIngressAudience(ack.ackedMsgId, ack.originPeerId);
            return audience?.includes(ack.fromPeerId) === true;
        }
        catch (error) {
            console.warn(`AL acknowledgement ${ack.ackedMsgId} could not be checked against its admission:`, error);
            return false;
        }
    }

    private takeRelayBudget(sessionId: string): boolean {
        const nowMs = this.#clock.nowMs();
        if (this.#budgets.size >= RELAY_BUDGET_SWEEP_SIZE) {
            for (const [id, budget] of this.#budgets) {
                if (budget.windowEndsAtMs <= nowMs) {
                    this.#budgets.delete(id);
                }
            }
        }
        const current = this.#budgets.get(sessionId);
        const budget = current !== undefined && current.windowEndsAtMs > nowMs
            ? current
            : { windowEndsAtMs: nowMs + RELAY_BUDGET_WINDOW_MS, used: 0 };
        this.#budgets.set(sessionId, budget);
        budget.used += 1;
        return budget.used <= RELAY_BUDGET_PER_SESSION;
    }
}
