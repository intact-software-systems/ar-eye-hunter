import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type {
    ALAckPayload,
    ALNackPayload,
    ALRepairPayload
} from '../../../al-contracts/al-control.ts';
import { decodePersistedALMessage } from '../../../al-contracts/al-message-persistence-validation.ts';
import type { ALReadyable } from '../../../al-contracts/al-runtime.ts';
import { PersistenceWriteExpiredError } from '../../../persistence/persistence-write-deadline.ts';
import { hasSameResourceEntryValue } from '../../../queuebox/resource-entry-observations.ts';
import type { ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
import type { ALAdmissionWorkBackend, ALAdmissionWorkWriteContext } from '../../al-admission-work-backend.ts';
import type {
    ALOutboundPendingAckSnapshot,
    ALOutboundRepairAttemptSnapshot,
    ALOutboundSentMessageSnapshot
} from '../../al-runtime-state-stores.ts';
import { ALAdmissionBackendConflictError } from '../../ALAdmissionBackendConflictError.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../../ALStoreRetention.ts';
import type {
    ALLatestSupersedenceValue,
    ALReplacementSupersedenceValue,
    ALSupersedenceAcceptance
} from '../../compute-al-supersedence-observation.ts';
import type { ALWorkQueuePort } from '../../work/al-work-queue-port.ts';
import {
    captureALOutboundCreationExpiry,
    type ALOutboundMessageReference
} from '../al-outbound-canonical-message.ts';
import {
    readALOutboundCanonicalWrites,
    writeALOutboundCanonicalFacts,
    type ALOutboundCanonicalFactWrite
} from '../al-outbound-canonical-storage.ts';
import type {
    ALOutboundDispatchPhase,
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundRepairTrigger
} from '../al-outbound-message-runtime.ts';
import {
    retainALOutboundPendingAdmission,
    type ALOutboundPendingAdmission,
    type RetainALOutboundPendingAdmissionInput
} from '../al-outbound-pending-admission.ts';
import type { ALOutboundComputeIntent } from '../compute-al-outbound-dispatch.ts';
import { ALOutboundControlAdmission } from '../control/al-outbound-control-admission.ts';
import {
    ALOutboundAdmissionEffectStore,
    type ALOutboundEffectCandidate
} from './al-outbound-admission-effect-store.ts';
import { toALOutboundVersionKey } from './al-outbound-admission-keys.ts';
import {
    ALOutboundAdmissionMutations,
    type ALOutboundAdmissionMutation,
    type ALOutboundStateWrite
} from './al-outbound-admission-mutations.ts';
import { ALOutboundAdmissionReads } from './al-outbound-admission-reads.ts';
import type { ALStoredOutboundMessage } from './al-outbound-admission-validation.ts';

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
    private readonly mutations: ALOutboundAdmissionMutations;
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
        this.mutations = new ALOutboundAdmissionMutations({
            namespace: input.namespace,
            canonicalScope: input.canonicalScope,
            retention: input.retention,
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
            mutations: this.mutations.computeStateWrites(bundle.mutations, nowMs),
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
                if (!await this.mutations.hasCurrentObservations(tx, mutations)) {
                    return 'conflict';
                }
                await this.mutations.assertMessageIdentities(tx, bundle.mutations);
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
                await this.mutations.writeStateWrites(tx, mutations);
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
}
