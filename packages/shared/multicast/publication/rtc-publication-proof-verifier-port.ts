import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALOutboundMessageRuntime } from '../../alm/outbound/al-outbound-message-runtime.ts';

export interface RtcPublicationProofVerifierPort {
    verifyPublicationProof(message: ALMessage, clock: ALOutboundMessageRuntime.Clock): Promise<boolean>;
    getVerifiedSignature(message: ALMessage): boolean;
}
