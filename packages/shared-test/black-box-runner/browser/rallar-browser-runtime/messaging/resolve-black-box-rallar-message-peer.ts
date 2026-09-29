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

/**
 * The roster names no role, so `receiver` resolves only while exactly one other session is live; sessions are told
 * apart by id, since hosted agents may share one principal (C11).
 */
export function resolveBlackBoxRallarMessagePeer(
    input: ResolveBlackBoxRallarMessagePeerInput
): Either<string, string> {
    if (input.toPeer === 'server') {
        return input.serverPeerId === undefined
            ? Either.ofLeft('the WS server named no peer id')
            : Either.ofRight(input.serverPeerId);
    }
    const others = (input.roomSessions ?? []).filter((session) =>
        session.status === 'active' && session.expiresAtEpochMs > input.nowMs &&
        session.sessionId !== input.ownSessionId
    );
    const [receiver] = others;
    return others.length === 1 && receiver !== undefined
        ? Either.ofRight(receiver.sessionId)
        : Either.ofLeft(`the room holds ${others.length} other live sessions, not exactly one`);
}
