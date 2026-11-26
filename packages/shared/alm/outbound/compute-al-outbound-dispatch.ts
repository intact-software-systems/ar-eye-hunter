import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { toChangedALMessageRow } from '../../al-contracts/al-message-persistence-validation.ts';
import { resolveALMessageExpireAtMs, type ALAckAlgo } from '../../al-contracts/al-policy.ts';
import { EntityStatus, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import type { ALOutboundPendingAckSnapshot, ALOutboundSentMessageSnapshot } from '../al-runtime-state-stores.ts';
import type { ALDeliveryAdmissionVerdict } from '../delivery/al-delivery-lifecycle.ts';
import {
    toALOutboundOrderingTrackMutations,
    type ALOutboundAdmissionMutation
} from './admission/al-outbound-admission-mutations.ts';
import {
    toALOutboundMessageFence,
    type ALOutboundCommitBundle,
    type ALOutboundDurableEffectWrite,
    type ALOutboundMessageReadDto
} from './admission/al-outbound-admission-store.ts';
import { toALOutboundSentPolicy } from './admission/al-outbound-admission-validation.ts';
import { toALOutboundRecordedSentPositions } from './admission/to-al-outbound-recorded-sent-positions.ts';
import { isALOutboundReadSignedHeldRow, toALOutboundMessageReference } from './al-outbound-canonical-message.ts';
import type {
    ALOutboundDispatchPhase,
    ALOutboundDispatchPlan,
    ALOutboundSettlementFact
} from './al-outbound-message-runtime.ts';
import {
    resolveALOutboundReplanRefusalSettlement,
    toALOutboundReplanRefusalComputed
} from './control/resolve-al-outbound-replan-refusal-settlement.ts';
import {
    toALOutboundDispatchCompletionReceipt,
    type ALOutboundDispatchCompletionRead
} from './control/to-al-outbound-dispatch-completion-receipt.ts';
import { computeALOutboundFirstHopWaitWrites } from './first-hop/compute-al-outbound-first-hop-wait.ts';
import { toALCapacityRefusedVerdict } from './lane/admit-al-outbound-volatile-budget.ts';
import {
    isALOutboundEmptyAudienceReceipt,
    toALOutboundEmptyAudienceReceipt
} from './message-end/to-al-outbound-empty-audience-receipt.ts';
import { toALOutboundReadMessageEndBundle } from './message-end/to-al-outbound-message-end-bundle.ts';
import {
    computeALOutboundRepairAttemptCharge,
    type ALOutboundRepairBudget
} from './repair-budget/compute-al-outbound-repair-attempt-charge.ts';
import {
    toALOutboundAckTimeoutEffectId,
    toALOutboundAttemptIdentity,
    toALOutboundSendEffectId
} from './to-al-outbound-effect-id.ts';
import { toALOutboundPreparedFingerprint } from './to-al-outbound-prepared-fingerprint.ts';
import {
    isALOutboundAckTrackingWritable,
    toALOutboundTrackedReceiptAlgo,
    trackALOutboundPendingAckSnapshot
} from './transition-al-outbound-pending-ack.ts';

export type ALOutboundComputeIntent = 'enqueue' | 'dequeue' | 'repair';

export interface ALOutboundCommitDispatchOptions {
    readonly explicitPlan?: boolean;
    readonly pendingAdmission?: ResourceEntry;
    readonly observedOutboxEntry?: ResourceEntry;
    /** The outbox row exactly as this caller's own claim returned it; its commit fences that claim. */
    readonly claimedOutboxEntry?: ResourceEntry;
    readonly attemptIdentity?: string;
    readonly repairBudget?: ALOutboundRepairBudget;
}

export interface ALOutboundComputedDto<TPrepared> {
    readonly msg?: ALMessage;
    readonly bundle?: ALOutboundCommitBundle<TPrepared>;
    readonly verdict: ALDeliveryAdmissionVerdict;
    readonly reason?: string;
    readonly entries: readonly ResourceEntry[];
    /** What an admitted plan, or the original of a duplicate, tracks; `none` for a verdict that admitted nothing. */
    readonly trackedReceiptAlgo: ALAckAlgo;
}

export interface ComputeALOutboundDispatchInput<TPrepared> {
    readonly read: ALOutboundMessageReadDto<TPrepared>;
    readonly outboxEntry: ResourceEntry;
    readonly dispatchAtMs: number;
    readonly intent: ALOutboundComputeIntent;
    readonly phase: ALOutboundDispatchPhase;
    readonly options: ALOutboundCommitDispatchOptions;
}

/** The state mutations and durable effects one commit writes together. */
export interface ALOutboundDispatchWrites<TPrepared> {
    readonly mutations: readonly ALOutboundAdmissionMutation[];
    readonly durableEffects: readonly ALOutboundDurableEffectWrite<TPrepared>[];
}

/** What an admitted dispatch writes from: its canonical row, its repair charge, and whether it completes its receipt. */
interface ComputeALOutboundDispatchWritesInput<TPrepared> {
    readonly dispatch: ComputeALOutboundDispatchInput<TPrepared>;
    readonly canonicalEntry: ResourceEntry;
    readonly repairCharge: readonly ALOutboundAdmissionMutation[];
    readonly completesReceiptAtAdmission: boolean;
}

/** How a dispatch with no early exit is routed. */
interface ALOutboundRouteInput {
    readonly durable: boolean;
    readonly completesReceiptAtAdmission: boolean;
    readonly queuedAttempts: number;
}

export function computeALOutboundDispatch<TPrepared>(
    input: ComputeALOutboundDispatchInput<TPrepared>
): ALOutboundComputedDto<TPrepared> {
    const earlyResult = toEarlyDispatchResult(input);
    if (earlyResult) {
        return { ...earlyResult, msg: input.read.msg };
    }
    const { read, options } = input;
    const repairCharge = computeALOutboundRepairAttemptCharge(read, options.repairBudget);
    if (repairCharge.left) {
        return toRepairExhaustedResult(read, repairCharge.left.detail);
    }

    const completesReceiptAtAdmission = isReceiptCompleteAtAdmission(input);
    const awaitPhysicalDispatch = input.intent === 'enqueue' && read.plan.preparedMessages.length === 0 &&
        !completesReceiptAtAdmission;
    const canonicalEntry = toChangedALMessageRow(input.outboxEntry, {
        status: awaitPhysicalDispatch ? EntityStatus.NEW : EntityStatus.COMPLETED
    });
    const writes = computeDispatchWrites({
        dispatch: input,
        canonicalEntry,
        repairCharge: repairCharge.right!,
        completesReceiptAtAdmission
    });
    const verdict = computeALOutboundRouteVerdict(read, {
        durable: awaitPhysicalDispatch || read.plan.lane !== 'volatile',
        completesReceiptAtAdmission,
        queuedAttempts: writes.durableEffects.filter((effect) => effect.payload.kind === 'send-prepared').length
    });
    const reason = verdict.kind === 'unroutable' ? verdict.detail : undefined;
    return {
        ...toALOutboundComputedResult(verdict, reason, [canonicalEntry]),
        msg: read.msg,
        trackedReceiptAlgo: verdict.kind === 'admitted'
            ? toALOutboundTrackedReceiptAlgo(read.plan.ackTracking)
            : 'none',
        bundle: toDispatchBundle(input, canonicalEntry, writes)
    };
}

/**
 * Whether this admission's receipt is complete with nobody to confirm it, which ends the message in the admission's
 * own commit: a send with no copy then leaves no canonical row for a later dequeue. Only the admission decides it; a
 * later dispatch of the message finds it ended.
 */
function isReceiptCompleteAtAdmission<TPrepared>(input: ComputeALOutboundDispatchInput<TPrepared>): boolean {
    return input.intent === 'enqueue' && isALOutboundEmptyAudienceReceipt(input.read.plan);
}

function toDispatchBundle<TPrepared>(
    input: ComputeALOutboundDispatchInput<TPrepared>,
    canonicalEntry: ResourceEntry,
    writes: ALOutboundDispatchWrites<TPrepared>
): ALOutboundCommitBundle<TPrepared> {
    const { read, options } = input;
    return {
        pendingAdmission: options.pendingAdmission,
        claimedCanonical: options.claimedOutboxEntry,
        senderId: read.msg.id.senderId,
        expectedVersion: read.clientRecord?.version,
        fencesSender: true,
        message: toALOutboundMessageFence(
            { originPeerId: read.msg.id.senderId, msgId: read.msg.id.msgId },
            read.messageVersion,
            toALOutboundMessageReference(read.canonicalScope, canonicalEntry, read.msg).expiresAtMs
        ),
        canonicalEntry,
        mutations: writes.mutations,
        durableEffects: writes.durableEffects.map((effect) => ({
            ...effect,
            retryAtMs: effect.retryAtMs ?? input.dispatchAtMs
        })),
        endedTimeoutEffectIds: []
    };
}

/** A spent repair budget is the message's terminal settlement: its commit ends the message. */
function toRepairExhaustedResult<TPrepared>(
    read: ALOutboundMessageReadDto<TPrepared>,
    detail: string
): ALOutboundComputedDto<TPrepared> {
    return {
        ...toALOutboundComputedResult<TPrepared>({ kind: 'skipped', reason: 'repair-exhausted', detail }, detail),
        msg: read.msg,
        bundle: toALOutboundReadMessageEndBundle(read.msg, read)
    };
}

/**
 * Everything an admitted dispatch writes: its message rows, its repair charge, its sends, and its receipt or the
 * first-hop wait that stands until the receipt's first answer.
 */
function computeDispatchWrites<TPrepared>(
    input: ComputeALOutboundDispatchWritesInput<TPrepared>
): ALOutboundDispatchWrites<TPrepared> {
    const { dispatch, canonicalEntry } = input;
    const { read } = dispatch;
    const messageExpiresAtMs = toALOutboundMessageReference(read.canonicalScope, canonicalEntry, read.msg).expiresAtMs;
    const receipt = computeReceiptWrites(input, messageExpiresAtMs);
    const firstHop = computeALOutboundFirstHopWaitWrites(dispatch, messageExpiresAtMs);
    return {
        mutations: [
            ...computeMessageMutations(read, canonicalEntry, receipt.completesReceipt),
            ...input.repairCharge,
            ...receipt.mutations,
            ...firstHop.mutations
        ],
        durableEffects: [
            ...computePreparedEffects(dispatch, canonicalEntry),
            ...receipt.durableEffects,
            ...firstHop.durableEffects
        ]
    };
}

/**
 * The receipt writes of a dispatch, and whether its commit completes the message's receipt: an admission whose
 * receipt nobody is left to confirm completes it with no row, and a dispatch with copies may complete its open row.
 */
function computeReceiptWrites<TPrepared>(
    input: ComputeALOutboundDispatchWritesInput<TPrepared>,
    messageExpiresAtMs: number
): ALOutboundReceiptWrites<TPrepared> {
    if (input.completesReceiptAtAdmission) {
        return RECEIPT_COMPLETE_AT_ADMISSION;
    }
    return input.dispatch.read.plan.preparedMessages.length > 0
        ? computeAckTrackingWrites(input.dispatch, messageExpiresAtMs)
        : NO_RECEIPT_WRITES;
}

function toALOutboundComputedResult<TPrepared>(
    verdict: ALDeliveryAdmissionVerdict,
    reason: string | undefined,
    entries: readonly ResourceEntry[] = []
): ALOutboundComputedDto<TPrepared> {
    return { verdict, reason, entries, trackedReceiptAlgo: 'none' };
}

/**
 * A fresh (non-early-exit) dispatch admits the message when it keeps it durably, queues a copy, or completes its
 * receipt at admission; otherwise it has nowhere to route it.
 */
function computeALOutboundRouteVerdict<TPrepared>(
    read: ALOutboundMessageReadDto<TPrepared>,
    route: ALOutboundRouteInput
): ALDeliveryAdmissionVerdict {
    const { durable, queuedAttempts } = route;
    return durable || route.completesReceiptAtAdmission || read.plan.preparedMessages.length > 0
        ? { kind: 'admitted', durable, queuedAttempts }
        : {
            kind: 'unroutable',
            reason: 'no-route',
            detail: `No outbound transport route for message ${read.msg.id.msgId}`
        };
}

function computeMessageMutations<TPrepared>(
    read: ALOutboundMessageReadDto<TPrepared>,
    canonicalEntry: ResourceEntry,
    completesReceipt: boolean
): ALOutboundAdmissionMutation[] {
    const expiresAtMs = resolveALMessageExpireAtMs(read.msg);
    const mutations: ALOutboundAdmissionMutation[] = [
        {
            kind: 'set-msg-owner',
            msgId: read.msg.id.msgId,
            senderId: read.msg.id.senderId,
            expireAtTimestamp: expiresAtMs
        },
        toSentMessageMutation(read, canonicalEntry, completesReceipt)
    ];
    mutations.push(...toALOutboundOrderingTrackMutations(read, expiresAtMs));
    appendSupersedenceMutations(mutations, read);
    return mutations;
}

function computePreparedEffects<TPrepared>(
    input: ComputeALOutboundDispatchInput<TPrepared>,
    canonicalEntry: ResourceEntry
): ALOutboundDurableEffectWrite<TPrepared>[] {
    const { read, options, phase } = input;
    const reference = toALOutboundMessageReference(read.canonicalScope, canonicalEntry, read.msg);
    const attemptIdentity = toALOutboundAttemptIdentity(options);
    const sentPositions = toALOutboundRecordedSentPositions(read);
    return read.plan.preparedMessages.map((prepared, index) => {
        const preparedFingerprint = toALOutboundPreparedFingerprint(prepared);
        return {
            effectId: toALOutboundSendEffectId({
                msgId: read.msg.id.msgId,
                phase,
                attemptIdentity,
                index,
                preparedFingerprint
            }),
            expireAtTimestamp: reference.expiresAtMs,
            payload: {
                kind: 'send-prepared',
                message: reference,
                prepared,
                preparedFingerprint,
                attemptIdentity,
                phase,
                sentPositions
            }
        };
    });
}

function toEarlyDispatchResult<TPrepared>(
    input: ComputeALOutboundDispatchInput<TPrepared>
): ALOutboundComputedDto<TPrepared> | undefined {
    const { read } = input;
    const expiresAtMs = Math.min(
        resolveALMessageExpireAtMs(read.msg) ?? Infinity,
        read.storedMessage?.reference.expiresAtMs ?? Infinity
    );
    if (expiresAtMs <= input.dispatchAtMs) {
        const detail = 'Message expired or is too stale';
        return toALOutboundComputedResult({ kind: 'expired', detail }, detail);
    }
    if (input.intent !== 'enqueue' && read.storedMessage?.ended) {
        const detail = `Message ${read.msg.id.msgId} has ended: nothing more is sent for it.`;
        return toALOutboundComputedResult({ kind: 'skipped', reason: 'message-ended', detail }, detail);
    }
    if (read.plan.dropReason) {
        const verdict = toALOutboundAdmissionVerdict(read.plan);
        const computed = toALOutboundComputedResult<TPrepared>(verdict, read.plan.dropReason);
        return toALOutboundReplanRefusalComputed({ computed, read, intent: input.intent });
    }
    if (input.intent === 'repair' && read.plan.preparedMessages.length === 0) {
        const detail = 'Repair has no prepared recipient attempt';
        return toALOutboundComputedResult({ kind: 'unroutable', reason: 'no-route', detail }, detail);
    }
    if (input.intent === 'enqueue' && read.sentSnapshot) {
        return toDuplicateDispatchResult(input, read.sentSnapshot);
    }
    if (read.supersedenceAcceptance?.observation.status === 'superseded') {
        const detail = `Skipping superseded outbound message ${read.msg.id.msgId}`;
        return toALOutboundComputedResult({ kind: 'superseded', detail }, detail);
    }
    return undefined;
}

/**
 * A replay answers `duplicate`. One whose read signed the row its sender still holds unsigned also stores that row,
 * frozen and signed, and leaves the send to the row's dequeue. Nothing orders the replay behind the dequeue that
 * freezes the row (ruling 22): the version fence lets one of the two store the proof, and the other reads it.
 */
function toDuplicateDispatchResult<TPrepared>(
    input: ComputeALOutboundDispatchInput<TPrepared>,
    sentSnapshot: ALOutboundSentMessageSnapshot
): ALOutboundComputedDto<TPrepared> {
    const { read } = input;
    const entry = sentSnapshot.outboxKey ? { ...input.outboxEntry, key: sentSnapshot.outboxKey } : undefined;
    const duplicate: ALOutboundComputedDto<TPrepared> = {
        ...toALOutboundComputedResult(
            { kind: 'duplicate' },
            `Duplicate outbound message ${read.msg.id.msgId}`,
            entry ? [entry] : []
        ),
        trackedReceiptAlgo: toALOutboundTrackedReceiptAlgo(read.storedMessage?.policy.ackTracking)
    };
    if (!isALOutboundReadSignedHeldRow(read)) {
        return duplicate;
    }
    // The read holds the row it signed, so the entry already carries that row's key.
    const canonicalEntry = toChangedALMessageRow(input.outboxEntry, { status: EntityStatus.NEW });
    return {
        ...duplicate,
        entries: [canonicalEntry],
        bundle: toDispatchBundle(input, canonicalEntry, {
            mutations: [toSentMessageMutation(read, canonicalEntry, false)],
            durableEffects: []
        })
    };
}

/** Keyed on the planner's drop code, never the human-readable `dropReason` string. */
export function toALOutboundAdmissionVerdict<TPrepared>(
    plan: Pick<ALOutboundDispatchPlan<TPrepared>, 'dropReason' | 'dropReasonCode' | 'capacityLimit'>
): ALDeliveryAdmissionVerdict {
    const detail = plan.dropReason ?? '';
    switch (plan.dropReasonCode) {
        case 'unauthorized':
        case 'unsupported':
        case 'no-leader':
        case 'no-publish-grant':
        case 'congested':
            return { kind: 'refused', reason: plan.dropReasonCode, detail };
        case 'capacity':
            return toALCapacityRefusedVerdict(plan.capacityLimit, detail);
        case 'not-yet-in-sync':
            return { kind: 'deferred', reason: 'not-yet-in-sync', detail };
        case 'no-route':
            return { kind: 'unroutable', reason: 'no-route', detail };
        case 'superseded':
            return { kind: 'superseded', detail };
        case 'expired':
            return { kind: 'expired', detail };
        case 'duplicate':
            return { kind: 'duplicate' };
        case 'planner-drop':
        case undefined:
            return { kind: 'skipped', reason: 'planner-drop', detail };
    }
}

function appendSupersedenceMutations<TPrepared>(
    mutations: ALOutboundAdmissionMutation[],
    read: ALOutboundMessageReadDto<TPrepared>
): void {
    const tracking = read.plan.supersedenceTracking;
    if (!tracking?.enabled || !tracking.key || !read.supersedenceAcceptance?.latestWrite) {
        return;
    }

    mutations.push({
        kind: 'set-supersedence-latest',
        supersedenceKey: tracking.key,
        expected: read.supersedence.latest,
        value: read.supersedenceAcceptance.latestWrite
    });
    for (const replacement of read.supersedenceAcceptance.replacementWrites) {
        mutations.push({
            kind: 'set-supersedence-replacement',
            msgId: replacement.msgId,
            value: replacement.value,
            observed: replacement.msgId === tracking.replacesMsgId ? read.supersedence.replacesReplacement : undefined
        });
    }
}

export interface ALOutboundCommitSettlementsInput<TPrepared> {
    readonly bundle: ALOutboundCommitBundle<TPrepared>;
    readonly msg: ALMessage;
    readonly read: ALOutboundDispatchCompletionRead<TPrepared>;
    readonly intent: ALOutboundComputeIntent;
}

/**
 * What a committed dispatch states at once: each message it superseded, and the receipt it completed -- only when
 * this commit itself completed it, which its sent row's end marker states. A commit that ends a message for another
 * reason states its own fact.
 */
export function toALOutboundCommitSettlements<TPrepared>(
    input: ALOutboundCommitSettlementsInput<TPrepared>
): readonly ALOutboundSettlementFact[] {
    const superseded = toALOutboundSupersededMsgIds(input.bundle).map((msgId): ALOutboundSettlementFact => ({
        kind: 'superseded',
        msgId,
        traceId: input.msg.id.traceId,
        replacementMsgId: input.msg.id.msgId,
        detail: 'A newer message replaced this one at its admission.'
    }));
    const completesReceipt = input.bundle.mutations.some((mutation) =>
        mutation.kind === 'set-sent-message' && mutation.ended
    );
    const completion = completesReceipt ? toCompletedReceiptFact(input.read) : undefined;
    const refusal = resolveALOutboundReplanRefusalSettlement(
        input.msg,
        toALOutboundAdmissionVerdict(input.read.plan),
        input.intent
    );
    return [...superseded, completion, refusal].filter((fact) => fact !== undefined);
}

/**
 * The acknowledgement of the receipt a commit completed: the open row its re-plan completed, or, with no row open,
 * the receipt an admission completed with nobody to confirm it.
 */
function toCompletedReceiptFact<TPrepared>(
    read: ALOutboundDispatchCompletionRead<TPrepared>
): ALOutboundSettlementFact | undefined {
    return read.pendingAck === undefined
        ? toALOutboundEmptyAudienceReceipt(read.msg)
        : toALOutboundDispatchCompletionReceipt(read);
}

/**
 * The predecessors this commit newly marks replaced: the observed supersedence state against what the
 * mutations write. Only the commit that moves the key's latest pointer to the message supersedes
 * anything, and never a predecessor whose row it observed already replaced -- a later commit of the
 * same message, or a named `replacesMsgId` another message already replaced, states nothing new.
 * A predecessor that is both the latest and the named `replacesMsgId` has its row written twice.
 */
function toALOutboundSupersededMsgIds<TPrepared>(bundle: ALOutboundCommitBundle<TPrepared>): readonly string[] {
    const latest = bundle.mutations.find((mutation) => mutation.kind === 'set-supersedence-latest');
    if (!latest || latest.expected?.latestMsgId === latest.value.latestMsgId) {
        return [];
    }
    const replaced = bundle.mutations.flatMap((mutation) =>
        mutation.kind === 'set-supersedence-replacement' && mutation.observed === undefined ? [mutation.msgId] : []
    );
    return [...new Set(replaced)];
}

/** A dispatch's receipt writes, and whether its commit completes the message's receipt, which ends the message. */
interface ALOutboundReceiptWrites<TPrepared> extends ALOutboundDispatchWrites<TPrepared> {
    readonly completesReceipt: boolean;
}

const NO_RECEIPT_WRITES: ALOutboundReceiptWrites<never> = {
    mutations: [],
    durableEffects: [],
    completesReceipt: false
};

const RECEIPT_COMPLETE_AT_ADMISSION: ALOutboundReceiptWrites<never> = {
    mutations: [],
    durableEffects: [],
    completesReceipt: true
};

function computeAckTrackingWrites<TPrepared>(
    input: ComputeALOutboundDispatchInput<TPrepared>,
    messageExpiresAtMs: number
): ALOutboundReceiptWrites<TPrepared> {
    const { read } = input;
    const tracking = read.plan.ackTracking;
    if (tracking === undefined || !isALOutboundAckTrackingWritable(tracking)) {
        return NO_RECEIPT_WRITES;
    }

    const pending = trackALOutboundPendingAckSnapshot({
        msgId: read.msg.id.msgId,
        current: read.pendingAck,
        acks: read.acks,
        tracking,
        nowMs: read.nowMs
    });
    if (!pending) {
        return read.pendingAck ? toCompletedRowWrites(read.msg) : NO_RECEIPT_WRITES;
    }
    return toOpenReceiptWrites(input, pending, messageExpiresAtMs);
}

/** The open receipt row a dispatch's tracking now fully confirms is deleted with its repair count. */
function toCompletedRowWrites(msg: ALMessage): ALOutboundReceiptWrites<never> {
    return {
        mutations: [
            { kind: 'delete-pending-ack', originPeerId: msg.id.senderId, msgId: msg.id.msgId },
            { kind: 'delete-repair-attempt', msgId: msg.id.msgId }
        ],
        durableEffects: [],
        completesReceipt: true
    };
}

function toOpenReceiptWrites<TPrepared>(
    input: ComputeALOutboundDispatchInput<TPrepared>,
    pending: ALOutboundPendingAckSnapshot,
    messageExpiresAtMs: number
): ALOutboundReceiptWrites<TPrepared> {
    const { read } = input;
    const opened: ALOutboundPendingAckSnapshot = read.pendingAck === undefined
        ? {
            ...pending,
            firstAttempt: { attemptIdentity: toALOutboundAttemptIdentity(input.options), phase: input.phase }
        }
        : pending;
    return {
        completesReceipt: false,
        mutations: [{
            kind: 'set-pending-ack',
            originPeerId: read.msg.id.senderId,
            snapshot: opened,
            expireAtTimestamp: messageExpiresAtMs
        }],
        durableEffects: [{
            effectId: toALOutboundAckTimeoutEffectId(pending),
            retryAtMs: pending.deadlineAtMs,
            // Downtime spends no attempts: retain the retry until the original message deadline.
            expireAtTimestamp: messageExpiresAtMs,
            payload: { kind: 'ack-timeout', msgId: pending.msgId }
        }]
    };
}

function toSentMessageMutation<TPrepared>(
    read: ALOutboundMessageReadDto<TPrepared>,
    canonicalEntry: ResourceEntry,
    ended: boolean
): ALOutboundAdmissionMutation {
    return {
        kind: 'set-sent-message',
        reference: toALOutboundMessageReference(read.canonicalScope, canonicalEntry, read.msg),
        policy: toALOutboundSentPolicy(read.storedMessage?.policy, read.plan),
        sentPositions: toALOutboundRecordedSentPositions(read),
        creationExpiry: read.creationExpiry,
        snapshot: {
            msgId: read.msg.id.msgId,
            msg: read.msg,
            outboxKey: canonicalEntry.key,
            supersedenceKey: read.plan.supersedenceTracking?.key ?? null
        } satisfies ALOutboundSentMessageSnapshot,
        ended
    };
}
