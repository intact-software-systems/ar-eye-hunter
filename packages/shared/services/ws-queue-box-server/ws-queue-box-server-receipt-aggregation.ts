import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    AL_RECEIPT_DEADLINE_GRACE_MS,
    decodeALControlMessage,
    newALReceiptControlMessage,
    type ALAckPayload,
    type ALReceiptPayload
} from '../../al-contracts/al-control.ts';
import {
    decodePersistedALMessageValue,
    type ALMessageRejection
} from '../../al-contracts/al-message-persistence-validation.ts';
import {
    normalizeALQosPolicy,
    resolveALMessageExpireAtMs,
    resolveALQosNormalizationInput,
    type ALMessageHandlingPlan,
    type ALQosInputProvider
} from '../../al-contracts/al-policy.ts';
import { DEFAULT_AL_EPHEMERAL_TTL_MS } from '../../alm/ALStoreRetention.ts';
import type { ALInboundMessageRuntime } from '../../alm/inbound/al-inbound-message-runtime.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundEnqueueResult,
    ALOutboundMessageRuntime
} from '../../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundControlAdmissionResult } from '../../alm/outbound/control/al-outbound-control-admission.ts';
import { Either } from '../../resilience/Either.ts';
import type { InboxOutboxEngine } from '../InboxOutboxEngine.ts';
import type { WsServerRoomAudience } from './ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerPreparedMessage } from './ws-queue-box-server-outbound-planning.ts';

/**
 * The longest the server holds a receipt aggregate in memory: the retention of the durable effect and
 * pending-control rows the same outbound owner keeps (`DEFAULT_AL_EPHEMERAL_TTL_MS`). The origin accepts
 * a terminal receipt until its own deadline plus the receipt grace, so an earlier `timed-out` still lands.
 */
export const WS_QUEUE_BOX_SERVER_RECEIPT_WINDOW_MS = DEFAULT_AL_EPHEMERAL_TTL_MS;

export namespace WsQueueBoxServerReceiptAggregation {
    /** What the server froze when it admitted a `receiver` room message: the audience its receipt answers for. */
    export interface Admission {
        readonly msgId: string;
        readonly originPeerId: string;
        readonly expectedRecipientPeerIds: readonly string[];
        readonly snapshotVersion: number;
        readonly deadlineAtMs: number;
    }

    export interface Dependencies {
        readonly serverPeerId: string;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly newControlId: () => string;
        readonly qosProvider: ALQosInputProvider | undefined;
        /** The engine the service's queues run on; the deadline sweep rides it as one more task. */
        readonly queueEngine: InboxOutboxEngine;
        /**
         * The service's outbound owner admitting one receipt as a durable `WS_OUTBOX` row, so its
         * dequeue reaches the origin through the cluster publisher wherever the origin is connected.
         */
        readonly enqueueOutbox: (
            message: ALMessage,
            plan: ALOutboundDispatchPlan<WsQueueBoxServerPreparedMessage>
        ) => Promise<ALOutboundEnqueueResult>;
        /** The server's own outbound owner, which answers every control addressed to the server itself. */
        readonly acceptServerControl: (message: ALMessage) => Promise<ALOutboundControlAdmissionResult>;
    }

    export interface AdmittedMessage {
        readonly message: ALMessage;
        readonly originPeerId: string;
        readonly roomAudience: WsServerRoomAudience | undefined;
        readonly acceptance: ALInboundMessageRuntime.Acceptance | undefined;
    }

    export interface CountedAck {
        readonly receipt: ALReceiptPayload | undefined;
        /** The aggregate's message deadline, which the receipt row outlives by the receipt grace. */
        readonly deadlineAtMs: number;
    }
}

interface WsQueueBoxServerReceiptAggregate extends WsQueueBoxServerReceiptAggregation.Admission {
    readonly confirmedRecipientPeerIds: readonly string[];
}

/**
 * The receipts of the `receiver` room messages this instance admitted, counted in memory (D37) and
 * answered to the origin as one durable outbox row per phase. It is also the server's control router:
 * a receiver ACK relayed for an origin is counted here, every other control goes to the server's own
 * outbound owner. An aggregate leaves the map when its audience is confirmed or its deadline passes.
 */
export class WsQueueBoxServerReceiptAggregation {
    readonly #aggregates = new Map<string, WsQueueBoxServerReceiptAggregate>();
    readonly #dependencies: WsQueueBoxServerReceiptAggregation.Dependencies;
    readonly #sweepTaskId: string;
    #nextDeadlineAtMs: number | undefined;

    constructor(dependencies: WsQueueBoxServerReceiptAggregation.Dependencies) {
        this.#dependencies = dependencies;
        this.#sweepTaskId = `${dependencies.serverPeerId}:receipt-sweep`;
        dependencies.queueEngine.includeTask(this.#sweepTaskId, {
            name: this.#sweepTaskId,
            maxConcurrency: () => 1,
            isWork: () => {
                this.scheduleNextSweep();
                return this.hasDueAggregate();
            },
            runnable: () => this.writeTimedOutReceipts(),
            ongoingTasks: []
        });
    }

    dispose(): void {
        this.#dependencies.queueEngine.excludeTask(this.#sweepTaskId);
    }

    /** The typed reason a relayed receiver ACK may not count, read against the live aggregate at ingress. */
    readRelayedAckRejection(ack: ALAckPayload): ALMessageRejection | undefined {
        const aggregate = this.#aggregates.get(toReceiptAggregateKey(ack.originPeerId, ack.ackedMsgId));
        const issues = validateWsQueueBoxServerReceiptAck(aggregate, ack, this.#dependencies.clock.nowMs());
        return issues.length === 0 ? undefined : { code: 'unauthorized', message: issues.join('; ') };
    }

    /** The `admitted` receipt the origin receives at once. An empty audience is complete as it is admitted. */
    recordAdmission(admission: WsQueueBoxServerReceiptAggregation.Admission): ALReceiptPayload {
        const key = toReceiptAggregateKey(admission.originPeerId, admission.msgId);
        const aggregate = this.#aggregates.get(key) ?? { ...admission, confirmedRecipientPeerIds: [] };
        if (aggregate.expectedRecipientPeerIds.length > 0 && !this.#aggregates.has(key)) {
            this.#aggregates.set(key, aggregate);
            this.#nextDeadlineAtMs = Math.min(this.#nextDeadlineAtMs ?? aggregate.deadlineAtMs, aggregate.deadlineAtMs);
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
            return Either.ofRight({ receipt: undefined, deadlineAtMs: next.deadlineAtMs });
        }
        this.deleteAggregate(key);
        return Either.ofRight({ receipt: toReceiptPayload(next, 'complete', nowMs), deadlineAtMs: next.deadlineAtMs });
    }

    /** The `timed-out` receipt of every aggregate whose deadline has passed; each leaves the map. */
    sweep(nowMs: number): readonly ALReceiptPayload[] {
        const receipts: ALReceiptPayload[] = [];
        for (const [key, aggregate] of this.#aggregates) {
            if (aggregate.deadlineAtMs <= nowMs) {
                this.deleteAggregate(key);
                receipts.push(toReceiptPayload(aggregate, 'timed-out', nowMs));
            }
        }
        return receipts;
    }

    /**
     * A message the server admitted, or retained for admission, starts its receipt here, once: a
     * re-sent message the runtime answers `pending-admission` again finds its aggregate already live.
     */
    async writeAdmittedReceipt(admitted: WsQueueBoxServerReceiptAggregation.AdmittedMessage): Promise<void> {
        const kind = admitted.acceptance?.kind;
        if (admitted.roomAudience === undefined || (kind !== 'admitted' && kind !== 'pending-admission')) {
            return;
        }
        const admission = this.toAdmission(admitted, admitted.roomAudience);
        if (
            admission !== undefined &&
            !this.#aggregates.has(toReceiptAggregateKey(admission.originPeerId, admission.msgId))
        ) {
            await this.writeReceipt(this.recordAdmission(admission), admission.deadlineAtMs);
        }
    }

    /**
     * A receiver ACK the server admitted as its origin's relay hop is counted here and never reaches
     * the server's own outbound owner, which answers only the controls addressed to the server. Ingress
     * already refused an ACK that could not count; one that loses a race to the sweep counts nothing.
     */
    async acceptControlMessage(message: ALMessage): Promise<void> {
        const control = decodeALControlMessage(message).right;
        if (control?.type !== 'ack' || control.payload.toPeerId === this.#dependencies.serverPeerId) {
            await this.#dependencies.acceptServerControl(message);
            return;
        }
        const counted = this.recordAck(control.payload).right;
        if (counted?.receipt !== undefined) {
            await this.writeReceipt(counted.receipt, counted.deadlineAtMs);
        }
    }

    /**
     * A `receiver` room message is aggregated; a message without a deadline answers within its ACK
     * timeout, and no aggregate outlives the server's receipt window, whatever deadline the client named.
     */
    private toAdmission(
        admitted: WsQueueBoxServerReceiptAggregation.AdmittedMessage,
        roomAudience: WsServerRoomAudience
    ): WsQueueBoxServerReceiptAggregation.Admission | undefined {
        const { message, originPeerId } = admitted;
        const { serverPeerId, qosProvider, clock } = this.#dependencies;
        const qos = resolveALQosNormalizationInput(
            message,
            { selfPeerId: serverPeerId, fromPeerId: originPeerId, direction: 'inbound' },
            qosProvider
        );
        const effective = normalizeALQosPolicy(message, qos).effective;
        return effective.ack.algo !== 'receiver' ? undefined : {
            msgId: message.id.msgId,
            originPeerId,
            expectedRecipientPeerIds: toFrozenAudience(message, originPeerId, roomAudience.recipientPeerIds),
            snapshotVersion: roomAudience.snapshotVersion,
            deadlineAtMs: Math.min(
                resolveALMessageExpireAtMs(message, effective) ?? clock.nowMs() + effective.ack.opts.timeoutMs,
                clock.nowMs() + WS_QUEUE_BOX_SERVER_RECEIPT_WINDOW_MS
            )
        };
    }

    private deleteAggregate(key: string): void {
        this.#aggregates.delete(key);
        let nextDeadlineAtMs: number | undefined;
        for (const aggregate of this.#aggregates.values()) {
            nextDeadlineAtMs = Math.min(nextDeadlineAtMs ?? aggregate.deadlineAtMs, aggregate.deadlineAtMs);
        }
        this.#nextDeadlineAtMs = nextDeadlineAtMs;
    }

    /** The engine forgets a wake once it fires, so each poll arms the next deadline again. */
    private scheduleNextSweep(): void {
        this.#dependencies.queueEngine.wakeAt(this.#sweepTaskId, this.#nextDeadlineAtMs);
    }

    private hasDueAggregate(): boolean {
        return this.#nextDeadlineAtMs !== undefined && this.#nextDeadlineAtMs <= this.#dependencies.clock.nowMs();
    }

    private async writeTimedOutReceipts(): Promise<void> {
        const nowMs = this.#dependencies.clock.nowMs();
        for (const receipt of this.sweep(nowMs)) {
            await this.writeReceipt(receipt, nowMs);
        }
    }

    /** A receipt row outlives its message's deadline by the receipt grace, as the origin's receipt row does. */
    private async writeReceipt(receipt: ALReceiptPayload, deadlineAtMs: number): Promise<void> {
        const id = {
            v: 2 as const,
            msgId: this.#dependencies.newControlId(),
            senderId: this.#dependencies.serverPeerId,
            ts: receipt.observedAtEpochMs
        };
        const expiresAtMs = Math.max(deadlineAtMs, receipt.observedAtEpochMs) + AL_RECEIPT_DEADLINE_GRACE_MS;
        const message = decodePersistedALMessageValue({
            ...newALReceiptControlMessage(id, receipt),
            constraints: { expiresAtMs }
        });
        await this.#dependencies.enqueueOutbox(message, toWsQueueBoxServerReceiptDispatchPlan(message));
    }
}

/**
 * The server withholds its own ACK only for a `receiver` room message it aggregates: there the receipt
 * speaks for the audience, and a relay row would re-originate the receivers' ACKs as the origin. A
 * `receiver` message the server receives for itself keeps its ACK.
 */
export function toWsQueueBoxServerInboundPlan(
    plan: ALMessageHandlingPlan,
    source: ALInboundMessageRuntime.Source
): ALMessageHandlingPlan {
    const aggregated = plan.ack.algo === 'receiver' && source.kind === 'ws-client' &&
        source.groupRecipientPeerIds !== undefined;
    return aggregated ? { ...plan, ack: { enabled: false, algo: plan.ack.algo, deferred: false } } : plan;
}

/**
 * A receipt is a durable outbox row: its immediate phase resolves nobody, and its dequeue reaches the
 * origin's socket on this instance or, through the cluster publisher, on another. The control message
 * itself stays volatile and best-effort, as every control must (`validateControlEnvelope`), so the QoS
 * planner would plan it volatile: the durable plan is built here instead, for the row alone.
 */
function toWsQueueBoxServerReceiptDispatchPlan(
    message: ALMessage
): ALOutboundDispatchPlan<WsQueueBoxServerPreparedMessage> {
    return { msg: message, dropReasonCode: undefined, persist: true, preparedMessages: [] };
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
    if (ack.toPeerId !== ack.originPeerId) {
        issues.push('AL acknowledgement is not addressed to the origin it names');
    }
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
