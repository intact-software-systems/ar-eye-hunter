import { describe, expect, it } from 'vitest';

import {
  authoredCodeRoots,
  generatedDirectoryExclusions,
  isAuthoredCodePath,
  toolMandatedFileExclusions,
} from '../../../../scripts/repo-structure-check/repository-files.mjs';

describe('repository structure authored-code scope', () => {
  it('covers every declared authored root and excludes outside paths', () => {
    expect(authoredCodeRoots).toEqual(['apps', 'packages', 'scripts', 'examples', 'tests']);
    for (const root of authoredCodeRoots) {
      expect(isAuthoredCodePath(`${root}/feature/module.ts`)).toBe(true);
      expect(isAuthoredCodePath(`${root}/feature/module.mjs`)).toBe(true);
      expect(isAuthoredCodePath(`${root}/feature/check.sh`)).toBe(true);
      expect(isAuthoredCodePath(`${root}/feature/styles.css`)).toBe(true);
      expect(isAuthoredCodePath(`${root}/feature/page.html`)).toBe(true);
      expect(isAuthoredCodePath(`${root}/feature/schema.prisma`)).toBe(true);
      expect(isAuthoredCodePath(`${root}/feature/query.sql`)).toBe(true);
    }
    expect(isAuthoredCodePath('docs/feature/module.ts')).toBe(false);
    expect(isAuthoredCodePath('playground/feature/module.ts')).toBe(false);
  });

  it('explicitly excludes generated directories and tool-mandated files', () => {
    expect(generatedDirectoryExclusions).toEqual([
      '.cache',
      '.deno',
      '.git',
      '.next',
      '.nx',
      '.parcel-cache',
      '.turbo',
      '.vite',
      'build',
      'coverage',
      'dist',
      'node_modules',
      'out',
      'playwright-report',
      'test-results',
      'tmp',
      'tmp-media',
      'vendor',
    ]);
    expect(toolMandatedFileExclusions).toEqual([
      'cypress.config',
      'jest.config',
      'playwright.config',
      'playwright.exhaustive.config',
      'playwright.full-stack.config',
      'playwright.recipe-console.config',
      'prettier.config',
      'prisma.config',
      'vite.config',
      'vitest.config',
      'vitest.deno.config',
      'vitest.postgres-integration.config',
    ]);
    for (const directory of generatedDirectoryExclusions) {
      expect(isAuthoredCodePath(`apps/example/${directory}/module.ts`)).toBe(false);
    }
    for (const file of toolMandatedFileExclusions) {
      expect(isAuthoredCodePath(`apps/example/${file}.ts`)).toBe(false);
    }
    expect(isAuthoredCodePath('packages/example/generated/module.ts')).toBe(false);
    expect(isAuthoredCodePath('packages/example/generated-types/module.ts')).toBe(false);
    expect(isAuthoredCodePath('packages/example/schema.generated.ts')).toBe(false);
  });
});
