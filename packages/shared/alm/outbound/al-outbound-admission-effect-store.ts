import { Temporal } from '@js-temporal/polyfill';

import {
    ResourceInboxLostReservationError,
    type ResourceInboxReleaseDisposition
} from '../../queuebox/queue-box-types.ts';
import { EntityStatus, NEW_AND_RETRY_STATUSES, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY, retryAfterAttempt } from '../../queuebox/ResourceInboxRetryPolicy.ts';
import type { ALAdmissionWorkBackend, ALAdmissionWorkWriteContext } from '../al-admission-work-backend.ts';
import { resolveExplicitOutboundMessageExpireAtMs } from '../ALMessageExpiry.ts';
import {
    resolveExpireAtTimestampWithFallback,
    toExpireAtTimestampFromNow,
    type NormalizedALRuntimeStoreRetentionConfig
} from '../ALStoreRetention.ts';
import type {
    ALClaimedOutboundEffect,
    ALOutboundDurableEffect,
    ALOutboundDurableEffectWrite,
    ALOutboundEffectSnapshot,
    ALOutboundPreparedMessageDecoder
} from './al-outbound-admission-store.ts';
import {
    AL_OUTBOUND_WORK_LEASE_MS,
    computeALOutboundWorkEntry,
    decodeALOutboundWorkEntry,
    isPendingALOutboundWork,
    toALOutboundWorkKey,
    toALOutboundWorkType
} from './al-outbound-work-entry.ts';

export interface ClaimALOutboundEffectsInput {
    readonly maxCount: number;
}

export interface RescheduleALOutboundEffectInput {
    readonly reservation: ResourceEntry;
    readonly retryAtMs: number;
}

export interface CreateALOutboundAdmissionEffectStoreInput {
    readonly backend: ALAdmissionWorkBackend;
    readonly namespace: string;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
}

export class ALOutboundAdmissionEffectStore {
    private readonly backend: ALAdmissionWorkBackend;
    private readonly namespace: string;
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;

    constructor(input: CreateALOutboundAdmissionEffectStoreInput) {
        this.backend = input.backend;
        this.namespace = input.namespace;
        this.retention = input.retention;
    }

    async persistEffect<TPrepared>(
        tx: ALAdmissionWorkWriteContext,
        effect: ALOutboundDurableEffectWrite<TPrepared>,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<void> {
        const observedAtMs = Date.now();
        const expireAtTimestamp = effect.expireAtTimestamp ?? this.resolveExpireAtTimestamp(effect.payload);
        if (expireAtTimestamp <= observedAtMs) {
            return;
        }
        const existing = await tx.readWork(toALOutboundWorkKey(this.namespace, effect.effectId));
        if (existing !== undefined) {
            decodeALOutboundWorkEntry(existing, this.namespace, decodePrepared);
            if (isPendingALOutboundWork(existing)) {
                return;
            }
        }
        const entry = computeALOutboundWorkEntry({
            namespace: this.namespace,
            effectId: effect.effectId,
            payload: effect.payload,
            observedAtMs,
            expireAtTimestamp,
            retryAtMs: effect.retryAtMs ?? observedAtMs
        });
        decodeALOutboundWorkEntry(entry, this.namespace, decodePrepared);
        tx.writeWork(entry);
    }

    async readEffect<TPrepared>(
        tx: ALAdmissionWorkWriteContext,
        effectId: string,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<ALOutboundEffectSnapshot<TPrepared> | undefined> {
        const entry = await tx.readWork(toALOutboundWorkKey(this.namespace, effectId));
        if (entry === undefined) {
            return undefined;
        }
        const effect = decodeALOutboundWorkEntry(entry, this.namespace, decodePrepared);
        return isPendingALOutboundWork(entry) ? effect : undefined;
    }

    async claimReadyEffects<TPrepared>(
        input: ClaimALOutboundEffectsInput,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<readonly ALClaimedOutboundEffect<TPrepared>[]> {
        const types = new Set([toALOutboundWorkType(this.namespace)]);
        const queue = this.backend.workQueue;
        const finalizations = await queue.reserveRetryExhaustionFinalizations(types, {
            processingAttempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
            maxToReserve: input.maxCount,
            staleAfterMs: AL_OUTBOUND_WORK_LEASE_MS
        });
        for (const { entry } of finalizations.values()) {
            decodeALOutboundWorkEntry(entry, this.namespace, decodePrepared);
            await this.releaseEffect(entry, { status: EntityStatus.FAILED, delayMs: null });
        }
        const remaining = input.maxCount - finalizations.size;
        if (remaining === 0) {
            return [];
        }
        const pending = await queue.reserveEntries(types, new Set(NEW_AND_RETRY_STATUSES), {
            maxToReserve: remaining,
            maxAttempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        });
        const recovered = await queue.reserveTimeoutEntries(types, {
            maxToReserve: Math.max(0, remaining - pending.size),
            maxAttempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        }, Temporal.Duration.from({ milliseconds: AL_OUTBOUND_WORK_LEASE_MS }));
        return [...pending.values(), ...recovered.values()].map((entry) => {
            const effect = decodeALOutboundWorkEntry(entry, this.namespace, decodePrepared);
            if (entry.status !== EntityStatus.RESERVED || effect.leaseUntilMs === undefined) {
                throw new TypeError('Outbound work requires a complete QueueBox reservation');
            }
            return { ...effect, leaseUntilMs: effect.leaseUntilMs };
        });
    }

    async completeEffect(reservation: ResourceEntry): Promise<void> {
        await this.releaseEffect(reservation, { status: EntityStatus.COMPLETED, delayMs: null });
    }

    async rescheduleEffect(input: RescheduleALOutboundEffectInput): Promise<void> {
        const decision = retryAfterAttempt(
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
            input.reservation.dequeueAudit.attempts,
            0.5
        );
        const disposition: ResourceInboxReleaseDisposition = decision.status === 'failed'
            ? { status: EntityStatus.FAILED, delayMs: null }
            : { status: EntityStatus.RETRY, delayMs: Math.max(1, Math.ceil(input.retryAtMs - Date.now())) };
        await this.releaseEffect(input.reservation, disposition);
    }

    async peekNextReadyAt<TPrepared>(
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<number | undefined> {
        let nextAt: number | undefined;
        const scope = toALOutboundWorkKey(this.namespace, '');
        for (const key of await this.backend.workQueue.getAllKeys()) {
            if (key.topicId !== scope.topicId || key.contextId !== scope.contextId) {
                continue;
            }
            const entry = await this.backend.workQueue.getItem(key);
            if (entry === undefined) {
                continue;
            }
            const effect = decodeALOutboundWorkEntry(entry, this.namespace, decodePrepared);
            if (!isPendingALOutboundWork(entry)) {
                continue;
            }
            const candidateAt = effect.leaseUntilMs ?? effect.retryAtMs;
            nextAt = nextAt === undefined ? candidateAt : Math.min(nextAt, candidateAt);
        }
        return nextAt;
    }

    private async releaseEffect(
        reservation: ResourceEntry,
        disposition: ResourceInboxReleaseDisposition
    ): Promise<void> {
        try {
            await this.backend.workQueue.releaseEntries([reservation], disposition);
        }
        catch (error) {
            if (!(error instanceof ResourceInboxLostReservationError)) {
                throw error;
            }
        }
    }

    private resolveExpireAtTimestamp<TPrepared>(effect: ALOutboundDurableEffect<TPrepared>): number {
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
}
