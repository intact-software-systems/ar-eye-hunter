import type { ALMessage } from '../al-contracts/al-contract.ts';
import { parseALControlMessage } from '../al-contracts/al-control.ts';
import type { ALRepairAlgo, ALSupersedenceAlgo } from '../al-contracts/al-policy.ts';
import { InMemoryALOrderingStore } from '../al-contracts/al-runtime.ts';
import type { ResilienceDto } from '../queuebox/DequeueResourceEntryController.ts';
import type { QueueBoxResourceEntryRepository } from '../queuebox/QueueBoxTypes.ts';
import type { Key, ResourceEntry } from '../queuebox/ResourceEntry.ts';
import { RetryableConflictError, RetryPolicies, tryWithPolicy, } from '../resilience/TryWith.ts';
import { QueueBoxUtilities } from '../services/QueueBoxUtilities.ts';
import type {
    ALOutboundAdmissionMutation,
    ALOutboundAdmissionStore,
    ALOutboundCommitBundle,
    ALOutboundDurableEffectWrite,
    ALOutboundEffectSettlement,
    ALOutboundMessageReadDto,
    ALOutboundRepairHint,
    ALPersistedOutboundEffect,
} from './ALOutboundAdmissionStore.ts';
import {
    createALOutboundAdmissionStore,
    createInMemoryALOutboundAdmissionState,
    toPendingAckExpireAtTimestamp,
    trackOutboundPendingAckSnapshot,
} from './ALOutboundAdmissionStore.ts';
import { resolveExplicitOutboundMessageExpireAtMs } from './ALMessageExpiry.ts';
import type {
    ALOutboundPendingAckSnapshot,
    ALOutboundRepairAttemptSnapshot,
    ALOutboundRuntimeStateStore,
    ALOutboundSentMessageSnapshot,
} from './ALRuntimeStateStores.ts';

export type ALOutboundDispatchPhase = 'immediate' | 'dequeue';

export type ALOutboundPreparedSendStatus = 'sent' | 'no-targets' | 'not-ready';

export type ALOutboundPreparedSendResult = Readonly<{
    status: ALOutboundPreparedSendStatus;
    reason?: string;
    retryAfterMs?: number;
}>;

export type ALOutboundAckTrackingPlan = Readonly<{
    enabled: boolean;
    timeoutMs: number;
    maxAttempts: number;
    expectedPeerIds: readonly string[];
    mode?: 'merge' | 'replace';
}>;

export type ALOutboundRepairTrackingPlan = Readonly<{
    enabled: boolean;
    algo: ALRepairAlgo;
    maxAttempts: number;
}>;

export type ALOutboundRetryTrackingPlan = Readonly<{
    enabled: boolean;
    maxAttempts: number;
    retryDelayMs?: number;
}>;

export type ALOutboundSupersedenceTrackingPlan = Readonly<{
    enabled: boolean;
    algo: ALSupersedenceAlgo;
    key?: string;
    replacesMsgId?: string;
}>;

export type ALOutboundRepairTrigger = 'ack-timeout' | 'nack' | 'repair';

export type ALOutboundRepairRequest = Readonly<{
    trigger: ALOutboundRepairTrigger;
    repair: ALOutboundRepairTrackingPlan;
    requestedByPeerId?: string;
    failedPeerIds: readonly string[];
    orderingTrackKey?: string;
    missingSeqs: readonly number[];
}>;

export type ALOutboundDispatchPlan<TPrepared> = Readonly<{
    dropReason?: string;
    persist: boolean;
    preparedMessages: readonly TPrepared[];
    ackTracking?: ALOutboundAckTrackingPlan;
    retryTracking?: ALOutboundRetryTrackingPlan;
    repairTracking?: ALOutboundRepairTrackingPlan;
    supersedenceTracking?: ALOutboundSupersedenceTrackingPlan;
}>;

export type ALOutboundMessageRuntimeInput<TPrepared> = Readonly<{
    diagnosticsRuntime: string;
    outbox: QueueBoxResourceEntryRepository;
    toOutboxEntry: (msg: ALMessage) => ResourceEntry;
    readMessageFromEntry: (entry: ResourceEntry) => ALMessage;
    planOutgoingMessage: (msg: ALMessage) => ALOutboundDispatchPlan<TPrepared>;
    sendPreparedMessage: (
        prepared: TPrepared,
        phase: ALOutboundDispatchPhase,
    ) => Promise<void | ALOutboundPreparedSendResult>;
    planRepairMessage?: (
        msg: ALMessage,
        request: ALOutboundRepairRequest,
    ) => Promise<ALOutboundDispatchPlan<TPrepared> | undefined>;
    onFallbackDequeue?: (msg: ALMessage, entry: ResourceEntry) => Promise<void>;
    stores?: ALOutboundRuntimeStores;
    diagnostics?: ALOutboundRuntimeDiagnosticsSink;
    nowMs?: () => number;
}>;

export type ALOutboundRuntimeStores = Readonly<{
    admissionStore?: ALOutboundAdmissionStore;
    supersedenceStore?: unknown;
    stateStore?: ALOutboundRuntimeStateStore;
}>;

export type ALOutboundRuntimeMessageDiagnostics = Readonly<{
    msgId: string;
    senderId?: string;
    resourceId?: string;
}>;

type ALOutboundRuntimeDiagnosticsContext = Readonly<{
    runtime: string;
}>;

export type ALOutboundRuntimeDiagnosticsEvent =
    & ALOutboundRuntimeDiagnosticsContext
    & (
        | Readonly<{
    kind: 'sender-queue-wait';
    senderId: string;
    message: ALOutboundRuntimeMessageDiagnostics;
    queued: boolean;
    durationMs: number;
}>
    | Readonly<{
    kind: 'browser-lock-wait';
    senderId: string;
    message: ALOutboundRuntimeMessageDiagnostics;
    lockName: string;
    available: boolean;
    durationMs: number;
}>
    | Readonly<{
    kind: 'browser-lock-hold';
    senderId: string;
    message: ALOutboundRuntimeMessageDiagnostics;
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
    messages: readonly ALOutboundRuntimeMessageDiagnostics[];
}>
    );

type ALOutboundRuntimeDiagnosticsEventInput =
    ALOutboundRuntimeDiagnosticsEvent extends infer TEvent
        ? TEvent extends ALOutboundRuntimeDiagnosticsEvent
            ? Omit<TEvent, 'runtime'>
        : never
        : never;

export type ALOutboundRuntimeDiagnosticsSink = (
    event: ALOutboundRuntimeDiagnosticsEvent,
) => void;

type BrowserLockManager = Readonly<{
    request<T>(
        name: string,
        options: Readonly<{ mode: 'exclusive' }>,
        callback: () => Promise<T>,
    ): Promise<T>;
}>;

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

export type ALOutboundEnqueueResult = Readonly<{
    status: ALOutboundEnqueueStatus;
    message: ALMessage;
    entry?: ResourceEntry;
    entries: readonly ResourceEntry[];
    reason?: string;
}>;

type ALOutboundComputeIntent = 'enqueue' | 'dequeue' | 'repair';

type ALOutboundComputeDependencies = Readonly<{
    toOutboxEntry: (msg: ALMessage) => ResourceEntry;
    canFallback: boolean;
}>;

type ALOutboundComputedDto<TPrepared> = Readonly<{
    bundle?: ALOutboundCommitBundle<TPrepared>;
    status: ALOutboundEnqueueStatus;
    reason?: string;
    entries: readonly ResourceEntry[];
}>;

type CommitDispatchOptions<TPrepared> = Readonly<{
    fallbackEntry?: ResourceEntry;
    replaceExistingOutbox?: boolean;
    deferEffectDrain?: boolean;
    extraMutations?: (
        read: ALOutboundMessageReadDto<TPrepared>,
    ) => readonly ALOutboundAdmissionMutation[] | 'skip' | undefined;
}>;

type ALOutboundCommitResult<TPrepared> = Readonly<{
    computed: ALOutboundComputedDto<TPrepared>;
    committed: boolean;
}>;

type ALDurableEffectRunResult =
    | Readonly<{ status: 'completed' }>
    | Readonly<{ status: 'reschedule'; readyAtMs: number; reason: string }>;

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
            ALOutboundMessageRuntime.COMMIT_MAX_RETRY_INTERVAL_MSECS,
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

    constructor(
        private readonly input: ALOutboundMessageRuntimeInput<TPrepared>,
    ) {
        this.admissionStore = input.stores?.admissionStore ?? createALOutboundAdmissionStore({
            kind: 'memory',
            namespace: 'al-outbound-runtime',
            supersedenceTrackTtlMs: 5 * 60_000,
            state: createInMemoryALOutboundAdmissionState(),
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

    async enqueueIfAbsent(msg: ALMessage): Promise<ALOutboundEnqueueResult> {
        if (this.disposed) {
            return ALOutboundMessageRuntime.toDisposedEnqueueResult(msg);
        }

        await this.ready();
        if (this.disposed) {
            return ALOutboundMessageRuntime.toDisposedEnqueueResult(msg);
        }

        const computed = await this.commitDispatchPlanWithRetry(
            msg,
            this.input.planOutgoingMessage,
            'enqueue',
            'immediate',
        );
        return {
            status: computed.status,
            message: msg,
            entry: computed.entries[0],
            entries: computed.entries,
            reason: computed.reason,
        };
    }

    async dequeue(
        typesToDequeue: Set<string>,
        resilience: ResilienceDto,
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
                await this.commitDispatchPlanWithRetry(
                    msg,
                    this.input.planOutgoingMessage,
                    'dequeue',
                    'dequeue',
                    {
                        fallbackEntry: entry,
                    },
                );
            },
        );
    }

    async acceptControlMessage(msg: ALMessage): Promise<boolean> {
        await this.ready();
        if (this.disposed) {
            return false;
        }

        const acceptance = await this.admissionStore.acceptControlMessage<TPrepared>(msg);
        if (!acceptance.handled) {
            return false;
        }

        const retryAtMs = await this.scheduleNotYetInSyncRetryIfRequired(msg);
        if (!this.runningEffectDrain) {
            await this.drainDurableEffectsNow();
        } else if (retryAtMs !== undefined) {
            this.scheduleEffectDrainAt(retryAtMs);
        }
        return true;
    }

    private async commitDispatchPlanWithRetry(
        msg: ALMessage,
        planner: (msg: ALMessage) => ALOutboundDispatchPlan<TPrepared>,
        intent: ALOutboundComputeIntent,
        phase: ALOutboundDispatchPhase,
        options: CommitDispatchOptions<TPrepared> = {},
    ): Promise<ALOutboundComputedDto<TPrepared>> {
        const result = await this.withSenderCommitQueue(
            msg,
            async () => await this.commitDispatchPlanWithRetryNow(
                msg,
                planner,
                intent,
                phase,
                options,
            ),
        );

        if (result.committed && !options.deferEffectDrain) {
            await this.finalizeCommittedOutbound();
        }

        return result.computed;
    }

    private async commitDispatchPlanWithRetryNow(
        msg: ALMessage,
        planner: (msg: ALMessage) => ALOutboundDispatchPlan<TPrepared>,
        intent: ALOutboundComputeIntent,
        phase: ALOutboundDispatchPhase,
        options: CommitDispatchOptions<TPrepared>,
    ): Promise<ALOutboundCommitResult<TPrepared>> {
        const dependencies = this.toComputeDependencies();

        try {
            return await tryWithPolicy<ALOutboundCommitResult<TPrepared>>(
                async () => {
                    if (this.disposed) {
                        return {
                            computed: ALOutboundMessageRuntime.toDisposedComputed(),
                            committed: false,
                        };
                    }

                    const read = await this.admissionStore.readOutgoingMessage(msg, planner);
                    if (this.disposed) {
                        return {
                            computed: ALOutboundMessageRuntime.toDisposedComputed(),
                            committed: false,
                        };
                    }

                    const computed = ALOutboundMessageRuntime.computeDispatch(
                        read,
                        dependencies,
                        intent,
                        phase,
                        options,
                    );

                    if (!computed.bundle) {
                        return {
                            computed,
                            committed: false,
                        };
                    }
                    if (this.disposed) {
                        return {
                            computed: ALOutboundMessageRuntime.toDisposedComputed(),
                            committed: false,
                        };
                    }

                    const status = await this.admissionStore.commitBundle(
                        this.toRuntimeClockedBundle(computed.bundle),
                    );
                    if (status === 'conflict') {
                        throw new RetryableConflictError('Outbound commit conflict');
                    }

                    return {
                        computed,
                        committed: true,
                    };
                },
                ALOutboundMessageRuntime.COMMIT_RETRY_POLICY,
            );
        } catch (error) {
            throw new Error(
                `Failed to commit outbound message after retries: ${msg.id.msgId}`,
                { cause: error },
            );
        }
    }

    static computeDispatch<TPrepared>(
        read: ALOutboundMessageReadDto<TPrepared>,
        dependencies: ALOutboundComputeDependencies,
        intent: ALOutboundComputeIntent,
        phase: ALOutboundDispatchPhase,
        options: CommitDispatchOptions<TPrepared> = {},
    ): ALOutboundComputedDto<TPrepared> {
        const plan = read.plan;
        if (plan.dropReason) {
            if (!plan?.dropReason?.includes('Skipping')) {
                console.warn(`Skipping outbound dispatch: ${plan.dropReason}`);
            }

            return {
                status: ALOutboundMessageRuntime.toEnqueueStatusFromReason(
                    plan.dropReason,
                ),
                reason: plan.dropReason,
                entries: [],
            };
        }

        if (intent === 'enqueue' && read.sentSnapshot) {
            const entry = read.sentSnapshot.outboxKey
                ? {
                    ...dependencies.toOutboxEntry(read.msg),
                    key: read.sentSnapshot.outboxKey,
                }
                : undefined;
            return {
                status: 'duplicate',
                reason: `Duplicate outbound message ${read.msg.id.msgId}`,
                entries: entry ? [entry] : [],
            };
        }

        const superseded = read.supersedenceAcceptance?.observation.status === 'superseded';
        if (superseded) {
            console.warn(`Skipping superseded outbound message ${read.msg.id.msgId}`);
            return {
                status: 'superseded',
                reason: `Skipping superseded outbound message ${read.msg.id.msgId}`,
                entries: [],
            };
        }

        const shouldDispatchPrepared = intent === 'enqueue'
            ? plan.preparedMessages.length > 0 && !plan.persist
            : plan.preparedMessages.length > 0;
        const shouldFallback = !shouldDispatchPrepared
            && intent !== 'enqueue'
            && dependencies.canFallback;
        const shouldEnqueueOutbox = (intent === 'enqueue' || (intent === 'repair' && plan.persist)) && !shouldDispatchPrepared;
        const entries: ResourceEntry[] = [];
        const mutations: ALOutboundAdmissionMutation[] = [
            {
                kind: 'set-msg-owner',
                msgId: read.msg.id.msgId,
                senderId: read.msg.id.senderId,
                expireAtTimestamp: resolveExplicitOutboundMessageExpireAtMs(read.msg),
            },
        ];
        const durableEffects: ALOutboundDurableEffectWrite<TPrepared>[] = [];

        const extraMutations = options.extraMutations?.(read) ?? [];
        if (extraMutations === 'skip') {
            return {
                status: 'skipped',
                reason: `Skipped outbound dispatch for message ${read.msg.id.msgId}`,
                entries: [],
            };
        }
        mutations.push(...extraMutations);

        this.appendSupersedenceMutations(mutations, read);

        if (shouldEnqueueOutbox) {
            const entry = this.toPersistedOutboxEntry(read, dependencies);
            entries.push(entry);
            mutations.push(
                this.toSentMessageMutation(
                    read.msg,
                    {
                        outboxKey: entry.key,
                        supersedenceKey: plan.supersedenceTracking?.key,
                    },
                ),
            );
            durableEffects.push({
                effectId: this.toEffectId('outbox', read.msg.id.msgId),
                expireAtTimestamp: resolveExplicitOutboundMessageExpireAtMs(read.msg),
                payload: {
                    kind: 'enqueue-outbox',
                    msg: read.msg,
                    entry,
                    replaceExisting: options.replaceExistingOutbox === true ||
                        (plan.supersedenceTracking?.enabled === true && plan.supersedenceTracking.key !== undefined),
                },
            });
        }

        if (shouldDispatchPrepared || shouldFallback) {
            mutations.push(this.toSentMessageMutation(read.msg));
            this.appendAckTrackingMutationsAndEffects(mutations, durableEffects, read);
        }

        if (shouldDispatchPrepared) {
            plan.preparedMessages.forEach((prepared, index) => {
                durableEffects.push({
                    effectId: this.toEffectId('send', read.msg.id.msgId, phase, index),
                    expireAtTimestamp: resolveExplicitOutboundMessageExpireAtMs(read.msg),
                    payload: {
                        kind: 'send-prepared',
                        msg: read.msg,
                        prepared,
                        phase,
                    },
                });
            });
        } else if (shouldFallback) {
            durableEffects.push({
                effectId: this.toEffectId('fallback', read.msg.id.msgId, phase),
                expireAtTimestamp: resolveExplicitOutboundMessageExpireAtMs(read.msg),
                payload: {
                    kind: 'fallback-dispatch',
                    msg: read.msg,
                    entry: options.fallbackEntry ?? dependencies.toOutboxEntry(read.msg),
                },
            });
        } else if (!shouldEnqueueOutbox) {
            console.warn(`No outbound transport route for message ${read.msg.id.msgId}`);
        }

        const status: ALOutboundEnqueueStatus = shouldEnqueueOutbox
            ? 'enqueued'
            : shouldDispatchPrepared
                ? 'sent-immediate'
                : shouldFallback
                    ? 'sent-immediate'
                    : 'no-route';
        const reason = status === 'no-route'
            ? `No outbound transport route for message ${read.msg.id.msgId}`
            : undefined;

        if (mutations.length === 0 && durableEffects.length === 0) {
            return {
                status,
                reason,
                entries,
            };
        }

        return {
            status,
            reason,
            entries,
            bundle: {
                senderId: read.msg.id.senderId,
                expectedVersion: read.clientRecord?.version,
                mutations,
                durableEffects,
            },
        };
    }

    private static toDisposedEnqueueResult(msg: ALMessage): ALOutboundEnqueueResult {
        return {
            status: 'skipped',
            message: msg,
            entries: [],
            reason: 'Outbound runtime is disposed.',
        };
    }

    private static toDisposedComputed<TPrepared>(): ALOutboundComputedDto<TPrepared> {
        return {
            status: 'skipped',
            entries: [],
            reason: 'Outbound runtime is disposed.',
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
        bundle: ALOutboundCommitBundle<TPrepared>,
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
            ),
        };
    }

    private async drainDurableEffectsNow(): Promise<void> {
        await this.startEffectDrain();
    }

    private requestEffectDrain(): void {
        if (this.disposed) {
            return;
        }

        void this.startEffectDrain().catch(error => {
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
                .catch(error => {
                    console.error('Outbound durable effect drain failed', error);
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
        let claimedCount = 0;
        let completedCount = 0;
        let rescheduledCount = 0;
        let skippedExpiredCount = 0;
        const messagesById = new Map<
            string,
            ALOutboundRuntimeMessageDiagnostics
        >();
        try {
            while (true) {
                if (this.disposed) {
                    break;
                }

                const claimed = await this.admissionStore.claimReadyEffects<TPrepared>(
                    this.effectWorkerId,
                    ALOutboundMessageRuntime.MAX_EFFECT_BATCH,
                    ALOutboundMessageRuntime.EFFECT_LEASE_MS,
                    this.readNowMs(),
                );
                if (claimed.length === 0) {
                    break;
                }
                claimedCount += claimed.length;
                let rescheduledInBatch = false;
                const settlements: ALOutboundEffectSettlement[] = [];

                for (const effect of claimed) {
                    if (this.disposed) {
                        break;
                    }

                    if (this.input.diagnostics) {
                        const message = this.toEffectMessageDiagnostics(effect);
                        const existing = messagesById.get(message.msgId);
                        messagesById.set(
                            message.msgId,
                            existing
                                ? { ...message, ...existing }
                                : message,
                        );
                    }

                    try {
                        if (effect.expireAtTimestamp <= this.readNowMs()) {
                            skippedExpiredCount += 1;
                        }
                        const runResult = await this.runDurableEffect(effect);
                        if (runResult.status === 'reschedule') {
                            settlements.push({
                                effectId: effect.effectId,
                                status: 'rescheduled',
                                retryAtMs: runResult.readyAtMs,
                                lastError: runResult.reason,
                            });
                            rescheduledInBatch = true;
                            continue;
                        }

                        settlements.push({
                            effectId: effect.effectId,
                            status: 'completed',
                        });
                    } catch (error) {
                        if (this.disposed) {
                            break;
                        }

                        settlements.push({
                            effectId: effect.effectId,
                            status: 'rescheduled',
                            retryAtMs: this.readNowMs() +
                                this.toEffectRetryDelayMs(effect.attempts),
                            lastError: ALOutboundMessageRuntime.toErrorMessage(error),
                        });
                        rescheduledInBatch = true;
                    }
                }

                const settled = await this.settleClaimedEffectBatch(
                    claimed,
                    settlements,
                );
                rescheduledInBatch ||= settled.some(
                    settlement => settlement.status === 'rescheduled',
                );
                completedCount += settled.filter(
                    settlement => settlement.status === 'completed',
                ).length;
                rescheduledCount += settled.filter(
                    settlement => settlement.status === 'rescheduled',
                ).length;

                if (rescheduledInBatch) {
                    break;
                }
            }

            if (this.disposed) {
                return;
            }

            const nextReadyAt = await this.admissionStore.peekNextEffectReadyAt(this.readNowMs());
            if (nextReadyAt !== undefined) {
                this.scheduleEffectDrainAt(nextReadyAt);
            }
        } finally {
            this.runningEffectDrain = false;
            this.emitDiagnostics({
                kind: 'effect-drain',
                workerId: this.effectWorkerId,
                durationMs: this.elapsedSince(startedAtMs),
                claimedCount,
                completedCount,
                rescheduledCount,
                skippedExpiredCount,
                messages: [...messagesById.values()],
            });
        }
    }

    private async settleClaimedEffectBatch(
        claimed: readonly ALPersistedOutboundEffect<TPrepared>[],
        settlements: readonly ALOutboundEffectSettlement[],
    ): Promise<readonly ALOutboundEffectSettlement[]> {
        const settleClaimedEffects = this.admissionStore.settleClaimedEffects?.bind(
            this.admissionStore,
        );
        if (!settleClaimedEffects) {
            for (const settlement of settlements) {
                if (settlement.status === 'completed') {
                    await this.admissionStore.completeEffect(
                        settlement.effectId,
                        this.effectWorkerId,
                    );
                    continue;
                }
                await this.admissionStore.rescheduleEffect(
                    settlement.effectId,
                    this.effectWorkerId,
                    settlement.retryAtMs,
                    settlement.lastError,
                );
            }
            return settlements;
        }

        try {
            await settleClaimedEffects(
                this.effectWorkerId,
                settlements,
            );
            return settlements;
        } catch (error) {
            if (this.disposed) {
                return [];
            }

            const claimedById = new Map(claimed.map(effect => [effect.effectId, effect]));
            const reason = ALOutboundMessageRuntime.toErrorMessage(error);
            const retries = settlements.map((settlement): ALOutboundEffectSettlement => {
                if (settlement.status === 'rescheduled') {
                    return settlement;
                }

                const attempts = claimedById.get(settlement.effectId)?.attempts ?? 0;
                return {
                    effectId: settlement.effectId,
                    status: 'rescheduled',
                    retryAtMs: this.readNowMs() + this.toEffectRetryDelayMs(attempts),
                    lastError: reason,
                };
            });
            await settleClaimedEffects(
                this.effectWorkerId,
                retries,
            );
            return retries;
        }
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
        effect: ALPersistedOutboundEffect<TPrepared>,
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
                        reason: sendResult.reason ?? 'Prepared outbound transport is not ready.',
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
                    effect.payload.request,
                );
                return { status: 'completed' };
            case 'nack-retry':
                await this.retransmitByMsgId(effect.payload.msgId, {
                    replaceExistingOutbox: true,
                });
                return { status: 'completed' };
        }
    }

    private async scheduleNotYetInSyncRetryIfRequired(
        controlMessage: ALMessage,
    ): Promise<number | undefined> {
        const parsed = parseALControlMessage(controlMessage);
        if (parsed?.type !== 'nack' || parsed.payload.reason !== 'not-yet-in-sync') {
            return undefined;
        }

        const msgId = parsed.payload.msgId;

        try {
            return await tryWithPolicy<number | undefined>(
                async () => {
                    const read = await this.admissionStore.readRepairMessage(
                        msgId,
                        this.input.planOutgoingMessage,
                    );
                    const msg = read.sentSnapshot?.msg;
                    const retry = read.plan?.retryTracking;
                    if (!msg || !retry?.enabled || retry.maxAttempts <= 0) {
                        return undefined;
                    }

                    const retryAttempt = read.nacks
                        .filter(nack => nack.reason === 'not-yet-in-sync')
                        .length;
                    if (retryAttempt > retry.maxAttempts) {
                        console.warn(
                            `Not-yet-in-sync retry budget exceeded for message ${msgId}`,
                        );
                        return undefined;
                    }

                    const retryDelayMs = Math.max(
                        0,
                        retry.retryDelayMs ??
                        ALOutboundMessageRuntime.NOT_YET_IN_SYNC_RETRY_DELAY_MS,
                    );
                    const retryAtMs = read.nowMs + retryDelayMs;
                    const status = await this.admissionStore.commitBundle<TPrepared>({
                        senderId: msg.id.senderId,
                        expectedVersion: read.clientRecord?.version,
                        mutations: [],
                        durableEffects: [
                            {
                                effectId: ALOutboundMessageRuntime.toEffectId(
                                    'nack-retry',
                                    msgId,
                                    'not-yet-in-sync',
                                ),
                                retryAtMs,
                                expireAtTimestamp: resolveExplicitOutboundMessageExpireAtMs(msg),
                                payload: {
                                    kind: 'nack-retry',
                                    msgId,
                                    reason: 'not-yet-in-sync',
                                },
                            },
                        ],
                    });

                    if (status === 'conflict') {
                        throw new RetryableConflictError(
                            'Outbound not-yet-in-sync retry commit conflict',
                        );
                    }

                    return retryAtMs;
                },
                ALOutboundMessageRuntime.COMMIT_RETRY_POLICY,
            );
        } catch (error) {
            throw new Error(
                `Failed to schedule not-yet-in-sync retry for message ${msgId}`,
                { cause: error },
            );
        }
    }

    private async handlePendingAckTimeout(msgId: string): Promise<void> {
        try {
            await tryWithPolicy(
                async () => {
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

                    const failedPeerIds = pending.expectedPeerIds.filter(peerId => !pending.ackedPeerIds.includes(peerId));
                    const nextPending: ALOutboundPendingAckSnapshot = {
                        ...pending,
                        attempts: pending.attempts + 1,
                        deadlineAtMs: Date.now() + pending.timeoutMs,
                    };
                    const bundle: ALOutboundCommitBundle<TPrepared> = {
                        senderId: msg.id.senderId,
                        expectedVersion: read.clientRecord?.version,
                        mutations: [
                            {
                                kind: 'set-pending-ack',
                                snapshot: nextPending,
                            },
                        ],
                        durableEffects: [
                            this.toAckTimeoutEffect(nextPending),
                            {
                                effectId: ALOutboundMessageRuntime.toEffectId(
                                    'repair-hint',
                                    msgId,
                                    'ack-timeout',
                                    nextPending.attempts,
                                    nextPending.deadlineAtMs,
                                ),
                                payload: {
                                    kind: 'repair-hint',
                                    msgId,
                                    request: {
                                        trigger: 'ack-timeout',
                                        failedPeerIds,
                                        missingSeqs: [],
                                    },
                                },
                            },
                        ],
                    };

                    const status = await this.admissionStore.commitBundle(bundle);
                    if (status === 'conflict') {
                        throw new RetryableConflictError(
                            'Outbound ack timeout commit conflict',
                        );
                    }

                    return;
                },
                ALOutboundMessageRuntime.COMMIT_RETRY_POLICY,
            );
            return;
        } catch (error) {
            throw new Error(
                `Failed to commit ack timeout for message ${msgId}`,
                { cause: error },
            );
        }
    }

    private async persistNextAckTimeout(
        msg: ALMessage,
        pending: ALOutboundPendingAckSnapshot,
        expectedVersion?: number,
    ): Promise<void> {
        const status = await this.admissionStore.commitBundle<TPrepared>({
            senderId: msg.id.senderId,
            expectedVersion,
            mutations: [],
            durableEffects: [
                this.toAckTimeoutEffect(pending),
            ],
        });
        if (status === 'conflict') {
            throw new RetryableConflictError(
                'Outbound ack timeout persistence commit conflict',
            );
        }
    }

    private async commitClearPendingAck(
        msg: ALMessage,
        pending: ALOutboundPendingAckSnapshot,
        expectedVersion?: number,
    ): Promise<void> {
        const status = await this.admissionStore.commitBundle<TPrepared>({
            senderId: msg.id.senderId,
            expectedVersion,
            mutations: [
                {
                    kind: 'delete-pending-ack',
                    msgId: pending.msgId,
                },
                {
                    kind: 'delete-repair-attempt',
                    msgId: pending.msgId,
                },
            ],
            durableEffects: [],
        });
        if (status === 'conflict') {
            throw new RetryableConflictError(
                'Outbound pending ack clear commit conflict',
            );
        }
    }

    private async executeRepairFromHint(
        fallbackMsgId: string,
        request: ALOutboundRepairHint,
    ): Promise<void> {
        if (request.orderingTrackKey && request.missingSeqs.length > 0) {
            const sentMessages = await this.admissionStore.getAllSentMessages();
            let retransmitted = false;

            for (const seq of request.missingSeqs) {
                const cached = sentMessages.find(snapshot =>
                    InMemoryALOrderingStore.toTrackKey(snapshot.msg) === request.orderingTrackKey
                    && snapshot.msg.ordering?.seq === seq);
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
        request: ALOutboundRepairHint,
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
                    repair,
                },
            );
            if (!handledPlan || handledPlan.dropReason) {
                if (handledPlan?.dropReason) {
                    console.warn(`Skipping outbound repair dispatch: ${handledPlan.dropReason}`);
                }
                await this.retransmitByMsgId(msgId);
                return;
            }

            const computed = await this.commitDispatchPlanWithRetry(
                msg,
                () => handledPlan,
                'repair',
                'immediate',
                {
                    extraMutations: repairRead => {
                        const currentAttempts = repairRead.repairAttempt?.attempts ?? attempts;
                        if (currentAttempts >= repair.maxAttempts) {
                            return 'skip';
                        }

                        return [
                            {
                                kind: 'set-repair-attempt',
                                snapshot: {
                                    msgId,
                                    attempts: currentAttempts + 1,
                                } satisfies ALOutboundRepairAttemptSnapshot,
                            },
                        ];
                    },
                    deferEffectDrain: true,
                },
            );
            if (computed.bundle === undefined) {
                await this.retransmitByMsgId(msgId);
            }
            return;
        } catch (error) {
            throw new Error(
                `Failed to commit repair for message ${msgId}`,
                { cause: error },
            );
        }
    }

    private async withSenderCommitQueue<T>(
        message: ALMessage,
        task: () => Promise<T>,
    ): Promise<T> {
        const senderId = message.id.senderId;
        const messageDiagnostics = this.toMessageDiagnostics(message);
        const existing = this.commitQueuesBySenderId.get(senderId);
        const previous = existing ?? Promise.resolve();
        const waitStartedAtMs = this.readNowMs();
        let release: (() => void) | undefined;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const tail = previous.catch(() => undefined).then(() => gate);
        this.commitQueuesBySenderId.set(senderId, tail);

        await previous.catch(() => undefined);
        this.emitDiagnostics({
            kind: 'sender-queue-wait',
            senderId,
            message: messageDiagnostics,
            queued: existing !== undefined,
            durationMs: this.elapsedSince(waitStartedAtMs),
        });

        try {
            return await this.withCrossContextCommitLock(
                senderId,
                messageDiagnostics,
                task,
            );
        } finally {
            release?.();
            if (this.commitQueuesBySenderId.get(senderId) === tail) {
                this.commitQueuesBySenderId.delete(senderId);
            }
        }
    }

    private async withCrossContextCommitLock<T>(
        senderId: string,
        message: ALOutboundRuntimeMessageDiagnostics,
        task: () => Promise<T>,
    ): Promise<T> {
        const lockName = `rallar:al-outbound-commit:${senderId}`;
        const locks = this.readBrowserLockManager();
        if (!locks) {
            this.emitDiagnostics({
                kind: 'browser-lock-wait',
                senderId,
                message,
                lockName,
                available: false,
                durationMs: 0,
            });
            const holdStartedAtMs = this.readNowMs();
            try {
                return await task();
            } finally {
                this.emitDiagnostics({
                    kind: 'browser-lock-hold',
                    senderId,
                    message,
                    lockName,
                    available: false,
                    durationMs: this.elapsedSince(holdStartedAtMs),
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
                    message,
                    lockName,
                    available: true,
                    durationMs: this.elapsedSince(waitStartedAtMs),
                });
                const holdStartedAtMs = this.readNowMs();
                try {
                    return await task();
                } finally {
                    this.emitDiagnostics({
                        kind: 'browser-lock-hold',
                        senderId,
                        message,
                        lockName,
                        available: true,
                        durationMs: this.elapsedSince(holdStartedAtMs),
                    });
                }
            },
        );
    }

    private readNowMs(): number {
        return this.input.nowMs?.() ?? Date.now();
    }

    private elapsedSince(startedAtMs: number): number {
        return Math.max(0, this.readNowMs() - startedAtMs);
    }

    private emitDiagnostics(event: ALOutboundRuntimeDiagnosticsEventInput): void {
        try {
            this.input.diagnostics?.({
                ...event,
                runtime: this.input.diagnosticsRuntime,
            } as ALOutboundRuntimeDiagnosticsEvent);
        } catch (error) {
            console.error('AL outbound runtime diagnostics sink failed', error);
        }
    }

    private toMessageDiagnostics(
        message: ALMessage,
    ): ALOutboundRuntimeMessageDiagnostics {
        return {
            msgId: message.id.msgId,
            senderId: message.id.senderId,
            resourceId: message.route.resourceId,
        };
    }

    private toEffectMessageDiagnostics(
        effect: ALPersistedOutboundEffect<TPrepared>,
    ): ALOutboundRuntimeMessageDiagnostics {
        return 'msg' in effect.payload
            ? this.toMessageDiagnostics(effect.payload.msg)
            : { msgId: effect.payload.msgId };
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
        options: Readonly<{
            replaceExistingOutbox?: boolean;
        }> = {},
    ): Promise<void> {
        const sent = await this.admissionStore.getSentMessage(msgId);
        if (!sent) {
            console.warn(`No cached outbound message found for retransmit ${msgId}`);
            return;
        }

        await this.commitDispatchPlanWithRetry(
            sent.msg,
            this.input.planOutgoingMessage,
            'repair',
            'immediate',
            {
                replaceExistingOutbox: options.replaceExistingOutbox,
                deferEffectDrain: true,
            },
        );
    }

    private toComputeDependencies(): ALOutboundComputeDependencies {
        return {
            toOutboxEntry: this.input.toOutboxEntry,
            canFallback: this.input.onFallbackDequeue !== undefined,
        };
    }

    private toEffectRetryDelayMs(attempts: number): number {
        return Math.min(5_000, 25 * Math.pow(2, Math.max(0, attempts)));
    }

    private toAckTimeoutEffect(
        pending: ALOutboundPendingAckSnapshot,
    ): ALOutboundDurableEffectWrite<TPrepared> {
        return {
            effectId: ALOutboundMessageRuntime.toEffectId(
                'ack-timeout',
                pending.msgId,
                pending.attempts + 1,
                pending.deadlineAtMs,
            ),
            retryAtMs: pending.deadlineAtMs,
            expireAtTimestamp: toPendingAckExpireAtTimestamp(pending),
            payload: {
                kind: 'ack-timeout',
                msgId: pending.msgId,
            },
        };
    }

    private isAckComplete(pending: ALOutboundPendingAckSnapshot): boolean {
        return pending.expectedPeerIds.length === 0
            || pending.expectedPeerIds.every(peerId => pending.ackedPeerIds.includes(peerId));
    }

    private static appendSupersedenceMutations<TPrepared>(
        mutations: ALOutboundAdmissionMutation[],
        read: ALOutboundMessageReadDto<TPrepared>,
    ): void {
        const tracking = read.plan.supersedenceTracking;
        if (!tracking?.enabled || !tracking.key || !read.supersedenceAcceptance?.latestWrite) {
            return;
        }

        mutations.push({
            kind: 'set-supersedence-latest',
            supersedenceKey: tracking.key,
            value: read.supersedenceAcceptance.latestWrite,
        });
        for (const replacement of read.supersedenceAcceptance.replacementWrites) {
            mutations.push({
                kind: 'set-supersedence-replacement',
                msgId: replacement.msgId,
                value: replacement.value,
            });
        }
    }

    private static appendAckTrackingMutationsAndEffects<TPrepared>(
        mutations: ALOutboundAdmissionMutation[],
        durableEffects: ALOutboundDurableEffectWrite<TPrepared>[],
        read: ALOutboundMessageReadDto<TPrepared>,
    ): void {
        const tracking = read.plan.ackTracking;
        if (!tracking?.enabled || tracking.expectedPeerIds.length === 0 || tracking.timeoutMs <= 0) {
            return;
        }

        const pending = trackOutboundPendingAckSnapshot(
            read.msg.id.msgId,
            read.pendingAck,
            read.acks,
            tracking,
            read.nowMs,
        );
        if (!pending) {
            if (read.pendingAck) {
                mutations.push({
                    kind: 'delete-pending-ack',
                    msgId: read.msg.id.msgId,
                });
                mutations.push({
                    kind: 'delete-repair-attempt',
                    msgId: read.msg.id.msgId,
                });
            }
            return;
        }

        mutations.push({
            kind: 'set-pending-ack',
            snapshot: pending,
        });
        durableEffects.push({
            effectId: this.toEffectId(
                'ack-timeout',
                pending.msgId,
                pending.attempts + 1,
                pending.deadlineAtMs,
            ),
            retryAtMs: pending.deadlineAtMs,
            expireAtTimestamp: toPendingAckExpireAtTimestamp(pending),
            payload: {
                kind: 'ack-timeout',
                msgId: pending.msgId,
            },
        });
    }

    private static toPersistedOutboxEntry<TPrepared>(
        read: ALOutboundMessageReadDto<TPrepared>,
        dependencies: ALOutboundComputeDependencies,
    ): ResourceEntry {
        const entry = dependencies.toOutboxEntry(read.msg);
        const tracking = read.plan.supersedenceTracking;
        if (!tracking?.enabled || !tracking.key || !read.priorOutboxKey) {
            return entry;
        }

        return {
            ...entry,
            key: read.priorOutboxKey,
        };
    }

    private static toSentMessageMutation(
        msg: ALMessage,
        metadata: Readonly<{
            outboxKey?: Key;
            supersedenceKey?: string;
        }> = {},
    ): ALOutboundAdmissionMutation {
        return {
            kind: 'set-sent-message',
            snapshot: {
                msgId: msg.id.msgId,
                msg,
                outboxKey: metadata.outboxKey,
                supersedenceKey: metadata.supersedenceKey,
            } satisfies ALOutboundSentMessageSnapshot,
            expireAtTimestamp: resolveExplicitOutboundMessageExpireAtMs(msg),
        };
    }

    private static toEffectId(...parts: readonly (number | string)[]): string {
        return parts.map(part => encodeURIComponent(String(part))).join(':');
    }

    private static toEnqueueStatusFromReason(
        reason: string,
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

    private static toErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }

        return String(error);
    }
}
