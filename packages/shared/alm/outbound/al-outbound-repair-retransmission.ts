import { isRoomScopedALMessage, type ALMessage } from '../../al-contracts/al-contract.ts';
import { toALSeqsInRanges } from '../../al-contracts/al-seq-range.ts';
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
    ALOutboundRepairRequest
} from './al-outbound-message-runtime.ts';
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
    }
}

/**
 * Turns a repair hint into a new dispatch admission; the retry schedule that emitted the hint is elsewhere.
 * Without a repair planner a room-scoped message is retried along the sender's own hop only, so a retry
 * never widens a room audience.
 */
export class ALOutboundRepairRetransmission<TPrepared> {
    private readonly dependencies: ALOutboundRepairRetransmission.Dependencies<TPrepared>;

    constructor(dependencies: ALOutboundRepairRetransmission.Dependencies<TPrepared>) {
        this.dependencies = dependencies;
    }

    async retransmitFromRepairHint(
        fallbackMsgId: string,
        request: ALOutboundRepairHint,
        attemptIdentity: string
    ): Promise<void> {
        if (request.orderingTrackKey && request.missingRanges.length > 0) {
            let retransmitted = false;

            for (const seq of toALSeqsInRanges(request.missingRanges)) {
                const cached = await this.dependencies.admissionStore.readSentMessageByOrdering(
                    request.orderingTrackKey,
                    seq
                );
                if (!cached) {
                    continue;
                }

                retransmitted = true;
                await this.repairByMsgId(cached.msgId, request, attemptIdentity);
            }

            if (retransmitted) {
                return;
            }
        }

        await this.repairByMsgId(fallbackMsgId, request, attemptIdentity);
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
            console.warn(`Repair budget exceeded for message ${msgId}`);
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

/**
 * Whether the retry replays the sender's own hop: every peer still owed is one of the next hops the captured
 * plan sends through. Such a retry resends the same prepared frame to the same hop, which re-checks room
 * authority at ingress and deduplicates the repeat, so it cannot widen a room audience.
 */
function isOwnHopRetry<TPrepared>(
    plan: ALOutboundDispatchPlan<TPrepared>,
    pending: ALOutboundPendingAckSnapshot | undefined
): boolean {
    if (pending === undefined) {
        return false;
    }
    const nextHopPeerIds = plan.ackTracking?.nextHopPeerIds ?? [];
    const failedPeerIds = toFailedPeerIds(pending);
    return failedPeerIds.length > 0 && failedPeerIds.every((peerId) => nextHopPeerIds.includes(peerId));
}

function toFailedPeerIds(pending: ALOutboundPendingAckSnapshot): readonly string[] {
    return pending.expectedPeerIds.filter((peerId) => !pending.ackedPeerIds.includes(peerId));
}
