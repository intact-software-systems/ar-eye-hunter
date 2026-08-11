import type {
  ClientStateSnapshotReadOptions,
  GroupStateSnapshotReadOptions,
} from '@shared/api/state-snapshot-read.ts';

export class StateSnapshotReadQueryError extends Error {
  public readonly status = 400;

  public readonly code: 'invalid-state-revision' | 'invalid-group-causal-revision';

  public constructor(
    code: 'invalid-state-revision' | 'invalid-group-causal-revision',
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'StateSnapshotReadQueryError';
  }
}

export function readClientSnapshotPointQuery(
  query: URLSearchParams,
): ClientStateSnapshotReadOptions {
  const values = query.getAll('minStateRevision');
  if (values.length === 0) return {};
  if (values.length !== 1) {
    throw invalidClientFloor('minStateRevision must appear exactly once');
  }

  return { minStateRevision: readRevision(values[0], invalidClientFloor) };
}

export function readGroupSnapshotPointQuery(
  query: URLSearchParams,
): GroupStateSnapshotReadOptions {
  const groupValues = query.getAll('minGroupRevision');
  const presenceValues = query.getAll('minPresenceRevision');
  if (groupValues.length === 0 && presenceValues.length === 0) return {};
  if (groupValues.length !== 1 || presenceValues.length !== 1) {
    throw invalidGroupFloor(
      'minGroupRevision and minPresenceRevision must each appear exactly once',
    );
  }

  return {
    minCausalRevision: {
      groupRevision: readRevision(groupValues[0], invalidGroupFloor),
      presenceRevision: readRevision(presenceValues[0], invalidGroupFloor),
    },
  };
}

function readRevision(
  value: string,
  invalid: (message: string) => StateSnapshotReadQueryError,
): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw invalid('State revision must be a canonical non-negative integer');
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) {
    throw invalid('State revision must be a safe integer');
  }
  return revision;
}

function invalidClientFloor(message: string): StateSnapshotReadQueryError {
  return new StateSnapshotReadQueryError('invalid-state-revision', message);
}

function invalidGroupFloor(message: string): StateSnapshotReadQueryError {
  return new StateSnapshotReadQueryError('invalid-group-causal-revision', message);
}
