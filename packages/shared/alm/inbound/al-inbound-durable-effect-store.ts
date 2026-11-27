import type { ALDeliveryCarrier } from '../../al-contracts/al-control-value-codec.ts';
import { EntityStatus, NOT_COMPLETED_RETRYABLE_STATUSES } from '../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import { toError } from '../../resilience/to-error.ts';
import type { ALAdmissionBackend } from '../al-admission-backend.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type {
    ALAdmissionReadSession,
    ALAdmissionWorkBackend,
    ALAdmissionWorkWriteContext
} from '../al-admission-work-backend.ts';
import {
    computeALOrderingDeliveryPredecessorSeq,
    isALInboundDeliveryReaching
} from './admission/al-inbound-delivery-progress.ts';
import {
    assertALInboundDeliveryOwner,
    decodeALInboundBufferedSnapshot,
    decodeALInboundDeliveryProgress,
    decodeALInboundOrderingSnapshot,
    readALInboundBufferedMessage,
    type ALInboundBufferedSlot,
    type ALInboundOrderedDeliverySnapshot,
    type ALInboundResolvedDeliverySnapshot,
    type ALStoredInboundBufferedSnapshot
} from './al-inbound-ordering-validation.ts';
import {
    decodeALInboundWorkEntry,
    toALInboundWorkKey,
    type ALInboundDurableEffectWrite
} from './al-inbound-work-entry.ts';

export interface ALInboundOrderedDeliveryRead {
    readonly completedThrough: number;
    readonly predecessor: ALInboundDeliveryPredecessor | undefined;
}

export type ALInboundDeliveryPredecessor =
    | { readonly kind: 'effect'; }
    | { readonly kind: 'resync-required'; };

/** The delivery row a track's slot names, and the carrier whose lane claims it. */
export interface ALInboundOrderedSuccessor {
    readonly effectId: string;
    readonly carrier: ALDeliveryCarrier;
}

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

    /**
     * A delivery waits on the slot after the completed progress when one exists. Without one, it waits on its own
     * slot's predecessor: `seq - 1`, or the prior its admission read past an omission or at an entry, so the sequences
     * between that predecessor and `beforeSeq` were never this session's to deliver.
     */
    async readOrderedDelivery(trackKey: string, beforeSeq: number): Promise<ALInboundOrderedDeliveryRead> {
        return await this.backend.readWithin(async (session): Promise<ALInboundOrderedDeliveryRead> => {
            const progress = await session.read(
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
            const next = await this.readSlotMessage(
                session,
                await this.readSlot(session, trackKey, completedThrough + 1)
            );
            if (next !== undefined) {
                return { completedThrough, predecessor: await this.readDeliveryPredecessor(session, next) };
            }
            const own = await this.readSlot(session, trackKey, beforeSeq);
            const predecessorSeq = own === undefined
                ? beforeSeq - 1
                : computeALOrderingDeliveryPredecessorSeq(own.plan.orderingRuntime) ?? beforeSeq - 1;
            if (predecessorSeq <= completedThrough) {
                return { completedThrough, predecessor: undefined };
            }
            const predecessor = await this.readSlotMessage(
                session,
                await this.readReachingSlot(session, trackKey, predecessorSeq)
            );
            return {
                completedThrough,
                predecessor: predecessor === undefined
                    ? await this.readOrderingPredecessor(session, trackKey, predecessorSeq)
                    : await this.readDeliveryPredecessor(session, predecessor)
            };
        });
    }

    /** The delivery row the track's slot after `completedThrough` names, and that slot's carrier. */
    async readOrderedSuccessor(
        trackKey: string,
        completedThrough: number
    ): Promise<ALInboundOrderedSuccessor | undefined> {
        return await this.backend.readWithin(async (session) => {
            const next = await this.readSlot(session, trackKey, completedThrough + 1);
            return next?.delivery === undefined
                ? undefined
                : { effectId: next.delivery.effectId, carrier: next.carrier };
        });
    }

    private toBufferedSlot(trackKey: string, seq: number): ALInboundBufferedSlot {
        const prefix = `${this.namespace}:buffered:${trackKey}:`;
        return { trackKey, prefix, key: `${prefix}${seq}` };
    }

    private async readSlot(
        session: ALAdmissionReadSession,
        trackKey: string,
        seq: number
    ): Promise<ALStoredInboundBufferedSnapshot | undefined> {
        const slot = this.toBufferedSlot(trackKey, seq);
        return await session.read(slot.key, (value) => decodeALInboundBufferedSnapshot(value, slot));
    }

    /**
     * The slot whose completed delivery reaches `seq`: its own, read by its key, or on a miss one whose reach a bounded
     * hold extended past it, found among the track's slots.
     */
    private async readReachingSlot(
        session: ALAdmissionReadSession,
        trackKey: string,
        seq: number
    ): Promise<ALStoredInboundBufferedSnapshot | undefined> {
        const own = await this.readSlot(session, trackKey, seq);
        if (own !== undefined) {
            return own;
        }
        const { prefix } = this.toBufferedSlot(trackKey, seq);
        const slots = await session.list(
            prefix,
            (value, key) => decodeALInboundBufferedSnapshot(value, { trackKey, prefix, key })
        );
        return slots.find((slot) => isALInboundDeliveryReaching(slot.value, seq))?.value;
    }

    /** The slot's message, or `undefined` for no slot: none was read, or it expired with its message meanwhile. */
    private async readSlotMessage(
        session: ALAdmissionReadSession,
        stored: ALStoredInboundBufferedSnapshot | undefined
    ): Promise<ALInboundResolvedDeliverySnapshot | undefined> {
        return stored === undefined ? undefined : await readALInboundBufferedMessage({
            database: session,
            namespace: this.namespace,
            slot: this.toBufferedSlot(stored.trackKey, stored.seq),
            stored
        });
    }

    private async readOrderingPredecessor(
        database: Pick<ALAdmissionBackend, 'read'>,
        trackKey: string,
        expectedSeq: number
    ): Promise<ALInboundDeliveryPredecessor> {
        const ordering = await database.read(
            `${this.namespace}:ordering:${trackKey}`,
            decodeALInboundOrderingSnapshot
        );
        return {
            kind: ordering !== undefined && ordering.lastContiguousSeq < expectedSeq ? 'effect' : 'resync-required'
        };
    }

    private async readDeliveryPredecessor(
        session: ALAdmissionReadSession,
        snapshot: ALInboundOrderedDeliverySnapshot
    ): Promise<ALInboundDeliveryPredecessor> {
        if (snapshot.delivery === undefined) {
            return { kind: 'effect' };
        }
        const entry = await session.readWork(toALInboundWorkKey(this.namespace, snapshot.delivery.effectId));
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
