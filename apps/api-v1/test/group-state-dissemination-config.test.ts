import assert from 'node:assert/strict';

import {
  groupStateDisseminationStartupLogLine,
  readApiGroupStateDisseminationConfig,
} from '../src/runtime/group-formation/group-state-dissemination-config.ts';

Deno.test('group-state dissemination defaults to dual-emit', () => {
  assert.deepEqual(
    readApiGroupStateDisseminationConfig(fakeEnv({})),
    { dissemination: 'dual-emit' },
  );
});

Deno.test('group-state dissemination accepts only the three explicit modes and trims input', () => {
  assert.deepEqual(
    readApiGroupStateDisseminationConfig(
      fakeEnv({ RALLAR_GROUP_STATE_DISSEMINATION: ' delta-primary ' }),
    ),
    { dissemination: 'delta-primary' },
  );
  assert.deepEqual(
    readApiGroupStateDisseminationConfig(
      fakeEnv({ RALLAR_GROUP_STATE_DISSEMINATION: 'snapshot-per-change' }),
    ),
    { dissemination: 'snapshot-per-change' },
  );
  assert.throws(
    () =>
      readApiGroupStateDisseminationConfig(
        fakeEnv({ RALLAR_GROUP_STATE_DISSEMINATION: 'delta' }),
      ),
    /RALLAR_GROUP_STATE_DISSEMINATION must be one of snapshot-per-change, dual-emit, delta-primary/,
  );
});

Deno.test('legacy formation damping forces snapshot-per-change regardless of the env value', () => {
  assert.deepEqual(
    readApiGroupStateDisseminationConfig(
      fakeEnv({ RALLAR_GROUP_FORMATION_DAMPING: 'legacy' }),
    ),
    { dissemination: 'snapshot-per-change' },
  );
  assert.deepEqual(
    readApiGroupStateDisseminationConfig(
      fakeEnv({
        RALLAR_GROUP_FORMATION_DAMPING: 'legacy',
        RALLAR_GROUP_STATE_DISSEMINATION: 'delta-primary',
      }),
    ),
    { dissemination: 'snapshot-per-change' },
  );
  assert.deepEqual(
    readApiGroupStateDisseminationConfig(
      fakeEnv({
        RALLAR_GROUP_FORMATION_DAMPING: 'damped',
        RALLAR_GROUP_STATE_DISSEMINATION: 'delta-primary',
      }),
    ),
    { dissemination: 'delta-primary' },
  );
});

Deno.test('an invalid dissemination value fails startup even under legacy damping', () => {
  assert.throws(
    () =>
      readApiGroupStateDisseminationConfig(
        fakeEnv({
          RALLAR_GROUP_FORMATION_DAMPING: 'legacy',
          RALLAR_GROUP_STATE_DISSEMINATION: 'bogus',
        }),
      ),
    /RALLAR_GROUP_STATE_DISSEMINATION must be one of snapshot-per-change, dual-emit, delta-primary/,
  );
});

Deno.test('group-state dissemination startup log exposes the active mode', () => {
  assert.equal(
    groupStateDisseminationStartupLogLine({ dissemination: 'dual-emit' }),
    'Rallar API-v1 group-state dissemination: dual-emit',
  );
});

function fakeEnv(values: Readonly<Record<string, string | undefined>>) {
  return {
    get(name: string): string | undefined {
      return values[name];
    },
  };
}
