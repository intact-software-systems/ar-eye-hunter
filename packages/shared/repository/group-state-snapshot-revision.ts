import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import {
    compareGroupCausalRevision,
    readGroupCausalRevision,
} from '@shared/api/group-client-views.ts';
import { jsonEquals } from './state-utils.ts';
import {
    type StateSnapshotRevisionDecision,
    StateSnapshotRevisionConflictError,
} from './state-snapshot-revision.ts';

export class GroupStateSnapshotIncomparableError extends Error {
    constructor(readonly groupRef: GroupRef) {
        super('Group snapshot causal tuple is incomparable');
        this.name = 'GroupStateSnapshotIncomparableError';
    }
}

export function decideGroupSnapshotCausalRevision(
    current: GroupSnapshot | undefined,
    incoming: GroupSnapshot,
): StateSnapshotRevisionDecision {
    if (!current) return 'inserted';

    const order = compareGroupCausalRevision(
        readGroupCausalRevision(incoming),
        readGroupCausalRevision(current),
    );
    if (order === 'dominates') return 'advanced';
    if (order === 'dominated') return 'stale';
    if (order === 'incomparable') return 'incomparable';
    if (jsonEquals(current, incoming)) return 'duplicate';

    throw new StateSnapshotRevisionConflictError(
        'Group',
        incoming.stateRevision,
    );
}
