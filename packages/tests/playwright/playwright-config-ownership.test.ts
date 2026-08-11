import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import arEyeConfig from '../../../apps/ar-eye-hunter-v1/playwright.config.ts';
import rallarConfig from '../../../apps/rallar-black-box/playwright.config.ts';
import recipeConsoleConfig from '../../../apps/rallar-black-box/playwright.recipe-console.config.ts';
import relicConfig from '../../../apps/relic-hunters-v1/playwright.config.ts';

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

    expect(relicConfig.testDir).toBe('../../tests/playwright/relic-hunters');
    expect(relicConfig.use?.baseURL).toBe('http://127.0.0.1:5175');
    expect(relicConfig.webServer).toMatchObject({
      command: expect.stringContaining('npm --workspace relic-hunters-v1 run dev'),
    });

    expect(rallarConfig.testDir).toBe('../../tests/playwright/rallar-black-box');
    expect(rallarConfig.use?.baseURL).toBe('http://127.0.0.1:5176');

    expect(arEyeConfig.testDir).toBe('../../tests/playwright/ar-eye-hunter');
    expect(arEyeConfig.use?.baseURL).toBe('http://127.0.0.1:5186');
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

  test('pins the Recipe Console API origin for every Playwright web server', () => {
    const webServers = Array.isArray(recipeConsoleConfig.webServer)
      ? recipeConsoleConfig.webServer
      : [recipeConsoleConfig.webServer];

    expect(webServers).toHaveLength(2);
    for (const webServer of webServers) {
      expect(webServer?.env?.VITE_RALLAR_API_BASE_URL).toBe('http://localhost:8080');
    }
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
