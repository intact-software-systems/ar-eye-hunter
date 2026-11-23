import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { ReadableKeyedValues } from '@shared/cache/RepositoryInterfaces.ts';
import type { RtcPublicationProofVerifierPort } from '@shared/multicast/publication/rtc-publication-proof-verifier-port.ts';
import { RtcPublicationProofVerifier } from '@shared/multicast/publication/rtc-publication-proof-verifier.ts';
import { readRtcGroupSnapshotByRef } from '@shared/multicast/read-rtc-outbound-observation.ts';
import { toPublicationVerificationCrypto } from '@shared/signature/publication-crypto.ts';

import { ROOM_PUBLICATION_CRYPTO } from '../signature/publication-crypto-fixtures.ts';

/** A keyless page's verifier: it records nothing, so every frame that must carry a proof stays unverified. */
export const KEYLESS_PUBLICATION_VERIFIER: RtcPublicationProofVerifierPort = new RtcPublicationProofVerifier({
    crypto: { kind: 'unavailable' },
    findGroupSnapshot: () => undefined
});

/**
 * A page's verifier over its own room cache, as the browser composes it: it verifies the receipted room sends and
 * granted publications the page relays or receives (D756) against the keys its cached snapshot names.
 */
export function createRoomPublicationVerifier(
    groups: ReadableKeyedValues<string, GroupSnapshot>
): RtcPublicationProofVerifierPort {
    return new RtcPublicationProofVerifier({
        crypto: toPublicationVerificationCrypto(ROOM_PUBLICATION_CRYPTO.subtle),
        findGroupSnapshot: (groupRef) => readRtcGroupSnapshotByRef(groups, groupRef)
    });
}
