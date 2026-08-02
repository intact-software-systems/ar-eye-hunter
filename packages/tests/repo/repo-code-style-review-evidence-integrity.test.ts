import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const canonicalStylePath = '.agents/skills/rallar-code-writing/references/repo-code-style.md';

describe('repo code style review evidence integrity', () => {
  it('keeps changed production warnings visible when the default output is capped', () => {
    const codeWriting = readRepo('.agents/skills/rallar-code-writing/SKILL.md');

    expect(codeWriting).toMatch(/smallest\s+directory containing changed production files/);
  });

  it('requires human traceability evidence and dispositions for changed construction warnings', () => {
    const canonicalStyle = readRepo(canonicalStylePath);
    const humanGuide = readRepo('docs/repo-human-style-guide.md');

    for (const source of [canonicalStyle, humanGuide]) {
      expectAllNormalized(source, [
        'code-only trace exercise',
        'temporary ratchet',
        'owner and removal condition',
        'construction-warning disposition',
        'path, rule, and symbol',
        'demonstrated false positive',
        'accepted existing debt with no new/worsened magnitude and an owner',
        'silence or a warning-only exit code is not a disposition',
      ]);
    }
  });

  it('requires the final review outcome to retain every family-level two-timeline trace', () => {
    const humanGuide = readRepo('docs/repo-human-style-guide.md');
    const reviewOutcome = humanGuide.slice(humanGuide.indexOf('## Review outcome'));

    expectAllNormalized(reviewOutcome, [
      'family-level construction/registration and runtime-invocation trace evidence',
      'variant inventory',
      'authoritative trace contract above',
    ]);
    expect(reviewOutcome).not.toContain('one representative input traced');
  });

  it('keeps semantic evidence primary while preserving warning-only construction review', () => {
    const canonicalStyle = readRepo(canonicalStylePath);
    const humanGuide = readRepo('docs/repo-human-style-guide.md');

    for (const source of [canonicalStyle, humanGuide]) {
      expectAllNormalized(source, [
        'Semantic tests are primary',
        'Source inventories, exact-tree checks, string assertions, and line/count ratchets are supplementary and temporary',
        'named owner and removal condition',
        'does not make every optional warning globally blocking',
      ]);
    }
  });
});

function readRepo(filePath: string): string {
  return readFileSync(path.join(repoRoot, filePath), 'utf8');
}

function readJson(filePath: string): unknown {
  return JSON.parse(readRepo(filePath));
}

function expectAll(haystack: string, needles: readonly string[]): void {
  for (const needle of needles) {
    expect(haystack, needle).toContain(needle);
  }
}

function expectAllNormalized(haystack: string, needles: readonly string[]): void {
  const normalized = haystack.replace(/\s+/g, ' ').trim();
  for (const needle of needles) {
    expect(normalized, needle).toContain(needle.replace(/\s+/g, ' ').trim());
  }
}
