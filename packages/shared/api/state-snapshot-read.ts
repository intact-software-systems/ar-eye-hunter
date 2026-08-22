import type { GroupStateCausalRevision } from './group-types.ts';

export interface ClientStateSnapshotReadOptions {
    readonly minStateRevision?: number;
}

export interface GroupStateSnapshotReadOptions {
    readonly minCausalRevision?: GroupStateCausalRevision;
}

export type StateSnapshotReadSource = 'cache' | 'durable';

export interface StateSnapshotReadFound<T> {
    readonly status: 'found';
    readonly source: StateSnapshotReadSource;
    readonly snapshot: T;
}

export interface StateSnapshotReadNotFound {
    readonly status: 'not-found';
    readonly source: 'durable';
}

export interface StateSnapshotReadFloorNotSatisfied<T> {
    readonly status: 'floor-not-satisfied';
    readonly source: 'durable';
    readonly snapshot: T;
}

export type StateSnapshotReadResult<T> =
    | StateSnapshotReadFound<T>
    | StateSnapshotReadNotFound
    | StateSnapshotReadFloorNotSatisfied<T>;

export type StateSnapshotReadDiagnosticName =
    | 'rallar.rest.client-state-snapshot-read'
    | 'rallar.rest.group-state-snapshot-read';

export type StateSnapshotReadDiagnosticResult =
    | 'found'
    | 'not-found'
    | 'floor-not-satisfied'
    | 'error';

export type StateSnapshotReadFloorOutcome =
    | 'not-requested'
    | 'satisfied'
    | 'not-satisfied'
    | 'not-evaluated';

export type StateSnapshotReadCleanupOutcome =
    | 'not-attempted'
    | 'evicted'
    | 'changed-or-absent';

export interface StateSnapshotReadDiagnosticEvent {
    readonly name: StateSnapshotReadDiagnosticName;
    readonly source: StateSnapshotReadSource;
    readonly result: StateSnapshotReadDiagnosticResult;
    readonly floorOutcome: StateSnapshotReadFloorOutcome;
    readonly cleanupOutcome: StateSnapshotReadCleanupOutcome;
    readonly strictMode: boolean;
    readonly durationMs: number;
}

export type StateSnapshotReadDiagnosticsSink = (
    event: StateSnapshotReadDiagnosticEvent
) => void;
