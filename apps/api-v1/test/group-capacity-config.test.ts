import assert from 'node:assert/strict';

import { readApiGroupCapacityConfig } from '../src/runtime/group-formation/group-capacity-config.ts';

Deno.test('group capacity config defaults the member cap to 256', () => {
  assert.deepEqual(
    readApiGroupCapacityConfig(fakeEnv({})),
    { defaultMaxMembers: 256 },
  );
  assert.deepEqual(
    readApiGroupCapacityConfig(fakeEnv({ RALLAR_GROUP_DEFAULT_MAX_MEMBERS: '  ' })),
    { defaultMaxMembers: 256 },
  );
});

Deno.test('group capacity config accepts positive integer overrides and trims input', () => {
  assert.deepEqual(
    readApiGroupCapacityConfig(fakeEnv({ RALLAR_GROUP_DEFAULT_MAX_MEMBERS: ' 512 ' })),
    { defaultMaxMembers: 512 },
  );
  assert.deepEqual(
    readApiGroupCapacityConfig(fakeEnv({ RALLAR_GROUP_DEFAULT_MAX_MEMBERS: '1' })),
    { defaultMaxMembers: 1 },
  );
});

Deno.test('group capacity config disables the default cap on 0', () => {
  assert.deepEqual(
    readApiGroupCapacityConfig(fakeEnv({ RALLAR_GROUP_DEFAULT_MAX_MEMBERS: '0' })),
    { defaultMaxMembers: null },
  );
});

Deno.test('group capacity config rejects non-integer and negative values', () => {
  for (const invalid of ['-1', '1.5', 'many', 'NaN', 'Infinity']) {
    assert.throws(
      () => readApiGroupCapacityConfig(fakeEnv({ RALLAR_GROUP_DEFAULT_MAX_MEMBERS: invalid })),
      /RALLAR_GROUP_DEFAULT_MAX_MEMBERS must be a positive integer/,
    );
  }
});

function fakeEnv(values: Readonly<Record<string, string | undefined>>) {
  return {
    get(name: string): string | undefined {
      return values[name];
    },
  };
}
