import assert from 'node:assert/strict';
import {
  getApiRtcTopologyServiceOptions,
  readApiGlobalGraphRecomputeLimit,
} from '../src/services/rtc-topology-config.ts';

Deno.test('API RTC topology options are read from environment', () => {
  const env = fakeEnv({
    RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT: '7',
    RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT: '3',
    RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE: '3',
    RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: '51',
    RALLAR_RTC_TOPOLOGY_MESH_PARAM_K: '4',
    RALLAR_RTC_TOPOLOGY_RTT_REBUILD_DEBOUNCE_MS: '125',
  });

  assert.deepEqual(getApiRtcTopologyServiceOptions(env), {
    degreeLimit: 7,
    rttReportingDegreeLimit: 3,
    treeMinSize: 3,
    meshMinSize: 51,
    meshParamK: 4,
    rttRebuildDebounceMs: 125,
  });
});

Deno.test('API RTC topology options read RTT reporting degree from environment', () => {
  const env = fakeEnv({
    RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT: '3',
  });

  assert.deepEqual(getApiRtcTopologyServiceOptions(env), {
    rttReportingDegreeLimit: 3,
  });
});

Deno.test('API RTC topology options ignore unset and invalid values', () => {
  const env = fakeEnv({
    RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT: '0',
    RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT: '0',
    RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE: 'nope',
    RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: '-1',
    RALLAR_RTC_TOPOLOGY_MESH_PARAM_K: '',
    RALLAR_RTC_TOPOLOGY_RTT_REBUILD_DEBOUNCE_MS: 'not-ms',
  });

  assert.deepEqual(getApiRtcTopologyServiceOptions(env), {});
});

// Both bounds are required together: a window without a count, or a count
// without a window, would otherwise silently pair a configured value with a
// built-in default and produce a limit nobody asked for.
Deno.test('global graph recompute limit needs both bounds', () => {
  assert.deepEqual(
    readApiGlobalGraphRecomputeLimit(
      fakeEnv({
        RALLAR_RTC_TOPOLOGY_GLOBAL_GRAPH_RECOMPUTE_WINDOW_MS: '20000',
        RALLAR_RTC_TOPOLOGY_GLOBAL_GRAPH_RECOMPUTES_PER_WINDOW: '3',
      }),
    ),
    { windowMs: 20000, maxPerWindow: 3 },
  );

  for (
    const partial of [
      { RALLAR_RTC_TOPOLOGY_GLOBAL_GRAPH_RECOMPUTE_WINDOW_MS: '20000' },
      { RALLAR_RTC_TOPOLOGY_GLOBAL_GRAPH_RECOMPUTES_PER_WINDOW: '3' },
      { RALLAR_RTC_TOPOLOGY_GLOBAL_GRAPH_RECOMPUTE_WINDOW_MS: '0' },
      {
        RALLAR_RTC_TOPOLOGY_GLOBAL_GRAPH_RECOMPUTE_WINDOW_MS: '20000',
        RALLAR_RTC_TOPOLOGY_GLOBAL_GRAPH_RECOMPUTES_PER_WINDOW: '0',
      },
      {},
    ]
  ) {
    assert.equal(readApiGlobalGraphRecomputeLimit(fakeEnv(partial)), undefined);
  }
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
