import { EntityStatus, NOT_COMPLETED_RETRYABLE_STATUSES } from '../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import { toError } from '../../resilience/to-error.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type { ALAdmissionWorkBackend, ALAdmissionWorkWriteContext } from '../al-admission-work-backend.ts';
import type {
    ALInboundDeliveryPredecessor,
    ALInboundDurableEffectWrite,
    ALInboundOrderedDeliveryRead
} from './al-inbound-admission-store.ts';
import { decodeALInboundDeliveryProgress, decodeALInboundOrderingSnapshot } from './al-inbound-ordering-validation.ts';
import {
    assertALInboundDeliveryOwner,
    decodeALInboundBufferedSnapshot,
    readALInboundBufferedMessage,
    type ALInboundOrderedDeliverySnapshot
} from './al-inbound-ordering-validation.ts';
import {
    decodeALInboundWorkEntry,
    toALInboundWorkKey
} from './al-inbound-work-entry.ts';

export namespace ALInboundDurableEffectStore {
    export interface Dependencies {
        readonly backend: ALAdmissionWorkBackend;
        readonly namespace: string;
    }
}

/** Admission writes work atomically; the work port alone owns reservations and retry state. */
export class ALInboundDurableEffectStore {
    private readonly backend: ALAdmissionWorkBackend;
    private readonly namespace: string;

    constructor(dependencies: ALInboundDurableEffectStore.Dependencies) {
        this.backend = dependencies.backend;
        this.namespace = dependencies.namespace;
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
}
