import { ALMessage } from '../al-contracts/al-contract.ts';
import type { ALAckStatus, ALCompletedPendingAck, ALControlAcceptance } from '../al-contracts/al-control.ts';
import {
    isALControlTypeId,
    newALAckControlMessage,
    newALNackControlMessage,
    newALRepairControlMessage
} from '../al-contracts/al-control.ts';
import { ALMessageHandlingPlan, resolveALMessageExpireAtMs } from '../al-contracts/al-policy.ts';
import { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
import { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import { RetryableConflictError, RetryPolicies, tryWithPolicy } from '../resilience/TryWith.ts';
import type {
    ALInboundAdmissionMutation,
    ALInboundAdmissionStore,
    ALInboundBufferedReleaseReadDto,
    ALInboundCommitBundle,
    ALInboundDurableEffectWrite,
    ALInboundMessageReadDto,
    ALInboundPlanner,
    ALPersistedInboundEffect
} from './ALInboundAdmissionStore.ts';
import { ALAdmissionBackendConflictError } from './ALAdmissionBackendConflictError.ts';
import {
    createALInboundAdmissionStore,
    createInMemoryALInboundAdmissionState,
    markPendingAckLocalReadySnapshot,
    trackPendingAckSnapshot
} from './ALInboundAdmissionStore.ts';

export type ALInboundRuntimeStores = Readonly<{
    admissionStore: ALInboundAdmissionStore;
}>;

export type ALInboundMessageRuntimeInput = Readonly<{
    selfPeerId: string;
    inbox: QueueBoxResourceEntryRepository;
    planIncomingMessage: ALInboundPlanner;
    readStoredEntry: (
        entry: ResourceEntry
    ) => Readonly<ALMessage>;
    toInboxEntry: (msg: ALMessage) => ResourceEntry;
    dispatchInboxEntry: (
        entry: ResourceEntry,
        plan?: ALMessageHandlingPlan
    ) => Promise<void>;
    sendControlMessage: (msg: ALMessage) => Promise<void>;
    onControlMessage?: (
        msg: ALMessage,
        acceptance: ALControlAcceptance
    ) => Promise<void>;
    forwardMessage?: (
        msg: ALMessage,
        fromPeerId: string,
        plan: ALMessageHandlingPlan
    ) => Promise<void>;
    /**
     * Per-message forwarding capability, reconciled at admission so a
     * message this transport will not relay never records a forward
     * effect and acks as delivered, not forwarded. Absent means every
     * message `forwardMessage` can carry is forwardable.
     */
    canForwardMessage?: (msg: ALMessage) => boolean;
    stores?: ALInboundRuntimeStores;
}>;

type AdmissionComputeDependencies = Readonly<{
    selfPeerId: string;
    toInboxEntry: (msg: ALMessage) => ResourceEntry;
    canForward: (msg: ALMessage) => boolean;
}>;

export type AdmissionComputedDto = Readonly<{
    bundle: ALInboundCommitBundle;
}>;

type BufferedReleaseOptions = Readonly<{
    drainAfterCommit?: boolean;
}>;

export class ALInboundMessageRuntime {
    private static readonly MAX_COMMIT_ATTEMPTS = 10;
    private static readonly COMMIT_RETRY_INTERVAL_MSECS = 10;
    private static readonly COMMIT_MAX_RETRY_INTERVAL_MSECS = 50;
    private static readonly COMMIT_MAX_ELAPSED_MSECS = 500;
    private static readonly COMMIT_RETRY_POLICY = RetryPolicies
        .optimisticCommit('al-inbound-commit')
        .maxAttempts(ALInboundMessageRuntime.MAX_COMMIT_ATTEMPTS)
        .retryIntervalMsecs(ALInboundMessageRuntime.COMMIT_RETRY_INTERVAL_MSECS)
        .maxRetryIntervalMsecs(
            ALInboundMessageRuntime.COMMIT_MAX_RETRY_INTERVAL_MSECS
        )
        .maxElapsedMsecs(ALInboundMessageRuntime.COMMIT_MAX_ELAPSED_MSECS);
    private static readonly EFFECT_LEASE_MS = 10_000;
    private static readonly MAX_EFFECT_BATCH = 16;

    private readonly admissionStore: ALInboundAdmissionStore;
    private readonly readyPromise: Promise<void>;
    private readonly commitQueuesBySenderId = new Map<string, Promise<void>>();
    private readonly effectWorkerId = `al-inbound:${crypto.randomUUID()}`;
    private effectDrainPromise?: Promise<void>;
    private effectDrainTimer?: ReturnType<typeof setTimeout>;
    private bootstrappedEffects = false;

    private readonly input: ALInboundMessageRuntimeInput;

    constructor(
        input: ALInboundMessageRuntimeInput
    ) {
        this.input = input;
        this.admissionStore = input.stores?.admissionStore ?? createALInboundAdmissionStore({
            kind: 'memory',
            namespace: 'al-inbound-runtime',
            orderingTrackTtlMs: 5 * 60_000,
            supersedenceTrackTtlMs: 5 * 60_000,
            state: createInMemoryALInboundAdmissionState()
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

    async handleIncomingMessage(
        msg: ALMessage,
        fromPeerId: string
    ): Promise<void> {
        await this.ready();

        if (isALControlTypeId(msg.payload.typeId)) {
            const acceptance = await this.acceptControlMessageWithRetry(msg);
            await this.drainDurableEffectsIfIdle();
            await this.input.onControlMessage?.(msg, acceptance);
            return;
        }

        await this.handleIncomingMessageWithAdmission(msg, fromPeerId);
    }

    private async acceptControlMessageWithRetry(
        msg: ALMessage
    ): Promise<ALControlAcceptance> {
        return await tryWithPolicy(
            async () => {
                try {
                    return await this.admissionStore.acceptControlMessage(msg);
                }
                catch (error) {
                    if (error instanceof ALAdmissionBackendConflictError) {
                        throw new RetryableConflictError(
                            'Inbound control-message admission conflict',
                            { cause: error }
                        );
                    }
                    throw error;
                }
            },
            ALInboundMessageRuntime.COMMIT_RETRY_POLICY
        );
    }

    private async handleIncomingMessageWithAdmission(
        msg: ALMessage,
        fromPeerId: string,
        options: BufferedReleaseOptions = {}
    ): Promise<void> {
        await this.withSenderCommitQueue(
            msg.id.senderId,
            async () =>
                await this.handleIncomingMessageWithAdmissionNow(
                    msg,
                    fromPeerId,
                    options
                )
        );
    }

    private async handleIncomingMessageWithAdmissionNow(
        msg: ALMessage,
        fromPeerId: string,
        options: BufferedReleaseOptions
    ): Promise<void> {
        const dependencies = this.toComputeDependencies();

        try {
            await tryWithPolicy(
                async () => {
                    const read = await this.admissionStore.readIncomingMessage(
                        msg,
                        fromPeerId,
                        this.input.planIncomingMessage
                    );
                    const computed = ALInboundMessageRuntime.computeAdmission(read, dependencies);
                    const status = await this.admissionStore.commitBundle(computed.bundle);

                    if (status === 'conflict') {
                        throw new RetryableConflictError('Inbound commit conflict');
                    }

                    await this.finalizeCommittedAdmission(options.drainAfterCommit !== false);
                    return;
                },
                ALInboundMessageRuntime.COMMIT_RETRY_POLICY
            );
            return;
        }
        catch (error) {
            throw new Error(
                `Failed to commit inbound message after retries: ${msg.id.msgId}`,
                { cause: error }
            );
        }
    }

    static computeAdmission(
        read: ALInboundMessageReadDto,
        dependencies: AdmissionComputeDependencies
    ): AdmissionComputedDto {
        const plan = read.plan;
        const mutations: ALInboundAdmissionMutation[] = [];
        const durableEffects: ALInboundDurableEffectWrite[] = [];
        const shouldForward = dependencies.canForward(read.msg) && plan.forwarding.enabled;
        const completedPendingAcks: ALCompletedPendingAck[] = [];

        if (plan.dropReason) {
            this.appendNegativeControlEffects(
                durableEffects,
                dependencies.selfPeerId,
                read.msg,
                plan,
                read.fromPeerId
            );
            return {
                bundle: {
                    senderId: read.msg.id.senderId,
                    expectedVersion: read.clientRecord?.version,
                    mutations: [],
                    durableEffects
                }
            };
        }

        mutations.push({
            kind: 'set-msg-owner',
            msgId: read.msg.id.msgId,
            senderId: read.msg.id.senderId
        });

        if (read.orderingAcceptance.observation.trackKey && read.orderingAcceptance.nextSnapshot) {
            mutations.push({
                kind: 'set-ordering',
                trackKey: read.orderingAcceptance.observation.trackKey,
                snapshot: read.orderingAcceptance.nextSnapshot
            });
        }

        mutations.push({
            kind: 'set-dedup',
            dedupKey: plan.dedupKey,
            expireAtTimestamp: read.nowMs + Math.max(0, plan.effective.dedup.opts.windowMs)
        });

        if (plan.localDelivery.deferred) {
            if (plan.orderingRuntime.trackKey !== undefined && plan.orderingRuntime.seq !== undefined) {
                if (plan.supersedence.enabled && plan.supersedence.key) {
                    for (const buffered of read.bufferedSnapshots) {
                        if (
                            buffered.seq !== plan.orderingRuntime.seq &&
                            buffered.plan.supersedence.key === plan.supersedence.key &&
                            this.isNewerMessage(read.msg, buffered.msg)
                        ) {
                            mutations.push({
                                kind: 'delete-buffered',
                                trackKey: buffered.trackKey,
                                seq: buffered.seq
                            });
                        }
                    }
                }

                mutations.push({
                    kind: 'set-buffered',
                    snapshot: {
                        trackKey: plan.orderingRuntime.trackKey,
                        seq: plan.orderingRuntime.seq,
                        msg: read.msg,
                        plan
                    }
                });
            }

            this.appendNegativeControlEffects(
                durableEffects,
                dependencies.selfPeerId,
                read.msg,
                plan,
                read.fromPeerId
            );
        }
        else {
            this.appendLocalDeliveryEffects(
                durableEffects,
                dependencies.toInboxEntry,
                read.msg,
                plan
            );

            if (read.supersedenceAcceptance?.latestWrite && plan.supersedence.key) {
                mutations.push({
                    kind: 'set-supersedence-latest',
                    supersedenceKey: plan.supersedence.key,
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
        }

        // The plan defers subtree acks on the assumption it will forward; a
        // runtime that will not forward this message has no subtree to wait
        // for and must ack immediately instead of never.
        const ackDeferred = plan.ack.deferred && shouldForward;
        if (shouldForward && plan.ack.enabled && ackDeferred && plan.ack.toPeerId) {
            const transition = trackPendingAckSnapshot(
                read.msg.id.msgId,
                read.pendingAck,
                read.acks,
                plan.ack.toPeerId,
                plan.forwarding.nextHopPeerIds,
                !plan.localDelivery.deferred,
                this.toMessageEffectExpireAtTimestamp(read.msg, plan)
            );
            if (transition.pending) {
                mutations.push({
                    kind: 'set-control-pending',
                    msgId: read.msg.id.msgId,
                    value: {
                        kind: 'pending',
                        value: transition.pending
                    }
                });
            }
            else if (read.pendingAck) {
                mutations.push({
                    kind: 'delete-control-pending',
                    msgId: read.msg.id.msgId
                });
            }

            if (transition.completed) {
                completedPendingAcks.push(transition.completed);
            }
        }

        if (plan.ack.enabled && plan.ack.toPeerId && !ackDeferred) {
            durableEffects.push(
                this.toAckEffect(
                    dependencies.selfPeerId,
                    plan.ack.toPeerId,
                    read.msg.id.msgId,
                    shouldForward ? 'forwarded' : 'delivered',
                    this.toMessageEffectExpireAtTimestamp(read.msg, plan)
                )
            );
        }

        if (shouldForward) {
            durableEffects.push({
                effectId: this.toEffectId('forward', read.msg.id.msgId, read.fromPeerId),
                expireAtTimestamp: this.toMessageEffectExpireAtTimestamp(read.msg, plan),
                payload: {
                    kind: 'forward-message',
                    msg: read.msg,
                    fromPeerId: read.fromPeerId,
                    plan
                }
            });
        }
        else if (!plan.localDelivery.deferred && !plan.nack.enabled) {
            this.appendRepairEffect(
                durableEffects,
                dependencies.selfPeerId,
                read.msg,
                plan,
                read.fromPeerId
            );
        }

        this.appendCompletedPendingAckEffects(
            durableEffects,
            dependencies.selfPeerId,
            completedPendingAcks,
            this.toMessageEffectExpireAtTimestamp(read.msg, plan)
        );

        if (!plan.localDelivery.deferred && read.orderingAcceptance.observation.trackKey) {
            for (const seq of read.orderingAcceptance.observation.releasableSeqs) {
                durableEffects.push({
                    effectId: this.toEffectId('release', read.orderingAcceptance.observation.trackKey, seq),
                    payload: {
                        kind: 'release-buffered',
                        trackKey: read.orderingAcceptance.observation.trackKey,
                        seq
                    }
                });
            }
        }

        return {
            bundle: {
                senderId: read.msg.id.senderId,
                expectedVersion: read.clientRecord?.version,
                mutations,
                durableEffects
            }
        };
    }

    private async finalizeCommittedAdmission(
        drainAfterCommit: boolean
    ): Promise<void> {
        if (drainAfterCommit) {
            await this.drainDurableEffectsNow();
        }
        else {
            this.requestEffectDrain();
        }
    }

    private async releaseBufferedMessageWithAdmission(
        trackKey: string,
        seq: number,
        options: BufferedReleaseOptions = {}
    ): Promise<void> {
        const dependencies = this.toComputeDependencies();

        try {
            await tryWithPolicy(
                async () => {
                    const read = await this.admissionStore.readBufferedRelease(trackKey, seq);
                    if (!read) {
                        return;
                    }

                    const computed = ALInboundMessageRuntime.computeBufferedRelease(read, dependencies);
                    const status = await this.admissionStore.commitBundle(computed.bundle);

                    if (status === 'conflict') {
                        throw new RetryableConflictError(
                            'Buffered inbound release commit conflict'
                        );
                    }

                    await this.finalizeCommittedAdmission(options.drainAfterCommit !== false);
                    return;
                },
                ALInboundMessageRuntime.COMMIT_RETRY_POLICY
            );
            return;
        }
        catch (error) {
            throw new Error(
                `Failed to release buffered inbound message after retries: ${trackKey}:${seq}`,
                { cause: error }
            );
        }
    }

    private async withSenderCommitQueue<T>(
        senderId: string,
        task: () => Promise<T>
    ): Promise<T> {
        const previous = this.commitQueuesBySenderId.get(senderId) ?? Promise.resolve();
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.catch(() => undefined).then(() => gate);
        this.commitQueuesBySenderId.set(senderId, tail);

        await previous.catch(() => undefined);

        try {
            return await task();
        }
        finally {
            release?.();
            if (this.commitQueuesBySenderId.get(senderId) === tail) {
                this.commitQueuesBySenderId.delete(senderId);
            }
        }
    }

    static computeBufferedRelease(
        read: ALInboundBufferedReleaseReadDto,
        dependencies: AdmissionComputeDependencies
    ): AdmissionComputedDto {
        const plan = {
            ...read.snapshot.plan,
            localDelivery: {
                ...read.snapshot.plan.localDelivery,
                enabled: true,
                deferred: false
            }
        } satisfies ALMessageHandlingPlan;
        const superseded = read.supersedenceAcceptance?.observation.status === 'superseded';
        const mutations: ALInboundAdmissionMutation[] = [
            {
                kind: 'set-msg-owner',
                msgId: read.snapshot.msg.id.msgId,
                senderId: read.snapshot.msg.id.senderId
            },
            {
                kind: 'delete-buffered',
                trackKey: read.snapshot.trackKey,
                seq: read.snapshot.seq
            }
        ];
        const durableEffects: ALInboundDurableEffectWrite[] = [];
        const completedPendingAcks: ALCompletedPendingAck[] = [];

        if (!superseded && read.supersedenceAcceptance?.latestWrite && plan.supersedence.key) {
            mutations.push({
                kind: 'set-supersedence-latest',
                supersedenceKey: plan.supersedence.key,
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

        if (!superseded && plan.ack.enabled && plan.ack.deferred && plan.ack.toPeerId) {
            const transition = markPendingAckLocalReadySnapshot(
                read.snapshot.msg.id.msgId,
                read.pendingAck,
                read.acks
            );
            if (transition.pending) {
                mutations.push({
                    kind: 'set-control-pending',
                    msgId: read.snapshot.msg.id.msgId,
                    value: {
                        kind: 'pending',
                        value: transition.pending
                    }
                });
            }
            else if (read.pendingAck) {
                mutations.push({
                    kind: 'delete-control-pending',
                    msgId: read.snapshot.msg.id.msgId
                });
            }

            if (transition.completed) {
                completedPendingAcks.push(transition.completed);
            }
        }

        if (!superseded) {
            this.appendLocalDeliveryEffects(
                durableEffects,
                dependencies.toInboxEntry,
                read.snapshot.msg,
                plan
            );
        }

        if (!superseded && plan.ack.enabled && plan.ack.toPeerId && !plan.ack.deferred) {
            durableEffects.push(
                this.toAckEffect(
                    dependencies.selfPeerId,
                    plan.ack.toPeerId,
                    read.snapshot.msg.id.msgId,
                    'delivered',
                    this.toMessageEffectExpireAtTimestamp(read.snapshot.msg, plan)
                )
            );
        }

        this.appendCompletedPendingAckEffects(
            durableEffects,
            dependencies.selfPeerId,
            completedPendingAcks,
            this.toMessageEffectExpireAtTimestamp(read.snapshot.msg, plan)
        );

        return {
            bundle: {
                senderId: read.snapshot.msg.id.senderId,
                expectedVersion: read.clientRecord?.version,
                mutations,
                durableEffects
            }
        };
    }

    async dispatchStoredEntry(entry: ResourceEntry): Promise<'completed' | 'retry'> {
        await this.ready();

        const msg = this.input.readStoredEntry(entry);
        const plan = await this.admissionStore.planStoredEntry(
            msg,
            this.input.planIncomingMessage
        );

        if (plan.dropReason) {
            return plan.congestion.overloaded ? 'retry' : 'completed';
        }

        if (!plan.localDelivery.enabled) {
            return 'completed';
        }

        if (ALInboundMessageRuntime.shouldDeferLocalDelivery(plan)) {
            return 'retry';
        }

        await this.input.dispatchInboxEntry(entry, plan);
        return 'completed';
    }

    private async drainDurableEffectsNow(): Promise<void> {
        await this.startEffectDrain();
    }

    private async drainDurableEffectsIfIdle(): Promise<void> {
        if (this.effectDrainPromise) {
            return;
        }

        await this.startEffectDrain();
    }

    private requestEffectDrain(): void {
        void this.startEffectDrain().catch((error) => {
            console.error('Failed to drain inbound durable effects', error);
        });
    }

    private startEffectDrain(): Promise<void> {
        if (!this.effectDrainPromise) {
            if (this.effectDrainTimer !== undefined) {
                clearTimeout(this.effectDrainTimer);
                this.effectDrainTimer = undefined;
            }

            this.effectDrainPromise = this.runDurableEffectDrainLoop()
                .catch((error) => {
                    console.error('Inbound durable effect drain failed', error);
                })
                .finally(() => {
                    this.effectDrainPromise = undefined;
                });
        }

        return this.effectDrainPromise;
    }

    private async runDurableEffectDrainLoop(): Promise<void> {
        while (true) {
            const claimed = await this.admissionStore.claimReadyEffects(
                this.effectWorkerId,
                ALInboundMessageRuntime.MAX_EFFECT_BATCH,
                ALInboundMessageRuntime.EFFECT_LEASE_MS
            );
            if (claimed.length === 0) {
                break;
            }

            for (const effect of claimed) {
                try {
                    await this.runDurableEffect(effect);
                    await this.admissionStore.completeEffect(effect.effectId, this.effectWorkerId);
                }
                catch (error) {
                    await this.admissionStore.rescheduleEffect(
                        effect.effectId,
                        this.effectWorkerId,
                        Date.now() + this.toEffectRetryDelayMs(effect.attempts),
                        ALInboundMessageRuntime.toErrorMessage(error)
                    );
                }
            }
        }

        const nextReadyAt = await this.admissionStore.peekNextEffectReadyAt();
        if (nextReadyAt !== undefined) {
            this.scheduleEffectDrainAt(nextReadyAt);
        }
    }

    private scheduleEffectDrainAt(
        readyAtMs: number
    ): void {
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
        effect: ALPersistedInboundEffect
    ): Promise<void> {
        if (effect.expireAtTimestamp <= Date.now()) {
            return;
        }

        switch (effect.payload.kind) {
            case 'dispatch-local':
                await this.input.dispatchInboxEntry(effect.payload.entry, effect.payload.plan);
                return;
            case 'enqueue-inbox':
                await this.input.inbox.enqueueIfAbsent(effect.payload.entry);
                return;
            case 'send-control':
                await this.input.sendControlMessage(effect.payload.msg);
                return;
            case 'forward-message':
                if (!this.input.forwardMessage) {
                    return;
                }

                await this.input.forwardMessage(
                    effect.payload.msg,
                    effect.payload.fromPeerId,
                    effect.payload.plan
                );
                return;
            case 'release-buffered':
                await this.releaseBufferedMessageWithAdmission(
                    effect.payload.trackKey,
                    effect.payload.seq,
                    {
                        drainAfterCommit: false
                    }
                );
                return;
        }
    }

    private toComputeDependencies(): AdmissionComputeDependencies {
        return {
            selfPeerId: this.input.selfPeerId,
            toInboxEntry: this.input.toInboxEntry,
            canForward: (msg) =>
                this.input.forwardMessage !== undefined &&
                (this.input.canForwardMessage?.(msg) ?? true)
        };
    }

    private toEffectRetryDelayMs(
        attempts: number
    ): number {
        return Math.min(5_000, 25 * Math.pow(2, Math.max(0, attempts)));
    }

    private static appendLocalDeliveryEffects(
        durableEffects: ALInboundDurableEffectWrite[],
        toInboxEntry: (msg: ALMessage) => ResourceEntry,
        msg: ALMessage,
        plan: ALMessageHandlingPlan
    ): void {
        if (!plan.localDelivery.enabled) {
            return;
        }

        const entry = toInboxEntry(msg);
        const expireAtTimestamp = this.toMessageEffectExpireAtTimestamp(msg, plan);
        if (this.shouldDeferLocalDelivery(plan) || plan.localDelivery.persist) {
            durableEffects.push({
                effectId: this.toEffectId('inbox', msg.id.msgId),
                expireAtTimestamp,
                payload: {
                    kind: 'enqueue-inbox',
                    msg,
                    entry,
                    plan
                }
            });
            return;
        }

        durableEffects.push({
            effectId: this.toEffectId('dispatch', msg.id.msgId),
            expireAtTimestamp,
            payload: {
                kind: 'dispatch-local',
                msg,
                entry,
                plan
            }
        });
    }

    private static appendNegativeControlEffects(
        durableEffects: ALInboundDurableEffectWrite[],
        selfPeerId: string,
        msg: ALMessage,
        plan: ALMessageHandlingPlan,
        fromPeerId: string
    ): void {
        if (!plan.nack.enabled) {
            return;
        }

        const toPeerId = plan.nack.toPeerId ?? fromPeerId;
        const expireAtTimestamp = this.toMessageEffectExpireAtTimestamp(msg, plan);
        durableEffects.push({
            effectId: this.toEffectId(
                'nack',
                msg.id.msgId,
                toPeerId,
                this.toNackReason(plan.nack.reason)
            ),
            expireAtTimestamp,
            payload: {
                kind: 'send-control',
                msg: newALNackControlMessage(
                    selfPeerId,
                    toPeerId,
                    msg.id.msgId,
                    this.toNackReason(plan.nack.reason),
                    plan.orderingRuntime
                )
            }
        });

        this.appendRepairEffect(durableEffects, selfPeerId, msg, plan, fromPeerId);
    }

    private static appendRepairEffect(
        durableEffects: ALInboundDurableEffectWrite[],
        selfPeerId: string,
        msg: ALMessage,
        plan: ALMessageHandlingPlan,
        fromPeerId: string
    ): void {
        if (!plan.repair.enabled && plan.orderingRuntime.status !== 'gap') {
            return;
        }

        const toPeerId = plan.nack.toPeerId ?? fromPeerId;
        const expireAtTimestamp = this.toMessageEffectExpireAtTimestamp(msg, plan);
        durableEffects.push({
            effectId: this.toEffectId(
                'repair',
                msg.id.msgId,
                toPeerId,
                plan.orderingRuntime.trackKey ?? '-',
                plan.orderingRuntime.seq ?? '-',
                plan.orderingRuntime.expectedSeq ?? '-',
                plan.orderingRuntime.missingSeqs.join(',')
            ),
            expireAtTimestamp,
            payload: {
                kind: 'send-control',
                msg: newALRepairControlMessage(
                    selfPeerId,
                    toPeerId,
                    msg.id.msgId,
                    plan.orderingRuntime.status === 'gap' ? 'missing-seq' : 'retransmit',
                    plan.orderingRuntime
                )
            }
        });
    }

    private static appendCompletedPendingAckEffects(
        durableEffects: ALInboundDurableEffectWrite[],
        selfPeerId: string,
        completedPendingAcks: readonly ALCompletedPendingAck[],
        expireAtTimestamp?: number
    ): void {
        for (const completed of completedPendingAcks) {
            durableEffects.push(
                this.toAckEffect(
                    selfPeerId,
                    completed.toPeerId,
                    completed.msgId,
                    completed.status,
                    completed.expireAtTimestamp ?? expireAtTimestamp
                )
            );
        }
    }

    private static toAckEffect(
        selfPeerId: string,
        toPeerId: string,
        ackedMsgId: string,
        status: ALAckStatus,
        expireAtTimestamp?: number
    ): ALInboundDurableEffectWrite {
        return {
            effectId: this.toEffectId('ack', ackedMsgId, toPeerId, status),
            expireAtTimestamp,
            payload: {
                kind: 'send-control',
                msg: newALAckControlMessage(
                    selfPeerId,
                    toPeerId,
                    ackedMsgId,
                    status
                )
            }
        };
    }

    private static toEffectId(
        ...parts: readonly (number | string)[]
    ): string {
        return parts.map((part) => encodeURIComponent(String(part))).join(':');
    }

    private static toMessageEffectExpireAtTimestamp(
        msg: ALMessage,
        plan: ALMessageHandlingPlan
    ): number | undefined {
        return resolveALMessageExpireAtMs(msg, plan.effective);
    }

    static toNackReason(reason?: string) {
        switch (reason) {
            case 'gap':
                return 'gap' as const;
            case 'expired':
                return 'expired' as const;
            case 'overloaded':
                return 'overloaded' as const;
            default:
                return 'stale' as const;
        }
    }

    static shouldDeferLocalDelivery(
        plan: ALMessageHandlingPlan
    ): boolean {
        return plan.localDelivery.enabled &&
            plan.congestion.overloaded &&
            plan.congestion.action === 'defer';
    }

    static isNewerMessage(
        candidate: ALMessage,
        existing: ALMessage
    ): boolean {
        const candidateSeq = candidate.ordering?.seq;
        const existingSeq = existing.ordering?.seq;

        if (candidateSeq !== undefined || existingSeq !== undefined) {
            const seqComparison = (candidateSeq ?? Number.NEGATIVE_INFINITY) -
                (existingSeq ?? Number.NEGATIVE_INFINITY);
            if (seqComparison !== 0) {
                return seqComparison > 0;
            }
        }

        return (candidate.audit?.createdTs ?? candidate.id.ts) > (existing.audit?.createdTs ?? existing.id.ts);
    }

    private static toErrorMessage(
        error: unknown
    ): string {
        if (error instanceof Error) {
            return error.message;
        }

        return String(error);
    }
}
