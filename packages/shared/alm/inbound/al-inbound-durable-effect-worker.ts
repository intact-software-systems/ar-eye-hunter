import { toError } from '../../resilience/to-error.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type { ALInboundAdmissionStore } from './al-inbound-admission-store.ts';
import { ALInboundAdmittedDelivery } from './al-inbound-admitted-delivery.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';

export namespace ALInboundDurableEffectWorker {
    export interface Dependencies
        extends Pick<ALInboundMessageRuntime.Resources, 'admissionStore' | 'effectWorkerId' | 'clock' | 'scheduler'> {
        readonly delivery: ALInboundAdmittedDelivery;
    }
}

export class ALInboundDurableEffectWorker {
    private static readonly EFFECT_LEASE_MS = 10_000;
    private static readonly MAX_EFFECT_BATCH = 16;
    private readonly admissionStore: ALInboundAdmissionStore;
    private readonly dependencies: ALInboundDurableEffectWorker.Dependencies;
    private effectDrainPromise: Promise<void> | undefined;
    private cancelEffectDrain: (() => void) | undefined;
    private bootstrappedEffects = false;
    private effectDrainRequested = false;
    private disposed = false;

    constructor(dependencies: ALInboundDurableEffectWorker.Dependencies) {
        this.dependencies = dependencies;
        this.admissionStore = dependencies.admissionStore;
    }

    async startOnce(): Promise<void> {
        if (!this.disposed && !this.bootstrappedEffects) {
            this.bootstrappedEffects = true;
            await this.start();
        }
    }

    hasActiveDrain(): boolean {
        return this.effectDrainPromise !== undefined;
    }

    dispose(): void {
        this.disposed = true;
        this.cancelEffectDrain?.();
        this.cancelEffectDrain = undefined;
    }

    private requestEffectDrain(): void {
        void this.start().catch((error) => {
            console.error('Failed to drain inbound durable effects', error);
        });
    }

    start(): Promise<void> {
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
                    console.error('Inbound durable effect drain failed', error);
                    if (!this.disposed) {
                        this.scheduleEffectDrainAt(
                            this.dependencies.clock.nowMs() + this.toEffectRetryDelayMs(0)
                        );
                    }
                })
                .finally(() => {
                    this.effectDrainPromise = undefined;
                });
        }

        return this.effectDrainPromise.then(async () => {
            if (this.effectDrainRequested && !this.disposed) {
                await this.start();
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
        while (!this.disposed) {
            const claimed = await this.admissionStore.claimReadyEffects({
                workerId: this.dependencies.effectWorkerId,
                maxCount: ALInboundDurableEffectWorker.MAX_EFFECT_BATCH,
                leaseMs: ALInboundDurableEffectWorker.EFFECT_LEASE_MS,
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
                    const result = await this.dependencies.delivery.deliver(effect);
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
                    if (error instanceof ALAdmissionCorruptionError) {
                        throw error;
                    }
                    await this.admissionStore.rescheduleEffect({
                        effectId: effect.effectId,
                        workerId: this.dependencies.effectWorkerId,
                        retryAtMs: this.dependencies.clock.nowMs() + this.toEffectRetryDelayMs(effect.attempts),
                        lastError: toError(error).message
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

    private toEffectRetryDelayMs(
        attempts: number
    ): number {
        return Math.min(5_000, 25 * Math.pow(2, Math.max(0, attempts)));
    }
}
