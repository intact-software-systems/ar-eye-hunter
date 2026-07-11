import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, test } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const appRoot = join(repoRoot, 'apps/rallar-black-box');
const assertionScript = join(appRoot, 'scripts/assert-experience-chunks.ts');
const temporaryDirectories: string[] = [];

function run(command: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolveRun, reject) => {
        const child = spawn(command, args, {
            cwd,
            env: process.env,
            stdio: 'pipe',
        });
        let output = '';
        child.stdout.on('data', (chunk) => {
            output += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
            output += String(chunk);
        });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) {
                resolveRun();
                return;
            }
            reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${output}`));
        });
    });
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((directory) =>
            rm(directory, { recursive: true, force: true })
        )
    );
});

describe('Recipe Console build boundary', () => {
    test('ships mutually exclusive Recipe Console and legacy experience chunks', async () => {
        await expect(access(assertionScript)).resolves.toBeUndefined();

        const outputRoot = await mkdtemp(join(tmpdir(), 'rallar-experience-build-'));
        temporaryDirectories.push(outputRoot);

        await run(
            join(repoRoot, 'node_modules/.bin/vite'),
            [
                'build',
                '--outDir',
                outputRoot,
                '--emptyOutDir',
            ],
            appRoot
        );
        await run(
            process.execPath,
            [
                assertionScript,
                outputRoot,
            ],
            repoRoot
        );
    });
});
