import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type {
    ALAckPayload,
    ALNackPayload,
    ALRepairPayload
} from '../../al-contracts/al-control.ts';
import { decodePersistedALMessage } from '../../al-contracts/al-message-persistence-validation.ts';
import type { ALReadyable } from '../../al-contracts/al-runtime.ts';
import { toALOrderingTrackKey } from '../../al-contracts/al-runtime.ts';
import { PersistenceWriteExpiredError } from '../../persistence/persistence-write-deadline.ts';
import { hasSameResourceEntryValue } from '../../queuebox/resource-entry-observations.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import {
    decodeALAdmissionClientRecord,
    decodeALAdmissionString,
    decodeALAdmissionSupersedenceValue
} from '../al-admission-value-validation.ts';
import type { ALAdmissionWorkBackend, ALAdmissionWorkWriteContext } from '../al-admission-work-backend.ts';
import type {
    ALOutboundPendingAckSnapshot,
    ALOutboundRepairAttemptSnapshot,
    ALOutboundSentMessageSnapshot
} from '../al-runtime-state-stores.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../ALStoreRetention.ts';
import type {
    ALLatestSupersedenceValue,
    ALReplacementSupersedenceValue,
    ALSupersedenceAcceptance
} from '../compute-al-supersedence-observation.ts';
import type { ALWorkQueuePort } from '../work/al-work-queue-port.ts';
import {
    ALOutboundAdmissionEffectStore,
    type ALOutboundEffectCandidate
} from './al-outbound-admission-effect-store.ts';
import {
    toALOutboundMessageOwnerKey,
    toALOutboundOrderingMessageKey,
    toALOutboundPendingAckKey,
    toALOutboundRepairAttemptKey,
    toALOutboundSentMessageKey,
    toALOutboundSupersedenceLatestKey,
    toALOutboundSupersedenceReplacementKey,
    toALOutboundVersionKey
} from './al-outbound-admission-keys.ts';
import { ALOutboundAdmissionReads } from './al-outbound-admission-reads.ts';
import {
    decodeALOutboundSentMessage,
    type ALOutboundCapturedPolicy,
    type ALStoredOutboundMessage
} from './al-outbound-admission-validation.ts';
import {
    captureALOutboundCreationExpiry,
    type ALOutboundMessageReference
} from './al-outbound-canonical-message.ts';
import {
    readALOutboundCanonicalWrites,
    writeALOutboundCanonicalFacts,
    type ALOutboundCanonicalFactWrite
} from './al-outbound-canonical-storage.ts';
import type {
    ALOutboundDispatchPhase,
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundRepairTrigger
} from './al-outbound-message-runtime.ts';
import {
    retainALOutboundPendingAdmission,
    type ALOutboundPendingAdmission,
    type RetainALOutboundPendingAdmissionInput
} from './al-outbound-pending-admission.ts';
import type { ALOutboundComputeIntent } from './compute-al-outbound-dispatch.ts';
import { ALOutboundControlAdmission } from './control/al-outbound-control-admission.ts';
import { toALOutboundPendingAckExpireAtTimestamp } from './transition-al-outbound-pending-ack.ts';

export interface CreateALOutboundAdmissionStoreInput<TPrepared> {
    readonly nowMs: () => number;
    readonly canonicalScope: string;
    readonly namespace: string;
    readonly backend: ALAdmissionWorkBackend;
    readonly supersedenceTrackTtlMs: number;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    readonly decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>;
}

export interface ALOutboundVersionedClientRecord {
    readonly senderId: string;
    readonly version: number;
}

export type ALOutboundPreparedMessageDecoder<TPrepared> = (value: unknown, msg: ALMessage) => TPrepared;

export type ALOutboundPlanner<TPrepared> = (
    msg: ALMessage
) => ALOutboundDispatchPlan<TPrepared>;

export interface ALOutboundOutgoingReadInput<TPrepared> {
    readonly msg: ALMessage;
    readonly planner: ALOutboundPlanner<TPrepared>;
    readonly observedCanonicalEntry: ResourceEntry | undefined;
    readonly intent: ALOutboundComputeIntent;
}

interface ALOutboundCommitCandidate<TPrepared> {
    readonly executionExpiresAtMs: number | null;
    readonly bundle: ALOutboundCommitBundle<TPrepared>;
    readonly effects: readonly ALOutboundEffectCandidate<TPrepared>[];
    readonly canonicalWrites: readonly ALOutboundCanonicalFactWrite[];
    readonly mutations: readonly ALOutboundStateWrite[];
    readonly versionExpireAt: number;
}

export interface ALOutboundSupersedenceReadState {
    readonly key?: string;
    readonly latest?: ALLatestSupersedenceValue;
    readonly replacement?: ALReplacementSupersedenceValue;
}

export interface ALOutboundMessageReadDto<TPrepared> {
    readonly kind: 'outgoing';
    readonly storedMessage: ALStoredOutboundMessage | undefined;
    readonly canonicalScope: string;
    readonly canonicalEntry: ResourceEntry | undefined;
    readonly creationExpiry: string;
    readonly originalMsg: ALMessage;
    readonly msg: ALMessage;
    readonly nowMs: number;
    readonly clientRecord?: ALOutboundVersionedClientRecord;
    readonly plan: ALOutboundDispatchPlan<TPrepared>;
    readonly sentSnapshot?: ALOutboundSentMessageSnapshot;
    readonly pendingAck?: ALOutboundPendingAckSnapshot;
    readonly repairAttempt?: ALOutboundRepairAttemptSnapshot;
    readonly acks: readonly ALAckPayload[];
    readonly nacks: readonly ALNackPayload[];
    readonly repairs: readonly ALRepairPayload[];
    readonly supersedence: ALOutboundSupersedenceReadState;
    readonly supersedenceAcceptance?: ALSupersedenceAcceptance;
}

export interface ALOutboundRepairReadDto<TPrepared> {
    readonly kind: 'repair';
    readonly msgId: string;
    readonly nowMs: number;
    readonly clientRecord?: ALOutboundVersionedClientRecord;
    readonly sentSnapshot?: ALOutboundSentMessageSnapshot;
    readonly pendingAck?: ALOutboundPendingAckSnapshot;
    readonly repairAttempt?: ALOutboundRepairAttemptSnapshot;
    readonly acks: readonly ALAckPayload[];
    readonly nacks: readonly ALNackPayload[];
    readonly plan?: ALOutboundDispatchPlan<TPrepared>;
}

export type ALOutboundAdmissionMutation =
    | Readonly<
        { kind: 'set-ordering-message'; trackKey: string; seq: number; msgId: string; expireAtTimestamp: number; }
    >
    | Readonly<{
        kind: 'set-msg-owner';
        msgId: string;
        senderId: string;
        expireAtTimestamp?: number;
    }>
    | Readonly<{
        kind: 'set-sent-message';
        reference: ALOutboundMessageReference;
        policy: ALOutboundCapturedPolicy;
        creationExpiry: string;
        snapshot: ALOutboundSentMessageSnapshot;
        expireAtTimestamp?: number;
    }>
    | Readonly<{
        kind: 'delete-sent-message';
        msgId: string;
    }>
    | Readonly<{
        kind: 'set-pending-ack';
        snapshot: ALOutboundPendingAckSnapshot;
        expireAtTimestamp?: number;
    }>
    | Readonly<{
        kind: 'delete-pending-ack';
        msgId: string;
    }>
    | Readonly<{
        kind: 'set-repair-attempt';
        snapshot: ALOutboundRepairAttemptSnapshot;
        expireAtTimestamp?: number;
    }>
    | Readonly<{
        kind: 'delete-repair-attempt';
        msgId: string;
    }>
    | Readonly<{
        kind: 'set-supersedence-latest';
        supersedenceKey: string;
        expected: ALLatestSupersedenceValue | undefined;
        value: ALLatestSupersedenceValue;
    }>
    | Readonly<{
        kind: 'set-supersedence-replacement';
        msgId: string;
        value: ALReplacementSupersedenceValue;
    }>;

export interface ALOutboundRepairHint {
    readonly trigger: ALOutboundRepairTrigger;
    readonly requestedByPeerId?: string;
    readonly failedPeerIds: readonly string[];
    readonly orderingTrackKey?: string;
    readonly missingSeqs: readonly number[];
}

export type ALOutboundDurableEffect<TPrepared> =
    | ALOutboundPendingAdmission<TPrepared>
    | Readonly<{
        kind: 'send-prepared';
        message: ALOutboundMessageReference;
        prepared: TPrepared;
        preparedFingerprint: string;
        attemptIdentity: string;
        phase: ALOutboundDispatchPhase;
    }>
    | Readonly<{
        kind: 'ack-timeout';
        msgId: string;
    }>
    | Readonly<{
        kind: 'repair-hint';
        msgId: string;
        request: ALOutboundRepairHint;
    }>
    | Readonly<{
        kind: 'nack-retry';
        msgId: string;
        reason: 'not-yet-in-sync';
    }>
    | Readonly<{
        kind: 'admit-control';
        msg: ALMessage;
        expiresAtMs: number;
    }>
    | Readonly<{
        kind: 'dequeue-message';
        queueTypeId: string;
    }>;

export interface ALOutboundDurableEffectWrite<TPrepared> {
    readonly effectId: string;
    readonly payload: ALOutboundDurableEffect<TPrepared>;
    readonly retryAtMs?: number;
    readonly expireAtTimestamp?: number;
}

export interface ALOutboundEffectSnapshot<TPrepared> {
    readonly effectId: string;
    readonly payload: ALOutboundDurableEffect<TPrepared>;
    readonly canonicalMessage: ALMessage | undefined;
    readonly entry: ResourceEntry;
    readonly attempts: number;
    readonly retryAtMs: number;
    readonly leaseUntilMs: number | undefined;
    readonly expireAtTimestamp: number;
}

export interface ALOutboundCommitBundle<TPrepared> {
    readonly pendingAdmission?: ResourceEntry;
    readonly senderId: string;
    readonly expectedVersion?: number;
    readonly canonicalEntry?: ResourceEntry;
    readonly mutations: readonly ALOutboundAdmissionMutation[];
    readonly durableEffects: readonly ALOutboundDurableEffectWrite<TPrepared>[];
}

interface ALOutboundStateWrite {
    readonly key: string;
    readonly value:
        | string
        | ALStoredOutboundMessage
        | ALOutboundPendingAckSnapshot
        | ALOutboundRepairAttemptSnapshot
        | ALLatestSupersedenceValue
        | ALReplacementSupersedenceValue
        | undefined;
    readonly expireAtTimestamp: number | undefined;
    readonly supersedenceGuard: { readonly expected: ALLatestSupersedenceValue | undefined; } | undefined;
}

export interface ALOutboundNotYetInSyncRetrySchedule {
    readonly senderId: string;
    readonly expectedVersion: number | undefined;
    readonly msgId: string;
    readonly maxAttempts: number;
    readonly expireAtTimestamp: number | undefined;
    readonly retryAtMs: number;
}

export type ALOutboundNotYetInSyncRetryScheduleResult =
    | Readonly<{ status: 'scheduled'; retryAtMs: number; }>
    | Readonly<{ status: 'pending'; retryAtMs: number; }>
    | Readonly<{ status: 'exhausted'; }>
    | Readonly<{ status: 'conflict'; }>;
/**
 * Every member is a function property rather than a method so `TPrepared` stays invariant: a store
 * built for one prepared contract must not satisfy a consumer that expects another.
 */
export interface ALOutboundAdmissionStore<TPrepared> extends ALReadyable {
    readonly namespace: string;
    readonly canonicalScope: string;

    readonly readOutgoingMessage: (
        input: ALOutboundOutgoingReadInput<TPrepared>
    ) => Promise<ALOutboundMessageReadDto<TPrepared>>;

    readonly readRepairMessage: (
        msgId: string,
        planner: ALOutboundPlanner<TPrepared>
    ) => Promise<ALOutboundRepairReadDto<TPrepared>>;

    readonly isMessageSuperseded: (msg: ALMessage) => Promise<boolean>;

    readonly readSentMessage: (msgId: string) => Promise<ALOutboundSentMessageSnapshot | undefined>;

    readonly readSentMessageByOrdering: (
        trackKey: string,
        seq: number
    ) => Promise<ALOutboundSentMessageSnapshot | undefined>;

    readonly readReceiptState: (msgId: string) => Promise<ALOutboundPendingAckSnapshot | undefined>;

    readonly readPendingAck: (msgId: string) => Promise<ALOutboundPendingAckSnapshot | undefined>;

    /** Decodes one claimed work row of this scope, including the canonical message its payload references. */
    readonly readWorkSnapshot: (entry: ResourceEntry) => Promise<ALOutboundEffectSnapshot<TPrepared>>;

    readonly commitBundle: (
        bundle: ALOutboundCommitBundle<TPrepared>
    ) => Promise<'committed' | 'conflict' | 'expired'>;

    readonly retainPendingAdmission: (
        input: RetainALOutboundPendingAdmissionInput<TPrepared>
    ) => Promise<'pending' | 'conflict' | 'expired'>;

    /** The control-admission owner of this scope; the port carries the control it must replay. */
    readonly createControlAdmission: (
        port: ALWorkQueuePort,
        clock: ALOutboundMessageRuntime.Clock
    ) => ALOutboundControlAdmission<TPrepared>;
}

export function createALOutboundAdmissionStore<TPrepared>(
    input: CreateALOutboundAdmissionStoreInput<TPrepared>
): ALOutboundAdmissionStore<TPrepared> {
    return new ProviderBackedALOutboundAdmissionStore(input);
}

class ProviderBackedALOutboundAdmissionStore<TPrepared> implements ALOutboundAdmissionStore<TPrepared> {
    readonly namespace: string;
    readonly canonicalScope: string;
    private readonly supersedenceTrackTtlMs: number;
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    private readonly backend: ALAdmissionWorkBackend;
    private readonly nowMs: () => number;
    private readonly effectStore: ALOutboundAdmissionEffectStore<TPrepared>;
    private readonly reads: ALOutboundAdmissionReads<TPrepared>;
    private readonly decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>;

    constructor(input: CreateALOutboundAdmissionStoreInput<TPrepared>) {
        this.namespace = input.namespace;
        this.canonicalScope = input.canonicalScope;
        this.supersedenceTrackTtlMs = input.supersedenceTrackTtlMs;
        this.retention = input.retention;
        this.backend = input.backend;
        this.nowMs = input.nowMs;
        this.decodePrepared = input.decodePrepared;
        this.effectStore = new ALOutboundAdmissionEffectStore({
            nowMs: input.nowMs,
            canonicalScope: input.canonicalScope,
            backend: input.backend,
            namespace: input.namespace,
            retention: input.retention,
            decodePrepared: input.decodePrepared
        });
        this.reads = new ALOutboundAdmissionReads({
            nowMs: input.nowMs,
            namespace: input.namespace,
            canonicalScope: input.canonicalScope,
            backend: input.backend,
            supersedenceTrackTtlMs: input.supersedenceTrackTtlMs
        });
    }

    async ready(): Promise<void> {
        await this.backend.ready();
    }

    createControlAdmission(
        port: ALWorkQueuePort,
        clock: ALOutboundMessageRuntime.Clock
    ): ALOutboundControlAdmission<TPrepared> {
        return new ALOutboundControlAdmission({
            clock,
            backend: this.backend,
            effectStore: this.effectStore,
            reads: this.reads,
            namespace: this.namespace,
            retention: this.retention,
            port
        });
    }

    async readOutgoingMessage(
        input: ALOutboundOutgoingReadInput<TPrepared>
    ): Promise<ALOutboundMessageReadDto<TPrepared>> {
        return await this.reads.readOutgoingMessage(input);
    }

    async readRepairMessage(
        msgId: string,
        planner: ALOutboundPlanner<TPrepared>
    ): Promise<ALOutboundRepairReadDto<TPrepared>> {
        return await this.reads.readRepairMessage(msgId, planner);
    }

    async isMessageSuperseded(msg: ALMessage): Promise<boolean> {
        return await this.reads.isMessageSuperseded(msg);
    }

    async readSentMessage(msgId: string): Promise<ALOutboundSentMessageSnapshot | undefined> {
        return await this.reads.readSentMessage(msgId);
    }

    async readSentMessageByOrdering(trackKey: string, seq: number): Promise<ALOutboundSentMessageSnapshot | undefined> {
        return await this.reads.readSentMessageByOrdering(trackKey, seq);
    }

    async readPendingAck(msgId: string): Promise<ALOutboundPendingAckSnapshot | undefined> {
        return await this.reads.readPendingAck(msgId);
    }

    async readReceiptState(msgId: string): Promise<ALOutboundPendingAckSnapshot | undefined> {
        return await this.reads.readReceiptState(msgId);
    }

    async readWorkSnapshot(entry: ResourceEntry): Promise<ALOutboundEffectSnapshot<TPrepared>> {
        return await this.effectStore.readWorkSnapshot(entry);
    }

    async commitBundle(bundle: ALOutboundCommitBundle<TPrepared>): Promise<'committed' | 'conflict' | 'expired'> {
        if (bundle.mutations.length === 0 && bundle.durableEffects.length === 0) {
            return 'committed';
        }

        const nowMs = this.nowMs();
        const effects = this.effectStore.computeEffects(
            await this.effectStore.readEffects(bundle.durableEffects, bundle.canonicalEntry),
            nowMs
        );
        const issues = this.effectStore.validateEffects(effects);
        if (issues.length > 0) {
            throw new TypeError(issues.map((issue) => issue.message).join('; '));
        }
        const writeAtMs = this.nowMs();
        if (
            (bundle.canonicalEntry && bundle.canonicalEntry.audit.expiryTs.epochMilliseconds <= writeAtMs) ||
            effects.some((effect) => effect.entry.audit.expiryTs.epochMilliseconds <= writeAtMs)
        ) {
            return 'expired';
        }
        return await this.writeCommit({
            bundle,
            effects,
            executionExpiresAtMs: bundle.canonicalEntry?.audit.expiryTs.epochMilliseconds ??
                (effects.length > 0
                    ? Math.min(...effects.map((effect) => effect.entry.audit.expiryTs.epochMilliseconds))
                    : null),
            canonicalWrites: await this.readCanonicalWrites(bundle),
            mutations: bundle.mutations.map((mutation) => this.computeMutation(mutation, nowMs)),
            versionExpireAt: nowMs + this.retention.versionTtlMs
        });
    }

    private async readCanonicalWrites(
        bundle: ALOutboundCommitBundle<TPrepared>
    ): Promise<readonly ALOutboundCanonicalFactWrite[]> {
        if (!bundle.canonicalEntry) {
            return [];
        }
        const captured = bundle.mutations.find((mutation) => mutation.kind === 'set-sent-message')?.creationExpiry;
        return await readALOutboundCanonicalWrites({
            queue: this.backend.workQueue,
            scope: this.canonicalScope,
            entry: bundle.canonicalEntry,
            creationExpiry: captured ??
                captureALOutboundCreationExpiry(decodePersistedALMessage(bundle.canonicalEntry.resource)),
            activatePendingCanonical: bundle.pendingAdmission !== undefined,
            nowMs: this.nowMs
        });
    }

    private async writeCommit(
        candidate: ALOutboundCommitCandidate<TPrepared>
    ): Promise<'committed' | 'conflict' | 'expired'> {
        const { bundle, effects, mutations, canonicalWrites, versionExpireAt } = candidate;
        const version = { senderId: bundle.senderId, version: (bundle.expectedVersion ?? 0) + 1 };
        const versionKey = toALOutboundVersionKey(this.namespace, bundle.senderId);
        try {
            return await this.backend.write(async (tx) => {
                if (!await this.hasCurrentCommitFence(tx, bundle, effects)) {
                    return 'conflict';
                }
                await this.assertMutationObservations(tx, mutations);
                await this.assertMessageIdentities(tx, bundle.mutations);
                const eligibilityAtMs = this.nowMs();
                if (
                    (bundle.canonicalEntry &&
                        bundle.canonicalEntry.audit.expiryTs.epochMilliseconds <= eligibilityAtMs) ||
                    effects.some((effect) => effect.entry.audit.expiryTs.epochMilliseconds <= eligibilityAtMs)
                ) {
                    return 'expired';
                }
                if (await writeALOutboundCanonicalFacts(tx, canonicalWrites, this.nowMs) === 'expired') {
                    return 'expired';
                }
                this.effectStore.writeEffects(tx, effects);
                for (const mutation of mutations) {
                    await this.applyMutation(tx, mutation);
                }

                await tx.set(versionKey, version, versionExpireAt);
                return 'committed';
            }, candidate.executionExpiresAtMs);
        }
        catch (error) {
            if (error instanceof PersistenceWriteExpiredError) {
                return 'expired';
            }
            if (error instanceof ALAdmissionBackendConflictError) {
                return 'conflict';
            }
            throw error;
        }
    }

    /** The sender fence, the pending-admission row and every observed effect row, re-read inside the write. */
    private async hasCurrentCommitFence(
        tx: ALAdmissionWorkWriteContext,
        bundle: ALOutboundCommitBundle<TPrepared>,
        effects: readonly ALOutboundEffectCandidate<TPrepared>[]
    ): Promise<boolean> {
        const current = await this.reads.readClientRecordWithin(tx, bundle.senderId);
        if (current?.version !== bundle.expectedVersion) {
            return false;
        }
        if (bundle.pendingAdmission) {
            const pending = await tx.readWork(bundle.pendingAdmission.key);
            if (!pending || !hasSameResourceEntryValue(pending, bundle.pendingAdmission)) {
                return false;
            }
        }
        return (await this.effectStore.validateObservedWork(tx, effects)).length === 0;
    }

    async retainPendingAdmission(
        input: RetainALOutboundPendingAdmissionInput<TPrepared>
    ): Promise<'pending' | 'conflict' | 'expired'> {
        return await retainALOutboundPendingAdmission({
            backend: this.backend,
            namespace: this.namespace,
            nowMs: this.nowMs,
            decodePrepared: this.decodePrepared
        }, input);
    }

    private computeMutation(mutation: ALOutboundAdmissionMutation, nowMs: number): ALOutboundStateWrite {
        switch (mutation.kind) {
            case 'set-ordering-message':
                return {
                    key: toALOutboundOrderingMessageKey(this.namespace, mutation.trackKey, mutation.seq),
                    value: mutation.msgId,
                    expireAtTimestamp: mutation.expireAtTimestamp,
                    supersedenceGuard: undefined
                };
            case 'set-msg-owner':
                return {
                    key: toALOutboundMessageOwnerKey(this.namespace, mutation.msgId),
                    value: mutation.senderId,
                    expireAtTimestamp: Math.max(
                        mutation.expireAtTimestamp ?? 0,
                        nowMs + this.retention.msgOwnerTtlMs,
                        nowMs + this.retention.controlHistoryTtlMs
                    ),
                    supersedenceGuard: undefined
                };
            case 'set-sent-message':
                return this.computeSentMessageMutation(mutation, nowMs);
            case 'set-repair-attempt':
                return {
                    key: toALOutboundRepairAttemptKey(this.namespace, mutation.snapshot.msgId),
                    value: mutation.snapshot,
                    expireAtTimestamp: mutation.expireAtTimestamp ?? nowMs + this.retention.repairAttemptTtlMs,
                    supersedenceGuard: undefined
                };
            case 'set-pending-ack':
                return {
                    key: toALOutboundPendingAckKey(this.namespace, mutation.snapshot.msgId),
                    value: mutation.snapshot,
                    expireAtTimestamp: mutation.expireAtTimestamp ??
                        toALOutboundPendingAckExpireAtTimestamp(mutation.snapshot),
                    supersedenceGuard: undefined
                };
            case 'delete-sent-message':
            case 'delete-pending-ack':
            case 'delete-repair-attempt':
                return {
                    key: this.toDeletedMutationKey(mutation),
                    value: undefined,
                    expireAtTimestamp: undefined,
                    supersedenceGuard: undefined
                };
            case 'set-supersedence-latest':
            case 'set-supersedence-replacement':
                return this.computeSupersedenceMutation(mutation);
        }
    }

    private toDeletedMutationKey(
        mutation: Extract<
            ALOutboundAdmissionMutation,
            { kind: 'delete-sent-message' | 'delete-pending-ack' | 'delete-repair-attempt'; }
        >
    ): string {
        switch (mutation.kind) {
            case 'delete-sent-message':
                return toALOutboundSentMessageKey(this.namespace, mutation.msgId);
            case 'delete-pending-ack':
                return toALOutboundPendingAckKey(this.namespace, mutation.msgId);
            case 'delete-repair-attempt':
                return toALOutboundRepairAttemptKey(this.namespace, mutation.msgId);
        }
    }

    private computeSentMessageMutation(
        mutation: Extract<ALOutboundAdmissionMutation, { kind: 'set-sent-message'; }>,
        nowMs: number
    ): ALOutboundStateWrite {
        return {
            key: toALOutboundSentMessageKey(this.namespace, mutation.snapshot.msgId),
            value: {
                msgId: mutation.snapshot.msgId,
                reference: mutation.reference,
                supersedenceKey: mutation.snapshot.supersedenceKey,
                unicastPeerId: mutation.snapshot.msg.targets?.mode === 'unicast'
                    ? mutation.snapshot.msg.targets.toPeerId
                    : null,
                orderingTrackKey: toALOrderingTrackKey(mutation.snapshot.msg) ?? null,
                orderingSeq: mutation.snapshot.msg.ordering?.seq ?? null,
                policy: mutation.policy,
                creationExpiry: mutation.creationExpiry
            },
            expireAtTimestamp: Math.max(
                mutation.expireAtTimestamp ?? 0,
                nowMs + this.retention.sentMessageTtlMs,
                nowMs + this.retention.controlHistoryTtlMs
            ),
            supersedenceGuard: undefined
        };
    }

    private computeSupersedenceMutation(
        mutation: Extract<
            ALOutboundAdmissionMutation,
            { kind: 'set-supersedence-latest' | 'set-supersedence-replacement'; }
        >
    ): ALOutboundStateWrite {
        switch (mutation.kind) {
            case 'set-supersedence-latest':
                return {
                    key: toALOutboundSupersedenceLatestKey(this.namespace, mutation.supersedenceKey),
                    value: mutation.value,
                    expireAtTimestamp: mutation.value.updatedAtMs + this.supersedenceTrackTtlMs,
                    supersedenceGuard: { expected: mutation.expected }
                };
            case 'set-supersedence-replacement':
                return {
                    key: toALOutboundSupersedenceReplacementKey(this.namespace, mutation.msgId),
                    value: mutation.value,
                    expireAtTimestamp: mutation.value.updatedAtMs + this.supersedenceTrackTtlMs,
                    supersedenceGuard: undefined
                };
        }
    }

    private async assertMessageIdentities(
        tx: ALAdmissionWorkWriteContext,
        mutations: readonly ALOutboundAdmissionMutation[]
    ): Promise<void> {
        for (const mutation of mutations) {
            if (mutation.kind === 'set-msg-owner') {
                const key = toALOutboundMessageOwnerKey(this.namespace, mutation.msgId);
                const owner = await tx.read(key, decodeALAdmissionString);
                if (owner !== undefined && owner !== mutation.senderId) {
                    throw new ALAdmissionCorruptionError(key, new TypeError('Message id belongs to another sender'));
                }
            }
            if (mutation.kind === 'set-sent-message') {
                const key = toALOutboundSentMessageKey(this.namespace, mutation.snapshot.msgId);
                const sent = await tx.read(key, (value) => decodeALOutboundSentMessage(value, mutation.snapshot.msgId));
                if (
                    mutation.reference.scope !== this.canonicalScope ||
                    (sent !== undefined && !jsonEquals(sent.reference, mutation.reference))
                ) {
                    throw new ALAdmissionCorruptionError(
                        key,
                        new TypeError('Message id has conflicting canonical identity')
                    );
                }
            }
        }
    }

    private async assertMutationObservations(
        tx: ALAdmissionWorkWriteContext,
        writes: readonly ALOutboundStateWrite[]
    ): Promise<void> {
        for (const write of writes) {
            if (write.supersedenceGuard === undefined) {
                continue;
            }
            const current = await tx.read(write.key, (value) => decodeALAdmissionSupersedenceValue(value, 'latest'));
            if (!jsonEquals(current, write.supersedenceGuard.expected)) {
                throw new ALAdmissionBackendConflictError('Outbound shared supersedence observation changed');
            }
        }
    }

    private async applyMutation(tx: ALAdmissionWorkWriteContext, write: ALOutboundStateWrite): Promise<void> {
        if (write.value === undefined) {
            await tx.remove(write.key);
        }
        else {
            await tx.set(write.key, write.value, write.expireAtTimestamp);
        }
    }
}
