import { isRoomScopedALMessage, type ALMessage } from '../../al-contracts/al-contract.ts';
import {
    decodeALPeerControlMessage,
    parseALControlMessage,
    type ALPeerControlMessage
} from '../../al-contracts/al-control.ts';
import { resolveALMessageExpireAtMs } from '../../al-contracts/al-policy.ts';
import { RetryableConflictError } from '../../resilience/TryWith.ts';
import type { ALOutboundPendingAckSnapshot } from '../al-runtime-state-stores.ts';
import type { ALWorkOutcome } from '../work/al-work-queue-port.ts';
import type {
    ALOutboundAdmissionStore,
    ALOutboundCommitBundle,
    ALOutboundDurableEffectWrite,
    ALOutboundPlanner,
    ALOutboundVersionedClientRecord
} from './admission/al-outbound-admission-store.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundRepairRequest,
    ALOutboundRuntimeDiagnosticsSink,
    ALOutboundSettlementEmitter
} from './al-outbound-message-runtime.ts';
import { controlTargetMsgId, type ALOutboundControlSource } from './compute-al-outbound-control-admission.ts';
import type {
    ALOutboundControlAdmission,
    ALOutboundControlAdmissionResult,
    ALOutboundPendingControl
} from './control/al-outbound-control-admission.ts';
import { toALOutboundReceiptExhaustedFact } from './control/to-al-outbound-receipt-exhausted-fact.ts';
import { writeALOutboundControlAdmissionDiagnostic } from './control/write-al-outbound-control-admission-diagnostic.ts';
import { toALOutboundAckTimeoutEffectId, toALOutboundEffectId } from './to-al-outbound-effect-id.ts';
import {
    isALOutboundReceiptComplete,
    toALOutboundAckRetryScheduleEndTimestamp
} from './transition-al-outbound-pending-ack.ts';

export namespace ALOutboundRepairAdmission {
    export interface Dependencies<TPrepared> {
        readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
        readonly controlAdmission: ALOutboundControlAdmission<TPrepared>;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly planOutgoingMessage: ALOutboundPlanner<TPrepared>;
        readonly planRepairMessage:
            | ((
                msg: ALMessage,
                request: ALOutboundRepairRequest
            ) => Promise<ALOutboundDispatchPlan<TPrepared> | undefined>)
            | undefined;
        readonly diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
        /** The lane's guarded emitter: where a receipt and a not-yet-in-sync budget state that they ran out. */
        readonly settlements: ALOutboundSettlementEmitter;
    }

    /** A receipt the `ack-timeout` schedule retries, with the message deadline that ends it. */
    export interface RetriedReceipt {
        readonly msg: ALMessage;
        readonly pending: ALOutboundPendingAckSnapshot;
        readonly messageExpiresAtMs: number;
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

    async acceptControlMessage(
        msg: ALMessage,
        source: ALOutboundControlSource
    ): Promise<ALOutboundControlAdmissionResult> {
        const decoded = decodeALPeerControlMessage(msg);
        if (decoded.left) {
            return { kind: 'not-handled' };
        }
        const control = decoded.right!;
        const admitted: ALOutboundControlAdmissionResult = await this.hasCurrentRepairAuthority(control)
            ? await this.dependencies.controlAdmission.admit(msg, source)
            : { kind: 'not-handled' };
        writeALOutboundControlAdmissionDiagnostic(this.dependencies.diagnostics, {
            control: msg,
            targetMsgId: controlTargetMsgId(control),
            receiptPhase: undefined,
            admitted
        });
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

    private async hasCurrentRepairAuthority(control: ALPeerControlMessage): Promise<boolean> {
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
            referenceKey: read.storedMessage?.reference.key,
            admittedAudience: read.plan?.admittedAudience,
            recipientScope: read.plan?.recipientScope,
            sessionInvalidation: read.plan?.sessionInvalidation,
            trigger: control.type,
            requestedByPeerId: control.payload.fromPeerId,
            orderingTrackKey: control.payload.orderingKey,
            missingRanges: control.payload.missingRanges ?? [],
            failedPeerIds: [],
            completedHopPeerIds: [],
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
            this.dependencies.settlements({
                kind: 'not-yet-in-sync-exhausted',
                msgId,
                detail: `The not-yet-in-sync retry budget of ${retry.maxAttempts} ran out.`
            });
        }
    }

    async retryPendingAck(msgId: string): Promise<void> {
        const read = await this.admissionStore.readRepairMessage(msgId, this.dependencies.planOutgoingMessage);
        const pending = read.pendingAck;
        const msg = read.sentSnapshot?.msg;
        const messageExpiresAtMs = read.storedMessage?.reference.expiresAtMs;
        if (!pending) {
            return;
        }
        if (!msg || messageExpiresAtMs === undefined) {
            await this.commitOrphanedReceiptCleanup(msgId, read.clientRecord);
            return;
        }
        if (pending.deadlineAtMs > this.readNowMs()) {
            await this.persistNextAckTimeout({ msg, pending, messageExpiresAtMs }, read.clientRecord?.version);
            return;
        }
        if (isALOutboundReceiptComplete(pending)) {
            await this.commitClearPendingAck(msg, pending, read.clientRecord?.version);
            return;
        }
        if (pending.attempts >= pending.maxAttempts) {
            await this.commitReceiptExhausted(msg, pending, read.clientRecord?.version);
            return;
        }

        const nextPending: ALOutboundPendingAckSnapshot = {
            ...pending,
            attempts: pending.attempts + 1,
            deadlineAtMs: this.readNowMs() + pending.timeoutMs
        };
        const bundle = this.toAckTimeoutRepairBundle(
            { msg, pending: nextPending, messageExpiresAtMs },
            read.clientRecord?.version
        );
        const status = await this.admissionStore.commitBundle(bundle);
        if (status === 'conflict') {
            throw new RetryableConflictError('Outbound ack timeout commit conflict');
        }
    }

    /**
     * Ends this owner's receipt of a message another carrier now owns (D56): both rows go in one commit and
     * nothing is stated -- the message is not cancelled. A conflict leaves an inert row: the hand-over
     * completes every later effect of the message silently, so nothing retries it before it expires.
     */
    async endReceipt(msgId: string): Promise<void> {
        const read = await this.admissionStore.readRepairMessage(msgId, this.dependencies.planOutgoingMessage);
        if (read.pendingAck === undefined || read.clientRecord === undefined) {
            return;
        }
        await this.admissionStore.commitBundle(
            toEndReceiptBundle(read.clientRecord.senderId, msgId, read.clientRecord.version)
        );
    }

    /** A receipt whose message is gone has nothing left to retry. */
    private async commitOrphanedReceiptCleanup(
        msgId: string,
        clientRecord: ALOutboundVersionedClientRecord | undefined
    ): Promise<void> {
        if (!clientRecord) {
            return;
        }
        const status = await this.admissionStore.commitBundle(
            toEndReceiptBundle(clientRecord.senderId, msgId, clientRecord.version)
        );
        if (status === 'conflict') {
            throw new RetryableConflictError('Expired outbound acknowledgement cleanup commit conflict');
        }
    }

    private toAckTimeoutRepairBundle(
        receipt: ALOutboundRepairAdmission.RetriedReceipt,
        expectedVersion: number | undefined
    ): ALOutboundCommitBundle<TPrepared> {
        const { msg, pending, messageExpiresAtMs } = receipt;
        const failedPeerIds = pending.expectedPeerIds.filter((peerId) => !pending.ackedPeerIds.includes(peerId));
        return {
            senderId: msg.id.senderId,
            expectedVersion,
            mutations: [{
                kind: 'set-pending-ack',
                originPeerId: msg.id.senderId,
                snapshot: pending,
                expireAtTimestamp: messageExpiresAtMs
            }],
            durableEffects: [
                this.toAckTimeoutEffect(pending, messageExpiresAtMs),
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
                        request: { trigger: 'ack-timeout', failedPeerIds, missingRanges: [] }
                    }
                }
            ]
        };
    }

    private async persistNextAckTimeout(
        receipt: ALOutboundRepairAdmission.RetriedReceipt,
        expectedVersion?: number
    ): Promise<void> {
        const status = await this.admissionStore.commitBundle({
            senderId: receipt.msg.id.senderId,
            expectedVersion,
            mutations: [],
            durableEffects: [
                this.toAckTimeoutEffect(receipt.pending, receipt.messageExpiresAtMs)
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
        const status = await this.admissionStore.commitBundle(
            toEndReceiptBundle(msg.id.senderId, pending.msgId, expectedVersion)
        );
        if (status === 'conflict') {
            throw new RetryableConflictError(
                'Outbound pending ack clear commit conflict'
            );
        }
    }

    /**
     * The budget ran out: the row goes in the commit whose success states the terminal fact, so the fact
     * is stated once across replays and reloads, and a late ACK finds no row to complete (Q6).
     */
    private async commitReceiptExhausted(
        msg: ALMessage,
        pending: ALOutboundPendingAckSnapshot,
        expectedVersion: number | undefined
    ): Promise<void> {
        const status = await this.admissionStore.commitBundle(
            toEndReceiptBundle(msg.id.senderId, pending.msgId, expectedVersion)
        );
        if (status === 'conflict') {
            throw new RetryableConflictError('Outbound receipt exhaustion commit conflict');
        }
        if (status === 'committed') {
            this.dependencies.settlements(toALOutboundReceiptExhaustedFact(
                pending,
                { cause: 'budget' },
                `The receipt ran out of retries after ${pending.attempts} of ${pending.maxAttempts}.`
            ));
        }
    }

    private readNowMs(): number {
        return this.dependencies.clock.nowMs();
    }

    private toAckTimeoutEffect(
        pending: ALOutboundPendingAckSnapshot,
        messageExpiresAtMs: number
    ): ALOutboundDurableEffectWrite<TPrepared> {
        return {
            effectId: toALOutboundAckTimeoutEffectId(pending),
            retryAtMs: pending.deadlineAtMs,
            expireAtTimestamp: toALOutboundAckRetryScheduleEndTimestamp(pending, messageExpiresAtMs),
            payload: {
                kind: 'ack-timeout',
                msgId: pending.msgId
            }
        };
    }
}

/** The commit that ends one receipt: its pending-ACK row and its repair-attempt row, under the sender's fence. */
function toEndReceiptBundle<TPrepared>(
    senderId: string,
    msgId: string,
    expectedVersion: number | undefined
): ALOutboundCommitBundle<TPrepared> {
    return {
        senderId,
        expectedVersion,
        mutations: [
            { kind: 'delete-pending-ack', originPeerId: senderId, msgId },
            { kind: 'delete-repair-attempt', msgId }
        ],
        durableEffects: []
    };
}
