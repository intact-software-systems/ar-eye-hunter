import { spawnSync } from 'node:child_process';

it('keeps the maintained RTT group-scan diagnostic checked', () => {
    const result = spawnSync(
        'bunx',
        ['tsc', '-p', 'packages/shared-rtc-bench/tsconfig.json', '--noEmit'],
        { encoding: 'utf8' }
    );
    expect(result.status, result.stderr).toBe(0);
});
