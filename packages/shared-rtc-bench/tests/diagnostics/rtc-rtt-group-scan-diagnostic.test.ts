import { spawnSync } from 'node:child_process';

it('keeps the maintained RTT group-scan diagnostic checked', () => {
    const result = spawnSync(
        'deno',
        [
            'check',
            '--config',
            'packages/shared-rtc-bench/deno.json',
            'packages/shared-rtc-bench/diagnostics/rtc-rtt-group-scan-bench.ts'
        ],
        { encoding: 'utf8' }
    );
    expect(result.status, result.stderr).toBe(0);
});
