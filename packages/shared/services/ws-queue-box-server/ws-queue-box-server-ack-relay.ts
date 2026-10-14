import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodeALControlMessage, type ALAckPayload } from '../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import { Either } from '../../resilience/Either.ts';
import type { WsQueueBoxServerReceiptAggregation } from './ws-queue-box-server-receipt-aggregation.ts';
import {
    recordWsQueueBoxServerReceiptObservation,
    toImmutableWsQueueBoxServerReceiptAck,
    type WsQueueBoxServerReceiptAckFacts,
    type WsQueueBoxServerReceiptObserver
} from './ws-queue-box-server-receipt-observation.ts';

/** Carries one receiver ACK to the other server instances; the left value names why it could not be sent. */
export type WsServerAckRelayPublisher = (
    message: ALMessage
) => Promise<Either<string, 'published'>>;

const RELAY_BUDGET_WINDOW_MS = 60_000;
/** ACKs one session may relay for one admitted message per window: its own ACK of every copy a retrying origin sends. */
const RELAY_BUDGET_PER_AGGREGATE = 8;
/** ACKs whose admission a session may fail to prove per window before its unowned ACKs are refused unread. */
const UNPROVEN_RELAY_BUDGET_PER_SESSION = 60;
/** Budgets the map holds before a spend sweeps the expired ones, which it does at most once per window. */
const RELAY_BUDGET_SWEEP_SIZE = 1_024;

interface WsQueueBoxServerAckRelayRefusal {
    readonly outcome: 'provenance-refused' | 'budget-refused';
    readonly rejection: ALMessageRejection;
}

const UNPROVEN_REJECTION: ALMessageRejection = {
    code: 'unauthorized',
    message: 'AL acknowledgement names no message its origin admitted to this sender'
};
const UNPROVEN_BUDGET_REJECTION: ALMessageRejection = {
    code: 'unauthorized',
    message: 'AL acknowledgement relay budget of this session is used up'
};
const AGGREGATE_BUDGET_REJECTION: ALMessageRejection = {
    code: 'unauthorized',
    message: 'AL acknowledgement relay budget of this session for its message is used up'
};

export namespace WsQueueBoxServerAckRelay {
    export interface Dependencies {
        readonly serverPeerId: string;
        readonly receiptObserver?: WsQueueBoxServerReceiptObserver;
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
 * fixed number of ACKs per admitted message per window. That proof costs one store read, so a session whose
 * ACKs keep failing it is refused unread once it has spent its own budget of failures.
 */
export class WsQueueBoxServerAckRelay {
    readonly #serverPeerId: string;
    readonly #receiptObserver: WsQueueBoxServerReceiptObserver | undefined;
    readonly #receipts: WsQueueBoxServerReceiptAggregation;
    readonly #publishRelayedAck: WsServerAckRelayPublisher | undefined;
    readonly #clock: { nowMs(): number; };
    readonly #readIngressAudience: WsQueueBoxServerAckRelay.Dependencies['readIngressAudience'];
    readonly #budgets = new Map<string, { windowEndsAtMs: number; used: number; }>();
    #nextSweepAtMs = Number.NEGATIVE_INFINITY;

    constructor(dependencies: WsQueueBoxServerAckRelay.Dependencies) {
        this.#serverPeerId = dependencies.serverPeerId;
        this.#receiptObserver = dependencies.receiptObserver;
        this.#clock = dependencies.clock;
        this.#readIngressAudience = dependencies.readIngressAudience;
        this.#receipts = dependencies.receipts;
        this.#publishRelayedAck = dependencies.publishRelayedAck;
    }

    /** The ingress check; an ACK this instance will hand over is checked only for what needs no aggregate. */
    readRelayedAckRejection(
        ack: ALAckPayload,
        observation?: WsQueueBoxServerReceiptAggregation.ProtocolObservation
    ): ALMessageRejection | undefined {
        if (this.#publishRelayedAck === undefined || this.#receipts.holdsReceiptFor(ack)) {
            return this.#receipts.readRelayedAckRejection(ack, observation);
        }
        if (ack.toPeerId === ack.originPeerId) {
            return undefined;
        }
        const rejection: ALMessageRejection = {
            code: 'unauthorized',
            message: 'AL acknowledgement is not addressed to the origin it names'
        };
        if (this.#receiptObserver !== undefined && observation?.controlIdentity !== undefined) {
            try {
                recordWsQueueBoxServerReceiptObservation(this.#receiptObserver, {
                    kind: 'ack-rejection',
                    serverPeerId: this.#serverPeerId,
                    controlMsgId: observation.controlIdentity.msgId,
                    controlSenderId: observation.controlIdentity.senderId,
                    controlCreatedAtEpochMs: observation.controlIdentity.ts,
                    rejectionCode: 'unauthorized',
                    owner: 'ack-relay',
                    stage: observation.stage,
                    failedGuards: Object.freeze(['origin-addressee-mismatch'] as const)
                });
            }
            catch { /* Optional evidence cannot change the fixed-address refusal. */ }
        }
        return rejection;
    }

    /**
     * Whether the admitted ACK left for the instance that aggregates it, in which case this instance admits
     * nothing; refused when it is not proven or when its session used its relay budget for that message. A
     * notice that could not be published did not leave: this instance admits the ACK, which counts nowhere, and
     * the origin's ACK-timeout retry is what recovers it.
     */
    async relayUnownedAck(message: ALMessage): Promise<Either<ALMessageRejection, boolean>> {
        const publish = this.#publishRelayedAck;
        const ack = publish === undefined ? undefined : this.readUnownedAck(message);
        if (publish === undefined || ack === undefined) {
            return Either.ofRight(false);
        }
        const ackFacts = this.#receiptObserver
            ? Object.freeze({
                controlMsgId: message.id.msgId,
                controlSenderId: message.id.senderId,
                controlCreatedAtEpochMs: message.id.ts,
                ack: toImmutableWsQueueBoxServerReceiptAck(ack)
            })
            : undefined;
        const refusal = await this.spendRelayBudget(message.id.senderId, ack);
        if (refusal !== undefined) {
            this.recordRelayObservation(ackFacts, refusal.outcome);
            return Either.ofLeft(refusal.rejection);
        }
        const published = await publish(message);
        this.recordRelayObservation(ackFacts, published.left === undefined ? 'published' : 'publication-failed');
        if (published.left !== undefined) {
            console.warn(
                `AL acknowledgement ${message.id.msgId} for ${ack.originPeerId} was not relayed: ${published.left}`
            );
            return Either.ofRight(false);
        }
        return Either.ofRight(true);
    }

    /** A handed-over ACK: counted against this instance's aggregate, or dropped without an answer. */
    async acceptRelayedAck(message: ALMessage, relayPublisherId?: string): Promise<void> {
        const control = decodeALControlMessage(message).right;
        if (control?.type !== 'ack' || control.payload.toPeerId === this.#serverPeerId) {
            return;
        }
        await this.#receipts.acceptControlMessage(message, relayPublisherId, true);
    }

    private recordRelayObservation(
        ackFacts: WsQueueBoxServerReceiptAckFacts | undefined,
        outcome: 'provenance-refused' | 'budget-refused' | 'published' | 'publication-failed'
    ): void {
        if (ackFacts === undefined) {
            return;
        }
        recordWsQueueBoxServerReceiptObservation(this.#receiptObserver, {
            ...ackFacts,
            kind: 'ack-relay',
            serverPeerId: this.#serverPeerId,
            outcome
        });
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

    /**
     * Spends the budget the ACK is charged to, and names the refusal when there is none left: a proven ACK spends
     * its message's budget, and an unproven one its session's budget of failed proofs, which once spent refuses
     * the session's unowned ACKs before their store read.
     */
    private async spendRelayBudget(
        sessionId: string,
        ack: ALAckPayload
    ): Promise<WsQueueBoxServerAckRelayRefusal | undefined> {
        const unprovenKey = JSON.stringify(['unproven', sessionId]);
        if (!this.hasRelayBudget(unprovenKey, UNPROVEN_RELAY_BUDGET_PER_SESSION)) {
            return { outcome: 'budget-refused', rejection: UNPROVEN_BUDGET_REJECTION };
        }
        if (!await this.isAdmittedTo(ack)) {
            this.spendRelayBudgetUnit(unprovenKey);
            return { outcome: 'provenance-refused', rejection: UNPROVEN_REJECTION };
        }
        const aggregateKey = JSON.stringify(['aggregate', sessionId, ack.originPeerId, ack.ackedMsgId]);
        if (!this.hasRelayBudget(aggregateKey, RELAY_BUDGET_PER_AGGREGATE)) {
            return { outcome: 'budget-refused', rejection: AGGREGATE_BUDGET_REJECTION };
        }
        this.spendRelayBudgetUnit(aggregateKey);
        return undefined;
    }

    private hasRelayBudget(key: string, limit: number): boolean {
        const budget = this.#budgets.get(key);
        return budget === undefined || budget.windowEndsAtMs <= this.#clock.nowMs() || budget.used < limit;
    }

    private spendRelayBudgetUnit(key: string): void {
        const nowMs = this.#clock.nowMs();
        this.sweepExpiredRelayBudgets(nowMs);
        const current = this.#budgets.get(key);
        const budget = current !== undefined && current.windowEndsAtMs > nowMs
            ? current
            : { windowEndsAtMs: nowMs + RELAY_BUDGET_WINDOW_MS, used: 0 };
        this.#budgets.set(key, { ...budget, used: budget.used + 1 });
    }

    /** Every budget lives one window, so one sweep per window keeps the map within two windows of keys. */
    private sweepExpiredRelayBudgets(nowMs: number): void {
        if (this.#budgets.size < RELAY_BUDGET_SWEEP_SIZE || nowMs < this.#nextSweepAtMs) {
            return;
        }
        this.#nextSweepAtMs = nowMs + RELAY_BUDGET_WINDOW_MS;
        for (const [key, budget] of this.#budgets) {
            if (budget.windowEndsAtMs <= nowMs) {
                this.#budgets.delete(key);
            }
        }
    }
}
