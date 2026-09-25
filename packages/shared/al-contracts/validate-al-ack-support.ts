import type { ALDeliveryCarrier } from '../alm/delivery/al-delivery-lifecycle.ts';
import type { ALTargets } from './al-contract.ts';
import type {
    ALAckAlgo,
    ALAckOptions,
    ALQosCapabilities,
    ALQosNormalizationInput,
    ALRequestedAlgorithm
} from './al-policy.ts';

/** A requested QoS algorithm a carrier cannot honour for these targets; admission refuses it as `unsupported`. */
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

/** The ack algorithms of a carrier whose own receipt tracking implements the logical `receiver` receipt. */
const AL_RECEIVER_TRACKING_ACK_ALGOS: readonly ALAckAlgo[] = ['none', 'hop', 'subtree', 'receiver'];

/**
 * One issue naming an unsupported algorithm/carrier/target pair (D42). `receiver` confirms a frozen logical
 * audience, which only a unicast addressee or a room has; a world, all or principal broadcast has none.
 */
export function validateALAckSupport(input: ALAckSupportInput): readonly ALQosIssue[] {
    const { algo, carrier, targets, capabilities } = input;
    const supported = capabilities.supportedAck.includes(algo) &&
        (algo !== 'receiver' || hasLogicalReceiverAudience(targets));
    return supported
        ? []
        : [{ aspect: 'ack', detail: `ack ${algo} is unsupported for ${carrier} ${toTargetsName(targets)} targets` }];
}

/** Declares `receiver` for a carrier that tracks it; a provider that names its own ack set keeps that set. */
export function toALReceiverAckNormalizationInput(input: ALQosNormalizationInput): ALQosNormalizationInput {
    return { ...input, capabilities: { supportedAck: AL_RECEIVER_TRACKING_ACK_ALGOS, ...input.capabilities } };
}

/** A requested `receiver` normalizes as requested: whether a carrier supports it is admission's refusal, never a downgrade. */
export function toALNormalizableAckAlgos(
    supported: readonly ALAckAlgo[],
    requested: ALRequestedAlgorithm<ALAckAlgo, ALAckOptions> | undefined
): readonly ALAckAlgo[] {
    return requested?.algo === 'receiver' ? [...supported, 'receiver'] : supported;
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
