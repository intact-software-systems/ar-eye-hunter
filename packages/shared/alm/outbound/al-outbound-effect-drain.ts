import { toError } from '../../resilience/to-error.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type {
    ALOutboundAdmissionStore,
    ALOutboundPreparedMessageDecoder,
    ALPersistedOutboundEffect
} from './al-outbound-admission-store.ts';
import type {
    ALOutboundMessageRuntime,
    ALOutboundRuntimeDiagnosticsEvent,
    ALOutboundRuntimeDiagnosticsSink
} from './al-outbound-message-runtime.ts';

export type ALOutboundEffectRunResult =
    | Readonly<{ status: 'completed'; }>
    | Readonly<{ status: 'reschedule'; readyAtMs: number; reason: string; }>;

interface ALOutboundDurableEffectDrainCounts {
    claimedCount: number;
    completedCount: number;
    rescheduledCount: number;
    skippedExpiredCount: number;
}

export namespace ALOutboundEffectDrain {
    export interface Dependencies<TPrepared> {
        readonly admissionStore: ALOutboundAdmissionStore;
        readonly effectWorkerId: string;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly scheduler: ALOutboundMessageRuntime.Scheduler;
        readonly decodePreparedMessage: ALOutboundPreparedMessageDecoder<TPrepared>;
        readonly diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
        /** Invoked once per claimed attempt, after commit; rejection retains/retries the durable effect unless corruption. */
        readonly runEffect: (effect: ALPersistedOutboundEffect<TPrepared>) => Promise<ALOutboundEffectRunResult>;
    }
}

export class ALOutboundEffectDrain<TPrepared> {
    private static readonly EFFECT_LEASE_MS = 10_000;
    private static readonly MAX_EFFECT_BATCH = 16;
    private readonly dependencies: ALOutboundEffectDrain.Dependencies<TPrepared>;
    private effectDrainPromise?: Promise<void>;
    private effectDrainRequested = false;
    private cancelEffectDrain: (() => void) | undefined;
    private bootstrappedEffects = false;
    private disposed = false;

    constructor(dependencies: ALOutboundEffectDrain.Dependencies<TPrepared>) {
        this.dependencies = dependencies;
    }

    async ready(): Promise<void> {
        if (!this.bootstrappedEffects) {
            await this.drain();
            this.bootstrappedEffects = true;
        }
    }

    dispose(): void {
        this.disposed = true;
        this.cancelEffectDrain?.();
        this.cancelEffectDrain = undefined;
    }

    async drainCommitted(): Promise<void> {
        await this.drain();
    }

    async requestCommittedDrain(): Promise<void> {
        const waitForDrain = this.effectDrainPromise === undefined;
        const drain = this.drain();
        if (waitForDrain) {
            await drain;
        }
    }

    private requestEffectDrain(): void {
        if (this.disposed) {
            return;
        }
        void this.drain().catch((error) => {
            console.error('Failed to drain outbound durable effects', error);
        });
    }

    drain(): Promise<void> {
        if (this.disposed) {
            return Promise.resolve();
        }
        this.effectDrainRequested = true;

        if (!this.effectDrainPromise) {
            this.cancelEffectDrain?.();
            this.cancelEffectDrain = undefined;

            this.effectDrainPromise = this.runRequestedEffectDrains()
                .catch((error) => {
                    if (error instanceof ALAdmissionCorruptionError) {
                        throw error;
                    }
                    console.error('Outbound durable effect drain failed', error);
                    this.scheduleAt(this.readNowMs() + computeALOutboundEffectRetryDelayMs(0));
                })
                .finally(() => {
                    this.effectDrainPromise = undefined;
                });
        }

        return this.effectDrainPromise.then(async () => {
            if (this.effectDrainRequested && !this.disposed) {
                await this.drain();
            }
        });
    }

    private async runRequestedEffectDrains(): Promise<void> {
        while (!this.disposed && this.effectDrainRequested) {
            this.effectDrainRequested = false;
            this.cancelEffectDrain?.();
            this.cancelEffectDrain = undefined;
            await this.runDurableEffectDrainLoop();
        }
    }

    private async runDurableEffectDrainLoop(): Promise<void> {
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

                const claimed = await this.dependencies.admissionStore.claimReadyEffects<TPrepared>(
                    {
                        workerId: this.dependencies.effectWorkerId,
                        maxCount: ALOutboundEffectDrain.MAX_EFFECT_BATCH,
                        leaseMs: ALOutboundEffectDrain.EFFECT_LEASE_MS,
                        nowMs: this.readNowMs()
                    },
                    this.dependencies.decodePreparedMessage
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

            const nextReadyAt = await this.dependencies.admissionStore.peekNextEffectReadyAt(
                this.dependencies.decodePreparedMessage
            );
            if (nextReadyAt !== undefined) {
                this.scheduleAt(nextReadyAt);
            }
        }
        finally {
            this.emitDiagnostics({
                kind: 'effect-drain',
                workerId: this.dependencies.effectWorkerId,
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
            const result = await this.dependencies.runEffect(effect);
            if (result.status === 'reschedule') {
                await this.rescheduleDurableEffect(effect, result.readyAtMs, result.reason);
                counts.rescheduledCount += 1;
                return;
            }

            await this.dependencies.admissionStore.completeEffect(
                effect.effectId,
                this.dependencies.effectWorkerId,
                this.dependencies.decodePreparedMessage
            );
            counts.completedCount += 1;
        }
        catch (error) {
            if (error instanceof ALAdmissionCorruptionError) {
                throw error;
            }
            if (!this.disposed) {
                await this.rescheduleDurableEffect(
                    effect,
                    this.readNowMs() + computeALOutboundEffectRetryDelayMs(effect.attempts),
                    toError(error).message
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
        await this.dependencies.admissionStore.rescheduleEffect({
            effectId: effect.effectId,
            workerId: this.dependencies.effectWorkerId,
            retryAtMs,
            lastError
        }, this.dependencies.decodePreparedMessage);
    }

    scheduleAt(readyAtMs: number): void {
        if (this.disposed) {
            return;
        }

        this.cancelEffectDrain?.();

        const delayMs = Math.max(0, readyAtMs - this.readNowMs());
        this.cancelEffectDrain = this.dependencies.scheduler.schedule(() => {
            this.cancelEffectDrain = undefined;
            this.requestEffectDrain();
        }, delayMs);
    }

    private readNowMs(): number {
        return this.dependencies.clock.nowMs();
    }

    private elapsedSince(startedAtMs: number): number {
        return Math.max(0, this.readNowMs() - startedAtMs);
    }

    private emitDiagnostics(event: ALOutboundRuntimeDiagnosticsEvent): void {
        try {
            this.dependencies.diagnostics?.(event);
        }
        catch (error) {
            console.error('AL outbound runtime diagnostics sink failed', error);
        }
    }
}

export function computeALOutboundEffectRetryDelayMs(attempts: number): number {
    return Math.min(5_000, 25 * Math.pow(2, Math.max(0, attempts)));
}
