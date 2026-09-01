import type { ALAdmissionBackend, ALAdmissionWriteContext } from '../al-admission-backend.ts';
import { resolveExplicitOutboundMessageExpireAtMs } from '../ALMessageExpiry.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../ALStoreRetention.ts';
import { resolveExpireAtTimestampWithFallback, toExpireAtTimestampFromNow } from '../ALStoreRetention.ts';
import type {
    ALOutboundDurableEffect,
    ALOutboundDurableEffectWrite,
    ALOutboundPreparedMessageDecoder,
    ALPersistedOutboundEffect
} from './al-outbound-admission-store.ts';
import { decodeALOutboundEffect, encodeALOutboundEffect } from './al-outbound-effect-validation.ts';

export interface ClaimALOutboundEffectsInput {
    readonly workerId: string;
    readonly maxCount: number;
    readonly leaseMs: number;
    readonly nowMs: number;
}

export interface RescheduleALOutboundEffectInput {
    readonly effectId: string;
    readonly workerId: string;
    readonly retryAtMs: number;
    readonly lastError: string | undefined;
}

export interface CreateALOutboundAdmissionEffectStoreInput {
    readonly backend: ALAdmissionBackend;
    readonly namespace: string;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
}

export class ALOutboundAdmissionEffectStore {
    private readonly backend: ALAdmissionBackend;
    private readonly namespace: string;
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;

    constructor(
        input: CreateALOutboundAdmissionEffectStoreInput
    ) {
        this.backend = input.backend;
        this.namespace = input.namespace;
        this.retention = input.retention;
    }

    async persistEffect<TPrepared>(
        tx: ALAdmissionWriteContext,
        effect: ALOutboundDurableEffectWrite<TPrepared>,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<void> {
        const expireAtTimestamp = effect.expireAtTimestamp ?? this.resolveExpireAtTimestamp(effect.payload);
        if (expireAtTimestamp <= Date.now()) {
            return;
        }

        const key = this.toEffectKey(effect.effectId);
        const existing = await tx.read(key, (value) => decodeALOutboundEffect(value, effect.effectId, decodePrepared));
        if (existing) {
            return;
        }

        const nowMs = Date.now();
        await tx.set(
            key,
            encodeALOutboundEffect({
                effectId: effect.effectId,
                payload: effect.payload,
                status: 'pending',
                attempts: 0,
                retryAtMs: effect.retryAtMs ?? nowMs,
                updatedAtMs: nowMs,
                expireAtTimestamp
            }),
            expireAtTimestamp
        );
    }

    async readEffect<TPrepared>(
        tx: ALAdmissionWriteContext,
        effectId: string,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<ALPersistedOutboundEffect<TPrepared> | undefined> {
        return await tx.read(
            this.toEffectKey(effectId),
            (value) => decodeALOutboundEffect(value, effectId, decodePrepared)
        );
    }

    async claimReadyEffects<TPrepared>(
        input: ClaimALOutboundEffectsInput,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<readonly ALPersistedOutboundEffect<TPrepared>[]> {
        if (input.maxCount <= 0) {
            return [];
        }

        return await this.backend.write(async (tx) => {
            const effects = [
                ...await tx.list(
                    this.toEffectPrefix(),
                    (value, key) =>
                        decodeALOutboundEffect(value, key.slice(this.toEffectPrefix().length), decodePrepared)
                )
            ]
                .map((entry) => entry.value)
                .sort((left, right) => left.retryAtMs - right.retryAtMs || left.effectId.localeCompare(right.effectId));
            const claimed: ALPersistedOutboundEffect<TPrepared>[] = [];
            for (const effect of effects) {
                if (claimed.length >= input.maxCount) {
                    break;
                }
                if (!this.isReady(effect, input.nowMs)) {
                    continue;
                }

                const claimedEffect: ALPersistedOutboundEffect<TPrepared> = {
                    ...effect,
                    status: 'running',
                    attempts: effect.attempts + 1,
                    leaseOwner: input.workerId,
                    leaseUntilMs: input.nowMs + input.leaseMs,
                    updatedAtMs: input.nowMs
                };
                await tx.set(
                    this.toEffectKey(effect.effectId),
                    encodeALOutboundEffect(claimedEffect),
                    effect.expireAtTimestamp
                );
                claimed.push(claimedEffect);
            }
            return claimed;
        });
    }

    async completeEffect<TPrepared>(
        effectId: string,
        workerId: string,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<void> {
        await this.backend.write(async (tx) => {
            const current = await tx.read(
                this.toEffectKey(effectId),
                (value) => decodeALOutboundEffect(value, effectId, decodePrepared)
            );
            if (current?.leaseOwner === workerId) {
                await tx.remove(this.toEffectKey(effectId));
            }
        });
    }

    async rescheduleEffect<TPrepared>(
        input: RescheduleALOutboundEffectInput,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<void> {
        await this.backend.write(async (tx) => {
            const current = await tx.read(
                this.toEffectKey(input.effectId),
                (value) => decodeALOutboundEffect(value, input.effectId, decodePrepared)
            );
            if (current?.leaseOwner !== input.workerId) {
                return;
            }

            await tx.set(
                this.toEffectKey(input.effectId),
                encodeALOutboundEffect({
                    ...current,
                    status: 'pending',
                    retryAtMs: input.retryAtMs,
                    leaseOwner: undefined,
                    leaseUntilMs: undefined,
                    lastError: input.lastError,
                    updatedAtMs: Date.now()
                }),
                current.expireAtTimestamp
            );
        });
    }

    async peekNextReadyAt<TPrepared>(
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<number | undefined> {
        let nextAt: number | undefined;
        for (
            const { value: effect } of await this.backend.list(
                this.toEffectPrefix(),
                (value, key) => decodeALOutboundEffect(value, key.slice(this.toEffectPrefix().length), decodePrepared)
            )
        ) {
            const candidateAt = effect.status === 'running' ? effect.leaseUntilMs : effect.retryAtMs;
            if (candidateAt === undefined) {
                continue;
            }
            nextAt = nextAt === undefined ? candidateAt : Math.min(nextAt, candidateAt);
        }
        return nextAt;
    }

    private resolveExpireAtTimestamp<TPrepared>(
        effect: ALOutboundDurableEffect<TPrepared>
    ): number {
        switch (effect.kind) {
            case 'send-prepared':
            case 'enqueue-outbox':
            case 'fallback-dispatch':
                return resolveExpireAtTimestampWithFallback(
                    resolveExplicitOutboundMessageExpireAtMs(effect.msg),
                    this.retention.durableEffectTtlMs
                );
            case 'ack-timeout':
            case 'repair-hint':
            case 'nack-retry':
                return toExpireAtTimestampFromNow(this.retention.durableEffectTtlMs);
        }
    }

    private isReady<TPrepared>(
        effect: ALPersistedOutboundEffect<TPrepared>,
        nowMs: number
    ): boolean {
        return effect.status === 'pending'
            ? effect.retryAtMs <= nowMs
            : effect.leaseUntilMs !== undefined && effect.leaseUntilMs <= nowMs;
    }

    private toEffectKey(effectId: string): string {
        return `${this.namespace}:effect:${effectId}`;
    }

    private toEffectPrefix(): string {
        return `${this.namespace}:effect:`;
    }
}
