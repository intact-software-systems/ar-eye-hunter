import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { scanProductionSources } from '../../../scripts/repo-style-check/repository-scan.mjs';
import {
  isReviewedDisposition,
  readReviewedDispositionContext,
  reviewedDispositions,
} from '../../../scripts/repo-style-check/reviewed-dispositions.mjs';

const repoRoot = process.cwd();
const checkerPath = path.join(repoRoot, 'scripts/check-changed-repo-style.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('reviewed repository style dispositions', () => {
  it('freezes exactly the six approved path, rule, and symbol triples', () => {
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
        path: 'packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts',
        rule: 'boundary.unknown',
        symbol: 'normalizeRtcBaselineJson',
      },
      {
        path: 'packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-grammar.ts',
        rule: 'layout.primary-export-name',
        symbol: 'parseRtcBaselineCommand',
      },
    ]);
  });

  it('passes only the two reviewed RTC baseline findings', () => {
    const fixture = createReviewedFixture();
    writeReviewedSources(fixture);

    const result = runChangedChecker(fixture);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('PASS: no new repository style findings');
  });

  it('emits checker-owned symbols for every reviewed key', () => {
    const findings = scanProductionSources({
      repoRoot,
      sources: reviewedSources(repoRoot),
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
        path: 'packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-grammar.ts',
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
      file: 'packages/shared-rtc-bench/other-baseline/rtc-baseline-decoding.ts',
      source: decodingSource('normalizeRtcBaselineJson'),
      ruleId: 'boundary.unknown',
    },
    {
      label: 'rule',
      file: 'packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts',
      source: 'export function normalizeRtcBaselineJson(value: string): string { return value; }\n',
      ruleId: 'layout.primary-export-name',
    },
    {
      label: 'symbol',
      file: 'packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts',
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
      'packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-grammar.ts',
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
      'packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts',
      '\nexport function decodeOther(value: unknown): string { return String(value); }\n',
    );

    const result = runChangedChecker(fixture);

    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain('FAIL: 1 new or worsened repository style finding');
    expect(result.stdout).toContain('boundary.unknown');
  });

  it('matches a receipt disposition only at exact native magnitude and candidate head', () => {
    const file = path.join(repoRoot, 'packages/example/large-owner.ts');
    const finding = {
      file,
      ruleId: 'file.cognitive-load',
      symbol: undefined,
      message: 'File cognitive load 112 reaches the required-separation-review tier.',
    };
    const decision = {
      decisionId: 'd'.repeat(64),
      projection: {
        rule: 'file.cognitive-load',
        path: 'packages/example/large-owner.ts',
        symbol: null,
        magnitude: 112,
        candidateHead: 'a'.repeat(40),
      },
    };

    expect(
      isReviewedDisposition(repoRoot, finding, {
        candidateHead: 'a'.repeat(40),
        decisions: [decision],
      }),
    ).toBe(true);
    expect(
      isReviewedDisposition(repoRoot, finding, {
        candidateHead: 'b'.repeat(40),
        decisions: [decision],
      }),
    ).toBe(false);
    expect(
      isReviewedDisposition(
        repoRoot,
        { ...finding, message: finding.message.replace('112', '113') },
        {
          candidateHead: 'a'.repeat(40),
          decisions: [decision],
        },
      ),
    ).toBe(false);
  });

  it('keeps trusted-main receipt verification issues visible and fail closed', () => {
    const context = readReviewedDispositionContext(repoRoot, 'a'.repeat(40), {
      readGovernanceDecisionIndex: () => ({
        decisions: [],
        duplicateDecisionIds: new Set(),
        issues: ['forged receipt was excluded'],
      }),
    });

    expect(context.decisions).toEqual([]);
    expect(context.issues).toEqual(['forged receipt was excluded']);
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
  const fixture = createGitFixture({ 'README.md': 'fixture\n' });
  commitAll(fixture, 'base');
  return fixture;
}

function reviewedSources(root: string) {
  return [
    {
      file: path.join(
        root,
        'packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts',
      ),
      raw: decodingSource('normalizeRtcBaselineJson'),
    },
    {
      file: path.join(
        root,
        'packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-grammar.ts',
      ),
      raw: 'export function parseRtcBaselineCommand(value: string): string { return value; }\n',
    },
  ];
}

function writeReviewedSources(fixture: string): void {
  writeFixture(
    fixture,
    'packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts',
    decodingSource('normalizeRtcBaselineJson'),
  );
  writeFixture(
    fixture,
    'packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-grammar.ts',
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
