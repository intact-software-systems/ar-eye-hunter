import assert from 'node:assert/strict';

import {
  readClientSnapshotPointQuery,
  readGroupSnapshotPointQuery,
  StateSnapshotReadQueryError,
} from '../../src/routes/state-snapshot-read/state-snapshot-read-query.ts';

const INVALID_VALUES = [
  '',
  ' ',
  '+1',
  '-1',
  '01',
  '1.0',
  '1e1',
  'NaN',
  'Infinity',
  String(Number.MAX_SAFE_INTEGER + 1),
] as const;

Deno.test('client snapshot floor parser accepts only one canonical safe integer', () => {
  assert.deepEqual(readClientSnapshotPointQuery(new URLSearchParams()), {});
  assert.deepEqual(
    readClientSnapshotPointQuery(new URLSearchParams('minStateRevision=0')),
    { minStateRevision: 0 },
  );
  assert.deepEqual(
    readClientSnapshotPointQuery(
      new URLSearchParams(`minStateRevision=${Number.MAX_SAFE_INTEGER}`),
    ),
    { minStateRevision: Number.MAX_SAFE_INTEGER },
  );

  for (const value of INVALID_VALUES) {
    assert.throws(
      () =>
        readClientSnapshotPointQuery(
          new URLSearchParams([['minStateRevision', value]]),
        ),
      (error) => isQueryError(error, 'invalid-state-revision'),
    );
  }
  assert.throws(
    () =>
      readClientSnapshotPointQuery(
        new URLSearchParams('minStateRevision=1&minStateRevision=1'),
      ),
    (error) => isQueryError(error, 'invalid-state-revision'),
  );
});

Deno.test('group snapshot floor parser requires one complete canonical causal pair', () => {
  assert.deepEqual(readGroupSnapshotPointQuery(new URLSearchParams()), {});
  assert.deepEqual(
    readGroupSnapshotPointQuery(
      new URLSearchParams('minGroupRevision=3&minPresenceRevision=5'),
    ),
    { minCausalRevision: { groupRevision: 3, presenceRevision: 5 } },
  );

  for (
    const query of [
      'minGroupRevision=1',
      'minPresenceRevision=1',
      'minGroupRevision=1&minPresenceRevision=1&minPresenceRevision=1',
      ...INVALID_VALUES.map(
        (value) =>
          new URLSearchParams([
            ['minGroupRevision', value],
            ['minPresenceRevision', '1'],
          ]).toString(),
      ),
      ...INVALID_VALUES.map(
        (value) =>
          new URLSearchParams([
            ['minGroupRevision', '1'],
            ['minPresenceRevision', value],
          ]).toString(),
      ),
    ]
  ) {
    assert.throws(
      () => readGroupSnapshotPointQuery(new URLSearchParams(query)),
      (error) => isQueryError(error, 'invalid-group-causal-revision'),
    );
  }
});

function isQueryError(error: unknown, code: string): boolean {
  return error instanceof StateSnapshotReadQueryError &&
    error.status === 400 && error.code === code;
}
