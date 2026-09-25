import type { ALDeliveryCarrier } from '../alm/delivery/al-delivery-lifecycle.ts';
import type { ALTargets } from './al-contract.ts';
import type {
    ALAckAlgo,
    ALAckOptions,
    ALEffectiveAlgorithm,
    ALQosCapabilities,
    ALQosNormalizationInput,
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

const AL_RECEIVER_DECLARING_ACK_ALGOS: readonly ALAckAlgo[] = ['none', 'hop', 'subtree', 'receiver'];

/**
 * One issue naming an unsupported algorithm/carrier/target pair (D42). `receiver` needs a logical audience, which
 * only a unicast addressee or a room has; a world, all or principal broadcast has none.
 */
export function validateALAckSupport(input: ALAckSupportInput): readonly ALQosIssue[] {
    const { algo, carrier, targets, capabilities } = input;
    const supported = capabilities.supportedAck.includes(algo) &&
        (algo !== 'receiver' || hasLogicalReceiverAudience(targets));
    return supported
        ? []
        : [{ aspect: 'ack', detail: `ack ${algo} is unsupported for ${carrier} ${toTargetsName(targets)} targets` }];
}

export function toALReceiverAckNormalizationInput(input: ALQosNormalizationInput): ALQosNormalizationInput {
    return { ...input, capabilities: { supportedAck: AL_RECEIVER_DECLARING_ACK_ALGOS, ...input.capabilities } };
}

/** A requested or defaulted `receiver` is kept: its support is admission's refusal, never a downgrade (D42). */
export function toALNormalizableAckAlgos(
    supported: readonly ALAckAlgo[],
    requested: ALRequestedAlgorithm<ALAckAlgo, ALAckOptions> | undefined,
    fallback: ALEffectiveAlgorithm<ALAckAlgo, ALAckOptions>
): readonly ALAckAlgo[] {
    return (requested ?? fallback).algo === 'receiver' ? [...supported, 'receiver'] : supported;
}

function hasLogicalReceiverAudience(targets: ALTargets | undefined): boolean {
    return targets !== undefined && (targets.mode !== 'broadcast' || targets.scope === 'room');
}

function toTargetsName(targets: ALTargets | undefined): string {
    if (targets === undefined) {
        return 'untargeted';
    }
    return targets.mode === 'broadcast' ? targets.scope : targets.mode;
}
