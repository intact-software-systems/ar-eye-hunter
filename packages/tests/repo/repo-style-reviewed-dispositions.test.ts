import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { scanProductionSources } from '../../../scripts/repo-style-check/repository-scan.mjs';
import { reviewedDispositions } from '../../../scripts/repo-style-check/reviewed-dispositions.mjs';

const repoRoot = process.cwd();
const checkerPath = path.join(repoRoot, 'scripts/check-changed-repo-style.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('reviewed repository style dispositions', () => {
  it('freezes exactly the seven approved path, rule, and symbol triples', () => {
    expect(Object.isFrozen(reviewedDispositions)).toBe(true);
    expect(reviewedDispositions).toEqual([
      {
        path: 'packages/shared-web/browser/rallar-data.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
      },
      {
        path: 'packages/shared/alm/ALInboundAdmissionStore.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
      },
      {
        path: 'packages/shared/alm/ALOutboundAdmissionStore.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
      },
      {
        path: 'packages/shared/rallar-ai/rallar-ai-types.ts',
        rule: 'boundary.unknown',
        symbol: undefined,
      },
      {
        path: 'scripts/perf/rtc-baseline/rtc-baseline-decoding.ts',
        rule: 'boundary.unknown',
        symbol: 'normalizeRtcBaselineJson',
      },
      {
        path: 'scripts/perf/rtc-baseline',
        rule: 'layout.directory-density',
        symbol: 'rtc-baseline',
      },
      {
        path: 'scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts',
        rule: 'layout.primary-export-name',
        symbol: 'parseRtcBaselineCommand',
      },
    ]);
  });

  it('passes only the three reviewed RTC baseline findings', () => {
    const fixture = createReviewedFixture();
    writeReviewedSources(fixture);

    const result = runChangedChecker(fixture);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('PASS: no new repository style findings');
  });

  it('emits checker-owned symbols for every reviewed key', () => {
    const directory = path.join(repoRoot, 'scripts/perf/rtc-baseline');
    const findings = scanProductionSources({
      repoRoot,
      sources: reviewedSources(directory),
      options: {
        layoutOnly: false,
        layoutDetails: true,
        constructionDetails: false,
        outputContracts: true,
        objectInterfaces: true,
      },
    }).findings;

    const findingKeys = findings.map(({ file, ruleId, symbol }) => ({
      path: path.relative(repoRoot, file),
      ruleId,
      symbol,
    }));
    const boundaryKeys = findingKeys.filter(({ ruleId }) => ruleId === 'boundary.unknown');

    expect(boundaryKeys).toHaveLength(6);
    expect(new Set(boundaryKeys.map(({ symbol }) => symbol))).toEqual(
      new Set(['normalizeRtcBaselineJson']),
    );
    expect(findingKeys.filter(({ ruleId }) => ruleId !== 'boundary.unknown')).toEqual([
      {
        path: 'scripts/perf/rtc-baseline',
        ruleId: 'layout.directory-density',
        symbol: 'rtc-baseline',
      },
      {
        path: 'scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts',
        ruleId: 'layout.primary-export-name',
        symbol: 'parseRtcBaselineCommand',
      },
    ]);
    expect(findings.find(({ message }) => message.startsWith('... and '))).toMatchObject({
      affectedCount: 3,
      symbol: 'normalizeRtcBaselineJson',
    });
  });

  it('keeps a growing unknown overflow blocking', () => {
    const file = 'apps/example/decode-boundary.ts';
    const fixture = createGitFixture({ [file]: unknownSource('decodeBoundary', 7) });
    commitAll(fixture, 'base');
    writeFixture(fixture, file, unknownSource('decodeBoundary', 8));

    const result = runChangedChecker(fixture);

    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain('boundary.unknown');
  });

  it.each([
    {
      label: 'path',
      file: 'scripts/perf/other-baseline/rtc-baseline-decoding.ts',
      source: decodingSource('normalizeRtcBaselineJson'),
      ruleId: 'boundary.unknown',
    },
    {
      label: 'rule',
      file: 'scripts/perf/rtc-baseline/rtc-baseline-decoding.ts',
      source: 'export function normalizeRtcBaselineJson(value: string): string { return value; }\n',
      ruleId: 'layout.primary-export-name',
    },
    {
      label: 'symbol',
      file: 'scripts/perf/rtc-baseline/rtc-baseline-decoding.ts',
      source: decodingSource('normalizeOtherRtcBaselineJson'),
      ruleId: 'boundary.unknown',
    },
  ])('fails closed for a wrong $label', ({ file, source, ruleId }) => {
    const fixture = createGitFixture({ 'README.md': 'fixture\n' });
    commitAll(fixture, 'base');
    writeFixture(fixture, file, source);

    const result = runChangedChecker(fixture);

    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain(ruleId);
  });

  it('keeps an undispositioned finding blocking beside reviewed findings', () => {
    const fixture = createReviewedFixture();
    writeReviewedSources(fixture);
    appendFixture(
      fixture,
      'scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts',
      `\nconst undispositionedFinding = '${'x'.repeat(110)}';\n`,
    );

    const result = runChangedChecker(fixture);

    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain('FAIL: 1 new or worsened repository style finding');
    expect(result.stdout).toContain('line.width');
  });

  it('keeps an unknown owned by another function blocking after reviewed overflow', () => {
    const fixture = createReviewedFixture();
    writeReviewedSources(fixture);
    appendFixture(
      fixture,
      'scripts/perf/rtc-baseline/rtc-baseline-decoding.ts',
      '\nexport function decodeOther(value: unknown): string { return String(value); }\n',
    );

    const result = runChangedChecker(fixture);

    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain('FAIL: 1 new or worsened repository style finding');
    expect(result.stdout).toContain('boundary.unknown');
  });

  it('documents the fail-closed reviewed-disposition contract', () => {
    const guide = readFileSync(path.join(repoRoot, 'docs/repo-human-style-guide.md'), 'utf8');
    const normalizedGuide = guide.replace(/\s+/gu, ' ');

    for (const requiredText of [
      'Reviewed changed-file dispositions',
      '`scripts/repo-style-check/reviewed-dispositions.mjs`',
      'exact normalized path, rule identifier, and checker-owned symbol',
      'never parses or substring-matches human-readable finding messages',
      'Dormant entries are allowed',
      'Every unmatched finding remains blocking',
    ]) {
      expect(normalizedGuide, requiredText).toContain(requiredText);
    }
  });
});

function createReviewedFixture(): string {
  const files = Object.fromEntries(
    Array.from({ length: 19 }, (_, index) => [
      `scripts/perf/rtc-baseline/fixture${index}-entry.ts`,
      '',
    ]),
  );
  const fixture = createGitFixture(files);
  commitAll(fixture, 'base');
  return fixture;
}

function reviewedSources(directory: string) {
  return [
    ...Array.from({ length: 19 }, (_, index) => ({
      file: path.join(directory, `fixture${index}-entry.ts`),
      raw: '',
    })),
    {
      file: path.join(directory, 'rtc-baseline-decoding.ts'),
      raw: decodingSource('normalizeRtcBaselineJson'),
    },
    {
      file: path.join(directory, 'rtc-baseline-cli-grammar.ts'),
      raw: 'export function parseRtcBaselineCommand(value: string): string { return value; }\n',
    },
  ];
}

function writeReviewedSources(fixture: string): void {
  writeFixture(
    fixture,
    'scripts/perf/rtc-baseline/rtc-baseline-decoding.ts',
    decodingSource('normalizeRtcBaselineJson'),
  );
  writeFixture(
    fixture,
    'scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts',
    'export function parseRtcBaselineCommand(value: string): string { return value; }\n',
  );
}

function decodingSource(symbol: string): string {
  return unknownSource(symbol, 7);
}

function unknownSource(symbol: string, localCount: number): string {
  return [
    'export interface RtcBaselineJson { readonly value: string; }',
    `export function ${symbol}(value: unknown): string {`,
    ...Array.from({ length: localCount }, (_, index) => `  const value${index}: unknown = value;`),
    '  return String(value);',
    '}',
    '',
  ].join('\n');
}

function createGitFixture(files: Readonly<Record<string, string>>): string {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'reviewed-style-fixture-'));
  fixtureRoots.push(fixtureRoot);
  runGit(fixtureRoot, ['init', '--initial-branch=main']);
  runGit(fixtureRoot, ['config', 'user.name', 'Repo Style Test']);
  runGit(fixtureRoot, ['config', 'user.email', 'repo-style@example.invalid']);
  for (const [relativePath, source] of Object.entries(files)) {
    writeFixture(fixtureRoot, relativePath, source);
  }
  return fixtureRoot;
}

function writeFixture(fixtureRoot: string, relativePath: string, source: string): void {
  const filePath = path.join(fixtureRoot, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source);
}

function appendFixture(fixtureRoot: string, relativePath: string, source: string): void {
  const filePath = path.join(fixtureRoot, relativePath);
  writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}${source}`);
}

function commitAll(fixtureRoot: string, message: string): void {
  runGit(fixtureRoot, ['add', '.']);
  runGit(fixtureRoot, ['commit', '-m', message]);
}

function runChangedChecker(fixtureRoot: string) {
  return spawnSync(process.execPath, [checkerPath, 'HEAD'], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  });
}

function runGit(fixtureRoot: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd: fixtureRoot, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
}
