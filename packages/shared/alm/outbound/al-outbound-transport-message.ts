import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodeALAdmissionRecord } from '../al-admission-value-validation.ts';
import { decodeALOutboundPreparedMessage } from './al-outbound-effect-validation.ts';

/** The admitted transport differences; message authority and payload live in the canonical row. */
export interface ALOutboundTransportMessage {
    readonly ingressPeerId: string | null;
    readonly forwarding: NonNullable<ALMessage['forwarding']> | null;
    readonly ttlHops: number | null;
    readonly diagnostics: NonNullable<ALMessage['diagnostics']> | null;
}

export function toALOutboundTransportMessage(message: ALMessage): ALOutboundTransportMessage {
    return {
        ingressPeerId: null,
        forwarding: message.forwarding ?? null,
        ttlHops: message.constraints?.ttlHops ?? null,
        diagnostics: message.diagnostics ?? null
    };
}

export function reconstructALOutboundTransportMessage(
    prepared: ALOutboundTransportMessage,
    canonical: ALMessage
): ALMessage {
    return {
        ...canonical,
        forwarding: prepared.forwarding ?? undefined,
        constraints: { ...canonical.constraints, ttlHops: prepared.ttlHops ?? undefined },
        diagnostics: prepared.diagnostics ?? undefined
    };
}

export function decodeALOutboundTransportMessage(value: unknown, canonical: ALMessage): ALOutboundTransportMessage {
    const prepared = decodeALAdmissionRecord(value, ['ingressPeerId', 'forwarding', 'ttlHops', 'diagnostics']);
    if (
        prepared.ingressPeerId !== null &&
        (typeof prepared.ingressPeerId !== 'string' || prepared.ingressPeerId.length === 0)
    ) {
        throw new TypeError('Captured transport ingress peer is invalid');
    }
    const message = decodeALOutboundPreparedMessage({
        ...canonical,
        forwarding: prepared.forwarding ?? undefined,
        constraints: { ...canonical.constraints, ttlHops: prepared.ttlHops ?? undefined },
        diagnostics: prepared.diagnostics ?? undefined
    }, canonical);
    return { ...toALOutboundTransportMessage(message), ingressPeerId: prepared.ingressPeerId };
}
