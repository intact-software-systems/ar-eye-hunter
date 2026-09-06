import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { Key, ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import type { ALOutboundSentMessageSnapshot } from '../al-runtime-state-stores.ts';
import { resolveExplicitOutboundMessageExpireAtMs } from '../ALMessageExpiry.ts';
import type {
    ALOutboundAdmissionMutation,
    ALOutboundCommitBundle,
    ALOutboundDurableEffectWrite,
    ALOutboundMessageReadDto
} from './al-outbound-admission-store.ts';
import type { ALOutboundDispatchPhase, ALOutboundEnqueueStatus } from './al-outbound-message-runtime.ts';
import { toALOutboundEffectId } from './to-al-outbound-effect-id.ts';
import { toALOutboundPreparedFingerprint } from './to-al-outbound-prepared-fingerprint.ts';
import {
    toALOutboundPendingAckExpireAtTimestamp,
    trackALOutboundPendingAckSnapshot
} from './transition-al-outbound-pending-ack.ts';

export type ALOutboundComputeIntent = 'enqueue' | 'dequeue' | 'repair';

export interface ALOutboundCommitDispatchOptions {
    readonly fallbackEntry?: ResourceEntry;
    readonly replaceExistingOutbox?: boolean;
    readonly repairBudget?: Readonly<{ priorAttempts: number; maxAttempts: number; }>;
}

export interface ALOutboundComputedDto<TPrepared> {
    readonly bundle?: ALOutboundCommitBundle<TPrepared>;
    readonly status: ALOutboundEnqueueStatus;
    readonly reason?: string;
    readonly entries: readonly ResourceEntry[];
}

export interface ComputeALOutboundDispatchInput<TPrepared> {
    readonly read: ALOutboundMessageReadDto<TPrepared>;
    readonly outboxEntry: ResourceEntry | undefined;
    readonly canFallback: boolean;
    readonly dispatchAtMs: number;
    readonly intent: ALOutboundComputeIntent;
    readonly phase: ALOutboundDispatchPhase;
    readonly options: ALOutboundCommitDispatchOptions;
}

interface ALOutboundDispatchStrategy {
    readonly dispatchPrepared: boolean;
    readonly fallback: boolean;
    readonly enqueueOutbox: boolean;
}

interface AppendALOutboundDispatchEffectsInput<TPrepared> {
    readonly input: ComputeALOutboundDispatchInput<TPrepared>;
    readonly strategy: ALOutboundDispatchStrategy;
    readonly entries: ResourceEntry[];
    readonly mutations: ALOutboundAdmissionMutation[];
    readonly effects: ALOutboundDurableEffectWrite<TPrepared>[];
}

interface ToALOutboundComputedResultInput<TPrepared> {
    readonly read: ALOutboundMessageReadDto<TPrepared>;
    readonly strategy: ALOutboundDispatchStrategy;
    readonly entries: readonly ResourceEntry[];
    readonly mutations: readonly ALOutboundAdmissionMutation[];
    readonly durableEffects: readonly ALOutboundDurableEffectWrite<TPrepared>[];
    readonly dispatchAtMs: number;
}

export function computeALOutboundDispatch<TPrepared>(
    input: ComputeALOutboundDispatchInput<TPrepared>
): ALOutboundComputedDto<TPrepared> {
    const earlyResult = toEarlyDispatchResult(input);
    if (earlyResult) {
        return earlyResult;
    }

    const strategy = toALOutboundDispatchStrategy(input);
    const extraMutations = computeRepairAttemptMutations(input.read, input.options.repairBudget);
    if (extraMutations === 'skip') {
        return toSkippedDispatchResult(input.read.msg.id.msgId);
    }

    return buildALOutboundDispatchResult(input, strategy, extraMutations);
}

function toEarlyDispatchResult<TPrepared>(
    input: ComputeALOutboundDispatchInput<TPrepared>
): ALOutboundComputedDto<TPrepared> | undefined {
    const { read } = input;
    if (read.plan.dropReason) {
        return {
            status: toALOutboundEnqueueStatusFromReason(read.plan.dropReason),
            reason: read.plan.dropReason,
            entries: []
        };
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
    outboxEntry: ResourceEntry | undefined
): ALOutboundComputedDto<TPrepared> {
    const entry = read.sentSnapshot?.outboxKey
        ? { ...requireOutboxEntry(outboxEntry), key: read.sentSnapshot.outboxKey }
        : undefined;
    return {
        status: 'duplicate',
        reason: `Duplicate outbound message ${read.msg.id.msgId}`,
        entries: entry ? [entry] : []
    };
}

function toALOutboundDispatchStrategy<TPrepared>(
    input: ComputeALOutboundDispatchInput<TPrepared>
): ALOutboundDispatchStrategy {
    const preparedMessagesAvailable = input.read.plan.preparedMessages.length > 0;
    const dispatchPrepared = input.intent === 'enqueue'
        ? preparedMessagesAvailable && !input.read.plan.persist
        : preparedMessagesAvailable;
    return {
        dispatchPrepared,
        fallback: !dispatchPrepared && input.intent !== 'enqueue' && input.canFallback,
        enqueueOutbox: (input.intent === 'enqueue' || (input.intent === 'repair' && input.read.plan.persist)) &&
            !dispatchPrepared
    };
}

function buildALOutboundDispatchResult<TPrepared>(
    input: ComputeALOutboundDispatchInput<TPrepared>,
    strategy: ALOutboundDispatchStrategy,
    extraMutations: readonly ALOutboundAdmissionMutation[]
): ALOutboundComputedDto<TPrepared> {
    const { read } = input;
    const entries: ResourceEntry[] = [];
    const mutations: ALOutboundAdmissionMutation[] = [
        {
            kind: 'set-msg-owner',
            msgId: read.msg.id.msgId,
            senderId: read.msg.id.senderId,
            expireAtTimestamp: resolveExplicitOutboundMessageExpireAtMs(read.msg)
        }
    ];
    const durableEffects: ALOutboundDurableEffectWrite<TPrepared>[] = [];
    mutations.push(...extraMutations);
    appendSupersedenceMutations(mutations, read);
    appendALOutboundDispatchEffects({ input, strategy, entries, mutations, effects: durableEffects });
    return toALOutboundComputedResult({
        read,
        strategy,
        entries,
        mutations,
        durableEffects,
        dispatchAtMs: input.dispatchAtMs
    });
}

function appendALOutboundDispatchEffects<TPrepared>(
    input: AppendALOutboundDispatchEffectsInput<TPrepared>
): void {
    const { read, options, outboxEntry, phase } = input.input;
    if (input.strategy.enqueueOutbox) {
        const entry = toPersistedOutboxEntry(read, requireOutboxEntry(outboxEntry));
        input.entries.push(entry);
        input.mutations.push(
            toSentMessageMutation(read.msg, {
                outboxKey: entry.key,
                supersedenceKey: read.plan.supersedenceTracking?.key
            })
        );
        input.effects.push({
            effectId: toALOutboundEffectId(['outbox', read.msg.id.msgId]),
            expireAtTimestamp: resolveExplicitOutboundMessageExpireAtMs(read.msg),
            payload: {
                kind: 'enqueue-outbox',
                msg: read.msg,
                entry,
                replaceExisting: options.replaceExistingOutbox === true ||
                    (read.plan.supersedenceTracking?.enabled === true &&
                        read.plan.supersedenceTracking.key !== undefined)
            }
        });
    }
    if (input.strategy.dispatchPrepared || input.strategy.fallback) {
        input.mutations.push(toSentMessageMutation(read.msg));
        appendAckTrackingMutationsAndEffects(input.mutations, input.effects, read);
    }
    if (input.strategy.dispatchPrepared) {
        read.plan.preparedMessages.forEach((prepared, index) => {
            const preparedFingerprint = toALOutboundPreparedFingerprint(prepared);
            input.effects.push({
                effectId: toALOutboundEffectId([
                    'send',
                    read.msg.id.msgId,
                    phase,
                    index,
                    preparedFingerprint
                ]),
                expireAtTimestamp: resolveExplicitOutboundMessageExpireAtMs(read.msg),
                payload: { kind: 'send-prepared', msg: read.msg, prepared, preparedFingerprint, phase }
            });
        });
    }
    else if (input.strategy.fallback) {
        input.effects.push({
            effectId: toALOutboundEffectId(['fallback', read.msg.id.msgId, phase]),
            expireAtTimestamp: resolveExplicitOutboundMessageExpireAtMs(read.msg),
            payload: {
                kind: 'fallback-dispatch',
                msg: read.msg,
                entry: options.fallbackEntry ?? requireOutboxEntry(outboxEntry)
            }
        });
    }
}

function toALOutboundComputedResult<TPrepared>(
    input: ToALOutboundComputedResultInput<TPrepared>
): ALOutboundComputedDto<TPrepared> {
    const status: ALOutboundEnqueueStatus = input.strategy.enqueueOutbox
        ? 'enqueued'
        : input.strategy.dispatchPrepared || input.strategy.fallback
        ? 'accepted'
        : 'no-route';
    const reason = status === 'no-route'
        ? `No outbound transport route for message ${input.read.msg.id.msgId}`
        : undefined;
    const bundle = input.mutations.length === 0 && input.durableEffects.length === 0
        ? undefined
        : {
            senderId: input.read.msg.id.senderId,
            expectedVersion: input.read.clientRecord?.version,
            mutations: input.mutations,
            durableEffects: input.durableEffects.map((effect) => ({
                ...effect,
                retryAtMs: effect.retryAtMs ?? input.dispatchAtMs
            }))
        } satisfies ALOutboundCommitBundle<TPrepared>;
    return { status, reason, entries: input.entries, bundle };
}

function toSkippedDispatchResult<TPrepared>(msgId: string): ALOutboundComputedDto<TPrepared> {
    return { status: 'skipped', reason: `Skipped outbound dispatch for message ${msgId}`, entries: [] };
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

function toPersistedOutboxEntry<TPrepared>(
    read: ALOutboundMessageReadDto<TPrepared>,
    entry: ResourceEntry
): ResourceEntry {
    const tracking = read.plan.supersedenceTracking;
    if (!tracking?.enabled || !tracking.key || !read.priorOutboxKey) {
        return entry;
    }

    return { ...entry, key: read.priorOutboxKey };
}

function requireOutboxEntry(entry: ResourceEntry | undefined): ResourceEntry {
    if (!entry) {
        throw new Error('Outbound dispatch requires a captured outbox entry');
    }
    return entry;
}

function toSentMessageMutation(
    msg: ALMessage,
    metadata: Readonly<{
        outboxKey?: Key;
        supersedenceKey?: string;
    }> = {}
): ALOutboundAdmissionMutation {
    return {
        kind: 'set-sent-message',
        snapshot: {
            msgId: msg.id.msgId,
            msg,
            outboxKey: metadata.outboxKey,
            supersedenceKey: metadata.supersedenceKey
        } satisfies ALOutboundSentMessageSnapshot,
        expireAtTimestamp: resolveExplicitOutboundMessageExpireAtMs(msg)
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
