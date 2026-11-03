import type { ALMessage } from '../../al-contracts/al-contract.ts';

export interface RtcPublicationProofVerifierPort {
    verifyPublicationProof(message: ALMessage): Promise<boolean>;
    getVerifiedSignature(message: ALMessage): boolean;
}
