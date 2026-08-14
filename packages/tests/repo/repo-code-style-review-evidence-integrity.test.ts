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
        'resolved throughout the touched file',
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

  it('keeps group-state traceability guidance direct and compatibility-preserving', () => {
    const codeStyle = readRepo('.agents/skills/rallar-code-writing/references/repo-code-style.md');
    const serviceWriting = readRepo(
      '.agents/skills/rallar-code-writing/references/convergent-service-writing.md',
    );
    const realtime = readRepo('.agents/skills/rallar-realtime/SKILL.md');
    const organizing = readRepo('.agents/skills/organizing-repository-structure/SKILL.md');

    expectAllNormalized(codeStyle, [
      'discriminated type-to-payload relationship',
      'Repeated case-local assertions are not an acceptable substitute',
      'One boundary narrowing may establish an existing typed protocol relationship',
      'must not claim to validate fields it did not inspect',
      'named port declared beside the canonical owner',
      'Go to Definition reveals invocation, retry, commit, and failure semantics',
      'Capability cohesion is judged by responsibility, not method count',
    ]);
    expectAllNormalized(serviceWriting, [
      'Transaction, retry, lifecycle, and after-commit dependencies use a named port',
      'declared beside the canonical owner',
      'closed operation-name type',
      'exhaustive operation inventory',
      'Timing identity fields are deliberately populated, deliberately retained for compatibility',
      'separately approved observable-behavior work',
    ]);
    expectAllNormalized(realtime, [
      'more than 20 production modules',
      'more than three materially different control-flow families',
      'durable repository navigation map',
      'historical PR body is not a durable substitute',
    ]);
    expectAllNormalized(organizing, [
      'mirrored tests, and map',
      'generated navigation-evidence record',
      'repository-owned evidence',
    ]);
  });
});

function readRepo(filePath: string): string {
  return readFileSync(path.join(repoRoot, filePath), 'utf8');
}

function expectAllNormalized(haystack: string, needles: readonly string[]): void {
  const normalized = haystack.replace(/\s+/g, ' ').trim();
  for (const needle of needles) {
    expect(normalized, needle).toContain(needle.replace(/\s+/g, ' ').trim());
  }
}
