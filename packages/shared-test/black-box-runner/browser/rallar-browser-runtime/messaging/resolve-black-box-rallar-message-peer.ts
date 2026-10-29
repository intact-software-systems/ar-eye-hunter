import type { GroupPresenceSession } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';

import type {
    BlackBoxRallarMessageSendInput,
    BlackBoxRallarRecipientPeer
} from '../black-box-rallar-operation-contracts.ts';

export interface ResolveBlackBoxRallarMessagePeerInput {
    readonly toPeer: NonNullable<BlackBoxRallarMessageSendInput['toPeer']>;
    readonly serverPeerId: string | undefined;
    readonly ownSessionId: string | undefined;
    /** Undefined while the page holds no snapshot of the room. */
    readonly roomSessions: readonly GroupPresenceSession[] | undefined;
    readonly nowMs: number;
}

export interface ResolveBlackBoxRallarRecipientPeerInput {
    readonly recipientPeer: BlackBoxRallarRecipientPeer;
    readonly ownSessionId: string | undefined;
    readonly ownPrincipalId: string | undefined;
    /** Undefined while the page holds no snapshot of the room. */
    readonly roomSessions: readonly GroupPresenceSession[] | undefined;
    /** Undefined while the room has no active director. */
    readonly leaderSessionId: string | undefined;
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
 * the one other live session whose principal is not the sender's. A room of three principals tells its two recipients
 * apart by the room's leader, the role the receiver takes there: `receiver` is the leader, `recipient-b` the one such
 * session beside it.
 */
export function resolveBlackBoxRallarRecipientPeer(
    input: ResolveBlackBoxRallarRecipientPeerInput
): Either<string, string> {
    if (input.roomSessions === undefined) {
        return Either.ofLeft('the page holds no snapshot of the room');
    }
    const others = toOtherLiveSessions(input.roomSessions, input).filter((session) =>
        session.principalId !== input.ownPrincipalId
    );
    return input.recipientPeer === 'receiver'
        ? resolveReceiver(others, input.leaderSessionId)
        : resolveBesideLeader(others, input.leaderSessionId);
}

function resolveReceiver(
    others: readonly GroupPresenceSession[],
    leaderSessionId: string | undefined
): Either<string, string> {
    const [receiver] = others;
    if (others.length === 1 && receiver !== undefined) {
        return Either.ofRight(receiver.sessionId);
    }
    const leader = others.find((session) => session.sessionId === leaderSessionId);
    if (leader !== undefined) {
        return Either.ofRight(leader.sessionId);
    }
    const count = `the room holds ${others.length} other live sessions of another principal, not exactly one`;
    const noLeader = leaderSessionId === undefined ? 'the room names no leader' : 'its leader is none of them';
    return Either.ofLeft(others.length === 0 ? count : `${count}, and ${noLeader}`);
}

function resolveBesideLeader(
    others: readonly GroupPresenceSession[],
    leaderSessionId: string | undefined
): Either<string, string> {
    const recipients = others.filter((session) => session.sessionId !== leaderSessionId);
    const [recipient] = recipients;
    return recipients.length === 1 && recipient !== undefined
        ? Either.ofRight(recipient.sessionId)
        : Either.ofLeft(
            `the room holds ${recipients.length} other live sessions of another principal beside its leader, not exactly one`
        );
}

function toOtherLiveSessions(
    roomSessions: readonly GroupPresenceSession[],
    own: Readonly<{ ownSessionId: string | undefined; nowMs: number; }>
): readonly GroupPresenceSession[] {
    return roomSessions.filter((session) =>
        session.status === 'active' && session.expiresAtEpochMs > own.nowMs && session.sessionId !== own.ownSessionId
    );
}
