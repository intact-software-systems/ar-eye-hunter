import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

import { requireRecord } from '../../shared/api/exact-object-decoding.ts';
import { runOwnedTestProcess } from '../hetzner/owned-test-process.ts';

it('checks the hosted measurement with its declared environment and a frozen Deno lock', async (context) => {
    const root = path.resolve(__dirname, '../../..');
    const workflow = requireRecord(load(readFileSync(
        path.join(root, '.github/workflows/api-v1-state-write-pr-measurement.yml'),
        'utf8'
    )), 'measurement workflow');
    const jobs = requireRecord(workflow.jobs, 'workflow jobs');
    const job = requireRecord(jobs.compare, 'comparison job');
    const environment = requireRecord(job.env, 'measurement environment');
    const isolation = environment.DENO_NO_PACKAGE_JSON;
    if (isolation !== undefined && typeof isolation !== 'string') {
        throw new TypeError('The workflow Deno isolation setting must be text');
    }

    await expect(runOwnedTestProcess(context, {
        executable: 'deno',
        args: [
            'check',
            '--frozen',
            '--config',
            'apps/api-v1/deno.json',
            'apps/api-v1/scripts/perf/api-v1-state-write-concurrency-bench.ts'
        ],
        options: { cwd: root, env: { ...process.env, DENO_NO_PACKAGE_JSON: isolation }, timeout: 30_000 }
    })).resolves.toBeDefined();
}, 35_000);
