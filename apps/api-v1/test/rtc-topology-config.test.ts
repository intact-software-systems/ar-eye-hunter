import assert from 'node:assert/strict';
import { getApiRtcTopologyServiceOptions } from '../src/services/rtc-topology-config.ts';

Deno.test('API RTC topology options are read from environment', () => {
  const env = fakeEnv({
    RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT: '7',
    RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE: '3',
    RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: '51',
    RALLAR_RTC_TOPOLOGY_MESH_PARAM_K: '4',
    RALLAR_RTC_TOPOLOGY_RTT_REBUILD_DEBOUNCE_MS: '125',
  });

  assert.deepEqual(getApiRtcTopologyServiceOptions(env), {
    degreeLimit: 7,
    treeMinSize: 3,
    meshMinSize: 51,
    meshParamK: 4,
    rttRebuildDebounceMs: 125,
  });
});

Deno.test('API RTC topology options ignore unset and invalid values', () => {
  const env = fakeEnv({
    RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT: '0',
    RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE: 'nope',
    RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: '-1',
    RALLAR_RTC_TOPOLOGY_MESH_PARAM_K: '',
    RALLAR_RTC_TOPOLOGY_RTT_REBUILD_DEBOUNCE_MS: 'not-ms',
  });

  assert.deepEqual(getApiRtcTopologyServiceOptions(env), {});
});

function fakeEnv(values: Record<string, string | undefined>): Readonly<{
  get(name: string): string | undefined;
}> {
  return {
    get(name: string): string | undefined {
      return values[name];
    },
  };
}
