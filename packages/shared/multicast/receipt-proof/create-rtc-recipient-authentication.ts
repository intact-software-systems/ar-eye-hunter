import { readALTargetGroupRef } from '../../al-contracts/al-contract.ts';
import type { ALOutboundRecipientAuthentication } from '../../alm/outbound/control/read-al-outbound-recipient-proof.ts';
import { resolvePublicationKey } from '../../api/group-presence/resolve-publication-key.ts';
import type { GroupSnapshot } from '../../api/group-types.ts';
import type { ReadableKeyedValues } from '../../cache/RepositoryInterfaces.ts';
import type { PublicationVerificationCrypto } from '../../signature/publication-crypto.ts';
import { readRtcGroupSnapshotByRef } from '../read-rtc-outbound-observation.ts';
import { RtcReceiptProofVerifier } from './rtc-receipt-proof-verifier.ts';

export interface CreateRtcRecipientAuthenticationInput {
    readonly crypto: PublicationVerificationCrypto;
    readonly groupCache: ReadableKeyedValues<string, GroupSnapshot>;
    readonly nowEpochMs: () => number;
}

/**
 * How an RTC origin knows who spoke a recipient's control: by its signature, against the key the origin froze for a
 * counted recipient, or, for a send that froze none, the key the message's room registers for the recipient while it
 * is a live session there (ruling 19).
 */
export function createRtcRecipientAuthentication(
    input: CreateRtcRecipientAuthenticationInput
): ALOutboundRecipientAuthentication {
    return {
        kind: 'signature',
        verifier: new RtcReceiptProofVerifier({ crypto: input.crypto, nowEpochMs: input.nowEpochMs }),
        readRecipientKey: (msg, peerId) => {
            const groupRef = readALTargetGroupRef(msg);
            const room = groupRef === undefined ? undefined : readRtcGroupSnapshotByRef(input.groupCache, groupRef);
            return (room === undefined ? null : resolvePublicationKey(room, peerId, input.nowEpochMs())) ?? undefined;
        }
    };
}
