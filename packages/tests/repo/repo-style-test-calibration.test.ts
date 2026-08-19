import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  isProductionCodeFile,
  isNonProductionPath,
  resolveFileLineBackstop,
} from '../../../scripts/repo-style-check/repository-scan.mjs';

const repoRoot = process.cwd();

function readStyleAuthority(): string {
  return readFileSync(
    path.join(repoRoot, '.agents/skills/rallar-code-writing/references/repo-code-style.md'),
    'utf8',
  );
}

function readScanner(): string {
  return readFileSync(
    path.join(repoRoot, 'scripts/repo-style-check/repository-scan.mjs'),
    'utf8',
  );
}

describe('repo style test calibration', () => {
  it('gives test files the wider navigation backstop the test corpus was measured against', () => {
    expect(resolveFileLineBackstop('packages/tests/shared/queue.test.ts')).toBe(1500);
    expect(resolveFileLineBackstop('apps/api-v1/test/db/pglite-sql-adapter.test.ts')).toBe(1500);
    expect(resolveFileLineBackstop('packages/shared/queuebox/ResourceEntry.ts')).toBe(1200);
    expect(resolveFileLineBackstop('apps/api-v1/src/main.ts')).toBe(1200);
  });

  // The wider backstop is prepared, not yet reachable: collectProductionSources filters test paths
  // out of the scan entirely, so no test file is measured until the test scan is enabled. This
  // pins that honestly rather than letting the calibration read as though it were already live.
  it('records that the scan still excludes the files the wider backstop is for', () => {
    expect(isProductionCodeFile('packages/tests/shared/queue.test.ts')).toBe(false);
    expect(isProductionCodeFile('packages/shared/queuebox/ResourceEntry.ts')).toBe(true);
  });

  it('states both backstops in the authority the checker implements', () => {
    const authority = readStyleAuthority();

    expect(authority).toContain('`1,200` physical lines');
    expect(authority).toContain('`1,500`-line backstop');
  });

  // The calibration is deliberately narrow: only physical length differs. Cognitive load and
  // responsibility count are stricter on the test corpus than on production, so relaxing them
  // would loosen a rule tests already satisfy.
  it('relaxes no file metric for tests other than physical length', () => {
    const scanner = readScanner();

    expect(scanner).not.toContain('testCognitiveLoad');
    expect(scanner).not.toContain('testResponsibilityCount');
    expect(scanner).not.toContain('testHandlerComplexity');
  });

  it('resolves conventional role qualifiers before reading a filename stem', () => {
    const layoutRules = readFileSync(
      path.join(repoRoot, 'scripts/repo-style-check/layout-rules.mjs'),
      'utf8',
    );

    expect(layoutRules).toContain('fileRoleQualifierPattern');
    expect(layoutRules).toContain('.replace(fileRoleQualifierPattern');
  });

  it('classifies the test tree as non-production so the wider backstop applies to it', () => {
    expect(isNonProductionPath('packages/tests/shared/queue.test.ts')).toBe(true);
    expect(isNonProductionPath('apps/api-v1/test/db/pglite-sql-adapter.test.ts')).toBe(true);
    expect(isNonProductionPath('packages/shared/queuebox/ResourceEntry.ts')).toBe(false);
    expect(isNonProductionPath('apps/api-v1/src/main.ts')).toBe(false);
  });
});
