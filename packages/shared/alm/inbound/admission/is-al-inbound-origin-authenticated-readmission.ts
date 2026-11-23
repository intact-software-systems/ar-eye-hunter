import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALAckAlgo } from '../../../al-contracts/al-policy.ts';
import { isALLogicalReceiptMode } from '../../../al-contracts/validate-al-ack-support.ts';
import type { ALInboundMessageOwner } from '../al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime } from '../al-inbound-message-runtime.ts';

export interface ALInboundOriginAuthenticationInput {
    readonly source: ALInboundMessageRuntime.Source;
    /** Whether this page's verifier verified the copy's publisher proof (`verifyPublicationProof`). */
    readonly proofVerified: boolean;
}

export interface IsALInboundOriginAuthenticatedReadmissionInput {
    readonly msg: ALMessage;
    /** The receipt this peer's plan answers the arriving copy with. */
    readonly ackAlgo: ALAckAlgo;
    /** Whether the arriving copy is origin-authenticated (`isALInboundOriginAuthenticated`). */
    readonly originAuthenticated: boolean;
    /** The first admission's owner row; absent once it expired, when the copy stays the duplicate its dedup row says. */
    readonly owner: ALInboundMessageOwner | undefined;
}

/**
 * A copy is origin-authenticated when the WS server delivered it, or when its origin's publisher proof verified here
 * (D756); no other evidence counts.
 */
export function isALInboundOriginAuthenticated(input: ALInboundOriginAuthenticationInput): boolean {
    return input.source.kind === 'trusted-server' || input.proofVerified;
}

/**
 * Ruling 1 (D756): an origin-authenticated room copy that asks a `receiver` or `leader` receipt is admitted as new over
 * a first admission that was not origin-authenticated, so a forger's unreceipted copy cannot make the origin's copy a
 * confirmed duplicate. Every other copy stays the duplicate its dedup row says: a `hop`, `subtree` or unreceipted copy,
 * whose WS fallback must not deliver twice what an unsigned RTC copy delivered, and a room unicast, which only its
 * origin's own channel carries over RTC, so an unsigned first admission of it is never a forger's.
 */
export function isALInboundOriginAuthenticatedReadmission(
    input: IsALInboundOriginAuthenticatedReadmissionInput
): boolean {
    return input.originAuthenticated && input.owner?.originAuthenticated === false &&
        isALLogicalReceiptMode(input.ackAlgo) && input.msg.targets?.mode !== 'unicast';
}
