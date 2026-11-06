import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { ClientMutationCommand, ClientMutationRead } from './client-mutation-contracts.ts';

export interface ClientPresenceTransition {
    readonly before: ClientSnapshot | null;
    readonly beforeAtEpochMs: number;
    readonly after: ClientSnapshot;
    readonly afterAtEpochMs: number;
}

/** An expiry represents the last visible session even when the canonical read already filtered it by time. */
export function computeClientPresenceTransition(
    command: ClientMutationCommand,
    read: ClientMutationRead,
    after: ClientSnapshot
): ClientPresenceTransition {
    const afterAtEpochMs = Math.max(read.audienceObservedAtEpochMs, command.facts.nowEpochMs);
    const oldSession = read.session?.value;
    const endsSession = command.operation === 'expireSession' || command.operation === 'disconnectSession' ||
        command.operation === 'disconnectAuthorisedWsSession';
    return {
        beforeAtEpochMs: endsSession && oldSession
            ? Math.min(afterAtEpochMs, oldSession.expiresAtEpochMs - 1)
            : afterAtEpochMs,
        before: endsSession && oldSession && read.snapshot
            ? {
                ...read.snapshot,
                activeSessions: [
                    ...read.snapshot.activeSessions.filter((session) => session.sessionId !== oldSession.sessionId),
                    oldSession
                ]
            }
            : read.snapshot,
        after,
        afterAtEpochMs
    };
}
