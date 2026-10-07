import type { GroupPresenceSession } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { BlackBoxRallarMessageSendInput } from '../black-box-rallar-operation-contracts.ts';

export interface ResolveBlackBoxRallarMessagePeerInput {
    readonly toPeer: NonNullable<BlackBoxRallarMessageSendInput['toPeer']>;
    readonly serverPeerId: string | undefined;
    readonly ownSessionId: string | undefined;
    /** Undefined while the page holds no snapshot of the room. */
    readonly roomSessions: readonly GroupPresenceSession[] | undefined;
    readonly nowMs: number;
}

export interface ResolveBlackBoxRallarRecipientPeerInput {
    readonly ownSessionId: string | undefined;
    readonly ownPrincipalId: string | undefined;
    /** Undefined while the page holds no snapshot of the room. */
    readonly roomSessions: readonly GroupPresenceSession[] | undefined;
    readonly nowMs: number;
}

/**
 * The roster names no role, so `receiver` resolves only while exactly one other session is live; sessions are told
 * apart by id, since hosted agents may share one principal.
 */
export function resolveBlackBoxRallarMessagePeer(
    input: ResolveBlackBoxRallarMessagePeerInput
): Either<string, string> {
    if (input.toPeer === 'server') {
        return input.serverPeerId === undefined
            ? Either.ofLeft('the WS server named no peer id')
            : Either.ofRight(input.serverPeerId);
    }
    if (input.roomSessions === undefined) {
        return Either.ofLeft('the page holds no snapshot of the room');
    }
    const others = toOtherLiveSessions(input.roomSessions, input);
    const [receiver] = others;
    return others.length === 1 && receiver !== undefined
        ? Either.ofRight(receiver.sessionId)
        : Either.ofLeft(`the room holds ${others.length} other live sessions, not exactly one`);
}

/**
 * A room that holds a second session of the sender's principal tells the receiver apart by principal: `receiver` is
 * the one other live session whose principal is not the sender's.
 */
export function resolveBlackBoxRallarRecipientPeer(
    input: ResolveBlackBoxRallarRecipientPeerInput
): Either<string, string> {
    if (input.roomSessions === undefined) {
        return Either.ofLeft('the page holds no snapshot of the room');
    }
    const receivers = toOtherLiveSessions(input.roomSessions, input).filter((session) =>
        session.principalId !== input.ownPrincipalId
    );
    const [receiver] = receivers;
    return receivers.length === 1 && receiver !== undefined
        ? Either.ofRight(receiver.sessionId)
        : Either.ofLeft(`the room holds ${receivers.length} other live sessions of another principal, not exactly one`);
}

function toOtherLiveSessions(
    roomSessions: readonly GroupPresenceSession[],
    own: Readonly<{ ownSessionId: string | undefined; nowMs: number; }>
): readonly GroupPresenceSession[] {
    return roomSessions.filter((session) =>
        session.status === 'active' && session.expiresAtEpochMs > own.nowMs && session.sessionId !== own.ownSessionId
    );
}
