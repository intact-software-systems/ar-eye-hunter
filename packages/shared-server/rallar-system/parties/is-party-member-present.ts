import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { isClientSnapshotPresent } from '../client-state/is-client-snapshot-present.ts';

/** Party rosters additionally hide a member whose account is no longer active. */
export function isPartyMemberPresent(snapshot: ClientSnapshot | null, observedAtEpochMs: number): boolean {
    return snapshot?.principal.status === 'active' && isClientSnapshotPresent(snapshot, observedAtEpochMs);
}
