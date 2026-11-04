import type { RtcPublicationProofVerifierPort } from '@shared/multicast/publication/rtc-publication-proof-verifier-port.ts';
import { RtcPublicationProofVerifier } from '@shared/multicast/publication/rtc-publication-proof-verifier.ts';

/** A keyless page's verifier: it records nothing, so every granted frame stays unverified. */
export const KEYLESS_PUBLICATION_VERIFIER: RtcPublicationProofVerifierPort = new RtcPublicationProofVerifier({
    crypto: { kind: 'unavailable' },
    findGroupSnapshot: () => undefined,
    nowEpochMs: Date.now
});
