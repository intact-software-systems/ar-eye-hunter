import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { isClientSnapshotSessionLive } from '../presence/snapshot-presence.ts';

/** Account presence as friends see it; transport presenceState is not this predicate. */
export function isClientSnapshotPresent(snapshot: ClientSnapshot | null, atEpochMs: number): boolean {
    return snapshot?.activeSessions.some((session) => isClientSnapshotSessionLive(session, atEpochMs)) === true;
}
