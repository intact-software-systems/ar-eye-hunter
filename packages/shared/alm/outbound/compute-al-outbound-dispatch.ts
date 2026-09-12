import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs } from '../../al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '../../al-contracts/al-runtime.ts';
import { EntityStatus, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import type { ALOutboundSentMessageSnapshot } from '../al-runtime-state-stores.ts';
import type { ALDeliveryAdmissionVerdict } from '../delivery/al-delivery-lifecycle.ts';
import type { ALOutboundAdmissionMutation } from './admission/al-outbound-admission-mutations.ts';
import type {
    ALOutboundCommitBundle,
    ALOutboundDurableEffectWrite,
    ALOutboundMessageReadDto
} from './admission/al-outbound-admission-store.ts';
import { captureALOutboundPolicy } from './admission/al-outbound-admission-validation.ts';
import { toALOutboundMessageReference } from './al-outbound-canonical-message.ts';
import type {
    ALOutboundDispatchPhase,
    ALOutboundDispatchPlan,
    ALOutboundEnqueueStatus
} from './al-outbound-message-runtime.ts';
import { toALOutboundEffectId } from './to-al-outbound-effect-id.ts';
import { toALOutboundEnqueueStatus } from './to-al-outbound-enqueue-status.ts';
import { toALOutboundPreparedFingerprint } from './to-al-outbound-prepared-fingerprint.ts';
import {
    toALOutboundPendingAckExpireAtTimestamp,
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
    readonly status: ALOutboundEnqueueStatus;
    readonly verdict: ALDeliveryAdmissionVerdict;
    readonly reason?: string;
    readonly entries: readonly ResourceEntry[];
}

export interface ComputeALOutboundDispatchInput<TPrepared> {
    readonly read: ALOutboundMessageReadDto<TPrepared>;
    readonly outboxEntry: ResourceEntry;
    readonly dispatchAtMs: number;
    readonly intent: ALOutboundComputeIntent;
    readonly phase: ALOutboundDispatchPhase;
    readonly options: ALOutboundCommitDispatchOptions;
}

export function computeALOutboundDispatch<TPrepared>(
    input: ComputeALOutboundDispatchInput<TPrepared>
): ALOutboundComputedDto<TPrepared> {
    const earlyResult = toEarlyDispatchResult(input);
    if (earlyResult) {
        return { ...earlyResult, msg: input.read.msg };
    }
    const { read, options } = input;
    const repairMutations = computeRepairAttemptMutations(read, options.repairBudget);
    if (repairMutations === 'skip') {
        const detail = `Skipped outbound dispatch for message ${read.msg.id.msgId}`;
        return toALOutboundComputedResult({ kind: 'skipped', reason: 'repair-exhausted', detail }, detail);
    }

    const awaitPhysicalDispatch = input.intent === 'enqueue' && read.plan.preparedMessages.length === 0;
    const canonicalEntry = {
        ...input.outboxEntry,
        status: awaitPhysicalDispatch ? EntityStatus.NEW : EntityStatus.COMPLETED
    };
    const mutations = [...computeMessageMutations(read, canonicalEntry), ...repairMutations];
    const durableEffects = computePreparedEffects(input, canonicalEntry);
    // Captured before the ack-timeout effect (if any) is appended below: only `send-prepared` counts.
    const queuedAttempts = durableEffects.length;
    if (read.plan.preparedMessages.length > 0) {
        appendAckTrackingMutationsAndEffects(mutations, durableEffects, read);
    }

    const verdict = computeALOutboundRouteVerdict(read, awaitPhysicalDispatch || read.plan.persist, queuedAttempts);
    return {
        ...toALOutboundComputedResult(
            verdict,
            verdict.kind === 'unroutable' ? verdict.detail : undefined,
            [canonicalEntry]
        ),
        msg: read.msg,
        bundle: {
            pendingAdmission: options.pendingAdmission,
            senderId: read.msg.id.senderId,
            expectedVersion: read.clientRecord?.version,
            canonicalEntry,
            mutations,
            durableEffects: durableEffects.map((effect) => ({
                ...effect,
                retryAtMs: effect.retryAtMs ?? input.dispatchAtMs
            }))
        }
    };
}

function toALOutboundComputedResult<TPrepared>(
    verdict: ALDeliveryAdmissionVerdict,
    reason: string | undefined,
    entries: readonly ResourceEntry[] = []
): ALOutboundComputedDto<TPrepared> {
    return { status: toALOutboundEnqueueStatus(verdict), verdict, reason, entries };
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
    const attemptIdentity = options.attemptIdentity ?? 'initial';
    return read.plan.preparedMessages.map((prepared, index) => {
        const preparedFingerprint = toALOutboundPreparedFingerprint(prepared);
        return {
            effectId: toALOutboundEffectId([
                'send',
                read.msg.id.msgId,
                phase,
                attemptIdentity,
                index,
                preparedFingerprint
            ]),
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
    return toALOutboundComputedResult(
        { kind: 'duplicate' },
        `Duplicate outbound message ${read.msg.id.msgId}`,
        entry ? [entry] : []
    );
}

/** Keyed on the planner's drop code, never the human-readable `dropReason` string. */
function toALOutboundAdmissionVerdict(
    plan: Pick<ALOutboundDispatchPlan<unknown>, 'dropReason' | 'dropReasonCode'>
): ALDeliveryAdmissionVerdict {
    const detail = plan.dropReason ?? '';
    switch (plan.dropReasonCode) {
        case 'unauthorized':
            return { kind: 'refused', reason: 'unauthorized', detail };
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

function computeRepairAttemptMutations<TPrepared>(
    read: ALOutboundMessageReadDto<TPrepared>,
    repairBudget: ALOutboundCommitDispatchOptions['repairBudget']
): readonly ALOutboundAdmissionMutation[] | 'skip' {
    if (!repairBudget) {
        return [];
    }
    const attempts = read.repairAttempt?.attempts ?? repairBudget.priorAttempts;
    return attempts >= repairBudget.maxAttempts ? 'skip' : [{
        kind: 'set-repair-attempt',
        snapshot: { msgId: read.msg.id.msgId, attempts: attempts + 1 }
    }];
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
            value: replacement.value
        });
    }
}

function appendAckTrackingMutationsAndEffects<TPrepared>(
    mutations: ALOutboundAdmissionMutation[],
    durableEffects: ALOutboundDurableEffectWrite<TPrepared>[],
    read: ALOutboundMessageReadDto<TPrepared>
): void {
    const tracking = read.plan.ackTracking;
    if (!tracking?.enabled || tracking.expectedPeerIds.length === 0 || tracking.timeoutMs <= 0) {
        return;
    }

    const pending = trackALOutboundPendingAckSnapshot({
        msgId: read.msg.id.msgId,
        current: read.pendingAck,
        acks: read.acks,
        tracking,
        nowMs: read.nowMs
    });
    if (!pending) {
        if (read.pendingAck) {
            mutations.push(
                { kind: 'delete-pending-ack', msgId: read.msg.id.msgId },
                { kind: 'delete-repair-attempt', msgId: read.msg.id.msgId }
            );
        }
        return;
    }

    mutations.push({ kind: 'set-pending-ack', snapshot: pending });
    durableEffects.push({
        effectId: toALOutboundEffectId([
            'ack-timeout',
            pending.msgId,
            pending.attempts + 1,
            pending.deadlineAtMs
        ]),
        retryAtMs: pending.deadlineAtMs,
        expireAtTimestamp: toALOutboundPendingAckExpireAtTimestamp(pending),
        payload: { kind: 'ack-timeout', msgId: pending.msgId }
    });
}

function toSentMessageMutation<TPrepared>(
    read: ALOutboundMessageReadDto<TPrepared>,
    canonicalEntry: ResourceEntry
): ALOutboundAdmissionMutation {
    return {
        kind: 'set-sent-message',
        reference: toALOutboundMessageReference(read.canonicalScope, canonicalEntry, read.msg),
        policy: read.storedMessage?.policy ?? captureALOutboundPolicy(read.plan),
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
