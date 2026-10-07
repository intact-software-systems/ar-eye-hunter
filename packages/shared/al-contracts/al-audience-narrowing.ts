import type { ALMessage, ALTargets } from './al-contract.ts';

export type ALAudienceNarrowing =
    | Readonly<{ kind: 'principal'; principalId: string; }>
    | Readonly<{ kind: 'list'; recipientPeerIds: readonly string[]; }>
    | Readonly<{ kind: 'leader'; sessionId: string; }>;

export interface ALAudienceSession {
    readonly sessionId: string;
    readonly principalId: string;
}

/** A principal broadcast that names no principal narrows its room to no session. */
export function toALAudienceNarrowing(targets: ALTargets | undefined): ALAudienceNarrowing | undefined {
    if (targets?.mode !== 'broadcast') {
        return undefined;
    }
    if (targets.scope === 'principal') {
        return targets.principalRef === undefined
            ? { kind: 'list', recipientPeerIds: [] }
            : { kind: 'principal', principalId: targets.principalRef.principalId };
    }
    return targets.recipientPeerIds === undefined
        ? undefined
        : { kind: 'list', recipientPeerIds: targets.recipientPeerIds };
}

export function isALAudienceSession(session: ALAudienceSession, narrowing: ALAudienceNarrowing | undefined): boolean {
    switch (narrowing?.kind) {
        case undefined:
            return true;
        case 'principal':
            return session.principalId === narrowing.principalId;
        case 'list':
            return narrowing.recipientPeerIds.includes(session.sessionId);
        case 'leader':
            return session.sessionId === narrowing.sessionId;
    }
}

/**
 * A `group-leader` room send narrows the audience its sender names to the room's leader, the session its carrier
 * resolves from the room snapshot it admits with (D164). A room without one narrows to no session.
 */
export function toALLeaderNarrowing(
    message: Pick<ALMessage, 'delivery'>,
    leaderSessionId: string | undefined
): ALAudienceNarrowing | undefined {
    if (message.delivery?.ack !== 'group-leader') {
        return undefined;
    }
    return leaderSessionId === undefined
        ? { kind: 'list', recipientPeerIds: [] }
        : { kind: 'leader', sessionId: leaderSessionId };
}
