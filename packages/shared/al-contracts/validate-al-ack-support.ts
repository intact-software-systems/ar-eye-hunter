import type { ALDeliveryCarrier } from '../alm/delivery/al-delivery-lifecycle.ts';
import type { ALTargets } from './al-contract.ts';
import type {
    ALAckAlgo,
    ALAckOptions,
    ALEffectiveAlgorithm,
    ALQosCapabilities,
    ALRequestedAlgorithm
} from './al-policy.ts';

export interface ALQosIssue {
    readonly aspect: 'ack';
    readonly detail: string;
}

export interface ALAckSupportInput {
    readonly algo: ALAckAlgo;
    readonly carrier: ALDeliveryCarrier;
    /** `undefined` for an untargeted message, which names no logical recipient to confirm. */
    readonly targets: ALTargets | undefined;
    readonly capabilities: ALQosCapabilities;
}

/**
 * One issue naming an unsupported algorithm/carrier/target pair (D42). `receiver` needs a logical audience, which
 * only a unicast addressee or a room has: a multicast, a room broadcast with or without its fixed list, or a
 * principal broadcast that names its room; a world or all broadcast has none. A WS unicast has its
 * addressee as its audience only when it names its room: the room's router delivers it and the server aggregates
 * the addressee's ACK (D53). One that names no room has no aggregate on the server and is refused. `leader` needs
 * a room audience its leader may be inside, so a unicast has none either (D166).
 */
export function validateALAckSupport(input: ALAckSupportInput): readonly ALQosIssue[] {
    const { algo, carrier, targets, capabilities } = input;
    const supported = capabilities.supportedAck.includes(algo) &&
        (algo !== 'receiver' || hasLogicalReceiverAudience(targets, carrier)) &&
        (algo !== 'leader' || hasRoomAudience(targets));
    return supported
        ? []
        : [{ aspect: 'ack', detail: `ack ${algo} is unsupported for ${carrier} ${toTargetsName(targets)} targets` }];
}

/** `receiver` and `leader` count logical recipients; `hop` and `subtree` count next hops, and `none` counts nothing. */
export function isALLogicalReceiptMode(algo: ALAckAlgo): boolean {
    return algo === 'receiver' || algo === 'leader';
}

/**
 * A requested or defaulted `receiver` or `leader` is kept: its support is admission's refusal, never a downgrade
 * (D42).
 */
export function toALNormalizableAckAlgos(
    supported: readonly ALAckAlgo[],
    requested: ALRequestedAlgorithm<ALAckAlgo, ALAckOptions> | undefined,
    fallback: ALEffectiveAlgorithm<ALAckAlgo, ALAckOptions>
): readonly ALAckAlgo[] {
    const algo = (requested ?? fallback).algo;
    return isALLogicalReceiptMode(algo) ? [...supported, algo] : supported;
}

function hasLogicalReceiverAudience(
    targets: ALTargets | undefined,
    carrier: ALDeliveryCarrier
): boolean {
    if (targets?.mode === 'unicast') {
        return carrier !== 'ws' || targets.groupRef !== undefined;
    }
    return hasRoomAudience(targets);
}

function hasRoomAudience(targets: ALTargets | undefined): boolean {
    return targets !== undefined && targets.mode !== 'unicast' && (
        targets.mode !== 'broadcast' ||
        targets.scope === 'room' ||
        (targets.scope === 'principal' && targets.groupRef !== undefined)
    );
}

function toTargetsName(targets: ALTargets | undefined): string {
    if (targets === undefined) {
        return 'untargeted';
    }
    return targets.mode === 'broadcast' ? targets.scope : targets.mode;
}
