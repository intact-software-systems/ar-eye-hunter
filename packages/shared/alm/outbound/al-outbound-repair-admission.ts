import { isRoomScopedALMessage, type ALMessage } from '../../al-contracts/al-contract.ts';
import {
    decodeALControlMessage,
    parseALControlMessage,
    type ALParsedControlMessage
} from '../../al-contracts/al-control.ts';
import { toALOrderingTrackKey } from '../../al-contracts/al-runtime.ts';
import { RetryableConflictError, tryWithPolicy } from '../../resilience/TryWith.ts';
import type { ALOutboundPendingAckSnapshot, ALOutboundRepairAttemptSnapshot } from '../al-runtime-state-stores.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import { resolveExplicitOutboundMessageExpireAtMs } from '../ALMessageExpiry.ts';
import type {
    ALOutboundAdmissionMutation,
    ALOutboundAdmissionStore,
    ALOutboundCommitBundle,
    ALOutboundDurableEffectWrite,
    ALOutboundMessageReadDto,
    ALOutboundPreparedMessageDecoder,
    ALOutboundRepairHint,
    ALOutboundRepairReadDto
} from './al-outbound-admission-store.ts';
import { ALOutboundDispatchAdmission } from './al-outbound-dispatch-admission.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundRepairRequest
} from './al-outbound-message-runtime.ts';
import { toALOutboundEffectId } from './to-al-outbound-effect-id.ts';
import { toALOutboundPendingAckExpireAtTimestamp } from './transition-al-outbound-pending-ack.ts';

interface ALOutboundRetransmitOptions {
    readonly replaceExistingOutbox?: boolean;
}

interface ALOutboundCommitRepairInput<TPrepared> {
    readonly msg: ALMessage;
    readonly plan: ALOutboundDispatchPlan<TPrepared>;
    readonly priorAttempts: number;
    readonly maxAttempts: number;
}

export namespace ALOutboundRepairAdmission {
    export interface Dependencies<TPrepared> {
        readonly admissionStore: ALOutboundAdmissionStore;
        readonly dispatchAdmission: ALOutboundDispatchAdmission<TPrepared>;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly decodePreparedMessage: ALOutboundPreparedMessageDecoder<TPrepared>;
        readonly planOutgoingMessage: (msg: ALMessage) => ALOutboundDispatchPlan<TPrepared>;
        readonly planRepairMessage:
            | ((
                msg: ALMessage,
                request: ALOutboundRepairRequest
            ) => Promise<ALOutboundDispatchPlan<TPrepared> | undefined>)
            | undefined;
    }

    export interface ControlAcceptance {
        readonly handled: boolean;
        readonly retryAtMs: number | undefined;
    }
}

/** Turns persisted control/ACK/repair state into new durable admission commits; never sends directly. */
export class ALOutboundRepairAdmission<TPrepared> {
    private static readonly NOT_YET_IN_SYNC_RETRY_DELAY_MS = 50;
    private readonly admissionStore: ALOutboundAdmissionStore;
    private readonly dependencies: ALOutboundRepairAdmission.Dependencies<TPrepared>;

    constructor(dependencies: ALOutboundRepairAdmission.Dependencies<TPrepared>) {
        this.dependencies = dependencies;
        this.admissionStore = dependencies.admissionStore;
    }

    async acceptControlMessage(msg: ALMessage): Promise<ALOutboundRepairAdmission.ControlAcceptance> {
        const decoded = decodeALControlMessage(msg);
        if (decoded.left || !await this.hasCurrentRepairAuthority(decoded.right!)) {
            return { handled: false, retryAtMs: undefined };
        }
        const acceptance = await tryWithPolicy(
            async () => {
                try {
                    return await this.admissionStore.acceptControlMessage<TPrepared>(
                        msg,
                        this.dependencies.decodePreparedMessage
                    );
                }
                catch (error) {
                    if (error instanceof ALAdmissionBackendConflictError) {
                        throw new RetryableConflictError(
                            'Outbound control-message admission conflict',
                            { cause: error }
                        );
                    }
                    throw error;
                }
            },
            ALOutboundDispatchAdmission.COMMIT_RETRY_POLICY
        );
        return {
            handled: acceptance.handled,
            retryAtMs: acceptance.handled ? await this.scheduleNotYetInSyncRetryIfRequired(msg) : undefined
        };
    }

    private async hasCurrentRepairAuthority(control: ALParsedControlMessage): Promise<boolean> {
        if (
            control.type === 'ack' ||
            (control.type === 'nack' && control.payload.reason !== 'gap' &&
                control.payload.reason !== 'not-yet-in-sync')
        ) {
            return true;
        }
        const read = await this.admissionStore.readRepairMessage(
            control.payload.msgId,
            this.dependencies.planOutgoingMessage
        );
        const msg = read.sentSnapshot?.msg;
        if (!msg) {
            return false;
        }
        if (!isRoomScopedALMessage(msg)) {
            return true;
        }
        const planned = await this.dependencies.planRepairMessage?.(msg, {
            trigger: control.type,
            requestedByPeerId: control.payload.fromPeerId,
            orderingTrackKey: control.payload.orderingKey,
            missingSeqs: control.payload.missingSeqs ?? [],
            failedPeerIds: [],
            repair: read.plan?.repairTracking ?? { enabled: false, algo: 'none', maxAttempts: 0 }
        });
        return planned !== undefined && !planned.dropReason && planned.preparedMessages.length > 0;
    }

    private async scheduleNotYetInSyncRetryIfRequired(
        controlMessage: ALMessage
    ): Promise<number | undefined> {
        const parsed = parseALControlMessage(controlMessage);
        if (parsed?.type !== 'nack' || parsed.payload.reason !== 'not-yet-in-sync') {
            return undefined;
        }

        const msgId = parsed.payload.msgId;

        return await tryWithPolicy<number | undefined>(
            () => this.scheduleNotYetInSyncRetryOnce(msgId),
            ALOutboundDispatchAdmission.COMMIT_RETRY_POLICY
        );
    }

    private async scheduleNotYetInSyncRetryOnce(msgId: string): Promise<number | undefined> {
        const read = await this.admissionStore.readRepairMessage(msgId, this.dependencies.planOutgoingMessage);
        const msg = read.sentSnapshot?.msg;
        const retry = read.plan?.retryTracking;
        if (!msg || !retry?.enabled || retry.maxAttempts <= 0) {
            return undefined;
        }

        const retryDelayMs = Math.max(
            0,
            retry.retryDelayMs ?? ALOutboundRepairAdmission.NOT_YET_IN_SYNC_RETRY_DELAY_MS
        );
        const retryAtMs = read.nowMs + retryDelayMs;
        const result = await this.admissionStore.scheduleNotYetInSyncRetry<TPrepared>({
            senderId: msg.id.senderId,
            expectedVersion: read.clientRecord?.version,
            msgId,
            maxAttempts: retry.maxAttempts,
            expireAtTimestamp: resolveExplicitOutboundMessageExpireAtMs(msg),
            createEffect: (attempt) => ({
                effectId: toALOutboundEffectId(['nack-retry', msgId, 'not-yet-in-sync', attempt]),
                retryAtMs,
                expireAtTimestamp: resolveExplicitOutboundMessageExpireAtMs(msg),
                payload: { kind: 'nack-retry', msgId, reason: 'not-yet-in-sync' }
            })
        }, this.dependencies.decodePreparedMessage);
        if (result.status === 'conflict') {
            throw new RetryableConflictError('Outbound not-yet-in-sync retry commit conflict');
        }
        if (result.status === 'exhausted') {
            console.warn(`Not-yet-in-sync retry budget exceeded for message ${msgId}`);
            return undefined;
        }
        return result.retryAtMs;
    }

    async handlePendingAckTimeout(msgId: string): Promise<void> {
        await tryWithPolicy(
            () => this.handlePendingAckTimeoutOnce(msgId),
            ALOutboundDispatchAdmission.COMMIT_RETRY_POLICY
        );
    }

    private async handlePendingAckTimeoutOnce(msgId: string): Promise<void> {
        const read = await this.admissionStore.readRepairMessage(msgId, this.dependencies.planOutgoingMessage);
        const pending = read.pendingAck;
        const msg = read.sentSnapshot?.msg;
        if (!pending || !msg) {
            return;
        }
        if (pending.deadlineAtMs > this.readNowMs()) {
            await this.persistNextAckTimeout(msg, pending, read.clientRecord?.version);
            return;
        }
        if (this.isAckComplete(pending)) {
            await this.commitClearPendingAck(msg, pending, read.clientRecord?.version);
            return;
        }
        if (pending.attempts >= pending.maxAttempts) {
            console.warn(`Ack timeout exceeded retry budget for message ${msgId}`);
            await this.commitClearPendingAck(msg, pending, read.clientRecord?.version);
            return;
        }

        const nextPending: ALOutboundPendingAckSnapshot = {
            ...pending,
            attempts: pending.attempts + 1,
            deadlineAtMs: this.readNowMs() + pending.timeoutMs
        };
        const bundle = this.toAckTimeoutRepairBundle(msg, nextPending, read.clientRecord?.version);
        const status = await this.admissionStore.commitBundle(bundle, this.dependencies.decodePreparedMessage);
        if (status === 'conflict') {
            throw new RetryableConflictError('Outbound ack timeout commit conflict');
        }
    }

    private toAckTimeoutRepairBundle(
        msg: ALMessage,
        pending: ALOutboundPendingAckSnapshot,
        expectedVersion: number | undefined
    ): ALOutboundCommitBundle<TPrepared> {
        const failedPeerIds = pending.expectedPeerIds.filter((peerId) => !pending.ackedPeerIds.includes(peerId));
        return {
            senderId: msg.id.senderId,
            expectedVersion,
            mutations: [{ kind: 'set-pending-ack', snapshot: pending }],
            durableEffects: [
                this.toAckTimeoutEffect(pending),
                {
                    effectId: toALOutboundEffectId([
                        'repair-hint',
                        msg.id.msgId,
                        'ack-timeout',
                        pending.attempts,
                        pending.deadlineAtMs
                    ]),
                    payload: {
                        kind: 'repair-hint',
                        msgId: msg.id.msgId,
                        request: { trigger: 'ack-timeout', failedPeerIds, missingSeqs: [] }
                    }
                }
            ]
        };
    }

    private async persistNextAckTimeout(
        msg: ALMessage,
        pending: ALOutboundPendingAckSnapshot,
        expectedVersion?: number
    ): Promise<void> {
        const status = await this.admissionStore.commitBundle<TPrepared>({
            senderId: msg.id.senderId,
            expectedVersion,
            mutations: [],
            durableEffects: [
                this.toAckTimeoutEffect(pending)
            ]
        }, this.dependencies.decodePreparedMessage);
        if (status === 'conflict') {
            throw new RetryableConflictError(
                'Outbound ack timeout persistence commit conflict'
            );
        }
    }

    private async commitClearPendingAck(
        msg: ALMessage,
        pending: ALOutboundPendingAckSnapshot,
        expectedVersion?: number
    ): Promise<void> {
        const status = await this.admissionStore.commitBundle<TPrepared>({
            senderId: msg.id.senderId,
            expectedVersion,
            mutations: [
                {
                    kind: 'delete-pending-ack',
                    msgId: pending.msgId
                },
                {
                    kind: 'delete-repair-attempt',
                    msgId: pending.msgId
                }
            ],
            durableEffects: []
        }, this.dependencies.decodePreparedMessage);
        if (status === 'conflict') {
            throw new RetryableConflictError(
                'Outbound pending ack clear commit conflict'
            );
        }
    }

    async executeRepairFromHint(
        fallbackMsgId: string,
        request: ALOutboundRepairHint
    ): Promise<void> {
        if (request.orderingTrackKey && request.missingSeqs.length > 0) {
            const sentMessages = await this.admissionStore.getAllSentMessages();
            let retransmitted = false;

            for (const seq of request.missingSeqs) {
                const cached = sentMessages.find((snapshot) =>
                    toALOrderingTrackKey(snapshot.msg) === request.orderingTrackKey &&
                    snapshot.msg.ordering?.seq === seq
                );
                if (!cached) {
                    continue;
                }

                retransmitted = true;
                await this.repairByMsgId(cached.msgId, request);
            }

            if (retransmitted) {
                return;
            }
        }

        await this.repairByMsgId(fallbackMsgId, request);
    }

    private async repairByMsgId(
        msgId: string,
        request: ALOutboundRepairHint
    ): Promise<void> {
        const read = await this.admissionStore.readRepairMessage(msgId, this.dependencies.planOutgoingMessage);
        const msg = read.sentSnapshot?.msg;
        const plan = read.plan;
        if (!msg || !plan || plan.dropReason) {
            console.warn(`No cached outbound message found for repair ${msgId}`);
            return;
        }

        if (request.trigger === 'ack-timeout') {
            await this.retryMissingAcknowledgements(read, request);
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
        const handledPlan = this.dependencies.planRepairMessage
            ? await this.dependencies.planRepairMessage(msg, { ...request, repair })
            : plan;
        if (handledPlan?.dropReason) {
            console.warn(`Skipping outbound repair dispatch: ${handledPlan.dropReason}`);
            return;
        }
        if (!handledPlan) {
            return;
        }

        await this.commitRepairPlan({
            msg,
            plan: handledPlan,
            priorAttempts: attempts,
            maxAttempts: repair.maxAttempts
        });
    }

    private async retryMissingAcknowledgements(
        read: ALOutboundRepairReadDto<TPrepared>,
        request: ALOutboundRepairHint
    ): Promise<void> {
        const pending = read.pendingAck;
        const msg = read.sentSnapshot?.msg;
        const plan = read.plan;
        if (!pending || !msg || !plan || this.isAckComplete(pending) || pending.maxAttempts <= 0) {
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
            options: {}
        });
    }

    private async commitRepairPlan(repair: ALOutboundCommitRepairInput<TPrepared>): Promise<void> {
        await this.dependencies.dispatchAdmission.commit({
            msg: repair.msg,
            planner: () => repair.plan,
            intent: 'repair',
            phase: 'immediate',
            options: {
                extraMutations: (read) => this.toRepairAttemptMutations(read, repair.priorAttempts, repair.maxAttempts)
            }
        });
    }

    private toRepairAttemptMutations(
        read: ALOutboundMessageReadDto<TPrepared>,
        priorAttempts: number,
        maxAttempts: number
    ): readonly ALOutboundAdmissionMutation[] | 'skip' {
        const currentAttempts = read.repairAttempt?.attempts ?? priorAttempts;
        if (currentAttempts >= maxAttempts) {
            return 'skip';
        }

        return [{
            kind: 'set-repair-attempt',
            snapshot: {
                msgId: read.msg.id.msgId,
                attempts: currentAttempts + 1
            } satisfies ALOutboundRepairAttemptSnapshot
        }];
    }

    async retransmitByMsgId(
        msgId: string,
        options: ALOutboundRetransmitOptions = {}
    ): Promise<void> {
        const sent = await this.admissionStore.getSentMessage(msgId);
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
                replaceExistingOutbox: options.replaceExistingOutbox
            }
        });
    }

    private readNowMs(): number {
        return this.dependencies.clock.nowMs();
    }

    private toAckTimeoutEffect(
        pending: ALOutboundPendingAckSnapshot
    ): ALOutboundDurableEffectWrite<TPrepared> {
        return {
            effectId: toALOutboundEffectId([
                'ack-timeout',
                pending.msgId,
                pending.attempts + 1,
                pending.deadlineAtMs
            ]),
            retryAtMs: pending.deadlineAtMs,
            expireAtTimestamp: toALOutboundPendingAckExpireAtTimestamp(pending),
            payload: {
                kind: 'ack-timeout',
                msgId: pending.msgId
            }
        };
    }

    private isAckComplete(pending: ALOutboundPendingAckSnapshot): boolean {
        return pending.expectedPeerIds.length === 0 ||
            pending.expectedPeerIds.every((peerId) => pending.ackedPeerIds.includes(peerId));
    }
}
