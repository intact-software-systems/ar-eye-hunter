import type { ALTargets } from './al-contract.ts';

export type ALAudienceNarrowing =
    | Readonly<{ kind: 'principal'; principalId: string; }>
    | Readonly<{ kind: 'list'; recipientPeerIds: readonly string[]; }>;

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
    }
}
