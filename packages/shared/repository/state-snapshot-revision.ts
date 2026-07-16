export type StateSnapshotRevisionDecision =
    | 'inserted'
    | 'advanced'
    | 'duplicate'
    | 'stale'
    | 'legacy-refreshed';

export type StateSnapshotObservation =
    | 'inserted'
    | 'advanced'
    | 'duplicate'
    | 'stale';

export function toStateSnapshotObservation(
    decision: StateSnapshotRevisionDecision,
): StateSnapshotObservation {
    return decision === 'legacy-refreshed' ? 'advanced' : decision;
}

export class StateSnapshotRevisionConflictError extends Error {
    constructor(
        readonly entity: 'Client' | 'Group',
        readonly revision: number,
    ) {
        super(`${entity} snapshot revision conflict at revision ${revision}`);
        this.name = 'StateSnapshotRevisionConflictError';
    }
}

export function decideStateSnapshotRevision<T>(input: Readonly<{
    entity: 'Client' | 'Group';
    current?: T;
    incoming: T;
    stateRevisionOf: (value: T) => number | undefined;
    legacyVersionOf: (value: T) => number;
    equals: (left: T, right: T) => boolean;
}>): StateSnapshotRevisionDecision {
    if (!input.current) {
        return 'inserted';
    }

    const currentRevision = input.stateRevisionOf(input.current);
    const incomingRevision = input.stateRevisionOf(input.incoming);
    if (currentRevision !== undefined || incomingRevision !== undefined) {
        if (currentRevision === undefined) {
            return 'advanced';
        }
        if (incomingRevision === undefined || incomingRevision < currentRevision) {
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

    const currentVersion = input.legacyVersionOf(input.current);
    const incomingVersion = input.legacyVersionOf(input.incoming);
    if (incomingVersion > currentVersion) {
        return 'advanced';
    }
    if (incomingVersion < currentVersion) {
        return 'stale';
    }
    if (input.equals(input.current, input.incoming)) {
        return 'duplicate';
    }
    return 'legacy-refreshed';
}
