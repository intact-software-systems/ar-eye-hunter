import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALOrderingObservation } from '../../al-contracts/al-runtime.ts';
import type { ALDeliveryCarrier } from '../delivery/al-delivery-lifecycle.ts';

/** Where a receiver's ordering track stands, and what arrived, when it can no longer order the sender's messages. */
export interface ALInboundResyncCursor {
    readonly orderingKey: string;
    readonly senderId: string;
    readonly epoch: number;
    /** The last sequence the receiver delivered contiguously; `0` before any. */
    readonly lastContiguousSeq: number;
    /** The sequence the receiver expected next, `lastContiguousSeq + 1`. */
    readonly expectedSeq: number;
    /** The sequence that arrived and could not be ordered. */
    readonly observedSeq: number;
    readonly carrier: ALDeliveryCarrier;
}

/** The message a receiver admitted `resync-required`, or rejected at its ordered release, with its cursor. */
export interface ALInboundResyncRequired {
    readonly msg: ALMessage;
    readonly cursor: ALInboundResyncCursor;
}

export interface ALInboundResyncCursorInput {
    readonly msg: ALMessage;
    readonly observation: ALOrderingObservation;
    readonly carrier: ALDeliveryCarrier;
}

/** Undefined for an observation that is not a resynchronization, or that does not say where its track stands. */
export function toALInboundResyncCursor(input: ALInboundResyncCursorInput): ALInboundResyncCursor | undefined {
    const { msg, observation, carrier } = input;
    const orderingKey = msg.ordering?.orderingKey;
    const observedSeq = msg.ordering?.seq;
    if (
        observation.status !== 'resync-required' ||
        observation.trackKey === undefined ||
        observation.lastContiguousSeq === undefined ||
        observation.expectedSeq === undefined ||
        orderingKey === undefined ||
        observedSeq === undefined
    ) {
        return undefined;
    }
    return {
        orderingKey,
        senderId: msg.id.senderId,
        epoch: msg.ordering?.epoch ?? 0,
        lastContiguousSeq: observation.lastContiguousSeq,
        expectedSeq: observation.expectedSeq,
        observedSeq,
        carrier
    };
}
