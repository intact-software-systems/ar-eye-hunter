import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY, retryAfterAttempt } from '../../queuebox/ResourceInboxRetryPolicy.ts';
import type { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type {
    ALClaimedOutboundEffect,
    ALOutboundAdmissionStore,
    ALOutboundPreparedMessageDecoder
} from './al-outbound-admission-store.ts';
import type {
    ALOutboundMessageRuntime,
    ALOutboundRuntimeDiagnosticsSink
} from './al-outbound-message-runtime.ts';

export type ALOutboundWorkDisposition =
    | Readonly<{ status: 'completed'; }>
    | Readonly<{ status: 'reschedule'; readyAtMs: number; }>;

export type ALOutboundWorkAttemptResult =
    | ALOutboundWorkDisposition
    | Readonly<{ status: 'retained'; settled: Promise<ALOutboundWorkDisposition>; }>;

interface ALOutboundWorkCounts {
    claimedCount: number;
    completedCount: number;
    rescheduledCount: number;
    skippedExpiredCount: number;
}

export namespace ALOutboundWorkHandler {
    export interface Dependencies<TPrepared> {
        readonly admissionStore: ALOutboundAdmissionStore;
        readonly effectWorkerId: string;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly queueEngine: InboxOutboxEngine;
        readonly ownsQueueEngine: boolean;
        readonly decodePreparedMessage: ALOutboundPreparedMessageDecoder<TPrepared>;
        readonly diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
        readonly runEffect: (effect: ALClaimedOutboundEffect<TPrepared>) => Promise<ALOutboundWorkAttemptResult>;
    }
}

/** Translates AL outcomes to QueueBox releases; the supplied engine owns scheduling. */
export class ALOutboundWorkHandler<TPrepared> {
    private static readonly MAX_BATCH = 16;
    private readonly dependencies: ALOutboundWorkHandler.Dependencies<TPrepared>;
    private processing: Promise<void> | undefined;
    private bootstrapped = false;
    private disposed = false;

    constructor(dependencies: ALOutboundWorkHandler.Dependencies<TPrepared>) {
        this.dependencies = dependencies;
        dependencies.queueEngine.includeTask(dependencies.effectWorkerId, {
            name: dependencies.effectWorkerId,
            maxConcurrency: () => 1,
            isWork: () => this.hasReadyWork(),
            runnable: () =>
                this.processBatch().catch((error) => {
                    console.error('Outbound QueueBox work failed', error);
                }),
            ongoingTasks: []
        });
    }

    async ready(): Promise<void> {
        if (this.bootstrapped || this.disposed) {
            return;
        }
        await this.processBatch();
        this.bootstrapped = true;
        if (!this.disposed && this.dependencies.ownsQueueEngine) {
            this.dependencies.queueEngine.start();
        }
    }

    dispose(): void {
        this.disposed = true;
        this.dependencies.queueEngine.excludeTask(this.dependencies.effectWorkerId);
        if (this.dependencies.ownsQueueEngine) {
            this.dependencies.queueEngine.stop();
        }
    }

    async processCommitted(): Promise<void> {
        await this.processing;
        await this.processBatch();
        this.dependencies.queueEngine.wake();
    }

    async requestCommitted(): Promise<void> {
        this.dependencies.queueEngine.wake();
        if (this.processing === undefined) {
            await this.processBatch();
        }
    }

    private async hasReadyWork(): Promise<boolean> {
        if (this.disposed || this.processing !== undefined) {
            return false;
        }
        const next = await this.dependencies.admissionStore.peekNextEffectReadyAt();
        this.dependencies.queueEngine.wakeAt(this.dependencies.effectWorkerId, next);
        return next !== undefined && next <= this.dependencies.clock.nowMs();
    }

    private processBatch(): Promise<void> {
        if (this.disposed) {
            return Promise.resolve();
        }
        if (this.processing !== undefined) {
            return this.processing;
        }
        this.processing = this.runBatch().catch((error) => {
            if (error instanceof ALAdmissionCorruptionError) {
                throw error;
            }
            console.error('Outbound QueueBox attempt failed', error);
        }).finally(() => {
            this.processing = undefined;
            this.dependencies.queueEngine.wake();
        });
        return this.processing;
    }

    private async runBatch(): Promise<void> {
        const startedAtMs = this.dependencies.clock.nowMs();
        const counts: ALOutboundWorkCounts = {
            claimedCount: 0,
            completedCount: 0,
            rescheduledCount: 0,
            skippedExpiredCount: 0
        };
        try {
            const claimed = await this.dependencies.admissionStore.claimReadyEffects(
                { maxCount: ALOutboundWorkHandler.MAX_BATCH },
                this.dependencies.decodePreparedMessage
            );
            counts.claimedCount = claimed.length;
            for (const effect of claimed) {
                if (this.disposed) {
                    break;
                }
                await this.runClaimed(effect, counts);
            }
        }
        finally {
            this.emitDiagnostics(startedAtMs, counts);
            if (!this.disposed) {
                const next = await this.dependencies.admissionStore.peekNextEffectReadyAt();
                this.dependencies.queueEngine.wakeAt(this.dependencies.effectWorkerId, next);
            }
        }
    }

    private async runClaimed(effect: ALClaimedOutboundEffect<TPrepared>, counts: ALOutboundWorkCounts): Promise<void> {
        try {
            if (effect.expireAtTimestamp <= this.dependencies.clock.nowMs()) {
                counts.skippedExpiredCount += 1;
            }
            const result = await this.dependencies.runEffect(effect);
            if (result.status === 'retained') {
                void this.settleRetained(effect, result.settled).catch((error) => {
                    console.error('Retained outbound QueueBox work failed', error);
                });
                return;
            }
            await this.release(effect, result);
            if (result.status === 'reschedule') {
                counts.rescheduledCount += 1;
            }
            else {
                counts.completedCount += 1;
            }
        }
        catch (error) {
            if (error instanceof ALAdmissionCorruptionError) {
                throw error;
            }
            if (!this.disposed) {
                await this.retry(effect);
                counts.rescheduledCount += 1;
            }
        }
    }

    private async settleRetained(
        effect: ALClaimedOutboundEffect<TPrepared>,
        settlement: Promise<ALOutboundWorkDisposition>
    ): Promise<void> {
        try {
            const result = await settlement;
            if (!this.disposed) {
                await this.release(effect, result);
            }
        }
        catch (error) {
            if (error instanceof ALAdmissionCorruptionError) {
                throw error;
            }
            if (!this.disposed) {
                await this.retry(effect);
            }
        }
        finally {
            this.dependencies.queueEngine.wake();
        }
    }

    private async release(
        effect: ALClaimedOutboundEffect<TPrepared>,
        result: ALOutboundWorkDisposition
    ): Promise<void> {
        if (result.status === 'reschedule') {
            await this.dependencies.admissionStore.rescheduleEffect({
                reservation: effect.entry,
                retryAtMs: result.readyAtMs
            });
        }
        else {
            await this.dependencies.admissionStore.completeEffect(effect.entry);
        }
    }

    private async retry(effect: ALClaimedOutboundEffect<TPrepared>): Promise<void> {
        const decision = retryAfterAttempt(DEFAULT_RESOURCE_INBOX_RETRY_POLICY, effect.attempts, Math.random());
        await this.dependencies.admissionStore.rescheduleEffect({
            reservation: effect.entry,
            retryAtMs: this.dependencies.clock.nowMs() + (decision.delayMs ?? 0)
        });
    }

    private emitDiagnostics(startedAtMs: number, counts: ALOutboundWorkCounts): void {
        try {
            this.dependencies.diagnostics?.({
                kind: 'effect-drain',
                workerId: this.dependencies.effectWorkerId,
                durationMs: Math.max(0, this.dependencies.clock.nowMs() - startedAtMs),
                ...counts
            });
        }
        catch (error) {
            console.error('AL outbound runtime diagnostics sink failed', error);
        }
    }
}
