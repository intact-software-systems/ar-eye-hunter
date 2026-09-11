import { isRoomScopedALMessage, type ALMessage } from '../../al-contracts/al-contract.ts';
import {
    decodeALControlMessage,
    parseALControlMessage,
    type ALParsedControlMessage
} from '../../al-contracts/al-control.ts';
import { resolveALMessageExpireAtMs } from '../../al-contracts/al-policy.ts';
import { RetryableConflictError } from '../../resilience/TryWith.ts';
import type { ALOutboundPendingAckSnapshot } from '../al-runtime-state-stores.ts';
import type { ALWorkOutcome } from '../work/al-work-queue-port.ts';
import type {
    ALOutboundAdmissionStore,
    ALOutboundCommitBundle,
    ALOutboundDurableEffectWrite
} from './admission/al-outbound-admission-store.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundRepairRequest
} from './al-outbound-message-runtime.ts';
import type {
    ALOutboundControlAdmission,
    ALOutboundControlAdmissionResult,
    ALOutboundPendingControl
} from './control/al-outbound-control-admission.ts';
import { toALOutboundEffectId } from './to-al-outbound-effect-id.ts';
import {
    isALOutboundReceiptComplete,
    toALOutboundPendingAckExpireAtTimestamp
} from './transition-al-outbound-pending-ack.ts';

export namespace ALOutboundRepairAdmission {
    export interface Dependencies<TPrepared> {
        readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
        readonly controlAdmission: ALOutboundControlAdmission<TPrepared>;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly planOutgoingMessage: (msg: ALMessage) => ALOutboundDispatchPlan<TPrepared>;
        readonly planRepairMessage:
            | ((
                msg: ALMessage,
                request: ALOutboundRepairRequest
            ) => Promise<ALOutboundDispatchPlan<TPrepared> | undefined>)
            | undefined;
    }
}

/** Turns persisted control/ACK/repair state into new durable admission commits; never sends directly. */
export class ALOutboundRepairAdmission<TPrepared> {
    private static readonly NOT_YET_IN_SYNC_RETRY_DELAY_MS = 50;
    private readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
    private readonly dependencies: ALOutboundRepairAdmission.Dependencies<TPrepared>;

    constructor(dependencies: ALOutboundRepairAdmission.Dependencies<TPrepared>) {
        this.dependencies = dependencies;
        this.admissionStore = dependencies.admissionStore;
    }

    async acceptControlMessage(msg: ALMessage): Promise<ALOutboundControlAdmissionResult> {
        const decoded = decodeALControlMessage(msg);
        if (decoded.left || !await this.hasCurrentRepairAuthority(decoded.right!)) {
            return { kind: 'not-handled' };
        }
        const admitted = await this.dependencies.controlAdmission.admit(msg);
        if (admitted.kind === 'committed') {
            await this.scheduleNotYetInSyncRetryIfRequired(msg);
        }
        return admitted;
    }

    /** A retained control admission owes the same post-commit retry schedule the direct path writes. */
    async replayControlAdmission(payload: ALOutboundPendingControl): Promise<ALWorkOutcome> {
        const replayed = await this.dependencies.controlAdmission.replay(payload);
        if (replayed.committed) {
            await this.scheduleNotYetInSyncRetryIfRequired(payload.msg);
        }
        return replayed.outcome;
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
    ): Promise<void> {
        const parsed = parseALControlMessage(controlMessage);
        if (parsed?.type !== 'nack' || parsed.payload.reason !== 'not-yet-in-sync') {
            return;
        }

        const msgId = parsed.payload.msgId;

        await this.scheduleNotYetInSyncRetry(msgId);
    }

    private async scheduleNotYetInSyncRetry(msgId: string): Promise<void> {
        const read = await this.admissionStore.readRepairMessage(msgId, this.dependencies.planOutgoingMessage);
        const msg = read.sentSnapshot?.msg;
        const retry = read.plan?.retryTracking;
        if (!msg || !retry?.enabled || retry.maxAttempts <= 0) {
            return;
        }

        const retryDelayMs = Math.max(
            0,
            retry.retryDelayMs ?? ALOutboundRepairAdmission.NOT_YET_IN_SYNC_RETRY_DELAY_MS
        );
        const retryAtMs = read.nowMs + retryDelayMs;
        const result = await this.dependencies.controlAdmission.scheduleNotYetInSyncRetry({
            senderId: msg.id.senderId,
            expectedVersion: read.clientRecord?.version,
            msgId,
            maxAttempts: retry.maxAttempts,
            expireAtTimestamp: resolveALMessageExpireAtMs(msg),
            retryAtMs
        });
        if (result.status === 'conflict') {
            throw new RetryableConflictError('Outbound not-yet-in-sync retry commit conflict');
        }
        if (result.status === 'exhausted') {
            console.warn(`Not-yet-in-sync retry budget exceeded for message ${msgId}`);
            return;
        }
    }

    async retryPendingAck(msgId: string): Promise<void> {
        const read = await this.admissionStore.readRepairMessage(msgId, this.dependencies.planOutgoingMessage);
        const pending = read.pendingAck;
        const msg = read.sentSnapshot?.msg;
        if (!pending) {
            return;
        }
        if (!msg) {
            if (read.clientRecord) {
                const status = await this.admissionStore.commitBundle({
                    senderId: read.clientRecord.senderId,
                    expectedVersion: read.clientRecord.version,
                    mutations: [{ kind: 'delete-pending-ack', msgId }, { kind: 'delete-repair-attempt', msgId }],
                    durableEffects: []
                });
                if (status === 'conflict') {
                    throw new RetryableConflictError('Expired outbound acknowledgement cleanup commit conflict');
                }
            }
            return;
        }
        if (pending.deadlineAtMs > this.readNowMs()) {
            await this.persistNextAckTimeout(msg, pending, read.clientRecord?.version);
            return;
        }
        if (isALOutboundReceiptComplete(pending)) {
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
        const status = await this.admissionStore.commitBundle(bundle);
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
                    expireAtTimestamp: resolveALMessageExpireAtMs(msg),
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
        const status = await this.admissionStore.commitBundle({
            senderId: msg.id.senderId,
            expectedVersion,
            mutations: [],
            durableEffects: [
                this.toAckTimeoutEffect(pending)
            ]
        });
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
        const status = await this.admissionStore.commitBundle({
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
        });
        if (status === 'conflict') {
            throw new RetryableConflictError(
                'Outbound pending ack clear commit conflict'
            );
        }
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
}
