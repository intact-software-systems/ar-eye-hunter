import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { parseALControlMessage } from '../../al-contracts/al-control.ts';
import type { ALRepairAlgo, ALSupersedenceAlgo } from '../../al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '../../al-contracts/al-runtime.ts';
import type { ResilienceDto } from '../../queuebox/DequeueResourceEntryController.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import {
    RetryableConflictError,
    RetryPolicies,
    tryWithPolicy
} from '../../resilience/TryWith.ts';
import { QueueBoxUtilities } from '../../services/QueueBoxUtilities.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '../al-admission-backend.ts';
import type { ALOutboundPendingAckSnapshot, ALOutboundRepairAttemptSnapshot } from '../al-runtime-state-stores.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import { resolveExplicitOutboundMessageExpireAtMs } from '../ALMessageExpiry.ts';
import { normalizeALRuntimeStoreRetention } from '../ALStoreRetention.ts';
import type {
    ALOutboundAdmissionMutation,
    ALOutboundAdmissionStore,
    ALOutboundCommitBundle,
    ALOutboundDurableEffectWrite,
    ALOutboundMessageReadDto,
    ALOutboundRepairHint,
    ALPersistedOutboundEffect
} from './al-outbound-admission-store.ts';
import { createALOutboundAdmissionStore } from './al-outbound-admission-store.ts';
import {
    computeALOutboundDispatch,
    type ALOutboundCommitDispatchOptions,
    type ALOutboundComputedDto,
    type ALOutboundComputeDependencies,
    type ALOutboundComputeIntent
} from './compute-al-outbound-dispatch.ts';
import { toALOutboundEffectId } from './to-al-outbound-effect-id.ts';
import { toALOutboundPendingAckExpireAtTimestamp } from './transition-al-outbound-pending-ack.ts';

export type ALOutboundDispatchPhase = 'immediate' | 'dequeue';

export type ALOutboundPreparedSendStatus = 'sent' | 'no-targets' | 'not-ready';

export interface ALOutboundPreparedSendResult {
    readonly status: ALOutboundPreparedSendStatus;
    readonly reason?: string;
    readonly retryAfterMs?: number;
}

export interface ALOutboundAckTrackingPlan {
    readonly enabled: boolean;
    readonly timeoutMs: number;
    readonly maxAttempts: number;
    readonly expectedPeerIds: readonly string[];
    readonly mode?: 'merge' | 'replace';
}

export interface ALOutboundRepairTrackingPlan {
    readonly enabled: boolean;
    readonly algo: ALRepairAlgo;
    readonly maxAttempts: number;
}

export interface ALOutboundRetryTrackingPlan {
    readonly enabled: boolean;
    readonly maxAttempts: number;
    readonly retryDelayMs?: number;
}

export interface ALOutboundSupersedenceTrackingPlan {
    readonly enabled: boolean;
    readonly algo: ALSupersedenceAlgo;
    readonly key?: string;
    readonly replacesMsgId?: string;
}

export type ALOutboundRepairTrigger = 'ack-timeout' | 'nack' | 'repair';

export interface ALOutboundRepairRequest {
    readonly trigger: ALOutboundRepairTrigger;
    readonly repair: ALOutboundRepairTrackingPlan;
    readonly requestedByPeerId?: string;
    readonly failedPeerIds: readonly string[];
    readonly orderingTrackKey?: string;
    readonly missingSeqs: readonly number[];
}

export interface ALOutboundDispatchPlan<TPrepared> {
    readonly dropReason?: string;
    readonly persist: boolean;
    readonly preparedMessages: readonly TPrepared[];
    readonly ackTracking?: ALOutboundAckTrackingPlan;
    readonly retryTracking?: ALOutboundRetryTrackingPlan;
    readonly repairTracking?: ALOutboundRepairTrackingPlan;
    readonly supersedenceTracking?: ALOutboundSupersedenceTrackingPlan;
}

export interface ALOutboundMessageRuntimeInput<TPrepared> {
    readonly outbox: QueueBoxResourceEntryRepository;
    readonly toOutboxEntry: (msg: ALMessage) => ResourceEntry;
    readonly readMessageFromEntry: (entry: ResourceEntry) => ALMessage;
    readonly planOutgoingMessage: (msg: ALMessage) => ALOutboundDispatchPlan<TPrepared>;
    readonly planDequeuedMessage?: (msg: ALMessage) => ALOutboundDispatchPlan<TPrepared>;
    readonly beforeDequeueDispatch?: (msg: ALMessage, entry: ResourceEntry) => boolean | Promise<boolean>;
    readonly sendPreparedMessage: (
        prepared: TPrepared,
        phase: ALOutboundDispatchPhase
    ) => Promise<void | ALOutboundPreparedSendResult>;
    readonly planRepairMessage?: (
        msg: ALMessage,
        request: ALOutboundRepairRequest
    ) => Promise<ALOutboundDispatchPlan<TPrepared> | undefined>;
    readonly onFallbackDequeue?: (msg: ALMessage, entry: ResourceEntry) => Promise<void>;
    readonly stores?: ALOutboundRuntimeStores;
    readonly diagnostics?: ALOutboundRuntimeDiagnosticsSink;
    readonly nowMs?: () => number;
}
export interface ALOutboundRuntimeStores {
    readonly admissionStore?: ALOutboundAdmissionStore;
}
export type ALOutboundRuntimeDiagnosticsEvent =
    | Readonly<{
        kind: 'sender-queue-wait';
        senderId: string;
        queued: boolean;
        durationMs: number;
    }>
    | Readonly<{
        kind: 'browser-lock-wait';
        senderId: string;
        lockName: string;
        available: boolean;
        durationMs: number;
    }>
    | Readonly<{
        kind: 'browser-lock-hold';
        senderId: string;
        lockName: string;
        available: boolean;
        durationMs: number;
    }>
    | Readonly<{
        kind: 'effect-drain';
        workerId: string;
        durationMs: number;
        claimedCount: number;
        completedCount: number;
        rescheduledCount: number;
        skippedExpiredCount: number;
    }>;

export type ALOutboundRuntimeDiagnosticsSink = (
    event: ALOutboundRuntimeDiagnosticsEvent
) => void;

interface BrowserLockManager {
    request<T>(
        name: string,
        options: Readonly<{ mode: 'exclusive'; }>,
        callback: () => Promise<T>
    ): Promise<T>;
}

export type ALOutboundEnqueueStatus =
    | 'enqueued'
    | 'sent-immediate'
    | 'skipped'
    | 'duplicate'
    | 'superseded'
    | 'expired'
    | 'no-route'
    | 'rate-limited'
    | 'circuit-open'
    | 'failed';

export interface ALOutboundEnqueueResult {
    readonly status: ALOutboundEnqueueStatus;
    readonly message: ALMessage;
    readonly entry?: ResourceEntry;
    readonly entries: readonly ResourceEntry[];
    readonly reason?: string;
}

interface ALOutboundCommitResult<TPrepared> {
    readonly computed: ALOutboundComputedDto<TPrepared>;
    readonly committed: boolean;
}

interface ALOutboundCommitDispatchInput<TPrepared> {
    readonly msg: ALMessage;
    readonly planner: (msg: ALMessage) => ALOutboundDispatchPlan<TPrepared>;
    readonly intent: ALOutboundComputeIntent;
    readonly phase: ALOutboundDispatchPhase;
    readonly options: ALOutboundCommitDispatchOptions<TPrepared>;
}

interface ALOutboundRetransmitOptions {
    readonly replaceExistingOutbox?: boolean;
}

interface ALOutboundCommitRepairInput<TPrepared> {
    readonly msg: ALMessage;
    readonly plan: ALOutboundDispatchPlan<TPrepared>;
    readonly priorAttempts: number;
    readonly maxAttempts: number;
}

type ALDurableEffectRunResult =
    | Readonly<{ status: 'completed'; }>
    | Readonly<{ status: 'reschedule'; readyAtMs: number; reason: string; }>;

interface ALOutboundDurableEffectDrainCounts {
    claimedCount: number;
    completedCount: number;
    rescheduledCount: number;
    skippedExpiredCount: number;
}

export class ALOutboundMessageRuntime<TPrepared> {
    private static readonly MAX_COMMIT_ATTEMPTS = 10;
    private static readonly COMMIT_RETRY_INTERVAL_MSECS = 10;
    private static readonly COMMIT_MAX_RETRY_INTERVAL_MSECS = 50;
    private static readonly COMMIT_MAX_ELAPSED_MSECS = 500;
    private static readonly NOT_YET_IN_SYNC_RETRY_DELAY_MS = 50;
    private static readonly COMMIT_RETRY_POLICY = RetryPolicies
        .optimisticCommit('al-outbound-commit')
        .maxAttempts(ALOutboundMessageRuntime.MAX_COMMIT_ATTEMPTS)
        .retryIntervalMsecs(ALOutboundMessageRuntime.COMMIT_RETRY_INTERVAL_MSECS)
        .maxRetryIntervalMsecs(
            ALOutboundMessageRuntime.COMMIT_MAX_RETRY_INTERVAL_MSECS
        )
        .maxElapsedMsecs(ALOutboundMessageRuntime.COMMIT_MAX_ELAPSED_MSECS);
    private static readonly EFFECT_LEASE_MS = 10_000;
    private static readonly MAX_EFFECT_BATCH = 16;

    private readonly admissionStore: ALOutboundAdmissionStore;
    private readonly readyPromise: Promise<void>;
    private readonly commitQueuesBySenderId = new Map<string, Promise<void>>();
    private readonly effectWorkerId = `al-outbound:${crypto.randomUUID()}`;
    private effectDrainPromise?: Promise<void>;
    private effectDrainTimer?: ReturnType<typeof setTimeout>;
    private bootstrappedEffects = false;
    private runningEffectDrain = false;
    private disposed = false;

    private readonly input: ALOutboundMessageRuntimeInput<TPrepared>;

    constructor(
        input: ALOutboundMessageRuntimeInput<TPrepared>
    ) {
        this.input = input;
        this.admissionStore = input.stores?.admissionStore ?? createALOutboundAdmissionStore({
            namespace: 'al-outbound-runtime',
            backend: new InMemoryAdmissionBackend(createInMemoryALAdmissionState()),
            supersedenceTrackTtlMs: 5 * 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        this.readyPromise = this.admissionStore.ready();
    }

    async ready(): Promise<void> {
        await this.readyPromise;

        if (this.disposed) {
            return;
        }

        if (!this.bootstrappedEffects) {
            this.bootstrappedEffects = true;
            await this.drainDurableEffectsNow();
        }
    }

    dispose(): void {
        this.disposed = true;
        if (this.effectDrainTimer !== undefined) {
            clearTimeout(this.effectDrainTimer);
            this.effectDrainTimer = undefined;
        }
    }

    async enqueueIfAbsent(
        msg: ALMessage,
        dispatchPlan?: ALOutboundDispatchPlan<TPrepared>
    ): Promise<ALOutboundEnqueueResult> {
        if (this.disposed) {
            return ALOutboundMessageRuntime.toDisposedEnqueueResult(msg);
        }

        await this.ready();
        if (this.disposed) {
            return ALOutboundMessageRuntime.toDisposedEnqueueResult(msg);
        }

        const computed = await this.commitDispatchPlanWithRetry({
            msg,
            planner: dispatchPlan === undefined
                ? this.input.planOutgoingMessage
                : () => dispatchPlan,
            intent: 'enqueue',
            phase: 'immediate',
            options: {}
        });
        return {
            status: computed.status,
            message: msg,
            entry: computed.entries[0],
            entries: computed.entries,
            reason: computed.reason
        };
    }
    async dequeue(
        typesToDequeue: Set<string>,
        resilience: ResilienceDto
    ): Promise<void> {
        if (this.disposed) {
            return;
        }
        await this.ready();
        if (this.disposed) {
            return;
        }
        await QueueBoxUtilities.defaultDequeue(
            this.input.outbox,
            typesToDequeue,
            resilience,
            async (entry) => {
                const msg = this.input.readMessageFromEntry(entry);
                const clusterDispatch = this.input.beforeDequeueDispatch?.(msg, entry);
                const clusterPublished = clusterDispatch === undefined || typeof clusterDispatch === 'boolean'
                    ? clusterDispatch ?? false
                    : await clusterDispatch;
                const computed = await this.commitDispatchPlanWithRetry({
                    msg,
                    planner: this.input.planDequeuedMessage ??
                        this.input.planOutgoingMessage,
                    intent: 'dequeue',
                    phase: 'dequeue',
                    options: {
                        fallbackEntry: entry
                    }
                });
                if (computed.status === 'no-route' && !clusterPublished) {
                    throw new Error(computed.reason);
                }
            }
        );
    }

    async acceptControlMessage(msg: ALMessage): Promise<boolean> {
        await this.ready();
        if (this.disposed) {
            return false;
        }

        const acceptance = await tryWithPolicy(
            async () => {
                try {
                    return await this.admissionStore.acceptControlMessage<TPrepared>(msg);
                }
                catch (error) {
                    if (error instanceof ALAdmissionBackendConflictError) {
                        throw new RetryableConflictError(
                            'Outbound control-message admission conflict',
                            { cause: error }
                        );
                    }
                    throw error;
                }
            },
            ALOutboundMessageRuntime.COMMIT_RETRY_POLICY
        );
        if (!acceptance.handled) {
            return false;
        }

        const retryAtMs = await this.scheduleNotYetInSyncRetryIfRequired(msg);
        if (!this.runningEffectDrain) {
            await this.drainDurableEffectsNow();
        }
        else if (retryAtMs !== undefined) {
            this.scheduleEffectDrainAt(retryAtMs);
        }
        return true;
    }

    private async commitDispatchPlanWithRetry(
        dispatch: ALOutboundCommitDispatchInput<TPrepared>
    ): Promise<ALOutboundComputedDto<TPrepared>> {
        const result = await this.withSenderCommitQueue(
            dispatch.msg.id.senderId,
            () => this.commitDispatchPlanWithRetryNow(dispatch)
        );

        if (result.committed && !dispatch.options.deferEffectDrain) {
            await this.finalizeCommittedOutbound();
        }

        return result.computed;
    }

    private async commitDispatchPlanWithRetryNow(
        dispatch: ALOutboundCommitDispatchInput<TPrepared>
    ): Promise<ALOutboundCommitResult<TPrepared>> {
        try {
            return await tryWithPolicy<ALOutboundCommitResult<TPrepared>>(
                () => this.commitDispatchOnce(dispatch),
                ALOutboundMessageRuntime.COMMIT_RETRY_POLICY
            );
        }
        catch (error) {
            throw new Error(
                `Failed to commit outbound message after retries: ${dispatch.msg.id.msgId}`,
                { cause: error }
            );
        }
    }

    private async commitDispatchOnce(
        dispatch: ALOutboundCommitDispatchInput<TPrepared>
    ): Promise<ALOutboundCommitResult<TPrepared>> {
        if (this.disposed) {
            return { computed: ALOutboundMessageRuntime.toDisposedComputed(), committed: false };
        }

        const read = await this.admissionStore.readOutgoingMessage(dispatch.msg, dispatch.planner);
        if (this.disposed) {
            return { computed: ALOutboundMessageRuntime.toDisposedComputed(), committed: false };
        }

        const computed = computeALOutboundDispatch({
            read,
            dependencies: this.toComputeDependencies(),
            intent: dispatch.intent,
            phase: dispatch.phase,
            options: dispatch.options
        });
        this.logDispatchDecision(computed, read.plan);
        if (!computed.bundle) {
            return { computed, committed: false };
        }
        if (this.disposed) {
            return { computed: ALOutboundMessageRuntime.toDisposedComputed(), committed: false };
        }

        const status = await this.admissionStore.commitBundle(this.toRuntimeClockedBundle(computed.bundle));
        if (status === 'conflict') {
            throw new RetryableConflictError('Outbound commit conflict');
        }

        return { computed, committed: true };
    }

    private logDispatchDecision(
        computed: ALOutboundComputedDto<TPrepared>,
        plan: ALOutboundDispatchPlan<TPrepared>
    ): void {
        if (plan.dropReason) {
            if (!plan.dropReason.includes('Skipping')) {
                console.warn(`Skipping outbound dispatch: ${plan.dropReason}`);
            }
            return;
        }
        if (computed.status === 'superseded' || computed.status === 'no-route') {
            console.warn(computed.reason);
        }
    }

    private static toDisposedEnqueueResult(msg: ALMessage): ALOutboundEnqueueResult {
        return {
            status: 'skipped',
            message: msg,
            entries: [],
            reason: 'Outbound runtime is disposed.'
        };
    }

    private static toDisposedComputed<TPrepared>(): ALOutboundComputedDto<TPrepared> {
        return {
            status: 'skipped',
            entries: [],
            reason: 'Outbound runtime is disposed.'
        };
    }

    private async finalizeCommittedOutbound(): Promise<void> {
        const runningDrain = this.effectDrainPromise;
        if (runningDrain) {
            await runningDrain;
        }

        await this.drainDurableEffectsNow();
    }

    private toRuntimeClockedBundle(
        bundle: ALOutboundCommitBundle<TPrepared>
    ): ALOutboundCommitBundle<TPrepared> {
        if (bundle.durableEffects.length === 0) {
            return bundle;
        }

        const nowMs = this.readNowMs();
        return {
            ...bundle,
            durableEffects: bundle.durableEffects.map((effect) =>
                effect.retryAtMs === undefined
                    ? { ...effect, retryAtMs: nowMs }
                    : effect
            )
        };
    }

    private async drainDurableEffectsNow(): Promise<void> {
        await this.startEffectDrain();
    }

    private requestEffectDrain(): void {
        if (this.disposed) {
            return;
        }
        void this.startEffectDrain().catch((error) => {
            console.error('Failed to drain outbound durable effects', error);
        });
    }

    private startEffectDrain(): Promise<void> {
        if (this.disposed) {
            return Promise.resolve();
        }

        if (!this.effectDrainPromise) {
            if (this.effectDrainTimer !== undefined) {
                clearTimeout(this.effectDrainTimer);
                this.effectDrainTimer = undefined;
            }

            this.effectDrainPromise = this.runDurableEffectDrainLoop()
                .catch((error) => {
                    console.error('Outbound durable effect drain failed', error);
                    this.scheduleEffectDrainAt(this.readNowMs() + this.toEffectRetryDelayMs(0));
                })
                .finally(() => {
                    this.effectDrainPromise = undefined;
                });
        }

        return this.effectDrainPromise;
    }

    private async runDurableEffectDrainLoop(): Promise<void> {
        this.runningEffectDrain = true;
        const startedAtMs = this.readNowMs();
        const counts: ALOutboundDurableEffectDrainCounts = {
            claimedCount: 0,
            completedCount: 0,
            rescheduledCount: 0,
            skippedExpiredCount: 0
        };
        try {
            while (true) {
                if (this.disposed) {
                    break;
                }

                const claimed = await this.admissionStore.claimReadyEffects<TPrepared>(
                    {
                        workerId: this.effectWorkerId,
                        maxCount: ALOutboundMessageRuntime.MAX_EFFECT_BATCH,
                        leaseMs: ALOutboundMessageRuntime.EFFECT_LEASE_MS,
                        nowMs: this.readNowMs()
                    }
                );
                if (claimed.length === 0) {
                    break;
                }
                counts.claimedCount += claimed.length;
                await this.runClaimedDurableEffects(claimed, counts);
            }

            if (this.disposed) {
                return;
            }

            const nextReadyAt = await this.admissionStore.peekNextEffectReadyAt();
            if (nextReadyAt !== undefined) {
                this.scheduleEffectDrainAt(nextReadyAt);
            }
        }
        finally {
            this.runningEffectDrain = false;
            this.emitDiagnostics({
                kind: 'effect-drain',
                workerId: this.effectWorkerId,
                durationMs: this.elapsedSince(startedAtMs),
                ...counts
            });
        }
    }

    private async runClaimedDurableEffects(
        effects: readonly ALPersistedOutboundEffect<TPrepared>[],
        counts: ALOutboundDurableEffectDrainCounts
    ): Promise<void> {
        for (const effect of effects) {
            if (this.disposed) {
                return;
            }

            await this.runClaimedDurableEffect(effect, counts);
        }
    }

    private async runClaimedDurableEffect(
        effect: ALPersistedOutboundEffect<TPrepared>,
        counts: ALOutboundDurableEffectDrainCounts
    ): Promise<void> {
        try {
            if (effect.expireAtTimestamp <= this.readNowMs()) {
                counts.skippedExpiredCount += 1;
            }
            const result = await this.runDurableEffect(effect);
            if (result.status === 'reschedule') {
                await this.rescheduleDurableEffect(effect, result.readyAtMs, result.reason);
                counts.rescheduledCount += 1;
                return;
            }

            await this.admissionStore.completeEffect(effect.effectId, this.effectWorkerId);
            counts.completedCount += 1;
        }
        catch (error) {
            if (!this.disposed) {
                await this.rescheduleDurableEffect(
                    effect,
                    this.readNowMs() + this.toEffectRetryDelayMs(effect.attempts),
                    ALOutboundMessageRuntime.toErrorMessage(error)
                );
                counts.rescheduledCount += 1;
            }
        }
    }

    private async rescheduleDurableEffect(
        effect: ALPersistedOutboundEffect<TPrepared>,
        retryAtMs: number,
        lastError: string
    ): Promise<void> {
        await this.admissionStore.rescheduleEffect({
            effectId: effect.effectId,
            workerId: this.effectWorkerId,
            retryAtMs,
            lastError
        });
    }

    private scheduleEffectDrainAt(readyAtMs: number): void {
        if (this.disposed) {
            return;
        }

        if (this.effectDrainTimer !== undefined) {
            clearTimeout(this.effectDrainTimer);
        }

        const delayMs = Math.max(0, readyAtMs - this.readNowMs());
        this.effectDrainTimer = setTimeout(() => {
            this.effectDrainTimer = undefined;
            this.requestEffectDrain();
        }, delayMs);
    }

    private async runDurableEffect(
        effect: ALPersistedOutboundEffect<TPrepared>
    ): Promise<ALDurableEffectRunResult> {
        if (effect.expireAtTimestamp <= this.readNowMs()) {
            return { status: 'completed' };
        }

        switch (effect.payload.kind) {
            case 'send-prepared': {
                const sendResult =
                    await this.input.sendPreparedMessage(effect.payload.prepared, effect.payload.phase) ??
                        { status: 'sent' };
                if (sendResult.status === 'not-ready') {
                    return {
                        status: 'reschedule',
                        readyAtMs: this.readNowMs() +
                            Math.max(0, sendResult.retryAfterMs ?? this.toEffectRetryDelayMs(effect.attempts)),
                        reason: sendResult.reason ?? 'Prepared outbound transport is not ready.'
                    };
                }

                return { status: 'completed' };
            }
            case 'enqueue-outbox':
                if (effect.payload.replaceExisting) {
                    await this.input.outbox.enqueue(effect.payload.entry);
                    return { status: 'completed' };
                }

                await this.input.outbox.enqueueIfAbsent(effect.payload.entry);
                return { status: 'completed' };
            case 'fallback-dispatch':
                if (this.input.onFallbackDequeue) {
                    await this.input.onFallbackDequeue(effect.payload.msg, effect.payload.entry);
                }
                return { status: 'completed' };
            case 'ack-timeout':
                await this.handlePendingAckTimeout(effect.payload.msgId);
                return { status: 'completed' };
            case 'repair-hint':
                await this.executeRepairFromHint(
                    effect.payload.msgId,
                    effect.payload.request
                );
                return { status: 'completed' };
            case 'nack-retry':
                await this.retransmitByMsgId(effect.payload.msgId, {
                    replaceExistingOutbox: true
                });
                return { status: 'completed' };
        }
    }

    private async scheduleNotYetInSyncRetryIfRequired(
        controlMessage: ALMessage
    ): Promise<number | undefined> {
        const parsed = parseALControlMessage(controlMessage);
        if (parsed?.type !== 'nack' || parsed.payload.reason !== 'not-yet-in-sync') {
            return undefined;
        }

        const msgId = parsed.payload.msgId;

        try {
            return await tryWithPolicy<number | undefined>(
                () => this.scheduleNotYetInSyncRetryOnce(msgId),
                ALOutboundMessageRuntime.COMMIT_RETRY_POLICY
            );
        }
        catch (error) {
            throw new Error(
                `Failed to schedule not-yet-in-sync retry for message ${msgId}`,
                { cause: error }
            );
        }
    }

    private async scheduleNotYetInSyncRetryOnce(msgId: string): Promise<number | undefined> {
        const read = await this.admissionStore.readRepairMessage(msgId, this.input.planOutgoingMessage);
        const msg = read.sentSnapshot?.msg;
        const retry = read.plan?.retryTracking;
        if (!msg || !retry?.enabled || retry.maxAttempts <= 0) {
            return undefined;
        }

        const retryAttempt = read.nacks.filter((nack) => nack.reason === 'not-yet-in-sync').length;
        if (retryAttempt > retry.maxAttempts) {
            console.warn(`Not-yet-in-sync retry budget exceeded for message ${msgId}`);
            return undefined;
        }

        const retryDelayMs = Math.max(
            0,
            retry.retryDelayMs ?? ALOutboundMessageRuntime.NOT_YET_IN_SYNC_RETRY_DELAY_MS
        );
        const retryAtMs = read.nowMs + retryDelayMs;
        const status = await this.admissionStore.commitBundle<TPrepared>({
            senderId: msg.id.senderId,
            expectedVersion: read.clientRecord?.version,
            mutations: [],
            durableEffects: [{
                effectId: toALOutboundEffectId(['nack-retry', msgId, 'not-yet-in-sync']),
                retryAtMs,
                expireAtTimestamp: resolveExplicitOutboundMessageExpireAtMs(msg),
                payload: { kind: 'nack-retry', msgId, reason: 'not-yet-in-sync' }
            }]
        });
        if (status === 'conflict') {
            throw new RetryableConflictError('Outbound not-yet-in-sync retry commit conflict');
        }

        return retryAtMs;
    }

    private async handlePendingAckTimeout(msgId: string): Promise<void> {
        try {
            await tryWithPolicy(
                () => this.handlePendingAckTimeoutOnce(msgId),
                ALOutboundMessageRuntime.COMMIT_RETRY_POLICY
            );
        }
        catch (error) {
            throw new Error(
                `Failed to commit ack timeout for message ${msgId}`,
                { cause: error }
            );
        }
    }

    private async handlePendingAckTimeoutOnce(msgId: string): Promise<void> {
        const read = await this.admissionStore.readRepairMessage(msgId, this.input.planOutgoingMessage);
        const pending = read.pendingAck;
        const msg = read.sentSnapshot?.msg;
        if (!pending || !msg) {
            return;
        }
        if (pending.deadlineAtMs > Date.now()) {
            await this.persistNextAckTimeout(msg, pending, read.clientRecord?.version);
            return;
        }
        if (this.isAckComplete(pending)) {
            await this.commitClearPendingAck(msg, pending, read.clientRecord?.version);
            return;
        }
        if (pending.attempts >= pending.maxAttempts) {
            console.warn(`Ack timeout exceeded retry budget for message ${msgId}`);
            await this.commitClearPendingAck(msg, pending, read.clientRecord?.version);
            return;
        }

        const nextPending: ALOutboundPendingAckSnapshot = {
            ...pending,
            attempts: pending.attempts + 1,
            deadlineAtMs: Date.now() + pending.timeoutMs
        };
        const bundle = this.toAckTimeoutRepairBundle(msg, nextPending, read.clientRecord?.version);
        const status = await this.admissionStore.commitBundle(bundle);
        if (status === 'conflict') {
            throw new RetryableConflictError('Outbound ack timeout commit conflict');
        }
    }

    private toAckTimeoutRepairBundle(
        msg: ALMessage,
        pending: ALOutboundPendingAckSnapshot,
        expectedVersion: number | undefined
    ): ALOutboundCommitBundle<TPrepared> {
        const failedPeerIds = pending.expectedPeerIds.filter((peerId) => !pending.ackedPeerIds.includes(peerId));
        return {
            senderId: msg.id.senderId,
            expectedVersion,
            mutations: [{ kind: 'set-pending-ack', snapshot: pending }],
            durableEffects: [
                this.toAckTimeoutEffect(pending),
                {
                    effectId: toALOutboundEffectId([
                        'repair-hint',
                        msg.id.msgId,
                        'ack-timeout',
                        pending.attempts,
                        pending.deadlineAtMs
                    ]),
                    payload: {
                        kind: 'repair-hint',
                        msgId: msg.id.msgId,
                        request: { trigger: 'ack-timeout', failedPeerIds, missingSeqs: [] }
                    }
                }
            ]
        };
    }

    private async persistNextAckTimeout(
        msg: ALMessage,
        pending: ALOutboundPendingAckSnapshot,
        expectedVersion?: number
    ): Promise<void> {
        const status = await this.admissionStore.commitBundle<TPrepared>({
            senderId: msg.id.senderId,
            expectedVersion,
            mutations: [],
            durableEffects: [
                this.toAckTimeoutEffect(pending)
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
        const status = await this.admissionStore.commitBundle<TPrepared>({
            senderId: msg.id.senderId,
            expectedVersion,
            mutations: [
                {
                    kind: 'delete-pending-ack',
                    msgId: pending.msgId
                },
                {
                    kind: 'delete-repair-attempt',
                    msgId: pending.msgId
                }
            ],
            durableEffects: []
        });
        if (status === 'conflict') {
            throw new RetryableConflictError(
                'Outbound pending ack clear commit conflict'
            );
        }
    }

    private async executeRepairFromHint(
        fallbackMsgId: string,
        request: ALOutboundRepairHint
    ): Promise<void> {
        if (request.orderingTrackKey && request.missingSeqs.length > 0) {
            const sentMessages = await this.admissionStore.getAllSentMessages();
            let retransmitted = false;

            for (const seq of request.missingSeqs) {
                const cached = sentMessages.find((snapshot) =>
                    toALOrderingTrackKey(snapshot.msg) === request.orderingTrackKey &&
                    snapshot.msg.ordering?.seq === seq
                );
                if (!cached) {
                    continue;
                }

                retransmitted = true;
                await this.repairByMsgId(cached.msgId, request);
            }

            if (retransmitted) {
                return;
            }
        }

        await this.repairByMsgId(fallbackMsgId, request);
    }

    private async repairByMsgId(
        msgId: string,
        request: ALOutboundRepairHint
    ): Promise<void> {
        try {
            const read = await this.admissionStore.readRepairMessage(msgId, this.input.planOutgoingMessage);
            const msg = read.sentSnapshot?.msg;
            const plan = read.plan;
            if (!msg || !plan) {
                console.warn(`No cached outbound message found for repair ${msgId}`);
                return;
            }

            const repair = plan.repairTracking;
            if (!repair?.enabled || repair.algo === 'none') {
                await this.retransmitByMsgId(msgId);
                return;
            }

            const attempts = read.repairAttempt?.attempts ?? 0;
            if (attempts >= repair.maxAttempts) {
                console.warn(`Repair budget exceeded for message ${msgId}`);
                await this.retransmitByMsgId(msgId);
                return;
            }

            const handledPlan = await this.input.planRepairMessage?.(
                msg,
                {
                    ...request,
                    repair
                }
            );
            if (!handledPlan || handledPlan.dropReason) {
                if (handledPlan?.dropReason) {
                    console.warn(`Skipping outbound repair dispatch: ${handledPlan.dropReason}`);
                }
                await this.retransmitByMsgId(msgId);
                return;
            }

            await this.commitRepairPlan({
                msg,
                plan: handledPlan,
                priorAttempts: attempts,
                maxAttempts: repair.maxAttempts
            });
        }
        catch (error) {
            throw new Error(
                `Failed to commit repair for message ${msgId}`,
                { cause: error }
            );
        }
    }

    private async commitRepairPlan(repair: ALOutboundCommitRepairInput<TPrepared>): Promise<void> {
        const computed = await this.commitDispatchPlanWithRetry({
            msg: repair.msg,
            planner: () => repair.plan,
            intent: 'repair',
            phase: 'immediate',
            options: {
                extraMutations: (read) => this.toRepairAttemptMutations(read, repair.priorAttempts, repair.maxAttempts),
                deferEffectDrain: true
            }
        });
        if (computed.bundle === undefined) {
            await this.retransmitByMsgId(repair.msg.id.msgId);
        }
    }

    private toRepairAttemptMutations(
        read: ALOutboundMessageReadDto<TPrepared>,
        priorAttempts: number,
        maxAttempts: number
    ): readonly ALOutboundAdmissionMutation[] | 'skip' {
        const currentAttempts = read.repairAttempt?.attempts ?? priorAttempts;
        if (currentAttempts >= maxAttempts) {
            return 'skip';
        }

        return [{
            kind: 'set-repair-attempt',
            snapshot: {
                msgId: read.msg.id.msgId,
                attempts: currentAttempts + 1
            } satisfies ALOutboundRepairAttemptSnapshot
        }];
    }

    private async withSenderCommitQueue<T>(
        senderId: string,
        task: () => Promise<T>
    ): Promise<T> {
        const existing = this.commitQueuesBySenderId.get(senderId);
        const previous = existing ?? Promise.resolve();
        const waitStartedAtMs = this.readNowMs();
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.catch(() => undefined).then(() => gate);
        this.commitQueuesBySenderId.set(senderId, tail);

        await previous.catch(() => undefined);
        this.emitDiagnostics({
            kind: 'sender-queue-wait',
            senderId,
            queued: existing !== undefined,
            durationMs: this.elapsedSince(waitStartedAtMs)
        });

        try {
            return await this.withCrossContextCommitLock(senderId, task);
        }
        finally {
            release?.();
            if (this.commitQueuesBySenderId.get(senderId) === tail) {
                this.commitQueuesBySenderId.delete(senderId);
            }
        }
    }

    private async withCrossContextCommitLock<T>(
        senderId: string,
        task: () => Promise<T>
    ): Promise<T> {
        const lockName = `rallar:al-outbound-commit:${senderId}`;
        const locks = this.readBrowserLockManager();
        if (!locks) {
            this.emitDiagnostics({
                kind: 'browser-lock-wait',
                senderId,
                lockName,
                available: false,
                durationMs: 0
            });
            const holdStartedAtMs = this.readNowMs();
            try {
                return await task();
            }
            finally {
                this.emitDiagnostics({
                    kind: 'browser-lock-hold',
                    senderId,
                    lockName,
                    available: false,
                    durationMs: this.elapsedSince(holdStartedAtMs)
                });
            }
        }

        const waitStartedAtMs = this.readNowMs();
        return await locks.request(
            lockName,
            { mode: 'exclusive' },
            async () => {
                this.emitDiagnostics({
                    kind: 'browser-lock-wait',
                    senderId,
                    lockName,
                    available: true,
                    durationMs: this.elapsedSince(waitStartedAtMs)
                });
                const holdStartedAtMs = this.readNowMs();
                try {
                    return await task();
                }
                finally {
                    this.emitDiagnostics({
                        kind: 'browser-lock-hold',
                        senderId,
                        lockName,
                        available: true,
                        durationMs: this.elapsedSince(holdStartedAtMs)
                    });
                }
            }
        );
    }

    private readNowMs(): number {
        return this.input.nowMs?.() ?? Date.now();
    }

    private elapsedSince(startedAtMs: number): number {
        return Math.max(0, this.readNowMs() - startedAtMs);
    }

    private emitDiagnostics(event: ALOutboundRuntimeDiagnosticsEvent): void {
        try {
            this.input.diagnostics?.(event);
        }
        catch (error) {
            console.error('AL outbound runtime diagnostics sink failed', error);
        }
    }

    private readBrowserLockManager(): BrowserLockManager | undefined {
        const candidate = (globalThis as {
            navigator?: {
                locks?: BrowserLockManager;
            };
        }).navigator?.locks;

        return typeof candidate?.request === 'function' ? candidate : undefined;
    }

    private async retransmitByMsgId(
        msgId: string,
        options: ALOutboundRetransmitOptions = {}
    ): Promise<void> {
        const sent = await this.admissionStore.getSentMessage(msgId);
        if (!sent) {
            console.warn(`No cached outbound message found for retransmit ${msgId}`);
            return;
        }

        await this.commitDispatchPlanWithRetry({
            msg: sent.msg,
            planner: this.input.planOutgoingMessage,
            intent: 'repair',
            phase: 'immediate',
            options: {
                replaceExistingOutbox: options.replaceExistingOutbox,
                deferEffectDrain: true
            }
        });
    }

    private toComputeDependencies(): ALOutboundComputeDependencies {
        return {
            toOutboxEntry: this.input.toOutboxEntry,
            canFallback: this.input.onFallbackDequeue !== undefined
        };
    }

    private toEffectRetryDelayMs(attempts: number): number {
        return Math.min(5_000, 25 * Math.pow(2, Math.max(0, attempts)));
    }

    private toAckTimeoutEffect(
        pending: ALOutboundPendingAckSnapshot
    ): ALOutboundDurableEffectWrite<TPrepared> {
        return {
            effectId: toALOutboundEffectId([
                'ack-timeout',
                pending.msgId,
                pending.attempts + 1,
                pending.deadlineAtMs
            ]),
            retryAtMs: pending.deadlineAtMs,
            expireAtTimestamp: toALOutboundPendingAckExpireAtTimestamp(pending),
            payload: {
                kind: 'ack-timeout',
                msgId: pending.msgId
            }
        };
    }

    private isAckComplete(pending: ALOutboundPendingAckSnapshot): boolean {
        return pending.expectedPeerIds.length === 0 ||
            pending.expectedPeerIds.every((peerId) => pending.ackedPeerIds.includes(peerId));
    }

    private static toErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }

        return String(error);
    }
}
