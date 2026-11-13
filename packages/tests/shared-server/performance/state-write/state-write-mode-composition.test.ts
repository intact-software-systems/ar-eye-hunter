import {
    mkdtemp,
    rm,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it
} from 'vitest';

import { runOwnedTestProcess } from '../../../hetzner/owned-test-process.ts';

const repository = path.resolve(__dirname, '../../../../..');

describe('existing state-write CLI native mode composition', () => {
    it.for(['disabled', 'enabled'])('dispatches %s diagnostics through the one runner', async (mode, context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'state-write-mode-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const preload = path.join(directory, 'preload.ts');
        await writeFile(
            preload,
            `import { plugin } from 'bun';
plugin({
    name: 'swap-state-write-runner',
    setup(build) {
        build.onLoad({ filter: /run-state-write-benchmark\\.ts$/ }, () => ({
            contents: 'export async function runStateWriteBenchmark(options, diagnostics) {\\n' +
                '    console.log(JSON.stringify({ mode: options.diagnostics.kind, composed: diagnostics !== undefined }));\\n' +
                '}',
            loader: 'ts'
        }));
    }
});
`
        );
        const output = await runOwnedTestProcess(context, {
            executable: 'bun',
            args: [
                'run',
                '--preload',
                preload,
                'apps/api-v1/scripts/perf/api-v1-state-write-concurrency-bench.ts',
                ...(mode === 'enabled' ? ['--diagnostics-dir=tmp/perf/mode-composition'] : [])
            ],
            options: { cwd: repository }
        });
        expect(JSON.parse(output.stdout)).toEqual({ mode, composed: mode === 'enabled' });
    });
});
