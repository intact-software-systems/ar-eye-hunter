import { Temporal } from '@js-temporal/polyfill';

import {
    ResourceInboxLostReservationError,
    type ResourceInboxReleaseDisposition
} from '../../queuebox/queue-box-types.ts';
import {
    EntityStatus,
    NEW_AND_RETRY_STATUSES,
    NOT_COMPLETED_RETRYABLE_STATUSES,
    type ResourceEntry
} from '../../queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY, retryAfterAttempt } from '../../queuebox/ResourceInboxRetryPolicy.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import { toError } from '../../resilience/to-error.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type { ALAdmissionWorkBackend, ALAdmissionWorkWriteContext } from '../al-admission-work-backend.ts';
import type {
    ALInboundDeliveryPredecessor,
    ALInboundDurableEffectWrite,
    ALInboundOrderedDeliveryRead,
    ALPersistedInboundEffect,
    ClaimALInboundEffectsInput,
    FinalizeALInboundEffectsInput,
    RescheduleALInboundEffectInput
} from './al-inbound-admission-store.ts';
import { decodeALInboundDeliveryProgress, decodeALInboundOrderingSnapshot } from './al-inbound-ordering-validation.ts';
import {
    assertALInboundDeliveryOwner,
    decodeALInboundBufferedSnapshot,
    readALInboundBufferedMessage,
    type ALInboundOrderedDeliverySnapshot
} from './al-inbound-ordering-validation.ts';
import {
    AL_INBOUND_WORK_LEASE_MS,
    decodeALInboundWorkEntry,
    toALInboundWorkKey,
    toALInboundWorkType
} from './al-inbound-work-entry.ts';

export namespace ALInboundDurableEffectStore {
    export interface Dependencies {
        readonly nowMs: () => number;
        readonly backend: ALAdmissionWorkBackend;
        readonly namespace: string;
    }
}

/** Admission writes work atomically; QueueBox alone owns reservations and retry state. */
export class ALInboundDurableEffectStore {
    private readonly backend: ALAdmissionWorkBackend;
    private readonly nowMs: () => number;
    private readonly namespace: string;

    constructor(dependencies: ALInboundDurableEffectStore.Dependencies) {
        this.backend = dependencies.backend;
        this.nowMs = dependencies.nowMs;
        this.namespace = dependencies.namespace;
    }

    async claimReadyEffects(input: ClaimALInboundEffectsInput): Promise<readonly ALPersistedInboundEffect[]> {
        const queue = this.backend.workQueue;
        const types = new Set([toALInboundWorkType(this.namespace)]);
        const pending = await queue.reserveEntries({
            typeIds: types,
            statusIds: new Set(NEW_AND_RETRY_STATUSES),
            reservationInput: {
                maxToReserve: input.maxCount,
                maxAttempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
            },
            observedEntries: input.entries
        });
        const recovered = await queue.reserveTimeoutEntries({
            typeIds: types,
            reservationInput: {
                maxToReserve: Math.max(0, input.maxCount - pending.size),
                maxAttempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
            },
            timeSinceStartTs: Temporal.Duration.from({ milliseconds: AL_INBOUND_WORK_LEASE_MS }),
            observedEntries: input.entries
        });
        const claimed: ALPersistedInboundEffect[] = [];
        for (const entry of [...pending.values(), ...recovered.values()]) {
            try {
                claimed.push(decodeALInboundWorkEntry(entry, this.namespace));
            }
            catch (error) {
                if (!(error instanceof ALAdmissionCorruptionError)) {
                    throw error;
                }
                await this.rejectEffect(entry);
            }
        }
        return claimed;
    }

    async completeEffect(reservation: ResourceEntry): Promise<void> {
        await this.releaseEffect(reservation, { status: EntityStatus.COMPLETED, delayMs: null });
    }

    async rejectEffect(reservation: ResourceEntry): Promise<void> {
        await this.releaseEffect(reservation, { status: EntityStatus.NON_RETRYABLE, delayMs: null });
    }

    async finalizeExhaustedEffects(input: FinalizeALInboundEffectsInput): Promise<void> {
        const claimed = await this.backend.workQueue.reserveRetryExhaustionFinalizations(
            new Set([toALInboundWorkType(this.namespace)]),
            {
                processingAttempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
                maxToReserve: input.maxCount,
                staleAfterMs: AL_INBOUND_WORK_LEASE_MS
            }
        );
        for (const { entry } of claimed.values()) {
            if (input.signal.aborted) {
                return;
            }
            let status: typeof EntityStatus.FAILED | typeof EntityStatus.NON_RETRYABLE = EntityStatus.FAILED;
            try {
                decodeALInboundWorkEntry(entry, this.namespace);
            }
            catch (error) {
                if (!(error instanceof ALAdmissionCorruptionError)) {
                    throw error;
                }
                status = EntityStatus.NON_RETRYABLE;
            }
            await this.releaseEffect(entry, { status, delayMs: null });
        }
    }

    async rescheduleEffect(input: RescheduleALInboundEffectInput): Promise<void> {
        const decision = retryAfterAttempt(
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
            input.reservation.dequeueAudit.attempts,
            0.5
        );
        const disposition: ResourceInboxReleaseDisposition =
            input.reason !== 'not-ready' && decision.status === 'failed'
                ? { status: EntityStatus.FAILED, delayMs: null }
                : {
                    status: EntityStatus.RETRY,
                    delayMs: Math.max(1, Math.ceil(input.retryAtMs - this.nowMs())),
                    reason: input.reason
                };
        await this.releaseEffect(input.reservation, disposition);
    }

    async readOrderedDelivery(trackKey: string, beforeSeq: number): Promise<ALInboundOrderedDeliveryRead> {
        const progress = await this.backend.read(
            `${this.namespace}:delivered:${trackKey}`,
            decodeALInboundDeliveryProgress
        );
        if (progress === undefined) {
            return { completedThrough: 0, predecessor: { kind: 'resync-required' } };
        }
        const completedThrough = progress.completedThrough;
        if (beforeSeq <= completedThrough + 1) {
            return { completedThrough, predecessor: undefined };
        }
        const expectedSeq = completedThrough + 1;
        const prefix = `${this.namespace}:buffered:${trackKey}:`;
        const stored = await this.backend.read(
            `${prefix}${expectedSeq}`,
            (value, key) => decodeALInboundBufferedSnapshot(value, { trackKey, prefix, key })
        );
        if (stored === undefined) {
            return { completedThrough, predecessor: await this.readOrderingPredecessor(trackKey, expectedSeq) };
        }
        const snapshot = await readALInboundBufferedMessage({
            database: this.backend,
            namespace: this.namespace,
            stored
        });
        return { completedThrough, predecessor: await this.readDeliveryPredecessor(snapshot) };
    }

    private async readOrderingPredecessor(
        trackKey: string,
        expectedSeq: number
    ): Promise<ALInboundDeliveryPredecessor> {
        const ordering = await this.backend.read(
            `${this.namespace}:ordering:${trackKey}`,
            decodeALInboundOrderingSnapshot
        );
        return {
            kind: ordering !== undefined && ordering.lastContiguousSeq < expectedSeq ? 'effect' : 'resync-required'
        };
    }

    private async readDeliveryPredecessor(
        snapshot: ALInboundOrderedDeliverySnapshot
    ): Promise<ALInboundDeliveryPredecessor> {
        if (snapshot.delivery === undefined) {
            return { kind: 'effect' };
        }
        const entry = await this.backend.workQueue.getItem(
            toALInboundWorkKey(this.namespace, snapshot.delivery.effectId)
        );
        if (entry === undefined) {
            return { kind: 'resync-required' };
        }
        if (!NOT_COMPLETED_RETRYABLE_STATUSES.has(entry.status) && entry.status !== EntityStatus.COMPLETED) {
            return { kind: 'resync-required' };
        }
        const effect = decodeALInboundWorkEntry(entry, this.namespace);
        try {
            assertALInboundDeliveryOwner(effect.payload, snapshot);
        }
        catch (error) {
            throw new ALAdmissionCorruptionError(JSON.stringify(entry.key), toError(error));
        }
        return { kind: NOT_COMPLETED_RETRYABLE_STATUSES.has(entry.status) ? 'effect' : 'resync-required' };
    }

    async persistEffect(tx: ALAdmissionWorkWriteContext, effect: ALInboundDurableEffectWrite): Promise<void> {
        const existing = await tx.readWork(effect.entry.key);
        if (existing !== undefined) {
            const stored = decodeALInboundWorkEntry(existing, this.namespace);
            if (!jsonEquals(stored.payload, effect.payload)) {
                throw new ALAdmissionCorruptionError(
                    JSON.stringify(effect.entry.key),
                    new TypeError('Stored inbound work differs from its computed identity')
                );
            }
            return;
        }
        tx.writeWork(effect.entry);
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
