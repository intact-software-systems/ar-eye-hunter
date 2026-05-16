import type { ALMessage } from '../al-contracts/al-contract.ts';
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
    repairTracking?: ALOutboundRepairTrackingPlan;
    supersedenceTracking?: ALOutboundSupersedenceTrackingPlan;
}>;

export type ALOutboundMessageRuntimeInput<TPrepared> = Readonly<{
    outbox: QueueBoxResourceEntryRepository;
    toOutboxEntry: (msg: ALMessage) => ResourceEntry;
    readMessageFromEntry: (entry: ResourceEntry) => ALMessage;
    planOutgoingMessage: (msg: ALMessage) => ALOutboundDispatchPlan<TPrepared>;
    sendPreparedMessage: (
        prepared: TPrepared,
        phase: ALOutboundDispatchPhase,
    ) => Promise<void>;
    planRepairMessage?: (
        msg: ALMessage,
        request: ALOutboundRepairRequest,
    ) => Promise<ALOutboundDispatchPlan<TPrepared> | undefined>;
    onFallbackDequeue?: (msg: ALMessage, entry: ResourceEntry) => Promise<void>;
    stores?: ALOutboundRuntimeStores;
}>;

export type ALOutboundRuntimeStores = Readonly<{
    admissionStore?: ALOutboundAdmissionStore;
    supersedenceStore?: unknown;
    stateStore?: ALOutboundRuntimeStateStore;
}>;

export type ALOutboundEnqueueStatus =
    | 'enqueued'
    | 'sent-immediate'
    | 'skipped'
    | 'duplicate'
    | 'superseded'
    | 'expired'
    | 'no-route'
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
    extraMutations?: (
        read: ALOutboundMessageReadDto<TPrepared>,
    ) => readonly ALOutboundAdmissionMutation[] | 'skip' | undefined;
}>;

export class ALOutboundMessageRuntime<TPrepared> {
    private static readonly MAX_COMMIT_ATTEMPTS = 10;
    private static readonly COMMIT_RETRY_INTERVAL_MSECS = 10;
    private static readonly COMMIT_MAX_RETRY_INTERVAL_MSECS = 50;
    private static readonly COMMIT_MAX_ELAPSED_MSECS = 500;
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

        if (!this.bootstrappedEffects) {
            this.bootstrappedEffects = true;
            await this.drainDurableEffectsNow();
        }
    }

    dispose(): void {
        if (this.effectDrainTimer !== undefined) {
            clearTimeout(this.effectDrainTimer);
            this.effectDrainTimer = undefined;
        }
    }

    async enqueueIfAbsent(msg: ALMessage): Promise<ALOutboundEnqueueResult> {
        await this.ready();

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
        await this.ready();

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

        const acceptance = await this.admissionStore.acceptControlMessage<TPrepared>(msg);
        if (!acceptance.handled) {
            return false;
        }

        if (!this.runningEffectDrain) {
            await this.drainDurableEffectsNow();
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
        return await this.withSenderCommitQueue(
            msg.id.senderId,
            async () => await this.commitDispatchPlanWithRetryNow(
                msg,
                planner,
                intent,
                phase,
                options,
            ),
        );
    }

    private async commitDispatchPlanWithRetryNow(
        msg: ALMessage,
        planner: (msg: ALMessage) => ALOutboundDispatchPlan<TPrepared>,
        intent: ALOutboundComputeIntent,
        phase: ALOutboundDispatchPhase,
        options: CommitDispatchOptions<TPrepared>,
    ): Promise<ALOutboundComputedDto<TPrepared>> {
        const dependencies = this.toComputeDependencies();

        try {
            return await tryWithPolicy<ALOutboundComputedDto<TPrepared>>(
                async () => {
                    const read = await this.admissionStore.readOutgoingMessage(msg, planner);
                    const computed = ALOutboundMessageRuntime.computeDispatch(
                        read,
                        dependencies,
                        intent,
                        phase,
                        options,
                    );

                    if (!computed.bundle) {
                        return computed;
                    }

                    const status = await this.admissionStore.commitBundle(computed.bundle);
                    if (status === 'conflict') {
                        throw new RetryableConflictError('Outbound commit conflict');
                    }

                    await this.finalizeCommittedOutbound();
                    return computed;
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
                    replaceExisting: plan.supersedenceTracking?.enabled === true && plan.supersedenceTracking.key !== undefined,
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

    private async finalizeCommittedOutbound(): Promise<void> {
        if (this.runningEffectDrain) {
            return;
        }

        await this.drainDurableEffectsNow();
    }

    private async drainDurableEffectsNow(): Promise<void> {
        await this.startEffectDrain();
    }

    private requestEffectDrain(): void {
        void this.startEffectDrain().catch(error => {
            console.error('Failed to drain outbound durable effects', error);
        });
    }

    private startEffectDrain(): Promise<void> {
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
        try {
            while (true) {
                const claimed = await this.admissionStore.claimReadyEffects<TPrepared>(
                    this.effectWorkerId,
                    ALOutboundMessageRuntime.MAX_EFFECT_BATCH,
                    ALOutboundMessageRuntime.EFFECT_LEASE_MS,
                );
                if (claimed.length === 0) {
                    break;
                }

                for (const effect of claimed) {
                    try {
                        await this.runDurableEffect(effect);
                        await this.admissionStore.completeEffect(effect.effectId, this.effectWorkerId);
                    } catch (error) {
                        await this.admissionStore.rescheduleEffect(
                            effect.effectId,
                            this.effectWorkerId,
                            Date.now() + this.toEffectRetryDelayMs(effect.attempts),
                            ALOutboundMessageRuntime.toErrorMessage(error),
                        );
                    }
                }
            }

            const nextReadyAt = await this.admissionStore.peekNextEffectReadyAt();
            if (nextReadyAt !== undefined) {
                this.scheduleEffectDrainAt(nextReadyAt);
            }
        } finally {
            this.runningEffectDrain = false;
        }
    }

    private scheduleEffectDrainAt(readyAtMs: number): void {
        if (this.effectDrainTimer !== undefined) {
            clearTimeout(this.effectDrainTimer);
        }

        const delayMs = Math.max(0, readyAtMs - Date.now());
        this.effectDrainTimer = setTimeout(() => {
            this.effectDrainTimer = undefined;
            this.requestEffectDrain();
        }, delayMs);
    }

    private async runDurableEffect(
        effect: ALPersistedOutboundEffect<TPrepared>,
    ): Promise<void> {
        if (effect.expireAtTimestamp <= Date.now()) {
            return;
        }

        switch (effect.payload.kind) {
            case 'send-prepared':
                await this.input.sendPreparedMessage(effect.payload.prepared, effect.payload.phase);
                return;
            case 'enqueue-outbox':
                if (effect.payload.replaceExisting) {
                    await this.input.outbox.enqueue(effect.payload.entry);
                    return;
                }

                await this.input.outbox.enqueueIfAbsent(effect.payload.entry);
                return;
            case 'fallback-dispatch':
                if (this.input.onFallbackDequeue) {
                    await this.input.onFallbackDequeue(effect.payload.msg, effect.payload.entry);
                }
                return;
            case 'ack-timeout':
                await this.handlePendingAckTimeout(effect.payload.msgId);
                return;
            case 'repair-hint':
                await this.executeRepairFromHint(
                    effect.payload.msgId,
                    effect.payload.request,
                );
                return;
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
        senderId: string,
        task: () => Promise<T>,
    ): Promise<T> {
        const previous = this.commitQueuesBySenderId.get(senderId) ?? Promise.resolve();
        let release: (() => void) | undefined;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const tail = previous.catch(() => undefined).then(() => gate);
        this.commitQueuesBySenderId.set(senderId, tail);

        await previous.catch(() => undefined);

        try {
            return await task();
        } finally {
            release?.();
            if (this.commitQueuesBySenderId.get(senderId) === tail) {
                this.commitQueuesBySenderId.delete(senderId);
            }
        }
    }

    private async retransmitByMsgId(msgId: string): Promise<void> {
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
