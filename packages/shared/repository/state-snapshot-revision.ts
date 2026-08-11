export type StateSnapshotRevisionDecision =
    | 'inserted'
    | 'advanced'
    | 'duplicate'
    | 'stale'
    | 'incomparable';

export type StateSnapshotObservation =
    | 'inserted'
    | 'advanced'
    | 'duplicate'
    | 'stale'
    | 'incomparable';

export function toStateSnapshotObservation(
    decision: StateSnapshotRevisionDecision,
): StateSnapshotObservation {
    return decision;
}

export class StateSnapshotRevisionConflictError extends Error {
    readonly entity: 'Client' | 'Group';
    readonly revision: number;

    constructor(
        entity: 'Client' | 'Group',
        revision: number,
    ) {
        super(`${entity} snapshot revision conflict at revision ${revision}`);
        this.entity = entity;
        this.revision = revision;
        this.name = 'StateSnapshotRevisionConflictError';
    }
}

export function decideStateSnapshotRevision<T>(input: Readonly<{
    entity: 'Client' | 'Group';
    current?: T;
    incoming: T;
    stateRevisionOf: (value: T) => number;
    equals: (left: T, right: T) => boolean;
}>): StateSnapshotRevisionDecision {
    if (!input.current) {
        return 'inserted';
    }

    const currentRevision = input.stateRevisionOf(input.current);
    const incomingRevision = input.stateRevisionOf(input.incoming);
    if (incomingRevision < currentRevision) {
        return 'stale';
    }
    if (incomingRevision > currentRevision) {
        return 'advanced';
    }
    if (input.equals(input.current, input.incoming)) {
        return 'duplicate';
    }
    throw new StateSnapshotRevisionConflictError(
        input.entity,
        incomingRevision,
    );
}
