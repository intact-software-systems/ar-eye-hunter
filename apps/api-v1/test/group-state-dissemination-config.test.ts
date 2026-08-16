import assert from 'node:assert/strict';

import {
  groupStateDisseminationStartupLogLine,
  readApiGroupStateDisseminationConfig,
} from '../src/runtime/group-formation/group-state-dissemination-config.ts';

Deno.test('group-state dissemination defaults to delta-primary', () => {
  assert.deepEqual(
    readApiGroupStateDisseminationConfig(fakeEnv({})),
    { dissemination: 'delta-primary' },
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

// Formation damping no longer overrides dissemination. The override existed so
// the issue-156 replay proof kept bit-for-bit legacy emission; that proof is
// now mode-independent, and silently rewriting an explicitly configured
// dissemination mode because an unrelated knob was set is a trap.
Deno.test('formation damping does not override the configured dissemination mode', () => {
  for (const damping of ['legacy', 'damped']) {
    assert.deepEqual(
      readApiGroupStateDisseminationConfig(
        fakeEnv({
          RALLAR_GROUP_FORMATION_DAMPING: damping,
          RALLAR_GROUP_STATE_DISSEMINATION: 'dual-emit',
        }),
      ),
      { dissemination: 'dual-emit' },
    );
    assert.deepEqual(
      readApiGroupStateDisseminationConfig(fakeEnv({ RALLAR_GROUP_FORMATION_DAMPING: damping })),
      { dissemination: 'delta-primary' },
    );
  }
});

Deno.test('an invalid dissemination value fails startup under any damping mode', () => {
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
