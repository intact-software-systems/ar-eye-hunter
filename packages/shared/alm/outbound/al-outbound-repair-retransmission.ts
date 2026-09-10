import { isRoomScopedALMessage, type ALMessage } from '../../al-contracts/al-contract.ts';
import type {
    ALOutboundAdmissionStore,
    ALOutboundRepairHint,
    ALOutboundRepairReadDto
} from './admission/al-outbound-admission-store.ts';
import type { ALOutboundDispatchAdmission } from './al-outbound-dispatch-admission.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundRepairRequest
} from './al-outbound-message-runtime.ts';
import { isALOutboundReceiptComplete } from './transition-al-outbound-pending-ack.ts';

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
        readonly planOutgoingMessage: (msg: ALMessage) => ALOutboundDispatchPlan<TPrepared>;
        readonly planRepairMessage:
            | ((
                msg: ALMessage,
                request: ALOutboundRepairRequest
            ) => Promise<ALOutboundDispatchPlan<TPrepared> | undefined>)
            | undefined;
    }
}

/** Turns a repair hint into a new dispatch admission; the retry schedule that emitted the hint is elsewhere. */
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
        if (request.orderingTrackKey && request.missingSeqs.length > 0) {
            let retransmitted = false;

            for (const seq of request.missingSeqs) {
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

        if (!this.dependencies.planRepairMessage && isRoomScopedALMessage(msg)) {
            return;
        }
        const repairedPlan = this.dependencies.planRepairMessage
            ? await this.dependencies.planRepairMessage(msg, { ...request, repair })
            : plan;
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
        if (!this.dependencies.planRepairMessage && isRoomScopedALMessage(msg)) {
            return;
        }
        const retryPlan = this.dependencies.planRepairMessage
            ? await this.dependencies.planRepairMessage(msg, {
                ...request,
                failedPeerIds: pending.expectedPeerIds.filter((peerId) => !pending.ackedPeerIds.includes(peerId)),
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
            options: { attemptIdentity }
        });
    }

    private async commitRepairPlan(repair: ALOutboundCommitRepairInput<TPrepared>): Promise<void> {
        await this.dependencies.dispatchAdmission.commit({
            msg: repair.msg,
            planner: () => repair.plan,
            intent: 'repair',
            phase: 'immediate',
            options: {
                repairBudget: { priorAttempts: repair.priorAttempts, maxAttempts: repair.maxAttempts },
                attemptIdentity: repair.attemptIdentity
            }
        });
    }
}
