import { isRoomScopedALMessage, type ALMessage } from '../../al-contracts/al-contract.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../al-contracts/al-message-resource-limits.ts';
import { computeALSeqRangePage } from '../../al-contracts/al-seq-range.ts';
import { RetryableConflictError } from '../../resilience/TryWith.ts';
import type { ALOutboundPendingAckSnapshot } from '../al-runtime-state-stores.ts';
import type {
    ALOutboundAdmissionStore,
    ALOutboundPlanner,
    ALOutboundRepairHint,
    ALOutboundRepairReadDto
} from './admission/al-outbound-admission-store.ts';
import type { ALOutboundDispatchAdmission } from './al-outbound-dispatch-admission.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundRepairRequest,
    ALOutboundSettlementEmitter
} from './al-outbound-message-runtime.ts';
import { isALOutboundOwnHopPeer } from './is-al-outbound-own-hop-peer.ts';
import { toALOutboundRepairHintEffectId } from './to-al-outbound-effect-id.ts';
import {
    isALOutboundReceiptComplete,
    toALOutboundCompletedHopPeerIds
} from './transition-al-outbound-pending-ack.ts';

interface ALOutboundRetransmitOptions {
    readonly attemptIdentity: string;
}

interface ALOutboundCommitRepairInput<TPrepared> {
    readonly msg: ALMessage;
    readonly plan: ALOutboundDispatchPlan<TPrepared>;
    readonly priorAttempts: number;
    readonly maxAttempts: number;
    readonly attemptIdentity: string;
}

/** A repair budget a message has spent, as its exhaustion settlement states it. */
interface ALOutboundRepairExhaustion {
    readonly msgId: string;
    readonly attempts: number;
    readonly maxAttempts: number;
}

export namespace ALOutboundRepairRetransmission {
    export interface Dependencies<TPrepared> {
        readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
        readonly dispatchAdmission: ALOutboundDispatchAdmission<TPrepared>;
        readonly planOutgoingMessage: ALOutboundPlanner<TPrepared>;
        readonly planRepairMessage:
            | ((
                msg: ALMessage,
                request: ALOutboundRepairRequest
            ) => Promise<ALOutboundDispatchPlan<TPrepared> | undefined>)
            | undefined;
        /** The lane's guarded emitter: where a spent repair budget states that its message is skipped. */
        readonly settlements: ALOutboundSettlementEmitter;
    }
}

/**
 * Turns a repair hint into a new dispatch admission; the retry schedule that emitted the hint is elsewhere.
 * Without a repair planner a room-scoped message is retried along the sender's own hop only, so a retry
 * never widens a room audience.
 */
export class ALOutboundRepairRetransmission<TPrepared> {
    private readonly dependencies: ALOutboundRepairRetransmission.Dependencies<TPrepared>;
    /**
     * The messages whose exhaustion this runtime has stated, so a later hint for one states nothing more.
     * Memory rather than a row: the budget row keeps meaning what it means, and a reload states an
     * exhaustion once more at most. Capped at the repair window, oldest out first.
     */
    private readonly exhaustedMsgIds = new Set<string>();

    constructor(dependencies: ALOutboundRepairRetransmission.Dependencies<TPrepared>) {
        this.dependencies = dependencies;
    }

    /**
     * Serves one page of the hint's missing sequences, ascending, and re-commits the rest as one follow-up
     * hint, so a wide gap costs a bounded page of indexed reads and dispatch commits per execution. A hint
     * without ordering, or whose last page finds no cached message, repairs the message it names instead.
     */
    async retransmitFromRepairHint(
        fallbackMsgId: string,
        request: ALOutboundRepairHint,
        attemptIdentity: string
    ): Promise<void> {
        const trackKey = request.orderingTrackKey;
        if (trackKey === undefined || request.missingRanges.length === 0) {
            await this.repairByMsgId(fallbackMsgId, request, attemptIdentity);
            return;
        }

        const { page, remaining } = computeALSeqRangePage(
            request.missingRanges,
            AL_MESSAGE_RESOURCE_LIMITS.repairPageMessages
        );
        let served = false;
        for (const seq of page) {
            const cached = await this.dependencies.admissionStore.readSentMessageByOrdering(trackKey, seq);
            if (cached) {
                served = true;
                await this.repairByMsgId(cached.msgId, request, attemptIdentity);
            }
        }

        if (remaining.length > 0) {
            await this.commitFollowUpRepairHint(fallbackMsgId, { ...request, missingRanges: remaining });
        }
        else if (!served) {
            await this.repairByMsgId(fallbackMsgId, request, attemptIdentity);
        }
    }

    async retransmitByMsgId(
        msgId: string,
        options: ALOutboundRetransmitOptions
    ): Promise<void> {
        const sent = await this.dependencies.admissionStore.readSentMessage(msgId);
        if (!sent) {
            console.warn(`No cached outbound message found for retransmit ${msgId}`);
            return;
        }

        await this.dependencies.dispatchAdmission.commit({
            msg: sent.msg,
            planner: this.dependencies.planOutgoingMessage,
            intent: 'repair',
            phase: 'immediate',
            origin: 'repair',
            options: {
                attemptIdentity: options.attemptIdentity
            }
        });
    }

    private async repairByMsgId(
        msgId: string,
        request: ALOutboundRepairHint,
        attemptIdentity: string
    ): Promise<void> {
        const read = await this.dependencies.admissionStore.readRepairMessage(
            msgId,
            this.dependencies.planOutgoingMessage
        );
        const msg = read.sentSnapshot?.msg;
        const plan = read.plan;
        if (!msg || !plan || plan.dropReason) {
            console.warn(`No cached outbound message found for repair ${msgId}`);
            return;
        }

        if (request.trigger === 'ack-timeout') {
            await this.retryMissingAcknowledgements(read, request, attemptIdentity);
            return;
        }

        const repair = plan.repairTracking;
        if (!repair?.enabled || repair.algo === 'none') {
            return;
        }

        const attempts = read.repairAttempt?.attempts ?? 0;
        if (attempts >= repair.maxAttempts) {
            this.settleRepairExhausted({ msgId, attempts, maxAttempts: repair.maxAttempts });
            return;
        }

        const repairedPlan = await this.readRepairPlan(read, request);
        if (repairedPlan?.dropReason) {
            console.warn(`Skipping outbound repair dispatch: ${repairedPlan.dropReason}`);
            return;
        }
        if (!repairedPlan) {
            return;
        }

        await this.commitRepairPlan({
            msg,
            plan: repairedPlan,
            priorAttempts: attempts,
            maxAttempts: repair.maxAttempts,
            attemptIdentity
        });
    }

    /**
     * The rest of a hint as one new hint, fenced on the sender's version like every hint commit. A conflict
     * retries the whole execution: its page dispatches are deduplicated by their effect identities.
     */
    private async commitFollowUpRepairHint(msgId: string, request: ALOutboundRepairHint): Promise<void> {
        const read = await this.dependencies.admissionStore.readRepairMessage(
            msgId,
            this.dependencies.planOutgoingMessage
        );
        const msg = read.sentSnapshot?.msg;
        const expiresAtMs = read.storedMessage?.reference.expiresAtMs;
        if (!msg || expiresAtMs === undefined) {
            return;
        }

        const status = await this.dependencies.admissionStore.commitBundle({
            senderId: msg.id.senderId,
            expectedVersion: read.clientRecord?.version,
            mutations: [],
            durableEffects: [{
                effectId: toALOutboundRepairHintEffectId(msgId, request),
                expireAtTimestamp: expiresAtMs,
                payload: { kind: 'repair-hint', msgId, request }
            }]
        });
        if (status === 'conflict') {
            throw new RetryableConflictError('Outbound repair follow-up hint commit conflict');
        }
    }

    /** The terminal statement of a message whose repair budget is spent; a repeat states nothing. */
    private settleRepairExhausted(exhaustion: ALOutboundRepairExhaustion): void {
        if (this.exhaustedMsgIds.has(exhaustion.msgId)) {
            return;
        }
        this.exhaustedMsgIds.add(exhaustion.msgId);
        if (this.exhaustedMsgIds.size > AL_MESSAGE_RESOURCE_LIMITS.repairWindow) {
            const [oldest] = this.exhaustedMsgIds;
            this.exhaustedMsgIds.delete(oldest!);
        }

        this.dependencies.settlements({
            kind: 'admission',
            msgId: exhaustion.msgId,
            trackedReceiptAlgo: 'none',
            verdict: {
                kind: 'skipped',
                reason: 'repair-exhausted',
                detail:
                    `The repair of ${exhaustion.msgId} ran out of retransmits after ${exhaustion.attempts} of ${exhaustion.maxAttempts}.`
            }
        });
    }

    private async readRepairPlan(
        read: ALOutboundRepairReadDto<TPrepared>,
        request: ALOutboundRepairHint
    ): Promise<ALOutboundDispatchPlan<TPrepared> | undefined> {
        const msg = read.sentSnapshot?.msg;
        const plan = read.plan;
        const repair = plan?.repairTracking;
        if (!msg || !plan || !repair) {
            return undefined;
        }
        if (!this.dependencies.planRepairMessage) {
            return isRoomScopedALMessage(msg) && !isOwnHopRetry(plan, read.pendingAck) ? undefined : plan;
        }
        return await this.dependencies.planRepairMessage(msg, {
            ...request,
            completedHopPeerIds: [],
            repair,
            recipientScope: plan.recipientScope,
            principalTargetId: plan.principalTargetId,
            sessionInvalidation: plan.sessionInvalidation,
            admittedAudience: plan.admittedAudience,
            referenceKey: read.storedMessage?.reference.key
        });
    }

    private async retryMissingAcknowledgements(
        read: ALOutboundRepairReadDto<TPrepared>,
        request: ALOutboundRepairHint,
        attemptIdentity: string
    ): Promise<void> {
        const pending = read.pendingAck;
        const msg = read.sentSnapshot?.msg;
        const plan = read.plan;
        if (!pending || !msg || !plan || isALOutboundReceiptComplete(pending) || pending.maxAttempts <= 0) {
            return;
        }
        if (!this.dependencies.planRepairMessage && isRoomScopedALMessage(msg) && !isOwnHopRetry(plan, pending)) {
            return;
        }
        const retryPlan = this.dependencies.planRepairMessage
            ? await this.dependencies.planRepairMessage(msg, {
                ...request,
                recipientScope: plan.recipientScope,
                principalTargetId: plan.principalTargetId,
                sessionInvalidation: plan.sessionInvalidation,
                admittedAudience: plan.admittedAudience,
                referenceKey: read.storedMessage?.reference.key,
                failedPeerIds: toFailedPeerIds(pending),
                completedHopPeerIds: toALOutboundCompletedHopPeerIds(read.acks),
                repair: { enabled: true, algo: 'retransmit', maxAttempts: pending.maxAttempts }
            })
            : plan;
        if (!retryPlan || retryPlan.dropReason) {
            return;
        }
        // The timeout admission already charged the receipt retry budget. Gap
        // repair has its own policy and must not suppress or charge this retry.
        await this.dependencies.dispatchAdmission.commit({
            msg,
            planner: () => retryPlan,
            intent: 'repair',
            phase: 'immediate',
            origin: 'repair',
            options: { attemptIdentity }
        });
    }

    private async commitRepairPlan(repair: ALOutboundCommitRepairInput<TPrepared>): Promise<void> {
        await this.dependencies.dispatchAdmission.commit({
            msg: repair.msg,
            planner: () => repair.plan,
            intent: 'repair',
            phase: 'immediate',
            origin: 'repair',
            options: {
                repairBudget: { priorAttempts: repair.priorAttempts, maxAttempts: repair.maxAttempts },
                attemptIdentity: repair.attemptIdentity
            }
        });
    }
}

/** Whether the retry replays the sender's own hop: every peer still owed is one of the captured plan's next hops. */
function isOwnHopRetry<TPrepared>(
    plan: ALOutboundDispatchPlan<TPrepared>,
    pending: ALOutboundPendingAckSnapshot | undefined
): boolean {
    if (pending === undefined) {
        return false;
    }
    const failedPeerIds = toFailedPeerIds(pending);
    return failedPeerIds.length > 0 && failedPeerIds.every((peerId) => isALOutboundOwnHopPeer(plan, peerId));
}

function toFailedPeerIds(pending: ALOutboundPendingAckSnapshot): readonly string[] {
    return pending.expectedPeerIds.filter((peerId) => !pending.ackedPeerIds.includes(peerId));
}
