import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = process.cwd();

function readRepoFile(filePath: string): string {
    return readFileSync(path.join(repoRoot, filePath), 'utf8');
}

function readRootScripts(): Record<string, string> {
    const packageJson = JSON.parse(readRepoFile('package.json')) as {
        scripts?: Record<string, string>;
    };
    return packageJson.scripts ?? {};
}

describe('Playwright config ownership', () => {
    test('keeps app tests behind app-owned configs', () => {
        expect(existsSync(path.join(repoRoot, 'playwright.config.ts'))).toBe(false);

        const relicLocalConfig = readRepoFile('apps/relic-hunters-v1/playwright.config.ts');
        expect(relicLocalConfig).toContain("testDir: '../../tests/playwright/relic-hunters'");
        expect(relicLocalConfig).toContain("baseURL: 'http://127.0.0.1:5175'");
        expect(relicLocalConfig).toContain('npm --workspace relic-hunters-v1 run dev');

        const rallarLocalConfig = readRepoFile('apps/rallar-black-box/playwright.config.ts');
        expect(rallarLocalConfig).toContain("testDir: '../../tests/playwright/rallar-black-box'");
        expect(rallarLocalConfig).toContain("baseURL: 'http://127.0.0.1:5176'");

        const arEyeLocalConfig = readRepoFile('apps/ar-eye-hunter-v1/playwright.config.ts');
        expect(arEyeLocalConfig).toContain("testDir: '../../tests/playwright/ar-eye-hunter'");
        expect(arEyeLocalConfig).toContain("baseURL: 'http://127.0.0.1:5186'");
    });

    test('uses explicit app config paths in root Playwright scripts', () => {
        const scripts = readRootScripts();

        expect(scripts['test:rallar']).toContain('--config apps/rallar-black-box/playwright.config.ts');
        expect(scripts['test:playwright:relic']).toContain(
            '--config apps/relic-hunters-v1/playwright.config.ts',
        );
        expect(scripts['test:playwright:relic']).not.toMatch(
            /\bplaywright test tests\/playwright\/relic-hunters\b/,
        );
        expect(scripts['test:playwright:relic:full-stack']).toContain(
            '--config apps/relic-hunters-v1/playwright.full-stack.config.ts',
        );
    });

    test('documents the app to config mapping for Playwright suites', () => {
        const readme = readRepoFile('tests/playwright/README.md');

        expect(readme).toContain('apps/rallar-black-box/playwright.config.ts');
        expect(readme).toContain('apps/relic-hunters-v1/playwright.config.ts');
        expect(readme).toContain('apps/ar-eye-hunter-v1/playwright.config.ts');
        expect(readme).toContain('npm run test:rallar');
        expect(readme).toContain('npm run test:playwright:relic');
    });
});
