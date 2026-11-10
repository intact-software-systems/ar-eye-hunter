import {
    signALReceiptProof,
    type ALReceiptControl,
    type ALReceiptProofFailure,
    type ALReceiptProofSignerPort
} from '../../al-contracts/receipt-proof/al-receipt-proof.ts';
import { Either } from '../../resilience/Either.ts';
import type { PublicationCrypto } from '../../signature/publication-crypto.ts';
import type { SignatureProof } from '../../signature/signature-proof.ts';

export interface RtcReceiptProofSignerDependencies {
    readonly crypto: PublicationCrypto;
}

/** A session signs its own receipt controls with its page key, the one its room registers for it. */
export class RtcReceiptProofSigner implements ALReceiptProofSignerPort {
    private readonly crypto: PublicationCrypto;

    constructor(dependencies: RtcReceiptProofSignerDependencies) {
        this.crypto = dependencies.crypto;
    }

    async signReceiptProof(control: ALReceiptControl): Promise<Either<ALReceiptProofFailure, SignatureProof>> {
        const { crypto } = this;
        if (crypto.kind === 'unavailable') {
            return Either.ofLeft({
                kind: 'signing-unavailable',
                message: `This page cannot sign a receipt control: ${crypto.reason}.`
            });
        }
        return await signALReceiptProof({ subtle: crypto.subtle, keyPair: crypto.keyPair, control });
    }
}
