import { spawnSync } from 'node:child_process';

it('keeps the maintained no-RTT room-graph diagnostic checked', () => {
    const result = spawnSync(
        'deno',
        [
            'check',
            '--config',
            'packages/shared-rtc-bench/deno.json',
            'packages/shared-rtc-bench/diagnostics/rtc-room-graph-no-rtt-bench.ts'
        ],
        { encoding: 'utf8' }
    );
    expect(result.status, result.stderr).toBe(0);
});
