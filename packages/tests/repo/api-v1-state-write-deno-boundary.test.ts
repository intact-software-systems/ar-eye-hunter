import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

import { runOwnedTestProcess } from '../hetzner/owned-test-process.ts';

it('checks the hosted measurement with its declared environment and a frozen Deno lock', async (context) => {
    const root = path.resolve(__dirname, '../../..');
    const workflow = requireObject(load(readFileSync(
        path.join(root, '.github/workflows/api-v1-state-write-pr-measurement.yml'),
        'utf8'
    )));
    const environment = requireObject(requireObject(requireObject(workflow.jobs).compare).env);
    const lockPath = path.join(root, 'apps/api-v1/deno.lock');
    const lockBefore = readFileSync(lockPath, 'utf8');
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
    expect(readFileSync(lockPath, 'utf8')).toBe(lockBefore);
}, 35_000);

function requireObject(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Expected a workflow object');
    }
    return value as Record<string, unknown>;
}
