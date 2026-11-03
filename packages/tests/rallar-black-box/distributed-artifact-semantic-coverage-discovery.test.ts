import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const playwrightCli = createRequire(import.meta.url).resolve('@playwright/test/cli');

const importedArtifactTestTitle = 'imports CI artifact files through the Runs panel and renders their analysis';
const configuredMonitorTestTitle = 'completes the configured live distributed run lifecycle and exports its artifact';

describe('distributed artifact acceptance discovery', () => {
    it('lists the human-facing Runs import workflow in the browser suite', () => {
        const listed = listPlaywrightTests([
            '--config',
            'apps/rallar-black-box/playwright.config.ts',
            'tests/playwright/rallar-black-box/tabbed-navigation.spec.ts'
        ]);

        expect(listed).toContain(importedArtifactTestTitle);
    }, 20_000);

    it('keeps the configured Monitor proof in the canonical fresh-Postgres command', () => {
        const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
            scripts?: Record<string, string>;
        };
        const command = packageJson.scripts?.['test:rallar:full-stack:postgres:distributed'];

        expect(command).toContain('RALLAR_BLACK_BOX_REQUIRE_FRESH_POSTGRES_API=1');
        expect(command).toContain(
            'tests/playwright/rallar-black-box/full-stack-recipe-console-monitor.spec.ts'
        );

        const listed = listPlaywrightTests([
            '--config',
            'apps/rallar-black-box/playwright.full-stack.config.ts',
            'tests/playwright/rallar-black-box/full-stack-recipe-console-monitor.spec.ts'
        ], {
            RALLAR_BLACK_BOX_FULL_STACK: '1',
            RALLAR_BLACK_BOX_REQUIRE_FRESH_POSTGRES_API: '1'
        });
        expect(listed).toContain(configuredMonitorTestTitle);
    }, 20_000);
});

function listPlaywrightTests(
    args: readonly string[],
    env: Readonly<Record<string, string>> = {}
): string {
    // Listing loads real Playwright configuration and test modules; bound that child separately.
    const result = spawnSync(process.execPath, [playwrightCli, 'test', '--list', ...args], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, ...env }
    });
    const output = `${result.stdout}${result.stderr}${result.error?.message ?? ''}`;
    expect(result.status, output).toBe(0);
    return output;
}
