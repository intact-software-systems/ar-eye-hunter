import { isRoomScopedALMessage, type ALMessage } from '../../al-contracts/al-contract.ts';
import { decodeALPeerControlMessage, type ALPeerControlMessage } from '../../al-contracts/al-control.ts';
import { resolveALMessageExpireAtMs } from '../../al-contracts/al-policy.ts';
import { RetryableConflictError } from '../../resilience/try-with-policy.ts';
import type { ALOutboundPendingAckSnapshot } from '../al-runtime-state-stores.ts';
import type { ALWorkClaimRun } from '../work/al-work-handler.ts';
import type { ALWorkOutcome } from '../work/al-work-queue-port.ts';
import type {
    ALOutboundAdmissionStore,
    ALOutboundCommitBundle,
    ALOutboundDurableEffectWrite,
    ALOutboundPlanner,
    ALOutboundRepairReadDto
} from './admission/al-outbound-admission-store.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundRepairRequest,
    ALOutboundRuntimeDiagnosticsSink,
    ALOutboundSettlementEmitter,
    ALOutboundSettlementFact
} from './al-outbound-message-runtime.ts';
import { computeALOutboundAttemptDeadline } from './attempt-deadline/compute-al-outbound-attempt-deadline.ts';
import { readALOutboundSendAttemptHeld } from './attempt-deadline/read-al-outbound-send-attempt-held.ts';
import type { ALOutboundControlSource } from './compute-al-outbound-control-admission.ts';
import { toALOutboundAdmissionVerdict } from './compute-al-outbound-dispatch.ts';
import type { ALOutboundControlAdmission, ALOutboundPendingControl } from './control/al-outbound-control-admission.ts';
import { isALOutboundRepairAuthorityControl } from './control/is-al-outbound-expected-repair-peer.ts';
import type { ALOutboundControlAdmissionResult } from './control/read-al-outbound-recipient-proof.ts';
import { resolveALOutboundReplanRefusalSettlement } from './control/resolve-al-outbound-replan-refusal-settlement.ts';
import { toALOutboundControlRepairHint } from './control/to-al-outbound-control-repair-hint.ts';
import { toALOutboundEndReceiptBundle } from './control/to-al-outbound-end-receipt-bundle.ts';
import { toALOutboundReceiptClasses } from './control/to-al-outbound-receipt-classes.ts';
import { toALOutboundReceiptExhaustedFact } from './control/to-al-outbound-receipt-exhausted-fact.ts';
import { writeALOutboundControlAdmissionDiagnostic } from './control/write-al-outbound-control-admission-diagnostic.ts';
import { isALOutboundOwnHopPeer } from './is-al-outbound-own-hop-peer.ts';
import {
    toALOutboundReadCommitFences,
    toALOutboundReadMessageEndBundle,
    type ALOutboundMessageEndRead
} from './message-end/to-al-outbound-message-end-bundle.ts';
import { toALOutboundAckTimeoutEffectId, toALOutboundEffectId } from './to-al-outbound-effect-id.ts';
import { isALOutboundReceiptComplete } from './transition-al-outbound-pending-ack.ts';

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
        /** The composition's fixed hops, the sender's own beside a plan's tracked next hops; undefined for none. */
        readonly hopPeerIds: readonly string[] | undefined;
        readonly diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
        /**
         * The lane's guarded emitter: where a receipt and a not-yet-in-sync budget state that they ran out, and a
         * receipt whose message a revoked publisher may no longer re-send states that refusal.
         */
        readonly settlements: ALOutboundSettlementEmitter;
    }

    /** A receipt the `ack-timeout` schedule retries, with the message deadline that ends it. */
    export interface RetriedReceipt {
        readonly msg: ALMessage;
        readonly pending: ALOutboundPendingAckSnapshot;
        readonly messageExpiresAtMs: number;
    }

    /** The read whose fences a receipt's next window commits under, and whether the window hints a repair of the message. */
    export interface NextAckWindow {
        readonly read: ALOutboundMessageEndRead;
        readonly hintsRepair: boolean;
    }
}

/**
 * Turns persisted control/ACK/repair state into new durable admission commits; never sends directly.
 * Without a repair planner a room-scoped gap, repair or not-yet-in-sync control carries authority only when the
 * sender's own hop sent it, the one repair that cannot widen a room audience. That hop retains a room send it answers
 * not-yet-in-sync, so the answer ends a WS client's first-hop wait and schedules no retry here.
 */
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
        const admitted: ALOutboundControlAdmissionResult = await this.readRepairAuthority(control)
            ? await this.dependencies.controlAdmission.admit(msg, source)
            : { kind: 'not-handled' };
        writeALOutboundControlAdmissionDiagnostic(this.dependencies.diagnostics, {
            control: msg,
            parsed: control,
            admitted,
            claimRun: undefined
        });
        if (admitted.kind === 'committed') {
            await this.scheduleNotYetInSyncRetryIfRequired(control);
        }
        return admitted;
    }

    /**
     * A retained control admission owes the same post-commit retry schedule the direct path writes, and states its
     * verdict as the direct path does, with the run of the claim that replays it: a control whose first admission lost
     * its commit is admitted here.
     */
    async replayControlAdmission(payload: ALOutboundPendingControl, claimRun: ALWorkClaimRun): Promise<ALWorkOutcome> {
        const replayed = await this.dependencies.controlAdmission.replay(payload);
        const control = decodeALPeerControlMessage(payload.msg).right;
        if (replayed.admitted === null || control === undefined) {
            return replayed.outcome;
        }
        writeALOutboundControlAdmissionDiagnostic(this.dependencies.diagnostics, {
            control: payload.msg,
            parsed: control,
            admitted: replayed.admitted,
            claimRun
        });
        if (replayed.admitted.kind === 'committed') {
            await this.scheduleNotYetInSyncRetryIfRequired(control);
        }
        return replayed.outcome;
    }

    private async readRepairAuthority(control: ALPeerControlMessage): Promise<boolean> {
        if (control.type === 'ack' || !isALOutboundRepairAuthorityControl(control)) {
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
        if (this.isOwnHopRoomSend(msg)) {
            return read.plan !== undefined &&
                isALOutboundOwnHopPeer(read.plan, this.dependencies.hopPeerIds, control.payload.fromPeerId);
        }
        if (!isRoomScopedALMessage(msg)) {
            return true;
        }
        const planned = await this.dependencies.planRepairMessage?.(msg, {
            ...toALOutboundControlRepairHint(control),
            referenceKey: read.storedMessage?.reference.key,
            admittedAudience: read.plan?.admittedAudience,
            admittedConnectionGenerationIds: read.plan?.admittedConnectionGenerationIds,
            recipientScope: read.plan?.recipientScope,
            sessionInvalidation: read.plan?.sessionInvalidation,
            accountView: read.plan?.accountView,
            completedHopPeerIds: [],
            repair: read.plan?.repairTracking ?? { enabled: false, algo: 'none', maxAttempts: 0 }
        });
        return planned !== undefined && !planned.dropReason && planned.preparedMessages.length > 0;
    }

    private async scheduleNotYetInSyncRetryIfRequired(control: ALPeerControlMessage): Promise<void> {
        if (control.type === 'nack' && control.payload.reason === 'not-yet-in-sync') {
            await this.scheduleNotYetInSyncRetry(control.payload.msgId);
        }
    }

    /** A room send this composition plans no repair for: only its own hop speaks for it. */
    private isOwnHopRoomSend(msg: ALMessage): boolean {
        return isRoomScopedALMessage(msg) && this.dependencies.planRepairMessage === undefined;
    }

    /** Re-read after the NACK's commit: a message ended since is retried and stated no more. */
    private async scheduleNotYetInSyncRetry(msgId: string): Promise<void> {
        const read = await this.admissionStore.readRepairMessage(msgId, this.dependencies.planOutgoingMessage);
        const msg = read.sentSnapshot?.msg;
        const retry = read.plan?.retryTracking;
        if (
            !msg || read.storedMessage?.ended || !retry?.enabled || retry.maxAttempts <= 0 || this.isOwnHopRoomSend(msg)
        ) {
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
                traceId: msg.id.traceId,
                detail: `The not-yet-in-sync retry budget of ${retry.maxAttempts} ran out.`
            });
        }
    }

    async retryPendingAck(msgId: string): Promise<void> {
        const read = await this.admissionStore.readRepairMessage(msgId, this.dependencies.planOutgoingMessage);
        const pending = read.pendingAck;
        const msg = read.sentSnapshot?.msg;
        const stored = read.storedMessage;
        if (!pending) {
            return;
        }
        if (!msg || stored === undefined) {
            await this.commitOrphanedReceiptCleanup(msgId, read);
            return;
        }
        // A terminal commit that keeps its incomplete row ended the message: a timer still queued writes nothing for it.
        if (stored.ended && !isALOutboundReceiptComplete(pending)) {
            return;
        }
        const messageExpiresAtMs = stored.reference.expiresAtMs;
        if (pending.deadlineAtMs > this.readNowMs()) {
            await this.persistNextAckTimeout({ msg, pending, messageExpiresAtMs }, read);
            return;
        }
        if (isALOutboundReceiptComplete(pending)) {
            await this.commitClearPendingAck(msg, read);
            return;
        }
        const refusal = read.plan &&
            resolveALOutboundReplanRefusalSettlement(msg, toALOutboundAdmissionVerdict(read.plan), 'ack-timeout');
        if (refusal) {
            await this.commitRefusedReceipt(msg, read, refusal);
            return;
        }
        const held = await this.readFirstAttemptHeld(read, pending);
        const deadline = computeALOutboundAttemptDeadline({ budget: pending, held, nowMs: this.readNowMs() });
        if (deadline.kind === 'exhausted') {
            await this.commitReceiptExhausted(msg, read, pending);
            return;
        }
        await this.commitNextAckWindow({ msg, pending: { ...pending, ...deadline.next }, messageExpiresAtMs }, {
            read,
            hintsRepair: deadline.kind === 'retry' && read.plan !== undefined && !read.plan.dropReason
        });
    }

    /** Whether the receipt has charged nothing and every copy of the dispatch that opened it is still queued. */
    private async readFirstAttemptHeld(
        read: ALOutboundRepairReadDto<TPrepared>,
        pending: ALOutboundPendingAckSnapshot
    ): Promise<boolean> {
        if (pending.attempts !== 0 || pending.firstAttempt === undefined || read.plan === undefined) {
            return false;
        }
        return await readALOutboundSendAttemptHeld(this.admissionStore, {
            ...pending.firstAttempt,
            msgId: pending.msgId,
            preparedMessages: read.plan.preparedMessages
        });
    }

    /** Commits the receipt's next window, `receipt.pending` as the window writes it. */
    private async commitNextAckWindow(
        receipt: ALOutboundRepairAdmission.RetriedReceipt,
        nextWindow: ALOutboundRepairAdmission.NextAckWindow
    ): Promise<void> {
        const status = await this.admissionStore.commitBundle(this.toNextAckWindowBundle(receipt, nextWindow));
        if (status === 'conflict') {
            throw new RetryableConflictError('Outbound ack timeout commit conflict');
        }
    }

    /**
     * A re-plan refused for good ends the message under the version its decision read: a same-sender commit since, such
     * as a completing ACK, conflicts and the retry decides again; the commit's success states the refusal once.
     */
    private async commitRefusedReceipt(
        msg: ALMessage,
        read: ALOutboundMessageEndRead,
        refusal: ALOutboundSettlementFact
    ): Promise<void> {
        const status = await this.admissionStore.commitBundle(toALOutboundReadMessageEndBundle(msg, read));
        if (status === 'conflict') {
            throw new RetryableConflictError('Outbound receipt refusal commit conflict');
        }
        if (status === 'committed') {
            this.dependencies.settlements(refusal);
        }
    }

    /** A receipt whose message is gone has nothing left to retry. */
    private async commitOrphanedReceiptCleanup(msgId: string, read: ALOutboundMessageEndRead): Promise<void> {
        if (!read.clientRecord) {
            return;
        }
        const status = await this.admissionStore.commitBundle(
            toALOutboundEndReceiptBundle(read.clientRecord.senderId, msgId, read)
        );
        if (status === 'conflict') {
            throw new RetryableConflictError('Expired outbound acknowledgement cleanup commit conflict');
        }
    }

    /**
     * The next window of a receipt, and the repair hint of a charged one when this peer can re-plan the message. A
     * copy this peer cannot re-plan, such as a relay's forwarded copy, has no retry of its own: its origin retries
     * it, so the hint would only fail its read.
     */
    private toNextAckWindowBundle(
        receipt: ALOutboundRepairAdmission.RetriedReceipt,
        nextWindow: ALOutboundRepairAdmission.NextAckWindow
    ): ALOutboundCommitBundle<TPrepared> {
        const { msg, pending, messageExpiresAtMs } = receipt;
        const failedPeerIds = toALOutboundReceiptClasses(pending).unconfirmedPeerIds;
        const repairHint: ALOutboundDurableEffectWrite<TPrepared> = {
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
        };
        return {
            senderId: msg.id.senderId,
            ...toALOutboundReadCommitFences({ originPeerId: msg.id.senderId, msgId: msg.id.msgId }, nextWindow.read),
            mutations: [{
                kind: 'set-pending-ack',
                originPeerId: msg.id.senderId,
                snapshot: pending,
                expireAtTimestamp: messageExpiresAtMs
            }],
            durableEffects: [
                this.toAckTimeoutEffect(pending, messageExpiresAtMs),
                ...(nextWindow.hintsRepair ? [repairHint] : [])
            ],
            endedTimeoutEffectIds: []
        };
    }

    private async persistNextAckTimeout(
        receipt: ALOutboundRepairAdmission.RetriedReceipt,
        read: ALOutboundMessageEndRead
    ): Promise<void> {
        const status = await this.admissionStore.commitBundle({
            senderId: receipt.msg.id.senderId,
            ...toALOutboundReadCommitFences(
                { originPeerId: receipt.msg.id.senderId, msgId: receipt.msg.id.msgId },
                read
            ),
            mutations: [],
            durableEffects: [
                this.toAckTimeoutEffect(receipt.pending, receipt.messageExpiresAtMs)
            ],
            endedTimeoutEffectIds: []
        });
        if (status === 'conflict') {
            throw new RetryableConflictError(
                'Outbound ack timeout persistence commit conflict'
            );
        }
    }

    private async commitClearPendingAck(msg: ALMessage, read: ALOutboundMessageEndRead): Promise<void> {
        const status = await this.admissionStore.commitBundle(
            toALOutboundEndReceiptBundle(msg.id.senderId, msg.id.msgId, read)
        );
        if (status === 'conflict') {
            throw new RetryableConflictError(
                'Outbound pending ack clear commit conflict'
            );
        }
    }

    /**
     * The budget ran out: the message ends in the commit whose success states the terminal fact, so the fact
     * is stated once across replays and reloads, and a late ACK is refused as naming an ended message (Q6).
     */
    private async commitReceiptExhausted(
        msg: ALMessage,
        read: ALOutboundMessageEndRead,
        pending: ALOutboundPendingAckSnapshot
    ): Promise<void> {
        const status = await this.admissionStore.commitBundle(toALOutboundReadMessageEndBundle(msg, read));
        if (status === 'conflict') {
            throw new RetryableConflictError('Outbound receipt exhaustion commit conflict');
        }
        if (status === 'committed') {
            this.dependencies.settlements(toALOutboundReceiptExhaustedFact({
                receipt: pending,
                exhaustion: { cause: 'budget' },
                detail: `The receipt ran out of retries after ${pending.attempts} of ${pending.maxAttempts}.`,
                traceId: msg.id.traceId
            }));
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
            expireAtTimestamp: messageExpiresAtMs,
            payload: {
                kind: 'ack-timeout',
                msgId: pending.msgId
            }
        };
    }
}
