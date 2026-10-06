import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs, type ALAckAlgo } from '../../al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '../../al-contracts/al-runtime.ts';
import { EntityStatus, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { Either } from '../../resilience/Either.ts';
import type { ALOutboundSentMessageSnapshot } from '../al-runtime-state-stores.ts';
import type { ALDeliveryAdmissionVerdict } from '../delivery/al-delivery-lifecycle.ts';
import type { ALOutboundAdmissionMutation } from './admission/al-outbound-admission-mutations.ts';
import type {
    ALOutboundCommitBundle,
    ALOutboundDurableEffectWrite,
    ALOutboundMessageReadDto
} from './admission/al-outbound-admission-store.ts';
import { toALOutboundSentPolicy } from './admission/al-outbound-admission-validation.ts';
import { toALOutboundMessageReference } from './al-outbound-canonical-message.ts';
import type {
    ALOutboundDispatchPhase,
    ALOutboundDispatchPlan,
    ALOutboundSettlementFact
} from './al-outbound-message-runtime.ts';
import {
    toALOutboundDispatchCompletionReceipt,
    type ALOutboundDispatchCompletionRead
} from './control/to-al-outbound-dispatch-completion-receipt.ts';
import { toALOutboundAckTimeoutEffectId, toALOutboundSendEffectId } from './to-al-outbound-effect-id.ts';
import { toALOutboundPreparedFingerprint } from './to-al-outbound-prepared-fingerprint.ts';
import {
    isALOutboundAckTrackingWritable,
    toALOutboundAckRetryScheduleEndTimestamp,
    toALOutboundEmptyAudienceReceipt,
    toALOutboundTrackedReceiptAlgo,
    trackALOutboundPendingAckSnapshot
} from './transition-al-outbound-pending-ack.ts';

export type ALOutboundComputeIntent = 'enqueue' | 'dequeue' | 'repair';

export interface ALOutboundCommitDispatchOptions {
    readonly explicitPlan?: boolean;
    readonly pendingAdmission?: ResourceEntry;
    readonly observedOutboxEntry?: ResourceEntry;
    readonly attemptIdentity?: string;
    readonly repairBudget?: Readonly<{ priorAttempts: number; maxAttempts: number; }>;
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

/** A repair budget a message has spent, as its exhaustion settlement states it. */
interface ALOutboundRepairExhaustion {
    readonly attempts: number;
    readonly maxAttempts: number;
}

/** The state mutations and durable effects one commit writes together. */
interface ALOutboundDispatchWrites<TPrepared> {
    readonly mutations: readonly ALOutboundAdmissionMutation[];
    readonly durableEffects: readonly ALOutboundDurableEffectWrite<TPrepared>[];
}

export function computeALOutboundDispatch<TPrepared>(
    input: ComputeALOutboundDispatchInput<TPrepared>
): ALOutboundComputedDto<TPrepared> {
    const earlyResult = toEarlyDispatchResult(input);
    if (earlyResult) {
        return { ...earlyResult, msg: input.read.msg };
    }
    const { read, options } = input;
    const repairCharge = computeRepairAttemptCharge(read, options.repairBudget);
    if (repairCharge.left) {
        const detail = toALOutboundRepairExhaustedDetail(read.msg.id.msgId, repairCharge.left);
        return toALOutboundComputedResult({ kind: 'skipped', reason: 'repair-exhausted', detail }, detail);
    }

    const awaitPhysicalDispatch = input.intent === 'enqueue' && read.plan.preparedMessages.length === 0;
    const canonicalEntry = {
        ...input.outboxEntry,
        status: awaitPhysicalDispatch ? EntityStatus.NEW : EntityStatus.COMPLETED
    };
    const writes = computeDispatchWrites(input, canonicalEntry, repairCharge.right!);
    const queuedAttempts = writes.durableEffects.filter((effect) => effect.payload.kind === 'send-prepared').length;
    const verdict = computeALOutboundRouteVerdict(
        read,
        awaitPhysicalDispatch || read.plan.lane !== 'volatile',
        queuedAttempts
    );
    return {
        ...toALOutboundComputedResult(
            verdict,
            verdict.kind === 'unroutable' ? verdict.detail : undefined,
            [canonicalEntry]
        ),
        msg: read.msg,
        trackedReceiptAlgo: verdict.kind === 'admitted'
            ? toALOutboundTrackedReceiptAlgo(read.plan.ackTracking)
            : 'none',
        bundle: {
            pendingAdmission: options.pendingAdmission,
            senderId: read.msg.id.senderId,
            expectedVersion: read.clientRecord?.version,
            canonicalEntry,
            mutations: writes.mutations,
            durableEffects: writes.durableEffects.map((effect) => ({
                ...effect,
                retryAtMs: effect.retryAtMs ?? input.dispatchAtMs
            }))
        }
    };
}

/** The identity the sends of one dispatch carry: `initial` for a first send, its hint's for a repair. */
export function toALOutboundAttemptIdentity(options: ALOutboundCommitDispatchOptions): string {
    return options.attemptIdentity ?? 'initial';
}

/** Everything an admitted dispatch writes: its message rows, its repair charge, its sends and its receipt. */
function computeDispatchWrites<TPrepared>(
    input: ComputeALOutboundDispatchInput<TPrepared>,
    canonicalEntry: ResourceEntry,
    repairCharge: readonly ALOutboundAdmissionMutation[]
): ALOutboundDispatchWrites<TPrepared> {
    const { read } = input;
    const ackTracking = read.plan.preparedMessages.length > 0
        ? computeAckTrackingWrites(
            read,
            toALOutboundMessageReference(read.canonicalScope, canonicalEntry, read.msg).expiresAtMs
        )
        : { mutations: [], durableEffects: [] };
    return {
        mutations: [...computeMessageMutations(read, canonicalEntry), ...repairCharge, ...ackTracking.mutations],
        durableEffects: [...computePreparedEffects(input, canonicalEntry), ...ackTracking.durableEffects]
    };
}

function toALOutboundComputedResult<TPrepared>(
    verdict: ALDeliveryAdmissionVerdict,
    reason: string | undefined,
    entries: readonly ResourceEntry[] = []
): ALOutboundComputedDto<TPrepared> {
    return { verdict, reason, entries, trackedReceiptAlgo: 'none' };
}

/** A fresh (non-early-exit) dispatch either admits the message or has nowhere to route it. */
function computeALOutboundRouteVerdict<TPrepared>(
    read: ALOutboundMessageReadDto<TPrepared>,
    durable: boolean,
    queuedAttempts: number
): ALDeliveryAdmissionVerdict {
    return durable || read.plan.preparedMessages.length > 0
        ? { kind: 'admitted', durable, queuedAttempts }
        : {
            kind: 'unroutable',
            reason: 'no-route',
            detail: `No outbound transport route for message ${read.msg.id.msgId}`
        };
}

function computeMessageMutations<TPrepared>(
    read: ALOutboundMessageReadDto<TPrepared>,
    canonicalEntry: ResourceEntry
): ALOutboundAdmissionMutation[] {
    const expiresAtMs = resolveALMessageExpireAtMs(read.msg);
    const mutations: ALOutboundAdmissionMutation[] = [
        {
            kind: 'set-msg-owner',
            msgId: read.msg.id.msgId,
            senderId: read.msg.id.senderId,
            expireAtTimestamp: expiresAtMs
        },
        toSentMessageMutation(read, canonicalEntry)
    ];
    const trackKey = toALOrderingTrackKey(read.msg);
    if (trackKey && read.msg.ordering?.seq !== undefined && expiresAtMs !== undefined) {
        mutations.push({
            kind: 'set-ordering-message',
            trackKey,
            seq: read.msg.ordering.seq,
            msgId: read.msg.id.msgId,
            expireAtTimestamp: expiresAtMs
        });
    }
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
                phase
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
    if (read.plan.dropReason) {
        return toALOutboundComputedResult(toALOutboundAdmissionVerdict(read.plan), read.plan.dropReason);
    }
    if (input.intent === 'repair' && read.plan.preparedMessages.length === 0) {
        const detail = 'Repair has no prepared recipient attempt';
        return toALOutboundComputedResult({ kind: 'unroutable', reason: 'no-route', detail }, detail);
    }
    if (input.intent === 'enqueue' && read.sentSnapshot) {
        return toDuplicateDispatchResult(read, input.outboxEntry);
    }
    if (read.supersedenceAcceptance?.observation.status === 'superseded') {
        const detail = `Skipping superseded outbound message ${read.msg.id.msgId}`;
        return toALOutboundComputedResult({ kind: 'superseded', detail }, detail);
    }
    return undefined;
}

function toDuplicateDispatchResult<TPrepared>(
    read: ALOutboundMessageReadDto<TPrepared>,
    outboxEntry: ResourceEntry
): ALOutboundComputedDto<TPrepared> {
    const entry = read.sentSnapshot?.outboxKey
        ? { ...outboxEntry, key: read.sentSnapshot.outboxKey }
        : undefined;
    return {
        ...toALOutboundComputedResult(
            { kind: 'duplicate' },
            `Duplicate outbound message ${read.msg.id.msgId}`,
            entry ? [entry] : []
        ),
        trackedReceiptAlgo: toALOutboundTrackedReceiptAlgo(read.storedMessage?.policy.ackTracking)
    };
}

/** Keyed on the planner's drop code, never the human-readable `dropReason` string. */
function toALOutboundAdmissionVerdict<TPrepared>(
    plan: Pick<ALOutboundDispatchPlan<TPrepared>, 'dropReason' | 'dropReasonCode'>
): ALDeliveryAdmissionVerdict {
    const detail = plan.dropReason ?? '';
    switch (plan.dropReasonCode) {
        case 'unauthorized':
        case 'unsupported':
        case 'capacity':
            return { kind: 'refused', reason: plan.dropReasonCode, detail };
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

/**
 * The one charge a budgeted repair makes, or the exhaustion it finds instead. The charge belongs to the
 * attempt's sends: a hint re-executed after a conflict or an expired lease finds them committed and
 * charges nothing more, so a budget is spent once per attempt identity.
 */
function computeRepairAttemptCharge<TPrepared>(
    read: ALOutboundMessageReadDto<TPrepared>,
    repairBudget: ALOutboundCommitDispatchOptions['repairBudget']
): Either<ALOutboundRepairExhaustion, readonly ALOutboundAdmissionMutation[]> {
    if (!repairBudget || read.repairAttemptCommitted) {
        return Either.ofRight([]);
    }
    const attempts = read.repairAttempt?.attempts ?? repairBudget.priorAttempts;
    if (attempts >= repairBudget.maxAttempts) {
        return Either.ofLeft({ attempts, maxAttempts: repairBudget.maxAttempts });
    }
    return Either.ofRight([{
        kind: 'set-repair-attempt',
        snapshot: { msgId: read.msg.id.msgId, attempts: attempts + 1 }
    }]);
}

function toALOutboundRepairExhaustedDetail(msgId: string, exhaustion: ALOutboundRepairExhaustion): string {
    return `The repair of ${msgId} ran out of retransmits after ${exhaustion.attempts} of ${exhaustion.maxAttempts}.`;
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
 * What a committed dispatch states at once: each message it superseded, a receipt nobody is left to
 * confirm, and the receipt its re-plan completed -- only when this commit deletes that row, since a
 * dispatch with no prepared copy writes no receipt mutation at all.
 */
export function toALOutboundCommitSettlements<TPrepared>(
    input: ALOutboundCommitSettlementsInput<TPrepared>
): readonly ALOutboundSettlementFact[] {
    const superseded = toALOutboundSupersededMsgIds(input.bundle).map((msgId): ALOutboundSettlementFact => ({
        kind: 'superseded',
        msgId,
        replacementMsgId: input.msg.id.msgId,
        detail: 'A newer message replaced this one at its admission.'
    }));
    const emptyAudience = input.intent === 'enqueue'
        ? toALOutboundEmptyAudienceReceipt(input.read.plan)
        : undefined;
    const deletesReceipt = input.bundle.mutations.some((mutation) => mutation.kind === 'delete-pending-ack');
    const completion = deletesReceipt
        ? toALOutboundDispatchCompletionReceipt(input.read)
        : undefined;
    return [...superseded, emptyAudience, completion].filter((fact) => fact !== undefined);
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

function computeAckTrackingWrites<TPrepared>(
    read: ALOutboundMessageReadDto<TPrepared>,
    messageExpiresAtMs: number
): ALOutboundDispatchWrites<TPrepared> {
    const tracking = read.plan.ackTracking;
    if (tracking === undefined || !isALOutboundAckTrackingWritable(tracking)) {
        return { mutations: [], durableEffects: [] };
    }

    const pending = trackALOutboundPendingAckSnapshot({
        msgId: read.msg.id.msgId,
        current: read.pendingAck,
        acks: read.acks,
        tracking,
        nowMs: read.nowMs
    });
    if (!pending) {
        return {
            mutations: read.pendingAck
                ? [
                    { kind: 'delete-pending-ack', originPeerId: read.msg.id.senderId, msgId: read.msg.id.msgId },
                    { kind: 'delete-repair-attempt', msgId: read.msg.id.msgId }
                ]
                : [],
            durableEffects: []
        };
    }

    return {
        mutations: [{
            kind: 'set-pending-ack',
            originPeerId: read.msg.id.senderId,
            snapshot: pending,
            expireAtTimestamp: messageExpiresAtMs
        }],
        durableEffects: [{
            effectId: toALOutboundAckTimeoutEffectId(pending),
            retryAtMs: pending.deadlineAtMs,
            expireAtTimestamp: toALOutboundAckRetryScheduleEndTimestamp(pending, messageExpiresAtMs),
            payload: { kind: 'ack-timeout', msgId: pending.msgId }
        }]
    };
}

function toSentMessageMutation<TPrepared>(
    read: ALOutboundMessageReadDto<TPrepared>,
    canonicalEntry: ResourceEntry
): ALOutboundAdmissionMutation {
    return {
        kind: 'set-sent-message',
        reference: toALOutboundMessageReference(read.canonicalScope, canonicalEntry, read.msg),
        policy: toALOutboundSentPolicy(read.storedMessage?.policy, read.plan),
        creationExpiry: read.creationExpiry,
        snapshot: {
            msgId: read.msg.id.msgId,
            msg: read.msg,
            outboxKey: canonicalEntry.key,
            supersedenceKey: read.plan.supersedenceTracking?.key ?? null
        } satisfies ALOutboundSentMessageSnapshot,
        expireAtTimestamp: resolveALMessageExpireAtMs(read.msg)
    };
}
