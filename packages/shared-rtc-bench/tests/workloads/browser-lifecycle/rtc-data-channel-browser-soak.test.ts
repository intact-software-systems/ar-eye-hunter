import { spawnSync } from 'node:child_process';

it('keeps the browser lifecycle entry syntactically valid without running B05', () => {
  const result = spawnSync(
    'node',
    [
      '--check',
      'packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs',
    ],
    { encoding: 'utf8' },
  );
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});
