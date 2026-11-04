import type { RallarBlackBoxTestFaultRewrite } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { resolvePublicationKey } from '@shared/api/group-presence/resolve-publication-key.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { TransportFaultRewrite } from '@shared/transport-faults/transport-fault-port.ts';

import { isLiveRoomSession } from './resolve-black-box-rallar-message-peer.ts';

export interface ResolveBlackBoxRallarFaultRewriteInput {
    readonly rewrite: RallarBlackBoxTestFaultRewrite;
    /** Undefined while the page holds no snapshot of the room. */
    readonly snapshot: GroupSnapshot | undefined;
    readonly nowMs: number;
}

/**
 * A forged sender is a real member: the principal's one live session in the page's room snapshot, and the key that
 * session registered, so a receiver finds the key and refuses the frame only for its signature.
 */
export function resolveBlackBoxRallarFaultRewrite(
    input: ResolveBlackBoxRallarFaultRewriteInput
): Either<string, TransportFaultRewrite> {
    const { rewrite, snapshot } = input;
    if (rewrite === 'strip-proof') {
        return Either.ofRight({ kind: 'strip-proof' });
    }
    if (snapshot === undefined) {
        return Either.ofLeft('the page holds no snapshot of the room');
    }
    const { principal } = rewrite.forgeSender;
    const sessions = snapshot.activeSessions.filter((session) =>
        session.principalId === principal && isLiveRoomSession(session, input.nowMs)
    );
    const [session] = sessions;
    if (sessions.length !== 1 || session === undefined) {
        return Either.ofLeft(`the room holds ${sessions.length} live sessions of ${principal}, not exactly one`);
    }
    const key = resolvePublicationKey(snapshot, session.sessionId);
    return key === null
        ? Either.ofLeft(`session ${session.sessionId} of ${principal} registered no publication key`)
        : Either.ofRight({ kind: 'forge-sender', senderId: session.sessionId, keyId: key.keyId });
}
