import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';

import { SCOPE } from './group-state-inbox-test-runtime.ts';

/** The stored planned layout a `connect` dials and an `activate` promotes, for a test group in {@link SCOPE}. */
export function connectPlannedSnapshot(
    groupId: string,
    identity: Readonly<{
        groupRevision: number;
        presenceRevision: number;
        version: number;
        state: 'active' | 'removed';
    }>
) {
    const groupRef = { ...SCOPE, groupId };
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: identity.groupRevision,
            presenceRevision: identity.presenceRevision
        },
        state: identity.state,
        overlayId: toScopedOverlayId(groupRef),
        groupRef,
        name: groupId,
        topology: 'tree' as const,
        activeSessionIds: [],
        nextHopsBySessionId: {},
        degreeLimit: 1,
        version: identity.version,
        createdByClientId: 'owner',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2
    };
}
