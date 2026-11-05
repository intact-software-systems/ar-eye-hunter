import type { ClientSession } from '@shared/api/client-types.ts';
import type { GroupPolicyResult } from '@shared/api/group-policy-types.ts';

import { isClientSnapshotSessionLive } from '../../presence/snapshot-presence.ts';
import { denyGroupPolicy, GROUP_POLICY_ALLOWED } from './group-policy-result.ts';
import { holdsLiveGeneration } from './group-topic-subscription-policy.ts';

export interface CanConnectGroupPresenceAtGenerationInput {
    /** The session's active client-state rows, one per client instance holding it. */
    readonly clientSessions: readonly ClientSession[];
    readonly connectionGenerationId: string;
    readonly nowEpochMs: number;
}

/**
 * A presence connect asserted by a live session names one of its live connection generations, so the closing socket's
 * cleanup can find the row. A session with no live client-state row connects as before: REST-only presence holds no
 * socket whose generation could be compared.
 */
export function canConnectGroupPresenceAtGeneration(
    input: CanConnectGroupPresenceAtGenerationInput
): GroupPolicyResult {
    const live = input.clientSessions.filter((session) => isClientSnapshotSessionLive(session, input.nowEpochMs));
    if (live.length === 0 || holdsLiveGeneration(live, input.connectionGenerationId, input.nowEpochMs)) {
        return GROUP_POLICY_ALLOWED;
    }
    return denyGroupPolicy('stale-generation', 'The asserted connection generation is not a live one.');
}
