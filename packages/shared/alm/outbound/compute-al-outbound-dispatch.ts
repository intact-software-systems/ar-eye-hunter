import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs } from '../../al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '../../al-contracts/al-runtime.ts';
import { EntityStatus, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import type { ALOutboundSentMessageSnapshot } from '../al-runtime-state-stores.ts';
import type {
    ALOutboundAdmissionMutation,
    ALOutboundCommitBundle,
    ALOutboundDurableEffectWrite,
    ALOutboundMessageReadDto
} from './al-outbound-admission-store.ts';
import { captureALOutboundPolicy } from './al-outbound-admission-validation.ts';
import { toALOutboundMessageReference } from './al-outbound-canonical-message.ts';
import type { ALOutboundDispatchPhase, ALOutboundEnqueueStatus } from './al-outbound-message-runtime.ts';
import { toALOutboundEffectId } from './to-al-outbound-effect-id.ts';
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
        return { status: 'skipped', reason: `Skipped outbound dispatch for message ${read.msg.id.msgId}`, entries: [] };
    }

    const awaitPhysicalDispatch = input.intent === 'enqueue' && read.plan.preparedMessages.length === 0;
    const canonicalEntry = {
        ...input.outboxEntry,
        status: awaitPhysicalDispatch ? EntityStatus.NEW : EntityStatus.COMPLETED
    };
    const mutations = [...computeMessageMutations(read, canonicalEntry), ...repairMutations];
    const durableEffects = computePreparedEffects(input, canonicalEntry);
    if (read.plan.preparedMessages.length > 0) {
        appendAckTrackingMutationsAndEffects(mutations, durableEffects, read);
    }

    const status: ALOutboundEnqueueStatus = awaitPhysicalDispatch || read.plan.persist
        ? 'enqueued'
        : read.plan.preparedMessages.length > 0
        ? 'accepted'
        : 'no-route';
    return {
        msg: read.msg,
        status,
        reason: status === 'no-route' ? `No outbound transport route for message ${read.msg.id.msgId}` : undefined,
        entries: [canonicalEntry],
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
        return { status: 'expired', reason: 'Message expired or is too stale', entries: [] };
    }
    if (read.plan.dropReason) {
        return {
            status: toALOutboundEnqueueStatusFromReason(read.plan.dropReason),
            reason: read.plan.dropReason,
            entries: []
        };
    }
    if (input.intent === 'repair' && read.plan.preparedMessages.length === 0) {
        return { status: 'no-route', reason: 'Repair has no prepared recipient attempt', entries: [] };
    }
    if (input.intent === 'enqueue' && read.sentSnapshot) {
        return toDuplicateDispatchResult(read, input.outboxEntry);
    }
    return read.supersedenceAcceptance?.observation.status === 'superseded'
        ? { status: 'superseded', reason: `Skipping superseded outbound message ${read.msg.id.msgId}`, entries: [] }
        : undefined;
}

function toDuplicateDispatchResult<TPrepared>(
    read: ALOutboundMessageReadDto<TPrepared>,
    outboxEntry: ResourceEntry
): ALOutboundComputedDto<TPrepared> {
    const entry = read.sentSnapshot?.outboxKey
        ? { ...outboxEntry, key: read.sentSnapshot.outboxKey }
        : undefined;
    return {
        status: 'duplicate',
        reason: `Duplicate outbound message ${read.msg.id.msgId}`,
        entries: entry ? [entry] : []
    };
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
            supersedenceKey: read.plan.supersedenceTracking?.key
        } satisfies ALOutboundSentMessageSnapshot,
        expireAtTimestamp: resolveALMessageExpireAtMs(read.msg)
    };
}

function toALOutboundEnqueueStatusFromReason(
    reason: string
): ALOutboundEnqueueStatus {
    const normalized = reason.toLowerCase();
    if (normalized.includes('duplicate')) {
        return 'duplicate';
    }
    if (normalized.includes('superseded')) {
        return 'superseded';
    }
    if (normalized.includes('expired') || normalized.includes('too stale')) {
        return 'expired';
    }
    if (
        normalized.includes('no route') ||
        normalized.includes('no recipient') ||
        normalized.includes('without target') ||
        normalized.includes('without next hop') ||
        normalized.includes('without overlay context') ||
        normalized.includes('without planned transport') ||
        normalized.includes('without rtc channel') ||
        normalized.includes('without ws connection') ||
        normalized.includes('cannot route') ||
        normalized.includes('cannot resolve')
    ) {
        return 'no-route';
    }

    return 'skipped';
}
