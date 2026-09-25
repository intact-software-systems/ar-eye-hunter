import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    decodeALControlMessage,
    newALReceiptControlMessage,
    type ALAckPayload,
    type ALReceiptPayload
} from '../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import {
    normalizeALQosPolicy,
    resolveALMessageExpireAtMs,
    type ALMessageHandlingPlan,
    type ALQosNormalizationInput
} from '../../al-contracts/al-policy.ts';
import type { ALInboundMessageRuntime } from '../../alm/inbound/al-inbound-message-runtime.ts';
import type { ALOutboundEnqueueResult } from '../../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundControlAdmissionResult } from '../../alm/outbound/control/al-outbound-control-admission.ts';
import { Either } from '../../resilience/Either.ts';
import type { InboxOutboxEngine } from '../InboxOutboxEngine.ts';
import type { WsServerInboundAuthorization } from './ws-queue-box-server-contracts.ts';

export namespace WsQueueBoxServerReceiptAggregation {
    /** What the server froze when it admitted a `receiver` room message: the audience its receipt answers for. */
    export interface Admission {
        readonly msgId: string;
        readonly originPeerId: string;
        readonly expectedRecipientPeerIds: readonly string[];
        readonly snapshotVersion: number;
        readonly deadlineAtMs: number;
    }

    export interface Clock {
        nowMs(): number;
    }

    export interface Dependencies {
        readonly serverPeerId: string;
        readonly clock: Clock;
        readonly newControlId: () => string;
        /** The engine the service's queues run on; the deadline sweep rides it as one more task. */
        readonly queueEngine: InboxOutboxEngine;
        /** One `WS_OUTBOX` row per receipt, through the service's own outbox enqueue. */
        readonly enqueueOutbox: (message: ALMessage) => Promise<ALOutboundEnqueueResult>;
        /** The server's own outbound owner, which answers every control addressed to the server itself. */
        readonly acceptServerControl: (message: ALMessage) => Promise<ALOutboundControlAdmissionResult>;
    }

    export interface AdmittedMessage {
        readonly message: ALMessage;
        readonly originPeerId: string;
        readonly authorization: Extract<WsServerInboundAuthorization, { authorized: true; }>;
        /** The inbound normalization the server plans the message with. */
        readonly qos: ALQosNormalizationInput;
        readonly acceptance: ALInboundMessageRuntime.Acceptance | undefined;
    }

    export interface CountedAck {
        readonly receipt: ALReceiptPayload | undefined;
    }
}

interface WsQueueBoxServerReceiptAggregate extends WsQueueBoxServerReceiptAggregation.Admission {
    readonly confirmedRecipientPeerIds: readonly string[];
}

/**
 * The receipts of the `receiver` room messages this instance admitted, counted in memory (D37) and
 * answered to the origin as one outbox row per phase. An aggregate leaves the map when its audience is
 * confirmed or its deadline passes, so the map holds only messages still inside their deadline.
 */
export class WsQueueBoxServerReceiptAggregation {
    readonly #aggregates = new Map<string, WsQueueBoxServerReceiptAggregate>();
    readonly #dependencies: WsQueueBoxServerReceiptAggregation.Dependencies;
    readonly #sweepTaskId: string;

    constructor(dependencies: WsQueueBoxServerReceiptAggregation.Dependencies) {
        this.#dependencies = dependencies;
        this.#sweepTaskId = `${dependencies.serverPeerId}:receipt-sweep`;
        dependencies.queueEngine.includeTask(this.#sweepTaskId, {
            name: this.#sweepTaskId,
            maxConcurrency: () => 1,
            isWork: () => this.hasDueAggregate(),
            runnable: () => this.writeTimedOutReceipts(),
            ongoingTasks: []
        });
    }

    dispose(): void {
        this.#dependencies.queueEngine.excludeTask(this.#sweepTaskId);
    }

    aggregatesForOrigin(peerId: string): boolean {
        return [...this.#aggregates.values()].some((aggregate) => aggregate.originPeerId === peerId);
    }

    /** The `admitted` receipt the origin receives at once. An empty audience is complete as it is admitted. */
    recordAdmission(admission: WsQueueBoxServerReceiptAggregation.Admission): ALReceiptPayload {
        const key = toReceiptAggregateKey(admission.originPeerId, admission.msgId);
        const aggregate = this.#aggregates.get(key) ?? { ...admission, confirmedRecipientPeerIds: [] };
        if (aggregate.expectedRecipientPeerIds.length > 0) {
            this.#aggregates.set(key, aggregate);
        }
        return toReceiptPayload(aggregate, 'admitted', this.#dependencies.clock.nowMs());
    }

    /** A counted ACK; its `complete` receipt when it confirms the last expected recipient, none before. */
    recordAck(ack: ALAckPayload): Either<ALMessageRejection, WsQueueBoxServerReceiptAggregation.CountedAck> {
        const key = toReceiptAggregateKey(ack.originPeerId, ack.ackedMsgId);
        const aggregate = this.#aggregates.get(key);
        const nowMs = this.#dependencies.clock.nowMs();
        const issues = validateWsQueueBoxServerReceiptAck(aggregate, ack, nowMs);
        if (issues.length > 0 || aggregate === undefined) {
            return Either.ofLeft({ code: 'unauthorized', message: issues.join('; ') });
        }
        const next = {
            ...aggregate,
            confirmedRecipientPeerIds: [...aggregate.confirmedRecipientPeerIds, ack.logicalRecipientPeerId]
        };
        if (next.confirmedRecipientPeerIds.length < next.expectedRecipientPeerIds.length) {
            this.#aggregates.set(key, next);
            return Either.ofRight({ receipt: undefined });
        }
        this.#aggregates.delete(key);
        return Either.ofRight({ receipt: toReceiptPayload(next, 'complete', nowMs) });
    }

    /** The `timed-out` receipt of every aggregate whose deadline has passed; each leaves the map. */
    sweep(nowMs: number): readonly ALReceiptPayload[] {
        const receipts: ALReceiptPayload[] = [];
        for (const [key, aggregate] of this.#aggregates) {
            if (aggregate.deadlineAtMs <= nowMs) {
                this.#aggregates.delete(key);
                receipts.push(toReceiptPayload(aggregate, 'timed-out', nowMs));
            }
        }
        return receipts;
    }

    /** A message the server admitted, or retained for admission, starts its receipt here. */
    async writeAdmittedReceipt(admitted: WsQueueBoxServerReceiptAggregation.AdmittedMessage): Promise<void> {
        const kind = admitted.acceptance?.kind;
        const admission = kind === 'admitted' || kind === 'pending-admission'
            ? toWsQueueBoxServerReceiptAdmission(admitted, this.#dependencies.clock.nowMs())
            : undefined;
        if (admission !== undefined) {
            await this.writeReceipt(this.recordAdmission(admission));
        }
    }

    /**
     * A receiver ACK the server admitted as its origin's relay hop is counted here and never reaches
     * the server's own outbound owner, which answers only the controls addressed to the server.
     */
    async acceptControlMessage(message: ALMessage): Promise<void> {
        const control = decodeALControlMessage(message).right;
        if (control?.type !== 'ack' || control.payload.toPeerId === this.#dependencies.serverPeerId) {
            await this.#dependencies.acceptServerControl(message);
            return;
        }
        const receipt = this.recordAck(control.payload);
        if (receipt.left) {
            console.warn(`Refused WS receiver acknowledgement ${message.id.msgId}: ${receipt.left.message}`);
        }
        if (receipt.right?.receipt !== undefined) {
            await this.writeReceipt(receipt.right.receipt);
        }
    }

    private hasDueAggregate(): boolean {
        const deadlines = [...this.#aggregates.values()].map((aggregate) => aggregate.deadlineAtMs);
        const nextDeadlineAtMs = deadlines.length === 0 ? undefined : Math.min(...deadlines);
        this.#dependencies.queueEngine.wakeAt(this.#sweepTaskId, nextDeadlineAtMs);
        return nextDeadlineAtMs !== undefined && nextDeadlineAtMs <= this.#dependencies.clock.nowMs();
    }

    private async writeTimedOutReceipts(): Promise<void> {
        for (const receipt of this.sweep(this.#dependencies.clock.nowMs())) {
            await this.writeReceipt(receipt);
        }
    }

    private async writeReceipt(receipt: ALReceiptPayload): Promise<void> {
        const id = {
            v: 2 as const,
            msgId: this.#dependencies.newControlId(),
            senderId: this.#dependencies.serverPeerId,
            ts: receipt.observedAtEpochMs
        };
        await this.#dependencies.enqueueOutbox(newALReceiptControlMessage(id, receipt));
    }
}

/**
 * Under `receiver` the server is no logical recipient and never acknowledges on its own: the receipt
 * speaks for the audience, and a relay row would re-originate the receivers' ACKs as the origin.
 */
export function toWsQueueBoxServerInboundPlan(plan: ALMessageHandlingPlan): ALMessageHandlingPlan {
    return plan.ack.algo === 'receiver'
        ? { ...plan, ack: { enabled: false, algo: plan.ack.algo, deferred: false } }
        : plan;
}

/**
 * A `receiver` message the router authorized with a room audience is aggregated. The frozen audience
 * is that authorized audience less the origin and the target's own exclusions; a message without a
 * deadline answers within its ACK timeout.
 */
function toWsQueueBoxServerReceiptAdmission(
    admitted: WsQueueBoxServerReceiptAggregation.AdmittedMessage,
    nowMs: number
): WsQueueBoxServerReceiptAggregation.Admission | undefined {
    const { groupRecipientPeerIds, snapshotVersion } = admitted.authorization;
    const effective = normalizeALQosPolicy(admitted.message, admitted.qos).effective;
    if (groupRecipientPeerIds === undefined || snapshotVersion === undefined || effective.ack.algo !== 'receiver') {
        return undefined;
    }
    return {
        msgId: admitted.message.id.msgId,
        originPeerId: admitted.originPeerId,
        expectedRecipientPeerIds: toFrozenAudience(admitted.message, admitted.originPeerId, groupRecipientPeerIds),
        snapshotVersion,
        deadlineAtMs: resolveALMessageExpireAtMs(admitted.message, effective) ?? nowMs + effective.ack.opts.timeoutMs
    };
}

/** Every reason this ACK may not count; an absent aggregate makes the rest moot. */
function validateWsQueueBoxServerReceiptAck(
    aggregate: WsQueueBoxServerReceiptAggregate | undefined,
    ack: ALAckPayload,
    nowMs: number
): readonly string[] {
    if (aggregate === undefined) {
        return ['AL acknowledgement names no receipt this server aggregates'];
    }
    const issues: string[] = [];
    if (ack.fromPeerId !== ack.logicalRecipientPeerId) {
        issues.push('AL acknowledgement speaks for another recipient than its sender');
    }
    if (!aggregate.expectedRecipientPeerIds.includes(ack.logicalRecipientPeerId)) {
        issues.push('AL acknowledgement confirms no recipient of the frozen audience');
    }
    if (aggregate.confirmedRecipientPeerIds.includes(ack.logicalRecipientPeerId)) {
        issues.push('AL acknowledgement confirms a peer the receipt already counted');
    }
    if (aggregate.deadlineAtMs <= nowMs) {
        issues.push('AL acknowledgement arrived after its receipt deadline');
    }
    return issues;
}

function toFrozenAudience(
    message: ALMessage,
    originPeerId: string,
    authorizedPeerIds: readonly string[]
): readonly string[] {
    const targets = message.targets;
    return [...new Set(authorizedPeerIds)].filter((peerId) =>
        peerId !== originPeerId &&
        (targets?.mode !== 'broadcast' ||
            (!targets.exceptPeerIds?.includes(peerId) &&
                (targets.recipientPeerIds === undefined || targets.recipientPeerIds.includes(peerId))))
    );
}

function toReceiptAggregateKey(originPeerId: string, msgId: string): string {
    return JSON.stringify([originPeerId, msgId]);
}

function toReceiptPayload(
    aggregate: WsQueueBoxServerReceiptAggregate,
    phase: ALReceiptPayload['phase'],
    observedAtEpochMs: number
): ALReceiptPayload {
    return {
        msgId: aggregate.msgId,
        originPeerId: aggregate.originPeerId,
        expectedRecipientPeerIds: aggregate.expectedRecipientPeerIds,
        confirmedRecipientPeerIds: aggregate.confirmedRecipientPeerIds,
        snapshotVersion: aggregate.snapshotVersion,
        phase,
        observedAtEpochMs
    };
}
