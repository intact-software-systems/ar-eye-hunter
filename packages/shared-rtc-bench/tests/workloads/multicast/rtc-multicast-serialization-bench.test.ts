import { spawnSync } from 'node:child_process';

it('keeps the multicast benchmark as a checked, non-executed B04 entry', () => {
  const result = spawnSync(
    'deno',
    [
      'check',
      '--config',
      'packages/shared-rtc-bench/deno.json',
      'packages/shared-rtc-bench/workloads/multicast/rtc-multicast-serialization-bench.ts',
    ],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
});
