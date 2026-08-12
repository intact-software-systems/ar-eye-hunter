import { spawnSync } from 'node:child_process';

const entries = [
  'webrtc-group-cache-fallback-bench.ts',
  'webrtc-group-manager-state-bench.ts',
  'webrtc-group-manager-peer-owners-bench.ts',
  'webrtc-heartbeat-callback-churn-bench.ts',
] as const;

it('keeps each group-coordination benchmark checked without running B04', () => {
  const result = spawnSync(
    'deno',
    [
      'check',
      '--config',
      'packages/shared-rtc-bench/deno.json',
      ...entries.map((entry) => `packages/shared-rtc-bench/workloads/group-coordination/${entry}`),
    ],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
});
