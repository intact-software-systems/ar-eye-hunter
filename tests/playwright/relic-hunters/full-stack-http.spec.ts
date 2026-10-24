import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('Relic HTTP commands preserve identity, replay, round progression and room lifecycle', async ({}, testInfo) => {
    test.skip(process.env.RELIC_HUNTERS_FULL_STACK !== '1', 'Requires the real embedded Relic server on port 8090.');
    const artifacts = testInfo.outputPath('relic-http-recipe');
    // The full-stack config owns the actual API lifecycle; this runs the reusable black-box contract against it.
    await promisify(execFile)('deno', [
        'run',
        '-A',
        'packages/shared-test/black-box-runner/scenario-black-box.ts',
        '-c',
        'packages/shared-test/black-box-runner/tests/relic/relic-game-idempotency.json',
        '--artifact-dir',
        artifacts
    ], {
        cwd: repositoryRoot,
        env: { ...process.env, RALLAR_API_BASE_URL: 'http://127.0.0.1:8090', RALLAR_BB_RUN_ID: randomUUID() },
        maxBuffer: 2 * 1024 * 1024
    });
    const reportPath = `${artifacts}/report.json`;
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    await testInfo.attach('Relic HTTP black-box report', { path: reportPath, contentType: 'application/json' });
    expect(report.summary.failure).toBe(0);
    expect(report.summary.postRunAssertions.failure).toBe(0);
});
