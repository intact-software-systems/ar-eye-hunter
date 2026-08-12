import { spawnSync } from 'node:child_process';

it('keeps the maintained RTT traffic diagnostic checked', { timeout: 30_000 }, () => {
  const result = spawnSync(
    'deno',
    [
      'check',
      '--config',
      'packages/shared-rtc-bench/deno.json',
      'packages/shared-rtc-bench/diagnostics/rtt-traffic/rtc-topology-rtt-traffic-metrics.ts',
    ],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
});
