import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { isALControlTypeId, type ALControlAcceptance } from '../../al-contracts/al-control.ts';
import type { ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '../../al-contracts/al-runtime.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { NOT_COMPLETED_RETRYABLE_STATUSES } from '../../queuebox/ResourceEntry.ts';
import {
    RetryableConflictError,
    RetryPolicies,
    tryWithPolicy
} from '../../resilience/TryWith.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import type {
    ALInboundAdmissionStore,
    ALInboundPlanner,
    ALPersistedInboundEffect
} from './al-inbound-admission-store.ts';
import { shouldDeferALInboundLocalDelivery } from './al-inbound-effect-intent.ts';
import { computeALInboundAdmission, computeALInboundBufferedRelease } from './compute-al-inbound-admission.ts';
import {
    prepareALInboundCommitBundle,
    type ALInboundEffectPreparationDependencies
} from './prepare-al-inbound-commit-bundle.ts';

export interface ALInboundRuntimeStores {
    readonly admissionStore: ALInboundAdmissionStore;
}

export namespace ALInboundMessageRuntime {
    export interface Clock {
        nowMs(): number;
    }

    export interface Scheduler {
        /** Runs the callback once after the delay; the returned operation cancels it before invocation. */
        schedule(callback: () => void, delayMs: number): () => void;
    }

    export interface Resources {
        readonly admissionStore: ALInboundAdmissionStore;
        readonly effectPreparation: ALInboundEffectPreparationDependencies;
        readonly effectWorkerId: string;
        readonly clock: Clock;
        readonly scheduler: Scheduler;
    }

    export interface Dependencies extends Resources {
        readonly inbox: QueueBoxResourceEntryRepository;
        readonly planIncomingMessage: ALInboundPlanner;
        readonly readStoredEntry: (entry: ResourceEntry) => Readonly<ALMessage>;
        readonly dispatchInboxEntry: (entry: ResourceEntry, plan?: ALMessageHandlingPlan) => Promise<void>;
        readonly sendControlMessage: (msg: ALMessage) => Promise<void>;
        readonly onControlMessage?: (msg: ALMessage, acceptance: ALControlAcceptance) => Promise<void>;
        readonly forwardMessage?: (msg: ALMessage, fromPeerId: string, plan: ALMessageHandlingPlan) => Promise<void>;
        /** Absence means the configured transport can forward every message. */
        readonly canForwardMessage?: (msg: ALMessage) => boolean;
    }
}

export class ALInboundMessageRuntime {
    private static readonly COMMIT_RETRY_POLICY = RetryPolicies.optimisticCommit(
        'al-inbound-commit'
    );
    private static readonly EFFECT_LEASE_MS = 10_000;
    private static readonly MAX_EFFECT_BATCH = 16;

    private readonly admissionStore: ALInboundAdmissionStore;
    private readonly readyPromise: Promise<void>;
    private readonly commitQueuesBySenderId = new Map<string, Promise<void>>();

    private effectDrainPromise?: Promise<void>;
    private cancelEffectDrain: (() => void) | undefined;
    private bootstrappedEffects = false;
    private disposed = false;

    private readonly dependencies: ALInboundMessageRuntime.Dependencies;

    constructor(dependencies: ALInboundMessageRuntime.Dependencies) {
        this.dependencies = dependencies;
        this.admissionStore = dependencies.admissionStore;
        this.readyPromise = this.admissionStore.ready();
    }

    async ready(): Promise<void> {
        await this.readyPromise;

        if (!this.disposed && !this.bootstrappedEffects) {
            this.bootstrappedEffects = true;
            await this.startEffectDrain();
        }
    }

    dispose(): void {
        this.disposed = true;
        this.cancelEffectDrain?.();
        this.cancelEffectDrain = undefined;
    }

    async handleIncomingMessage(
        msg: ALMessage,
        fromPeerId: string
    ): Promise<void> {
        await this.ready();

        if (this.disposed) {
            return;
        }

        if (isALControlTypeId(msg.payload.typeId)) {
            const acceptance = await this.acceptControlMessageWithRetry(msg);
            if (!this.effectDrainPromise) {
                await this.startEffectDrain();
            }
            if (!this.disposed) {
                await this.dependencies.onControlMessage?.(msg, acceptance);
            }
            return;
        }

        await this.withSenderCommitQueue(
            msg.id.senderId,
            () => this.admitIncomingMessage(msg, fromPeerId)
        );
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

    private async admitIncomingMessage(
        msg: ALMessage,
        fromPeerId: string
    ): Promise<void> {
        if (this.disposed) {
            return;
        }
        try {
            await tryWithPolicy(
                async () => {
                    const read = await this.admissionStore.readIncomingMessage(
                        msg,
                        fromPeerId,
                        this.dependencies.planIncomingMessage
                    );
                    const canForward = !read.plan.dropReason && this.dependencies.forwardMessage !== undefined &&
                        (this.dependencies.canForwardMessage?.(msg) ?? true);
                    const computed = computeALInboundAdmission(read, canForward);
                    const bundle = prepareALInboundCommitBundle(computed, this.dependencies.effectPreparation);
                    const status = await this.admissionStore.commitBundle(bundle);

                    if (status === 'conflict') {
                        throw new RetryableConflictError('Inbound commit conflict');
                    }

                    await this.startEffectDrain();
                },
                ALInboundMessageRuntime.COMMIT_RETRY_POLICY
            );
        }
        catch (error) {
            throw new Error(
                `Failed to commit inbound message after retries: ${msg.id.msgId}`,
                { cause: error }
            );
        }
    }

    private async releaseBufferedMessageWithAdmission(
        trackKey: string,
        seq: number
    ): Promise<'completed' | 'retry'> {
        try {
            return await tryWithPolicy(
                async () => {
                    const read = await this.admissionStore.readBufferedRelease(trackKey, seq);
                    if (!read) {
                        return 'completed';
                    }

                    const plan = await this.admissionStore.planStoredEntry(
                        read.snapshot.msg,
                        this.dependencies.planIncomingMessage
                    );
                    if (
                        ALInboundMessageRuntime.shouldRetryAdmittedDelivery(plan) ||
                        (!plan.dropReason && await this.hasUndeliveredPredecessor(read.snapshot.msg))
                    ) {
                        return 'retry';
                    }
                    const computed = computeALInboundBufferedRelease(read, plan);
                    const bundle = prepareALInboundCommitBundle(computed, this.dependencies.effectPreparation);
                    const status = await this.admissionStore.commitBundle(bundle);

                    if (status === 'conflict') {
                        throw new RetryableConflictError(
                            'Buffered inbound release commit conflict'
                        );
                    }

                    this.requestEffectDrain();
                    return 'completed';
                },
                ALInboundMessageRuntime.COMMIT_RETRY_POLICY
            );
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

    async dispatchStoredEntry(entry: ResourceEntry): Promise<'completed' | 'retry'> {
        await this.ready();
        return await this.dispatchAdmittedEntry(entry);
    }

    private async dispatchAdmittedEntry(entry: ResourceEntry): Promise<'completed' | 'retry'> {
        if (this.disposed) {
            return 'retry';
        }
        const msg = this.dependencies.readStoredEntry(entry);
        const plan = await this.admissionStore.planStoredEntry(
            msg,
            this.dependencies.planIncomingMessage
        );

        if (this.disposed || ALInboundMessageRuntime.shouldRetryAdmittedDelivery(plan)) {
            return 'retry';
        }

        if (plan.dropReason || !plan.localDelivery.enabled) {
            await this.completeOrderedDelivery(msg);
            return 'completed';
        }

        if (await this.hasUndeliveredPredecessor(msg)) {
            return 'retry';
        }
        if (this.disposed) {
            return 'retry';
        }
        await this.dependencies.dispatchInboxEntry(entry, plan);
        await this.completeOrderedDelivery(msg);
        return 'completed';
    }

    private async hasUndeliveredPredecessor(msg: ALMessage): Promise<boolean> {
        const seq = msg.ordering?.seq;
        const trackKey = toALOrderingTrackKey(msg);
        if (seq === undefined || trackKey === undefined) {
            return false;
        }
        const predecessors = await this.admissionStore.readDeliveryPredecessors(trackKey, seq);
        for (const predecessor of predecessors) {
            if (predecessor.kind === 'effect') {
                return true;
            }
            const entry = await this.dependencies.inbox.getItem(predecessor.key);
            if (
                entry && NOT_COMPLETED_RETRYABLE_STATUSES.has(entry.status) &&
                entry.audit.expiryTs.epochMilliseconds > this.dependencies.clock.nowMs()
            ) {
                const queued = this.dependencies.readStoredEntry(entry);
                if (
                    queued.id.msgId === predecessor.msg.id.msgId && queued.id.senderId === predecessor.msg.id.senderId
                ) {
                    return true;
                }
            }
            await this.completeOrderedDelivery(predecessor.msg);
        }
        return false;
    }

    private async completeOrderedDelivery(msg: ALMessage): Promise<void> {
        const trackKey = toALOrderingTrackKey(msg);
        const seq = msg.ordering?.seq;
        if (trackKey === undefined || seq === undefined) {
            return;
        }
        await tryWithPolicy(async () => {
            const read = await this.admissionStore.readBufferedRelease(trackKey, seq);
            if (!read || read.snapshot.msg.id.msgId !== msg.id.msgId) {
                return;
            }
            const status = await this.admissionStore.commitMutations({
                senderId: msg.id.senderId,
                expectedVersion: read.clientRecord?.version,
                mutations: [{ kind: 'delete-buffered', trackKey, seq }]
            });
            if (status === 'conflict') {
                throw new RetryableConflictError('Ordered delivery completion conflict');
            }
        }, ALInboundMessageRuntime.COMMIT_RETRY_POLICY);
    }

    private requestEffectDrain(): void {
        void this.startEffectDrain().catch((error) => {
            console.error('Failed to drain inbound durable effects', error);
        });
    }

    private startEffectDrain(): Promise<void> {
        if (this.disposed) {
            return Promise.resolve();
        }
        if (!this.effectDrainPromise) {
            this.cancelEffectDrain?.();
            this.cancelEffectDrain = undefined;

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
        while (!this.disposed) {
            const claimed = await this.admissionStore.claimReadyEffects({
                workerId: this.dependencies.effectWorkerId,
                maxCount: ALInboundMessageRuntime.MAX_EFFECT_BATCH,
                leaseMs: ALInboundMessageRuntime.EFFECT_LEASE_MS,
                nowMs: this.dependencies.clock.nowMs()
            });
            if (claimed.length === 0) {
                break;
            }

            for (const effect of claimed) {
                if (this.disposed) {
                    return;
                }
                try {
                    const result = await this.runDurableEffect(effect);
                    if (result === 'retry') {
                        await this.admissionStore.rescheduleEffect({
                            effectId: effect.effectId,
                            workerId: this.dependencies.effectWorkerId,
                            retryAtMs: this.dependencies.clock.nowMs() + this.toEffectRetryDelayMs(effect.attempts),
                            lastError: 'Admitted message is awaiting current delivery state'
                        });
                    }
                    else {
                        await this.admissionStore.completeEffect(effect.effectId, this.dependencies.effectWorkerId);
                    }
                }
                catch (error) {
                    await this.admissionStore.rescheduleEffect({
                        effectId: effect.effectId,
                        workerId: this.dependencies.effectWorkerId,
                        retryAtMs: this.dependencies.clock.nowMs() + this.toEffectRetryDelayMs(effect.attempts),
                        lastError: ALInboundMessageRuntime.toErrorMessage(error)
                    });
                }
            }
        }

        const nextReadyAt = await this.admissionStore.peekNextEffectReadyAt(this.dependencies.clock.nowMs());
        if (nextReadyAt !== undefined) {
            this.scheduleEffectDrainAt(nextReadyAt);
        }
    }

    private scheduleEffectDrainAt(readyAtMs: number): void {
        if (this.disposed) {
            return;
        }
        this.cancelEffectDrain?.();
        const delayMs = Math.max(0, readyAtMs - this.dependencies.clock.nowMs());
        this.cancelEffectDrain = this.dependencies.scheduler.schedule(() => {
            this.cancelEffectDrain = undefined;
            this.requestEffectDrain();
        }, delayMs);
    }

    private async runDurableEffect(
        effect: ALPersistedInboundEffect
    ): Promise<'completed' | 'retry'> {
        if (effect.expireAtTimestamp <= this.dependencies.clock.nowMs()) {
            if (effect.payload.kind === 'dispatch-local' || effect.payload.kind === 'enqueue-inbox') {
                await this.completeOrderedDelivery(effect.payload.msg);
            }
            return 'completed';
        }

        switch (effect.payload.kind) {
            case 'dispatch-local':
                return await this.dispatchAdmittedEntry(effect.payload.entry);
            case 'enqueue-inbox':
                await this.dependencies.inbox.enqueueIfAbsent(effect.payload.entry);
                return 'completed';
            case 'send-control':
                await this.dependencies.sendControlMessage(effect.payload.msg);
                return 'completed';
            case 'forward-message':
                return await this.forwardAdmittedMessage(effect.payload.msg, effect.payload.fromPeerId);
            case 'release-buffered':
                return await this.releaseBufferedMessageWithAdmission(
                    effect.payload.trackKey,
                    effect.payload.seq
                );
        }
    }

    private async forwardAdmittedMessage(msg: ALMessage, fromPeerId: string): Promise<'completed' | 'retry'> {
        const plan = await this.admissionStore.planStoredEntry(
            msg,
            (message, _senderId, stores) => this.dependencies.planIncomingMessage(message, fromPeerId, stores)
        );
        if (this.disposed || ALInboundMessageRuntime.shouldRetryAdmittedDelivery(plan)) {
            return 'retry';
        }
        if (!plan.dropReason && plan.forwarding.enabled) {
            await this.dependencies.forwardMessage?.(msg, fromPeerId, plan);
        }
        return 'completed';
    }

    private static shouldRetryAdmittedDelivery(plan: ALMessageHandlingPlan): boolean {
        return plan.dropReason === 'not-yet-in-sync' ||
            (Boolean(plan.dropReason) && plan.nack.reason === 'overloaded') ||
            (!plan.dropReason && shouldDeferALInboundLocalDelivery(plan));
    }

    private toEffectRetryDelayMs(
        attempts: number
    ): number {
        return Math.min(5_000, 25 * Math.pow(2, Math.max(0, attempts)));
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
