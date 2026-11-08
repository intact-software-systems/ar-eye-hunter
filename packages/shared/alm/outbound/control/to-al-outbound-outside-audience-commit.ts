import type { ALOutboundPendingAckSnapshot } from '../../al-runtime-state-stores.ts';
import type { ALOutboundPendingAckRef } from '../admission/al-outbound-admission-keys.ts';
import type {
    ALOutboundCommitBundle,
    ALOutboundVersionedClientRecord
} from '../admission/al-outbound-admission-store.ts';
import type { ALStoredOutboundMessage } from '../admission/al-outbound-admission-validation.ts';
import { acceptALOutboundOutsideAudienceNack } from '../transition-al-outbound-pending-ack.ts';

/** What the server's own receipt holds, read in one session before it records recipients outside it. */
export interface ALOutboundOutsideAudienceSurface {
    readonly clientRecord: ALOutboundVersionedClientRecord | undefined;
    readonly pending: ALOutboundPendingAckSnapshot | undefined;
    readonly stored: ALStoredOutboundMessage | undefined;
}

export interface ALOutboundOutsideAudienceCommitInput extends ALOutboundOutsideAudienceSurface {
    readonly receipt: ALOutboundPendingAckRef;
    readonly recipientPeerIds: readonly string[];
}

/** No receipt to record in, every recipient already outside, or the receipt row to write under the origin's fence. */
export type ALOutboundOutsideAudienceCommit<TPrepared> =
    | Readonly<{ status: 'absent' | 'committed'; }>
    | Readonly<{ status: 'write'; bundle: ALOutboundCommitBundle<TPrepared>; }>;

/** Folds each recipient the receipt expects into its outside class, as an outside-audience NACK from it would. */
export function toALOutboundOutsideAudienceCommit<TPrepared>(
    input: ALOutboundOutsideAudienceCommitInput
): ALOutboundOutsideAudienceCommit<TPrepared> {
    const { pending, stored, receipt } = input;
    if (pending === undefined || stored === undefined) {
        return { status: 'absent' };
    }
    const snapshot = input.recipientPeerIds
        .filter((peerId) => pending.expectedPeerIds.includes(peerId))
        .reduce(acceptALOutboundOutsideAudienceNack, pending);
    if (snapshot.outsideAudiencePeerIds.length === pending.outsideAudiencePeerIds.length) {
        return { status: 'committed' };
    }
    return {
        status: 'write',
        bundle: {
            senderId: receipt.originPeerId,
            expectedVersion: input.clientRecord?.version,
            mutations: [{
                kind: 'set-pending-ack',
                originPeerId: receipt.originPeerId,
                snapshot,
                expireAtTimestamp: stored.reference.expiresAtMs
            }],
            durableEffects: []
        }
    };
}
