import {
    mkdtemp,
    rm,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it
} from 'vitest';

import { runOwnedTestProcess } from '../../../hetzner/owned-test-process.ts';

const repository = path.resolve(__dirname, '../../../../..');
const perf = path.join(repository, 'apps/api-v1/scripts/perf');

describe('existing state-write CLI native mode composition', () => {
    it.for(['disabled', 'enabled'])('dispatches %s diagnostics through the one runner', async (mode, context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'state-write-mode-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const runner = path.join(directory, 'runner.ts');
        await writeFile(
            runner,
            `export async function runStateWriteBenchmark(options, diagnostics) {
            console.log(JSON.stringify({ mode: options.diagnostics.kind, composed: diagnostics !== undefined }));
        }`
        );
        const imports = {
            '@shared/': pathToFileURL(path.join(repository, 'packages/shared/')).href,
            '@shared-server/': pathToFileURL(path.join(repository, 'packages/shared-server/')).href,
            '@shared-graph/': pathToFileURL(path.join(repository, 'packages/shared-graph/')).href,
            [pathToFileURL(path.join(perf, 'state-write/run-state-write-benchmark.ts')).href]: pathToFileURL(runner).href
        };
        const importMap = path.join(directory, 'imports.json');
        await writeFile(importMap, JSON.stringify({ imports }));
        const output = await runOwnedTestProcess(context, {
            executable: 'deno',
            args: [
                'run',
                '--no-check',
                '--allow-read',
                '--config',
                'apps/api-v1/deno.json',
                '--import-map',
                importMap,
                'apps/api-v1/scripts/perf/api-v1-state-write-concurrency-bench.ts',
                ...(mode === 'enabled' ? ['--diagnostics-dir=tmp/perf/mode-composition'] : [])
            ],
            options: { cwd: repository }
        });
        expect(JSON.parse(output.stdout)).toEqual({ mode, composed: mode === 'enabled' });
    });
});
