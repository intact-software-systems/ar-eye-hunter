import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const canonicalStylePath = '.agents/skills/rallar-code-writing/references/repo-code-style.md';

describe('repo code style authority integrity', () => {
  it('routes every TypeScript change through one repo-wide style authority', () => {
    const agents = readRepo('AGENTS.md');
    const codeWriting = readRepo('.agents/skills/rallar-code-writing/SKILL.md');
    const humanGuide = readRepo('docs/repo-human-style-guide.md');
    const docsIndex = readRepo('docs/README.md');
    const packageJson = readJson('package.json') as {
      scripts?: Readonly<Record<string, string>>;
    };

    expect(existsSync(path.join(repoRoot, canonicalStylePath))).toBe(true);
    expect(
      existsSync(
        path.join(repoRoot, '.agents/skills/rallar-code-writing/references/package-code-style.md'),
      ),
    ).toBe(false);
    expect(codeWriting).toContain('Always read `references/repo-code-style.md`');
    expectAll(agents, ['any TypeScript change', canonicalStylePath]);
    expectAll(humanGuide, [canonicalStylePath, 'authoritative coding standard']);
    expect(docsIndex).toContain('./repo-human-style-guide.md');
    expect(packageJson.scripts).not.toHaveProperty('check:repo-style:strict');
    expect(packageJson.scripts).toHaveProperty('check:repo-style:object-interfaces');
    expectAll(readRepo(canonicalStylePath), [
      '`validateXxx` always returns all issues and never throws',
      'The caller or a central\n`classifyRuntimeFailure` policy decides the disposition',
      'Do not put a guessed\n`retryable` boolean on a low-level exception',
      'The plain-object `type` preference is a manual review rule',
      '`unknown` belongs only at an untrusted boundary',
    ]);
  });

  it('keeps canonical examples inside the vocabulary they teach', () => {
    const canonicalStyle = readRepo(canonicalStylePath);
    const factoryExample =
      canonicalStyle.match(
        /## Factory inputs and visible defaults([\s\S]*?)## Function inputs and outputs/,
      )?.[1] ?? '';

    expect(factoryExample).not.toContain('Manager');
  });

  it('applies the human file-size threshold to every TypeScript surface', () => {
    const canonicalStyle = readRepo(canonicalStylePath);

    expect(canonicalStyle).toContain('400 physical lines is the TypeScript-file review threshold');
    expect(canonicalStyle).not.toContain('production-file review threshold');
  });

  it('connects runtime failures to the established Either flow', () => {
    const canonicalStyle = readRepo(canonicalStylePath);
    const humanGuide = readRepo('docs/repo-human-style-guide.md');

    expect(canonicalStyle).toContain('`Either<RuntimeFailure, T>`');
    expect(humanGuide).toContain('left includes `RuntimeFailure`');
  });

  it('keeps changed production warnings visible when the default output is capped', () => {
    const codeWriting = readRepo('.agents/skills/rallar-code-writing/SKILL.md');

    expect(codeWriting).toMatch(/smallest\s+directory containing changed production files/);
  });

  it('keeps TypeScript formatter settings aligned with the canonical baseline', () => {
    expect(existsSync(path.join(repoRoot, '.prettierrc.json'))).toBe(true);

    const prettier = readJson('.prettierrc.json') as Record<string, unknown>;
    expect(prettier).toMatchObject({
      printWidth: 100,
      tabWidth: 2,
      useTabs: false,
      semi: true,
      singleQuote: true,
      trailingComma: 'all',
    });

    for (const denoConfigPath of [
      'deno.json',
      'apps/api-v1/deno.json',
      'apps/rallar-black-box-control-server/deno.json',
      'apps/relic-hunter-server-v1/deno.json',
    ]) {
      const deno = readJson(denoConfigPath) as {
        fmt?: Readonly<Record<string, unknown>>;
      };
      expect(deno.fmt, denoConfigPath).toMatchObject({
        lineWidth: 100,
        indentWidth: 2,
        useTabs: false,
        semiColons: true,
        singleQuote: true,
      });
    }
  });

  it('keeps Deno-owned TypeScript out of the Prettier formatting surface', () => {
    const prettierIgnorePath = path.join(repoRoot, '.prettierignore');

    expect(existsSync(prettierIgnorePath)).toBe(true);

    const prettierIgnore = readRepo('.prettierignore');
    for (const denoAppPath of [
      'apps/api-v1/**',
      'apps/rallar-black-box-control-server/**',
      'apps/relic-hunter-server-v1/**',
    ]) {
      expect(prettierIgnore).toContain(denoAppPath);
    }

    expectAll(readRepo(canonicalStylePath), ['`deno fmt`', '`.prettierignore`']);
  });

  it('keeps every repo-style suite in the testing workflow', () => {
    const testing = readRepo('.agents/skills/rallar-testing/SKILL.md');
    const commands = readRepo('.agents/skills/rallar-testing/references/test-commands.md');

    for (const testPath of [
      'packages/tests/repo/rallar-skill-integrity.test.ts',
      'packages/tests/repo/repo-code-style-integrity.test.ts',
      'packages/tests/repo/repo-style-check.test.ts',
    ]) {
      expect(testing).toContain(testPath);
      expect(commands).toContain(testPath);
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
