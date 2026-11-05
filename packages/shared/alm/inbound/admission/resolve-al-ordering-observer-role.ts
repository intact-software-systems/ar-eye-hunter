import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { resolveALFrozenMulticastAudience } from '../../../al-contracts/al-frozen-multicast-audience.ts';
import type { ALOrderingObserverRole } from '../../../al-contracts/al-runtime.ts';

/**
 * Which tracks an inbound runtime observes, fixed where it is composed: `addressed` for a session, which observes only
 * copies addressed to it, `every-track` for the WS server, which stays its clients' ordering hop.
 */
export type ALOrderingObserver = 'addressed' | 'every-track';

export interface ResolveALOrderingObserverRoleInput {
    readonly msg: ALMessage;
    readonly selfPeerId: string;
    /** Whether this admission delivers the copy here, now or on its release from a gap's buffer. */
    readonly delivering: boolean;
    readonly observer: ALOrderingObserver;
}

/**
 * A position depends only on the copies addressed to the session: one it delivers is observed in order, one frozen to
 * it that it may not deliver is witnessed, and a peer outside the frozen audience or a pure relay observes nothing.
 * The receipt mode is not read, so an unreceipted frozen copy is witnessed too.
 */
export function resolveALOrderingObserverRole(input: ResolveALOrderingObserverRoleInput): ALOrderingObserverRole {
    if (input.observer === 'every-track' || input.delivering) {
        return 'recipient';
    }
    const frozen = resolveALFrozenMulticastAudience(input.msg.targets);
    return frozen?.recipientPeerIds.includes(input.selfPeerId) === true ? 'witness' : 'none';
}
