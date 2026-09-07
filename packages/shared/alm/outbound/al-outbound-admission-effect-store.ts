import { Temporal } from '@js-temporal/polyfill';

import { resolveALMessageExpireAtMs } from '../../al-contracts/al-policy.ts';
import {
    ResourceInboxLostReservationError,
    type ResourceInboxReleaseDisposition,
    type ResourceInboxWorkPage
} from '../../queuebox/queue-box-types.ts';
import { hasSameResourceEntryValue } from '../../queuebox/resource-entry-observations.ts';
import { EntityStatus, NEW_AND_RETRY_STATUSES, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY, retryAfterAttempt } from '../../queuebox/ResourceInboxRetryPolicy.ts';
import { Either } from '../../resilience/Either.ts';
import { toError } from '../../resilience/to-error.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type { ALAdmissionWorkBackend, ALAdmissionWorkWriteContext } from '../al-admission-work-backend.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../ALStoreRetention.ts';
import type {
    ALClaimedOutboundEffect,
    ALOutboundDurableEffectWrite,
    ALOutboundEffectSnapshot,
    ALOutboundPreparedMessageDecoder
} from './al-outbound-admission-store.ts';
import {
    AL_OUTBOUND_WORK_LEASE_MS,
    computeALOutboundWorkEntry,
    decodeALOutboundWorkEntry,
    isPendingALOutboundWork,
    resolveALOutboundWorkReadyAt,
    toALOutboundWorkKey,
    toALOutboundWorkType
} from './al-outbound-work-entry.ts';

export interface ALOutboundEffectObservation<TPrepared> {
    readonly effect: ALOutboundDurableEffectWrite<TPrepared>;
    readonly existing: ResourceEntry | undefined;
}

export interface ALOutboundEffectCandidate<TPrepared> {
    readonly read: ALOutboundEffectObservation<TPrepared>;
    readonly entry: ResourceEntry;
    readonly write: boolean;
}

export interface ClaimALOutboundEffectsInput {
    readonly maxCount: number;
}

export interface RescheduleALOutboundEffectInput {
    readonly reservation: ResourceEntry;
    readonly retryAtMs: number;
    readonly reason?: 'not-ready';
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
    private reservationCursor: ResourceInboxWorkPage.Cursor | null = null;
    private readonly scanCursors = new Map<string, ResourceInboxWorkPage.Cursor | null>();
    private scanNextAt: number | undefined;

    constructor(input: CreateALOutboundAdmissionEffectStoreInput) {
        this.backend = input.backend;
        this.namespace = input.namespace;
        this.retention = input.retention;
    }

    async readEffects<TPrepared>(
        effects: readonly ALOutboundDurableEffectWrite<TPrepared>[]
    ): Promise<readonly ALOutboundEffectObservation<TPrepared>[]> {
        return await Promise.all(effects.map(async (effect) => ({
            effect,
            existing: await this.backend.workQueue.getItem(toALOutboundWorkKey(this.namespace, effect.effectId))
        })));
    }

    computeEffects<TPrepared>(
        observations: readonly ALOutboundEffectObservation<TPrepared>[],
        observedAtMs: number
    ): readonly ALOutboundEffectCandidate<TPrepared>[] {
        return observations.map((read) => ({
            read,
            write: read.existing === undefined || !isPendingALOutboundWork(read.existing),
            entry: computeALOutboundWorkEntry({
                namespace: this.namespace,
                effectId: read.effect.effectId,
                payload: read.effect.payload,
                observedAtMs,
                expireAtTimestamp: read.effect.expireAtTimestamp ??
                    ('msg' in read.effect.payload
                        ? resolveALMessageExpireAtMs(read.effect.payload.msg) ?? observedAtMs
                        : observedAtMs + this.retention.durableEffectTtlMs),
                retryAtMs: read.effect.retryAtMs ?? observedAtMs
            })
        }));
    }

    validateEffects<TPrepared>(
        candidates: readonly ALOutboundEffectCandidate<TPrepared>[],
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Either<Error, readonly ALOutboundEffectCandidate<TPrepared>[]> {
        try {
            for (const candidate of candidates) {
                decodeALOutboundWorkEntry(candidate.entry, this.namespace, decodePrepared);
                if (candidate.read.existing !== undefined) {
                    decodeALOutboundWorkEntry(candidate.read.existing, this.namespace, decodePrepared);
                }
            }
            return Either.ofRight(candidates);
        }
        catch (error) {
            return Either.ofLeft(toError(error));
        }
    }

    async assertObservations<TPrepared>(
        tx: ALAdmissionWorkWriteContext,
        candidates: readonly ALOutboundEffectCandidate<TPrepared>[]
    ): Promise<void> {
        for (const candidate of candidates) {
            const existing = await tx.readWork(candidate.entry.key);
            const expected = candidate.read.existing;
            if (
                existing === undefined || expected === undefined
                    ? existing !== expected
                    : !hasSameResourceEntryValue(existing, expected)
            ) {
                throw new ALAdmissionBackendConflictError('Outbound queue observation changed');
            }
        }
    }

    writeEffects<TPrepared>(
        tx: ALAdmissionWorkWriteContext,
        candidates: readonly ALOutboundEffectCandidate<TPrepared>[]
    ): void {
        for (const candidate of candidates) {
            if (candidate.write) {
                tx.writeWork(candidate.entry);
            }
        }
    }

    async claimReadyEffects<TPrepared>(
        input: ClaimALOutboundEffectsInput,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<readonly ALClaimedOutboundEffect<TPrepared>[]> {
        await this.rejectMalformedReservations(Math.min(256, input.maxCount));
        const types = new Set([toALOutboundWorkType(this.namespace)]);
        const queue = this.backend.workQueue;
        const finalizations = await queue.reserveRetryExhaustionFinalizations(types, {
            processingAttempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
            maxToReserve: input.maxCount,
            staleAfterMs: AL_OUTBOUND_WORK_LEASE_MS
        });
        for (const { entry } of finalizations.values()) {
            if (await this.acceptClaimedEffect(entry, decodePrepared) !== undefined) {
                await this.releaseEffect(entry, { status: EntityStatus.FAILED, delayMs: null });
            }
        }
        const remaining = input.maxCount - finalizations.size;
        if (remaining === 0) {
            return [];
        }
        const pending = await queue.reserveEntries({
            typeIds: types,
            statusIds: new Set(NEW_AND_RETRY_STATUSES),
            reservationInput: {
                maxToReserve: remaining,
                maxAttempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
            }
        });
        const recovered = await queue.reserveTimeoutEntries({
            typeIds: types,
            reservationInput: {
                maxToReserve: Math.max(0, remaining - pending.size),
                maxAttempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
            },
            timeSinceStartTs: Temporal.Duration.from({ milliseconds: AL_OUTBOUND_WORK_LEASE_MS })
        });
        const claimed: ALClaimedOutboundEffect<TPrepared>[] = [];
        for (const entry of [...pending.values(), ...recovered.values()]) {
            const effect = await this.acceptClaimedEffect(entry, decodePrepared);
            if (effect !== undefined) {
                claimed.push(effect);
            }
        }
        return claimed;
    }

    private async acceptClaimedEffect<TPrepared>(
        entry: ResourceEntry,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<ALClaimedOutboundEffect<TPrepared> | undefined> {
        let effect: ALOutboundEffectSnapshot<TPrepared>;
        try {
            effect = decodeALOutboundWorkEntry(entry, this.namespace, decodePrepared);
        }
        catch (error) {
            if (!(error instanceof ALAdmissionCorruptionError)) {
                throw error;
            }
            await this.releaseEffect(entry, { status: EntityStatus.NON_RETRYABLE, delayMs: null });
            return undefined;
        }
        if (entry.status !== EntityStatus.RESERVED || effect.leaseUntilMs === undefined) {
            throw new TypeError('Outbound work requires a complete QueueBox reservation');
        }
        return { ...effect, leaseUntilMs: effect.leaseUntilMs };
    }

    async rejectEffect(reservation: ResourceEntry): Promise<void> {
        await this.releaseEffect(reservation, { status: EntityStatus.NON_RETRYABLE, delayMs: null });
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
        const disposition: ResourceInboxReleaseDisposition =
            decision.status === 'failed' && input.reason !== 'not-ready'
                ? { status: EntityStatus.FAILED, delayMs: null }
                : {
                    status: EntityStatus.RETRY,
                    delayMs: Math.max(1, Math.ceil(input.retryAtMs - Date.now())),
                    reason: input.reason
                };
        await this.releaseEffect(input.reservation, disposition);
    }

    private async rejectMalformedReservations(maxToRead: number): Promise<void> {
        const page = await this.backend.workQueue.readWorkPage({
            typeId: toALOutboundWorkType(this.namespace),
            status: EntityStatus.RESERVED,
            maxToRead,
            cursor: this.reservationCursor
        });
        this.reservationCursor = page.nextCursor;
        for (const entry of page.entries) {
            if (entry.dequeueAudit.startTs === undefined) {
                await this.releaseEffect(entry, { status: EntityStatus.NON_RETRYABLE, delayMs: null });
            }
        }
    }

    async peekNextReadyAt(): Promise<number | undefined> {
        const statuses = [EntityStatus.NEW, EntityStatus.RETRY, EntityStatus.RESERVED];
        const nowMs = Date.now();
        let continueScan = false;
        for (const status of statuses) {
            const page = await this.backend.workQueue.readWorkPage({
                typeId: toALOutboundWorkType(this.namespace),
                status,
                maxToRead: 256,
                cursor: this.scanCursors.get(status) ?? null
            });
            this.scanCursors.set(status, page.nextCursor);
            continueScan ||= page.nextCursor !== null;
            for (const entry of page.entries) {
                if (entry.audit.expiryTs.epochMilliseconds <= nowMs) {
                    continue;
                }
                const candidateAt = entry.status === EntityStatus.RESERVED && entry.dequeueAudit.startTs === undefined
                    ? nowMs
                    : resolveALOutboundWorkReadyAt(entry);
                this.scanNextAt = Math.min(this.scanNextAt ?? candidateAt, candidateAt);
            }
        }
        if (continueScan) {
            return nowMs;
        }
        const nextAt = this.scanNextAt;
        this.scanNextAt = undefined;
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
}
