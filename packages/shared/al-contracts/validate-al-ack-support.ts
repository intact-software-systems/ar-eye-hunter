import type { ALDeliveryCarrier } from '../alm/delivery/al-delivery-lifecycle.ts';
import type { ALTargets } from './al-contract.ts';
import type {
    ALAckAlgo,
    ALAckOptions,
    ALEffectiveAlgorithm,
    ALQosCapabilities,
    ALQosInputProvider,
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
 * only a unicast addressee or a room has; a world, all or principal broadcast has none. A WS unicast has an
 * addressee but no relay that carries its receiver ACK back to the origin, so it is refused too.
 */
export function validateALAckSupport(input: ALAckSupportInput): readonly ALQosIssue[] {
    const { algo, carrier, targets, capabilities } = input;
    const supported = capabilities.supportedAck.includes(algo) &&
        (algo !== 'receiver' || hasLogicalReceiverAudience(targets, carrier));
    return supported
        ? []
        : [{ aspect: 'ack', detail: `ack ${algo} is unsupported for ${carrier} ${toTargetsName(targets)} targets` }];
}

export function toALReceiverAckNormalizationInput(input: ALQosNormalizationInput): ALQosNormalizationInput {
    return { ...input, capabilities: { supportedAck: AL_RECEIVER_DECLARING_ACK_ALGOS, ...input.capabilities } };
}

/** The provider of a carrier that tracks logical receipts: it declares `receiver` unless the provider names its own set. */
export function toALReceiverAckQosInputProvider(provider: ALQosInputProvider | undefined): ALQosInputProvider {
    return {
        defaultsForMessage: (msg, context) => provider?.defaultsForMessage?.(msg, context),
        capabilitiesForMessage: (msg, context) => ({
            supportedAck: AL_RECEIVER_DECLARING_ACK_ALGOS,
            ...provider?.capabilitiesForMessage?.(msg, context)
        }),
        authorizationForMessage: (msg, context) => provider?.authorizationForMessage?.(msg, context),
        liveForMessage: (msg, context) => provider?.liveForMessage?.(msg, context)
    };
}

/** A requested or defaulted `receiver` is kept: its support is admission's refusal, never a downgrade (D42). */
export function toALNormalizableAckAlgos(
    supported: readonly ALAckAlgo[],
    requested: ALRequestedAlgorithm<ALAckAlgo, ALAckOptions> | undefined,
    fallback: ALEffectiveAlgorithm<ALAckAlgo, ALAckOptions>
): readonly ALAckAlgo[] {
    return (requested ?? fallback).algo === 'receiver' ? [...supported, 'receiver'] : supported;
}

function hasLogicalReceiverAudience(targets: ALTargets | undefined, carrier: ALDeliveryCarrier): boolean {
    if (targets?.mode === 'unicast') {
        return carrier !== 'ws';
    }
    return targets !== undefined && (targets.mode !== 'broadcast' || targets.scope === 'room');
}

function toTargetsName(targets: ALTargets | undefined): string {
    if (targets === undefined) {
        return 'untargeted';
    }
    return targets.mode === 'broadcast' ? targets.scope : targets.mode;
}
