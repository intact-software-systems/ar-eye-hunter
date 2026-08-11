import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { analyzeCognitiveMetrics } from '../../../scripts/repo-style-check/cognitive-load-rules.mjs';

const repoRoot = process.cwd();
const checkerPath = path.join(repoRoot, 'scripts/repo-style-check.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('cognitive metric rules', () => {
  it('computes the calibrated walker semantics for a known snippet', () => {
    const metrics = analyzeCognitiveMetrics(
      'sample.ts',
      [
        'export function resolveKind(a: boolean, b: boolean, c: boolean): number {',
        '  if (a) {',
        '    if (b) {',
        '      return 2;',
        '    }',
        '  } else if (c) {',
        '    return 3;',
        '  } else {',
        '    return (a && b) || c ? 4 : 5;',
        '  }',
        '  return 1;',
        '}',
      ].join('\n'),
    );

    expect(metrics.cognitiveLoad).toBe(9);
    expect(metrics.worstFunction.name).toBe('resolveKind');
    expect(metrics.worstFunction.score).toBe(9);
    expect(metrics.valueExportCount).toBe(1);
  });

  it('scores nested callback decisions deeper than flat ones', () => {
    const flat = analyzeCognitiveMetrics(
      'flat.ts',
      'export function first(a: boolean): number {\n  if (a) {\n    return 1;\n  }\n  return 0;\n}',
    );
    const nested = analyzeCognitiveMetrics(
      'nested.ts',
      [
        'export function second(items: readonly boolean[]): number[] {',
        '  return items.map((item) => {',
        '    if (item) {',
        '      return 1;',
        '    }',
        '    return 0;',
        '  });',
        '}',
      ].join('\n'),
    );

    expect(flat.cognitiveLoad).toBe(1);
    expect(nested.cognitiveLoad).toBe(2);
  });

  it.each([
    { decisions: 50, tier: 'warn' },
    { decisions: 110, tier: 'review' },
    { decisions: 330, tier: 'refactor-or-register' },
  ])('reports the $tier tier at cognitive load $decisions', ({ decisions, tier }) => {
    const fixtureRoot = createFixture({ 'decision-dense.ts': decisionDenseSource(decisions) });

    const output = runChecker(fixtureRoot, '--cognitive-metrics');

    expect(output).toContain('[file.cognitive-load]');
    expect(output).toContain(`File cognitive load ${decisions} reaches the ${tier} tier`);
    expect(output).toContain('worst function computeDecisionDenseTotal');
  });

  it('stays silent below the warn tier and without the opt-in flag', () => {
    const belowTier = createFixture({ 'decision-dense.ts': decisionDenseSource(49) });
    expect(runChecker(belowTier, '--cognitive-metrics')).not.toContain('[file.cognitive-load]');

    const withoutFlag = createFixture({ 'decision-dense.ts': decisionDenseSource(120) });
    expect(runChecker(withoutFlag)).not.toContain('[file.cognitive-load]');
  });

  it('keeps both metrics warning-only with exit code zero', () => {
    const fixtureRoot = createFixture({
      'decision-dense.ts': decisionDenseSource(120),
      'wide-surface.ts': valueExportSource(12),
    });

    const result = executeChecker(fixtureRoot, '--cognitive-metrics');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('[file.cognitive-load]');
    expect(result.stdout).toContain('[file.responsibility-count]');
  });

  it('counts only runtime value exports for the responsibility rule', () => {
    const fixtureRoot = createFixture({
      'wide-surface.ts': valueExportSource(12),
      'narrow-surface.ts': [
        valueExportSource(11),
        ...Array.from(
          { length: 6 },
          (_, index) => `export interface Shape${index} { readonly id: string; }`,
        ),
      ].join('\n'),
    });

    const output = runChecker(fixtureRoot, '--cognitive-metrics');

    expect(output).toContain('[file.responsibility-count]');
    expect(output).toContain('File exports 12 runtime values');
    expect(output).not.toContain('File exports 11 runtime values');
    expect(output).not.toContain('File exports 17 runtime values');
  });

  it('measures TypeScript production sources only, not .mjs or declaration files', () => {
    const fixtureRoot = createFixture({
      'dense-script.mjs': plainScriptDecisionSource(120),
      'wide-ambient.d.ts': Array.from(
        { length: 13 },
        (_, index) => `export declare function readShape${index}(): void;`,
      ).join('\n'),
    });

    const output = runChecker(fixtureRoot, '--cognitive-metrics');

    expect(output).not.toContain('[file.cognitive-load]');
    expect(output).not.toContain('[file.responsibility-count]');
  });
});

function decisionDenseSource(decisionCount: number): string {
  const branches = Array.from(
    { length: decisionCount },
    (_, index) => `  if (input > ${index}) { total += ${index}; }`,
  );
  return [
    'export function computeDecisionDenseTotal(input: number): number {',
    '  let total = 0;',
    ...branches,
    '  return total;',
    '}',
  ].join('\n');
}

function plainScriptDecisionSource(decisionCount: number): string {
  const branches = Array.from(
    { length: decisionCount },
    (_, index) => `  if (input > ${index}) { total += ${index}; }`,
  );
  return [
    'export function computeDecisionDenseTotal(input) {',
    '  let total = 0;',
    ...branches,
    '  return total;',
    '}',
  ].join('\n');
}

function valueExportSource(valueCount: number): string {
  return Array.from(
    { length: valueCount },
    (_, index) => `export const surfaceValue${index} = ${index};`,
  ).join('\n');
}

function createFixture(files: Readonly<Record<string, string>>): string {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'repo-style-cognitive-fixture-'));
  fixtureRoots.push(fixtureRoot);

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(fixtureRoot, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
  }

  return fixtureRoot;
}

function runChecker(fixtureRoot: string, ...extraArgs: string[]): string {
  const result = executeChecker(fixtureRoot, ...extraArgs);

  expect(result.status, result.stderr).toBe(0);
  return `${result.stdout}${result.stderr}`;
}

function executeChecker(fixtureRoot: string, ...extraArgs: string[]) {
  return spawnSync(process.execPath, [checkerPath, '--root', fixtureRoot, ...extraArgs], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}
