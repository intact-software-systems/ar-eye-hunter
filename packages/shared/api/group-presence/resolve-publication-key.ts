import type { GroupPresencePublicationKey, GroupSnapshot } from '../group-types.ts';

/** The key an active session registered on its presence row; `null` when it registered none or is not active. */
export function resolvePublicationKey(
    snapshot: GroupSnapshot,
    sessionId: string
): GroupPresencePublicationKey | null {
    return snapshot.activeSessions.find((session) => session.sessionId === sessionId)?.publicationKey ?? null;
}
