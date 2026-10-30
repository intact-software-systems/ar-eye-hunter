import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import { runOwnedTestProcess } from './owned-test-process.ts';

const repoRoot = path.resolve(__dirname, '../../..');

it.for(['api-v1', 'relic-hunter-server-v1', 'rallar-black-box-control-server'])(
    'keeps the %s frozen cache and controller services independent of npm workspace dependencies',
    { timeout: 30_000 },
    async (app, context) => {
        const serviceDirectory = await mkdtemp(path.join(tmpdir(), 'rallar-deno-services-'));
        context.onTestFinished(() => rm(serviceDirectory, { recursive: true, force: true }));
        const lockPath = path.join(repoRoot, 'apps', app, 'deno.lock');
        const originalLock = await readFile(lockPath, 'utf8');
        await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [
                '-euc',
                'source "$1"; configure_rallar_deno_environment "$2"; configure_rallar_deno_environment "$2"; deno cache --frozen --config "$3" "$4"',
                'deno-runtime-test',
                path.join(repoRoot, 'scripts/hosted-rallar/controller/rallar-deno-runtime.sh'),
                serviceDirectory,
                path.join(repoRoot, 'apps', app, 'deno.json'),
                path.join(repoRoot, 'apps', app, 'src/main.ts')
            ],
            options: { cwd: repoRoot, env: { ...process.env, DENO_NO_PACKAGE_JSON: '0' } }
        });
        for (const service of ['rallar-api-v1', 'rallar-black-box-control']) {
            await expect(readFile(path.join(serviceDirectory, `${service}.service.d`, 'deno-runtime.conf'), 'utf8'))
                .resolves.toBe('[Service]\nEnvironment=DENO_NO_PACKAGE_JSON=1\n');
        }
        await expect(readFile(lockPath, 'utf8')).resolves.toBe(originalLock);
    }
);
