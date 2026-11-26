import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodeALMessageValue, type ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import { resolveALMessageExpireAtMs, type ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import { NOT_COMPLETED_RETRYABLE_STATUSES } from '../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import { Either } from '../../resilience/Either.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type { ALWorkQueuePort } from '../work/al-work-queue-port.ts';
import { computeALInboundAdmission } from './admission/compute-al-inbound-admission.ts';
import {
    isALInboundOriginAuthenticated,
    isALInboundOriginAuthenticatedReadmission
} from './admission/is-al-inbound-origin-authenticated-readmission.ts';
import { recordALInboundOrderingPosition } from './admission/record-al-inbound-ordering-position.ts';
import { validateALInboundCommitBundle } from './admission/validate-al-inbound-commit-bundle.ts';
import type { ALInboundAdmissionRead, ALInboundCommitBundle, ALInboundPlanner } from './al-inbound-admission-store.ts';
import { toALInboundLocalDeliveryEffectId } from './al-inbound-effect-intent.ts';
import { toALInboundMessageWithDeadline } from './al-inbound-message-deadline.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';
import { toALInboundPendingAdmissionId, type ALInboundPendingAdmission } from './al-inbound-pending-admission.ts';
import { computeALInboundPlanningObservations } from './al-inbound-planner-snapshot.ts';
import { toALInboundResyncCursor } from './al-inbound-resync-required.ts';
import { isAuthorizedStoredWsClientDelivery, toALDeliveryCarrier } from './al-inbound-source-validation.ts';
import { computeALInboundWorkEntry, decodeALInboundWorkEntry, toALInboundWorkKey } from './al-inbound-work-entry.ts';
import { toALInboundGapRenewalsDueAt } from './gap-renewal/compute-al-inbound-gap-renewal.ts';
import { readALInboundEffectFacts, type ALInboundEffectFacts } from './prepare-al-inbound-commit-bundle.ts';
import { readALInboundMessageAuthorization, toALInboundReceiver } from './read-al-inbound-message-authorization.ts';
import { resolveALInboundSignFailurePolicy } from './receipt-proof/is-al-inbound-recipient-receipt.ts';
import { signALInboundReceiptControls } from './receipt-proof/sign-al-inbound-receipt-controls.ts';

/** A replay past its deadline wrote nothing, so it has no work to announce. */
const REPLAY_EXPIRED: ALInboundMessageAdmission.ReplayResult = {
    outcome: 'completed',
    wroteWork: false,
    admission: Either.ofRight({ kind: 'not-admitted', reason: 'expired' })
};

/** The verdict of a replay whose current authority refuses the message: the drop an ingress would state. */
const REPLAY_UNAUTHORIZED_ADMISSION: Either<ALMessageRejection, ALInboundMessageRuntime.Admission> = Either.ofRight({
    kind: 'not-admitted',
    reason: 'unauthorized'
});

/** A stored WS client scope its current authority no longer covers ends the row, and nothing is written. */
const REPLAY_STORED_SCOPE_REFUSED: ALInboundMessageAdmission.ReplayResult = {
    outcome: { kind: 'non-retryable', reason: 'Stored WS client scope does not authorize delivery' },
    wroteWork: false,
    admission: REPLAY_UNAUTHORIZED_ADMISSION
};

/** A message past its deadline, found before its write or by the write itself: nothing was written for it. */
const ATTEMPT_EXPIRED: ALInboundMessageAdmission.Attempt = {
    kind: 'completed',
    acceptance: { kind: 'not-admitted', reason: 'expired' },
    wroteWork: false
};

export namespace ALInboundMessageAdmission {
    export interface Dependencies extends
        Pick<
            ALInboundMessageRuntime.Dependencies,
            | 'admissionStore'
            | 'clock'
            | 'effectPreparation'
            | 'planIncomingMessage'
            | 'verifyPublicationProof'
            | 'forwardMessage'
            | 'forwardRetriedCopy'
            | 'canForwardMessage'
            | 'isRoomPeerPresent'
            | 'readGapNackRelayHops'
            | 'readPendingAdmissionAuthority'
            | 'readRelayedAckRejection'
            | 'readRelayedRepairRequestRejection'
            | 'onResyncRequired'
            | 'onReplayAdmitted'
            | 'orderingObserver'
            | 'receiptProofs'
            | 'diagnostics'
            | 'effectWorkerId'
        > {
        readonly workPort: ALWorkQueuePort;
        /** The factor the lane stretches every gap renewal interval by. */
        readonly gapRenewalStretch: number;
    }

    export type ReplayOutcome =
        | 'completed'
        | 'retry'
        | { readonly kind: 'not-ready'; readonly retryAfterMs: number; }
        | { readonly kind: 'non-retryable'; readonly reason: string; };

    export interface ReplayResult {
        readonly outcome: ReplayOutcome;
        /** The replay's own commit persisted work behind the page its batch read; nothing else announces it. */
        readonly wroteWork: boolean;
        /** The verdict this replay reached; `undefined` when it reached none: its authority asked for a retry, or shutdown. */
        readonly admission: Either<ALMessageRejection, ALInboundMessageRuntime.Admission> | undefined;
    }

    export type Attempt =
        | {
            readonly kind: 'completed';
            readonly acceptance: ALInboundMessageRuntime.Acceptance;
            /** The commit persisted work the inbound worker must claim; an idle worker stays idle without it. */
            readonly wroteWork: boolean;
        }
        /** Its write lost to another commit on a row it read: a fresh attempt reads the winner. */
        | { readonly kind: 'conflict'; readonly pending: ALInboundPendingAdmission; }
        /** A readmission whose first delivery still waits to run: it wrote nothing, and a second read finds the same. */
        | { readonly kind: 'waiting'; readonly pending: ALInboundPendingAdmission; };
}

interface ALInboundAttemptPreparation {
    /** The arriving message with the deadline its pre-plan resolves. */
    readonly admitted: ALMessage;
    /** The one clock reading the read, the plan and the effect facts share. */
    readonly nowMs: number;
    readonly prePlan: ALMessageHandlingPlan;
    readonly originAuthenticated: boolean;
    readonly facts: ALInboundEffectFacts;
}

interface ALInboundAttemptDecision {
    /** The message as it arrived, which the records after a commit name. */
    readonly msg: ALMessage;
    readonly source: ALInboundMessageRuntime.Source;
    readonly preparation: ALInboundAttemptPreparation;
    readonly read: ALInboundAdmissionRead;
    readonly plan: ALMessageHandlingPlan;
    readonly readmission: boolean;
    readonly deadline: number;
}

/** One conditional admission per `attempt`; its owner looks again after a lost write, and QueueBox replays the rest. */
export class ALInboundMessageAdmission {
    private readonly dependencies: ALInboundMessageAdmission.Dependencies;
    private readonly shutdown = new AbortController();

    constructor(dependencies: ALInboundMessageAdmission.Dependencies) {
        this.dependencies = dependencies;
    }

    dispose(): void {
        this.shutdown.abort();
    }

    async attempt(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source,
        planner: ALInboundPlanner
    ): Promise<Either<ALMessageRejection, ALInboundMessageAdmission.Attempt>> {
        const prepared = await this.prepareAttempt(msg, source, planner);
        if (prepared.left) {
            return Either.ofLeft(prepared.left);
        }
        const preparation = prepared.right!;
        const { admitted, nowMs, prePlan } = preparation;
        const read = await this.dependencies.admissionStore.readIncomingMessage({
            msg: admitted,
            source,
            nowMs,
            prePlan,
            selfPeerId: this.dependencies.effectPreparation.selfPeerId,
            orderingObserver: this.dependencies.orderingObserver
        });
        if (this.shutdown.signal.aborted) {
            return Either.ofRight({ kind: 'completed', acceptance: { kind: 'disposed' }, wroteWork: false });
        }
        const readmission = isALInboundOriginAuthenticatedReadmission({
            msg: admitted,
            ackAlgo: prePlan.ack.algo,
            originAuthenticated: preparation.originAuthenticated,
            owner: read.observations.messageOwner
        });
        const plan = planner(admitted, source, computeALInboundPlanningObservations(read, readmission));
        const deadline = resolveALMessageExpireAtMs(admitted, plan.effective) ??
            nowMs + read.retention.durableEffectTtlMs;
        if (deadline <= this.dependencies.clock.nowMs()) {
            return Either.ofRight(ATTEMPT_EXPIRED);
        }
        if (readmission && await this.isFirstDeliveryQueued(admitted)) {
            return Either.ofRight({ kind: 'waiting', pending: toPendingAdmission(admitted, deadline, source) });
        }
        return await this.writeAttempt({ msg, source, preparation, read, plan, readmission, deadline });
    }

    /** What an attempt holds before its store read: the message with its deadline, decoded, and its effect facts. */
    private async prepareAttempt(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source,
        planner: ALInboundPlanner
    ): Promise<Either<ALMessageRejection, ALInboundAttemptPreparation>> {
        await this.dependencies.verifyPublicationProof?.(msg);
        const nowMs = this.dependencies.clock.nowMs();
        const prePlan = planner(msg, source, { nowMs });
        const initialDeadline = resolveALMessageExpireAtMs(msg, prePlan.effective);
        const admitted = initialDeadline === undefined ? msg : toALInboundMessageWithDeadline(msg, initialDeadline);
        const decoded = decodeALMessageValue(admitted);
        if (decoded.left) {
            return Either.ofLeft(decoded.left);
        }
        const proofVerified = await this.dependencies.verifyPublicationProof?.(admitted) === true;
        const originAuthenticated = isALInboundOriginAuthenticated({ source, proofVerified });
        const facts = readALInboundEffectFacts(
            nowMs,
            this.dependencies.effectPreparation,
            () => this.dependencies.readGapNackRelayHops(admitted, [])
        );
        return Either.ofRight({ admitted, nowMs, prePlan, originAuthenticated, facts });
    }

    /** The bundle the decision computes, with what may be forwarded and the recorded parent's presence read now. */
    private readAttemptBundle(decision: ALInboundAttemptDecision): ALInboundCommitBundle {
        const { preparation, read, plan } = decision;
        const { admitted } = preparation;
        const canForward = !plan.dropReason && this.dependencies.forwardMessage !== undefined &&
            (this.dependencies.canForwardMessage?.(admitted) ?? true);
        const recordedParentPresent = read.pendingAck === undefined ||
            (this.dependencies.isRoomPeerPresent?.(admitted, read.pendingAck.toPeerId) ?? true);
        return computeALInboundAdmission({
            read,
            plan,
            canForward,
            recordedParentPresent,
            retriedCopyNextHopPeerIds: this.dependencies.forwardRetriedCopy === undefined
                ? []
                : preparation.prePlan.forwarding.nextHopPeerIds,
            originAuthenticated: preparation.originAuthenticated,
            readmission: decision.readmission,
            facts: preparation.facts
        });
    }

    /** The attempt's one conditional write; the records after it are made only once it committed. */
    private async writeAttempt(
        decision: ALInboundAttemptDecision
    ): Promise<Either<ALMessageRejection, ALInboundMessageAdmission.Attempt>> {
        const { msg, source, preparation, read, plan } = decision;
        const validated = validateALInboundCommitBundle(this.readAttemptBundle(decision), read.namespace);
        if (validated.left) {
            return Either.ofLeft(validated.left);
        }
        const signed = toALInboundGapRenewalsDueAt(
            await signALInboundReceiptControls({
                bundle: validated.right!,
                namespace: read.namespace,
                receiptProofs: this.dependencies.receiptProofs,
                signFailure: resolveALInboundSignFailurePolicy(preparation.admitted),
                diagnostics: this.dependencies.diagnostics
            }),
            preparation.nowMs,
            this.dependencies.gapRenewalStretch
        );
        const status = await this.dependencies.admissionStore.commitBundle(signed);
        if (status === 'expired') {
            return Either.ofRight(ATTEMPT_EXPIRED);
        }
        if (status === 'conflict') {
            return Either.ofRight({
                kind: 'conflict',
                pending: toPendingAdmission(preparation.admitted, decision.deadline, source)
            });
        }
        this.recordResyncRequired(msg, source, plan);
        this.recordOrderingPosition(msg, source, plan);
        return Either.ofRight({
            kind: 'completed',
            acceptance: toAdmissionAcceptance(plan),
            wroteWork: signed.durableEffects.length > 0
        });
    }

    /**
     * Whether the first admission's local delivery of `msg` still waits to run. A readmission waits for it (D756): the
     * first delivery reads the stored message when it runs, so the application gets the first copy's content, then the
     * origin's, each once.
     */
    private async isFirstDeliveryQueued(msg: ALMessage): Promise<boolean> {
        const entry = await this.dependencies.workPort.readEntry(
            toALInboundWorkKey(this.dependencies.admissionStore.namespace, toALInboundLocalDeliveryEffectId(msg, false))
        );
        return entry !== undefined && NOT_COMPLETED_RETRYABLE_STATUSES.has(entry.status);
    }

    /** After the commit, so the owner is told of a resynchronization the store has already NACKed. */
    private recordResyncRequired(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source,
        plan: ALMessageHandlingPlan
    ): void {
        const cursor = toALInboundResyncCursor({
            msg,
            observation: plan.orderingRuntime,
            carrier: toALDeliveryCarrier(source)
        });
        if (cursor !== undefined) {
            this.dependencies.onResyncRequired?.({ msg, cursor });
        }
    }

    /** After the commit, so the position it states is the one the store holds. */
    private recordOrderingPosition(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source,
        plan: ALMessageHandlingPlan
    ): void {
        recordALInboundOrderingPosition(this.dependencies.diagnostics, {
            workerId: this.dependencies.effectWorkerId,
            msg,
            carrier: toALDeliveryCarrier(source),
            plan
        });
    }

    /** A message its ingress authority cannot judge yet, kept to the deadline its admission would carry. */
    async retainIncomingMessage(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source,
        planner: ALInboundPlanner
    ): Promise<ALInboundMessageRuntime.Acceptance> {
        await this.dependencies.verifyPublicationProof?.(msg);
        const nowMs = this.dependencies.clock.nowMs();
        const plan = planner(msg, source, { nowMs });
        const deadline = resolveALMessageExpireAtMs(msg, plan.effective) ??
            nowMs + this.dependencies.admissionStore.retention.durableEffectTtlMs;
        return await this.retainPending({
            kind: 'admit-message',
            msg: toALInboundMessageWithDeadline(msg, deadline),
            source
        });
    }

    async retainPending(pending: ALInboundPendingAdmission): Promise<ALInboundMessageRuntime.Acceptance> {
        const { admissionStore, clock } = this.dependencies;
        const deadline = pending.msg.constraints.expiresAtMs;
        if (deadline <= clock.nowMs()) {
            return { kind: 'not-admitted', reason: 'expired' };
        }
        const work = computeALInboundWorkEntry({
            namespace: admissionStore.namespace,
            effectId: toALInboundPendingAdmissionId(pending.msg),
            payload: pending,
            observedAtMs: clock.nowMs(),
            expireAtTimestamp: deadline,
            carrier: toALDeliveryCarrier(pending.source),
            signsForRecipient: false
        });
        decodeALInboundWorkEntry(work.entry, admissionStore.namespace);
        const observed = await this.dependencies.workPort.retainIfAbsent(work.entry);
        const stored = decodeALInboundWorkEntry(observed, admissionStore.namespace);
        // One message retained by an earlier arrival, over either carrier, is this same pending admission:
        // the row keeps that first arrival's source, and only a different message or deadline is corrupt.
        if (
            stored.payload.kind !== 'admit-message' || !jsonEquals(stored.payload.msg, pending.msg) ||
            stored.expireAtTimestamp !== deadline
        ) {
            throw new ALAdmissionCorruptionError(
                JSON.stringify(observed.key),
                new TypeError('Pending inbound admission differs from its immutable message')
            );
        }
        if (deadline <= clock.nowMs()) {
            return { kind: 'not-admitted', reason: 'expired' };
        }
        return NOT_COMPLETED_RETRYABLE_STATUSES.has(observed.status)
            ? { kind: 'pending-admission' }
            : { kind: 'not-admitted', reason: 'pending admission has terminated' };
    }

    async replay(pending: ALInboundPendingAdmission): Promise<ALInboundMessageAdmission.ReplayResult> {
        const authority = await this.dependencies.readPendingAdmissionAuthority?.(pending.msg, pending.source) ??
            { kind: 'authorized', source: pending.source };
        if (pending.msg.constraints.expiresAtMs <= this.dependencies.clock.nowMs()) {
            return REPLAY_EXPIRED;
        }
        if (authority.kind !== 'authorized') {
            return toAuthorityReplay(authority);
        }
        if (!isAuthorizedStoredWsClientDelivery(pending.msg, authority.source)) {
            return REPLAY_STORED_SCOPE_REFUSED;
        }
        return await this.replayAuthorized(pending.msg, authority, pending.source);
    }

    /** One fresh attempt under the source its current authority answered with; an admission is handed to its owner. */
    private async replayAuthorized(
        msg: ALMessage,
        authority: Extract<ALInboundMessageRuntime.PendingAuthority, { kind: 'authorized'; }>,
        pendingSource: ALInboundMessageRuntime.Source
    ): Promise<ALInboundMessageAdmission.ReplayResult> {
        const { source } = authority;
        const authorization = await readALInboundMessageAuthorization(
            msg,
            source,
            toALInboundReceiver(
                this.dependencies.effectPreparation.selfPeerId,
                this.dependencies.readRelayedAckRejection,
                this.dependencies.readRelayedRepairRequestRejection
            )
        );
        if (authorization.left) {
            return toRejectedReplay(authorization.left);
        }
        const result = await this.attempt(msg, source, this.dependencies.planIncomingMessage);
        if (result.left) {
            return toRejectedReplay(result.left);
        }
        const attempt = result.right!;
        if (attempt.kind === 'completed' && attempt.acceptance.kind === 'admitted' && !this.shutdown.signal.aborted) {
            await this.dependencies.onReplayAdmitted?.({
                msg,
                source,
                pendingSource,
                snapshotVersion: authority.snapshotVersion
            });
        }
        return toAttemptReplay(attempt, this.shutdown.signal.aborted);
    }
}

/** An authority that asks for a retry reached no verdict; one that refuses the message drops it unauthorized. */
function toAuthorityReplay(
    authority: Exclude<ALInboundMessageRuntime.PendingAuthority, { kind: 'authorized'; }>
): ALInboundMessageAdmission.ReplayResult {
    return authority.kind === 'retry'
        ? {
            outcome: { kind: 'not-ready', retryAfterMs: authority.retryAfterMs },
            wroteWork: false,
            admission: undefined
        }
        : { outcome: 'completed', wroteWork: false, admission: REPLAY_UNAUTHORIZED_ADMISSION };
}

/** A rejection ends the retained row; it is stated by its own code, as an ingress states it. */
function toRejectedReplay(rejection: ALMessageRejection): ALInboundMessageAdmission.ReplayResult {
    return {
        outcome: { kind: 'non-retryable', reason: rejection.message },
        wroteWork: false,
        admission: Either.ofLeft(rejection)
    };
}

/**
 * A replay that conflicts again, or waits for its first delivery, is retained still, so it states pending again;
 * shutdown reached no verdict.
 */
function toAttemptReplay(
    attempt: ALInboundMessageAdmission.Attempt,
    shutDown: boolean
): ALInboundMessageAdmission.ReplayResult {
    return {
        outcome: attempt.kind !== 'completed' || shutDown ? 'retry' : 'completed',
        wroteWork: attempt.kind === 'completed' && attempt.wroteWork,
        admission: shutDown
            ? undefined
            : Either.ofRight(attempt.kind === 'completed' ? attempt.acceptance : { kind: 'pending-admission' })
    };
}

/** The admission retained to run again: its commit conflicted, or it waits on an earlier delivery of its message. */
function toPendingAdmission(
    msg: ALMessage,
    deadline: number,
    source: ALInboundMessageRuntime.Source
): ALInboundPendingAdmission {
    return { kind: 'admit-message', msg: toALInboundMessageWithDeadline(msg, deadline), source };
}

function toAdmissionAcceptance(plan: ALMessageHandlingPlan): ALInboundMessageRuntime.Acceptance {
    if (plan.orderingRuntime.status === 'resync-required') {
        return { kind: 'resync-required' };
    }
    if (plan.dropReasonCode === 'duplicate') {
        return { kind: 'duplicate' };
    }
    return plan.dropReason ? { kind: 'not-admitted', reason: plan.dropReason } : { kind: 'admitted' };
}
