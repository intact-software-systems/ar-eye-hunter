import type { ClientSnapshot } from '@shared/api/client-types.ts';

/** The canonical member presence shown by PartyReader; transport presenceState is not this predicate. */
export function isPartyMemberPresent(snapshot: ClientSnapshot | null | undefined, observedAtEpochMs: number): boolean {
    return snapshot?.principal.status === 'active' &&
        snapshot.activeSessions.some((session) =>
            session.status === 'active' && session.disconnectedAtEpochMs === null &&
            session.expiresAtEpochMs > observedAtEpochMs
        );
}
