import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const importedArtifactTestTitle =
  'imports CI artifact files through the Runs panel and renders their analysis';
const configuredMonitorTestTitle =
  'completes the configured live distributed run lifecycle and exports its artifact';

describe('distributed artifact acceptance discovery', () => {
  it('lists the human-facing Runs import workflow in the browser suite', () => {
    const listed = listPlaywrightTests([
      '--config',
      'apps/rallar-black-box/playwright.config.ts',
      'tests/playwright/rallar-black-box/tabbed-navigation.spec.ts',
    ]);

    expect(listed).toContain(importedArtifactTestTitle);
  });

  it('keeps the configured Monitor proof in the canonical fresh-Postgres command', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const command = packageJson.scripts?.['test:rallar:full-stack:postgres:distributed'];

    expect(command).toContain('RALLAR_BLACK_BOX_REQUIRE_FRESH_POSTGRES_API=1');
    expect(command).toContain(
      'tests/playwright/rallar-black-box/full-stack-recipe-console-monitor.spec.ts',
    );

    const listed = listPlaywrightTests([
      '--config',
      'apps/rallar-black-box/playwright.full-stack.config.ts',
      'tests/playwright/rallar-black-box/full-stack-recipe-console-monitor.spec.ts',
    ], {
      RALLAR_BLACK_BOX_FULL_STACK: '1',
      RALLAR_BLACK_BOX_REQUIRE_FRESH_POSTGRES_API: '1',
    });
    expect(listed).toContain(configuredMonitorTestTitle);
  });
});

function listPlaywrightTests(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): string {
  const result = spawnSync('npx', ['playwright', 'test', '--list', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const output = `${result.stdout}${result.stderr}`;
  expect(result.status, output).toBe(0);
  return output;
}
