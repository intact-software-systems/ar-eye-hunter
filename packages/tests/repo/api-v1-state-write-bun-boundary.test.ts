import path from 'node:path';
import { expect, it } from 'vitest';

import { runOwnedTestProcess } from '../hetzner/owned-test-process.ts';

it('checks the hosted measurement compiles under Bun', async (context) => {
    const root = path.resolve(__dirname, '../../..');

    await expect(runOwnedTestProcess(context, {
        executable: 'bun',
        args: [
            'build',
            '--no-bundle',
            'apps/api-v1/scripts/perf/api-v1-state-write-concurrency-bench.ts'
        ],
        options: { cwd: root, timeout: 30_000 }
    })).resolves.toBeDefined();
}, 35_000);
