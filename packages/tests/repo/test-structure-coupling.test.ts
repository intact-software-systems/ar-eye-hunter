import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const checkerPath = path.join(repoRoot, 'scripts/check-test-structure-coupling.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('test structure-coupling review', () => {
  it('reports stable advisory candidates for structural tests of production source', () => {
    const fixture = createGitFixture({
      'packages/example/src/order.ts': 'export const second = 2;\nexport const first = 1;\n',
      'packages/tests/example/structure.test.ts': [
        "import { readFileSync } from 'node:fs';",
        "import { Project } from 'ts-morph';",
        '',
        "const source = readFileSync('packages/example/src/order.ts', 'utf8');",
        'const project = new Project();',
        "const names = project.createSourceFile('order.ts', source).getFunctions();",
        "expect(source).toContain('first');",
        "expect(source.split('\\n').length).toBe(2);",
        "expect(source.indexOf('second')).toBeLessThan(source.indexOf('first'));",
        'expect(names).toHaveLength(0);',
      ].join('\n'),
    });

    const first = runChecker(fixture);
    const second = runChecker(fixture);

    expect(first.status, first.stdout).toBe(0);
    expect(first.stdout).toContain('WARN: test structure-coupling review is advisory');
    expect(first.stdout).toContain('production-source-read');
    expect(first.stdout).toContain('ast-inspection');
    expect(first.stdout).toContain('symbol-assertion');
    expect(first.stdout).toContain('line-count');
    expect(first.stdout).toContain('call-or-import-order');
    expect(candidateLines(first.stdout)).toEqual(candidateLines(second.stdout));
    expect(first.stdout).toContain('evidence=unreviewed');
  });

  it('reports exact trees, source hashes or snapshots, and migration topology', () => {
    const fixture = createGitFixture({
      'packages/example/src/current.ts': 'export const current = true;\n',
      'packages/tests/example/structure.test.ts': [
        "import { createHash } from 'node:crypto';",
        "import { readdirSync, readFileSync } from 'node:fs';",
        '',
        "const source = readFileSync('packages/example/src/current.ts', 'utf8');",
        "expect(readdirSync('packages/example/src')).toEqual(['current.ts']);",
        "expect(createHash('sha256').update(source).digest('hex')).toBe('deadbeef');",
        'expect(source).toMatchSnapshot();',
        "expect(source).toContain('compatibility migration bridge');",
      ].join('\n'),
    });

    const result = runChecker(fixture);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('exact-file-tree');
    expect(result.stdout).toContain('source-hash-or-snapshot');
    expect(result.stdout).toContain('migration-or-compatibility-topology');
  });

  it('does not flag governance tests that read canonical guidance rather than production source', () => {
    const fixture = createGitFixture({
      'docs/repo-human-style-guide.md': '# Canonical guidance\n',
      'packages/tests/repo/governance.test.ts': [
        "import { readFileSync } from 'node:fs';",
        '',
        "const guidance = readFileSync('docs/repo-human-style-guide.md', 'utf8');",
        "expect(guidance).toContain('Canonical guidance');",
      ].join('\n'),
    });

    const result = runChecker(fixture);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('PASS: no current structure-coupled test candidates');
    expect(result.stdout).not.toContain('governance.test.ts');
  });

  it('does not treat fixture source strings as production-source reads', () => {
    const fixture = createGitFixture({
      'packages/tests/repo/fixture-builder.test.ts': [
        "const fixtureSource = \"const source = readFileSync('packages/example/src/public.ts', 'utf8');\";",
        "expect(fixtureSource).toContain('public.ts');",
      ].join('\n'),
    });

    const result = runChecker(fixture);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('PASS: no current structure-coupled test candidates');
  });

  it('does not parse declarations embedded in fixture source strings', () => {
    const fixture = createGitFixture({
      'packages/tests/repo/fixture-object.test.ts': [
        'const fixture = {',
        "  source: \"const source = readFileSync('packages/example/src/public.ts', 'utf8');\",",
        '};',
        "expect(fixture.source).toContain('public.ts');",
      ].join('\n'),
    });

    const result = runChecker(fixture);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('PASS: no current structure-coupled test candidates');
  });

  it('excludes non-code artifacts under test directories from source parsing', () => {
    const fixture = createGitFixture({
      'packages/tests/example/artifact.json': '{ deliberately invalid JSON',
      'packages/tests/example/notes.md': '# source = readFileSync(',
      'packages/tests/example/report.html': '<script>const broken = </script>',
      'packages/tests/example/screenshot.png': 'not image bytes and not source code',
      'packages/tests/example/semantic.test.ts': 'expect(true).toBe(true);\n',
    });

    const result = runChecker(fixture);
    const selectedArtifact = runChecker(fixture, [
      '--files',
      'packages/tests/example/artifact.json',
    ]);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('PASS: no current structure-coupled test candidates');
    expect(result.stdout).not.toContain('artifact.json');
    expect(result.stdout).not.toContain('notes.md');
    expect(result.stdout).not.toContain('report.html');
    expect(result.stdout).not.toContain('screenshot.png');
    expect(selectedArtifact.status, selectedArtifact.stdout).toBe(0);
    expect(selectedArtifact.stdout).toContain('PASS: no current structure-coupled test candidates');
    expect(selectedArtifact.stdout).not.toContain('artifact.json');
  });

  it('fails closed with path-specific evidence when supported test source cannot parse', () => {
    const fixture = createGitFixture({
      'packages/tests/example/broken.test.ts': "it('valid', () => {});\n",
    });
    const base = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
    writeFileSync(
      path.join(fixture.root, 'packages/tests/example/broken.test.ts'),
      "it('broken', () => {\n",
    );
    const head = commitFixture(fixture.root, 'break supported test source');

    const results = [
      runChecker(fixture),
      runChecker(fixture, ['--files', 'packages/tests/example/broken.test.ts']),
      runChecker(fixture, ['--changed', base, head]),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        'FAIL: supported test source could not be parsed: packages/tests/example/broken.test.ts:',
      );
      expect(result.stdout).not.toContain(' at parse (');
      expect(result.stdout).not.toContain('PASS: no current structure-coupled test candidates');
      expect(result.stdout).not.toContain('PASS: registry entries are complete and current');
    }
  });

  it('accepts individually registered durable public boundaries and temporary ratchets', () => {
    const fixture = createGitFixture({
      'packages/example/src/public.ts': 'export const publicApi = true;\n',
      'packages/tests/example/structure.test.ts': [
        "import { readFileSync } from 'node:fs';",
        '',
        "const source = readFileSync('packages/example/src/public.ts', 'utf8');",
        "expect(source).toContain('publicApi');",
        "expect(source.split('\\n').length).toBe(2);",
      ].join('\n'),
    });
    const initial = runChecker(fixture);
    const candidates = readCandidates(initial.stdout);

    writeRegistry(fixture.root, [
      durableEntry(candidates.find((candidate) => candidate.kind === 'symbol-assertion')!),
      temporaryEntry(candidates.find((candidate) => candidate.kind === 'line-count')!),
      ...candidates
        .filter((candidate) => candidate.kind === 'production-source-read')
        .map((candidate) => temporaryEntry(candidate)),
    ]);

    const result = runChecker(fixture);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('evidence=durable-public-boundary');
    expect(result.stdout).toContain('evidence=temporary-ratchet');
    expect(result.stdout).toContain('PASS: registry entries are complete and current');
  });

  it('rejects incomplete, duplicate, and stale registrations while keeping unreviewed candidates advisory', () => {
    const fixture = createGitFixture({
      'packages/example/src/public.ts': 'export const publicApi = true;\n',
      'packages/tests/example/structure.test.ts': [
        "import { readFileSync } from 'node:fs';",
        '',
        "const source = readFileSync('packages/example/src/public.ts', 'utf8');",
        "expect(source).toContain('publicApi');",
      ].join('\n'),
    });
    const candidates = readCandidates(runChecker(fixture).stdout);
    const candidate = candidates.find((item) => item.kind === 'symbol-assertion')!;
    const sourceRead = candidates.find((item) => item.kind === 'production-source-read')!;

    writeRegistry(fixture.root, [
      {
        ...durableEntry(candidate),
        owner: '',
        rationale: 'TODO',
        semanticCoverage: '[semantic test]',
      },
      durableEntry(candidate),
      {
        ...temporaryEntry(candidate),
        id: 'test-structure-coupling-stale',
      },
      {
        ...temporaryEntry(sourceRead),
        owner: 'later',
        removalCondition: '<removal condition>',
      },
    ]);

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('registry entry has duplicate id');
    expect(result.stdout).toContain('registry entry is stale');
    expect(result.stdout).toContain('durable boundary entry requires owner');
    expect(result.stdout).toContain('requires non-placeholder rationale and semanticCoverage');
    expect(result.stdout).toContain('temporary ratchet entry requires owner');
    expect(result.stdout).toContain('temporary ratchet entry requires removalCondition');
  });

  it('reports changed-range candidate deletion neutrally rather than claiming a semantic replacement', () => {
    const fixture = createGitFixture({
      'packages/example/src/public.ts': 'export const publicApi = true;\n',
      'packages/tests/example/structure.test.ts': [
        "import { readFileSync } from 'node:fs';",
        '',
        "const source = readFileSync('packages/example/src/public.ts', 'utf8');",
        "expect(source).toContain('publicApi');",
      ].join('\n'),
    });
    const base = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
    writeFileSync(
      path.join(fixture.root, 'packages/tests/example/structure.test.ts'),
      [
        "import { readFileSync } from 'node:fs';",
        '',
        "const source = readFileSync('packages/example/src/public.ts', 'utf8');",
        'expect(publicApi()).toBe(true);',
      ].join('\n'),
    );
    const head = commitFixture(fixture.root, 'replace source assertion');

    const result = runChecker(fixture, ['--changed', base, head]);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('mode=changed-range');
    expect(result.stdout).toContain('change=deleted');
    expect(result.stdout).not.toContain('deleted-or-replaced-semantic-coverage');
    expect(result.stdout).toContain('change=touched');
    expect(result.stdout).toContain('evidence=unreviewed');
    expect(result.stdout).toContain('does not block changed files while the inventory is reviewed');
  });

  it('reports a newly added structural test without Git missing-path noise', () => {
    const fixture = createGitFixture({
      'packages/example/src/public.ts': 'export const publicApi = true;\n',
    });
    const base = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
    const testPath = path.join(fixture.root, 'packages/tests/example/new-structure.test.ts');
    mkdirSync(path.dirname(testPath), { recursive: true });
    writeFileSync(
      testPath,
      [
        "import { readFileSync } from 'node:fs';",
        "const source = readFileSync('packages/example/src/public.ts', 'utf8');",
        "expect(source).toContain('publicApi');",
      ].join('\n'),
    );
    const head = commitFixture(fixture.root, 'add structural test');

    const result = runChecker(fixture, ['--changed', base, head]);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('change=new');
    expect(result.stdout).not.toContain('fatal: path');
  });

  it('reports renamed non-ASCII test paths as renamed using NUL-safe Git evidence', () => {
    const fixture = createGitFixture({
      'packages/example/src/public.ts': 'export const publicApi = true;\n',
      'packages/tests/example/å-structure.test.ts': [
        "import { readFileSync } from 'node:fs';",
        "const source = readFileSync('packages/example/src/public.ts', 'utf8');",
        "expect(source).toContain('publicApi');",
      ].join('\n'),
    });
    const base = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
    runGit(fixture.root, [
      'mv',
      'packages/tests/example/å-structure.test.ts',
      'packages/tests/example/å-renamed-structure.test.ts',
    ]);
    const head = commitFixture(fixture.root, 'rename structural test');

    const result = runChecker(fixture, ['--changed', base, head]);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('å-renamed-structure.test.ts');
    expect(result.stdout).toContain('change=renamed');
  });

  it('links candidates to production-source values within their source-structure test block', () => {
    const fixture = createGitFixture({
      'packages/example/src/public.ts': 'export const publicApi = true;\n',
      'packages/tests/example/scoped-structure.test.ts': [
        "import { readFileSync as readSource } from 'node:fs';",
        "import * as path from 'node:path';",
        '',
        "it('checks the public source boundary', () => {",
        '  const sourcePath = path.join(',
        "    repoRoot, 'packages', 'example', 'src', 'public.ts',",
        '  );',
        "  const source = readSource(sourcePath, 'utf8');",
        '  const artifact = JSON.parse(\'{"legacy": true}\');',
        "  expect(source).toContain('publicApi');",
        '  expect(artifact.legacy).toBe(true);',
        "  expect(readdirSync('tmp/artifacts')).toEqual(['legacy.json']);",
        "  const compatibilityNote = 'legacy migration complete';",
        '  expect(compatibilityNote).toBeDefined();',
        '});',
      ].join('\n'),
    });

    const result = runChecker(fixture);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('production-source-read');
    expect(result.stdout).toContain('symbol-assertion');
    expect(result.stdout).not.toContain('exact-file-tree');
    expect(result.stdout).not.toContain('migration-or-compatibility-topology');
    expect(result.stdout).not.toContain('JSON.parse');
  });

  it('keeps duplicate structural assertions as independently registered occurrences', () => {
    const fixture = createGitFixture({
      'packages/example/src/public.ts': 'export const publicApi = true;\n',
      'packages/tests/example/duplicate-structure.test.ts': [
        "import { readFileSync } from 'node:fs';",
        "const source = readFileSync('packages/example/src/public.ts', 'utf8');",
        "expect(source).toContain('publicApi');",
        "expect(source).toContain('publicApi');",
      ].join('\n'),
    });

    const candidates = readCandidates(runChecker(fixture).stdout).filter(
      (candidate) => candidate.kind === 'symbol-assertion',
    );

    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((candidate) => candidate.id)).size).toBe(2);
    expect(
      new Set(candidates.map((candidate) => `${candidate.line}:${candidate.column}`)).size,
    ).toBe(2);
  });

  it('validates registrations against the complete tree rather than a filtered report', () => {
    const fixture = createGitFixture({
      'packages/example/src/public.ts': 'export const publicApi = true;\n',
      'packages/tests/example/registered-structure.test.ts': [
        "import { readFileSync } from 'node:fs';",
        "const source = readFileSync('packages/example/src/public.ts', 'utf8');",
        "expect(source).toContain('publicApi');",
      ].join('\n'),
      'packages/tests/example/selected.test.ts': 'expect(true).toBe(true);\n',
    });
    const registeredCandidates = readCandidates(runChecker(fixture).stdout);
    writeRegistry(
      fixture.root,
      registeredCandidates.map((candidate) => temporaryEntry(candidate)),
    );
    const base = commitFixture(fixture.root, 'register reviewed candidate');
    writeFileSync(
      path.join(fixture.root, 'packages/tests/example/selected.test.ts'),
      'expect(false).toBe(false);\n',
    );
    const head = commitFixture(fixture.root, 'touch unrelated test');

    const selected = runChecker(fixture, ['--files', 'packages/tests/example/selected.test.ts']);
    const changed = runChecker(fixture, ['--changed', base, head]);

    expect(selected.status, selected.stdout).toBe(0);
    expect(selected.stdout).not.toContain('registry entry is stale');
    expect(changed.status, changed.stdout).toBe(0);
    expect(changed.stdout).not.toContain('registry entry is stale');
  });

  it('traverses mixed TypeScript test callbacks, imports, wrappers, paths, and source arrays', () => {
    const fixture = createGitFixture({
      'apps/example/src/public.ts': 'export const publicApi = true;\n',
      'packages/example/src/other.ts': 'export const otherApi = true;\n',
      'packages/tests/example/syntax-aware.test.ts': [
        "import { readFileSync as readSync } from 'node:fs';",
        "import readAsync from 'node:fs/promises';",
        "import * as path from 'node:path';",
        '',
        'const sourcePaths = [',
        "  path.join(repoRoot, 'apps', 'example', 'src', 'public.ts'),",
        "  path.resolve(repoRoot, 'packages', 'example', 'src', 'other.ts'),",
        '] as const;',
        '',
        'function readSource(filePath: string): string {',
        "  return readSync(filePath, 'utf8');",
        '}',
        '',
        "describe('syntax-aware traversal', function () {",
        "  test('finds wrapper reads in loops', async function () {",
        '    for (const filePath of sourcePaths) {',
        '      const source = readSource(filePath);',
        "      expect(source).toContain('Api');",
        '    }',
        "    await readAsync(sourcePaths[0], 'utf8');",
        '  });',
        '});',
      ].join('\n'),
    });

    const result = runChecker(fixture);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout.match(/production-source-read/g)).toHaveLength(2);
    expect(result.stdout).toContain('symbol-assertion');
  });

  it('does not label JSON parsing of source content as AST inspection', () => {
    const fixture = createGitFixture({
      'packages/example/src/public.json': '{"publicApi":true}\n',
      'packages/tests/example/json-source.test.ts': [
        "import { readFileSync } from 'node:fs';",
        "const source = readFileSync('packages/example/src/public.json', 'utf8');",
        'const parsed = JSON.parse(source);',
        'expect(parsed.publicApi).toBe(true);',
      ].join('\n'),
    });

    const result = runChecker(fixture);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('production-source-read');
    expect(result.stdout).not.toContain('ast-inspection');
  });

  it('reports real source-coupled ratchet and control-boundary tests', () => {
    const ratchet = runRepoChecker([
      '--files',
      'packages/tests/rallar-black-box/recipe-console-retention-panel.test.ts',
    ]);
    const controlBoundary = runRepoChecker([
      '--files',
      'packages/tests/rallar-black-box/control-protocol-boundary.test.ts',
    ]);

    expect(ratchet.status, ratchet.stdout).toBe(0);
    expect(ratchet.stdout).toContain('production-source-read');
    expect(ratchet.stdout).toContain('line-count');
    expect(controlBoundary.status, controlBoundary.stdout).toBe(0);
    expect(controlBoundary.stdout).toContain('production-source-read');
    expect(controlBoundary.stdout).toContain('symbol-assertion');
  }, 20_000);

  it('parses representative real repository suites without silently skipping evidence', () => {
    const recipeConsolePath = 'packages/tests/rallar-black-box/recipe-console-structure.test.ts';
    const truthfulNoCandidateAllowed = [
      'packages/tests/repo/github-actions-runtime-governance.test.ts',
    ];
    const result = runRepoChecker(['--files', recipeConsolePath, ...truthfulNoCandidateAllowed]);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toMatch(
      new RegExp(`REVIEWED ${recipeConsolePath} \\| candidates=[1-9][0-9]*`, 'u'),
    );
    for (const path of truthfulNoCandidateAllowed) {
      expect(result.stdout).toMatch(new RegExp(`REVIEWED ${path} \\| candidates=[0-9]+`, 'u'));
    }
  }, 30_000);

  it('parses every tracked supported test source without silent omission', () => {
    const result = runRepoChecker([]);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).not.toContain('supported test source could not be parsed');
    expect(result.stdout).toContain('PASS: registry entries are complete and current');
  }, 30_000);

  it('reports renamed removals and unchanged-source copies with range-safe evidence', () => {
    const fixture = createGitFixture({
      'packages/example/src/public.ts': 'export const publicApi = true;\n',
      'packages/tests/example/original-structure.test.ts': [
        "import { readFileSync } from 'node:fs';",
        "const source = readFileSync('packages/example/src/public.ts', 'utf8');",
        "expect(source).toContain('publicApi');",
        "expect(source).toContain('removedOnRename');",
      ].join('\n'),
    });
    const base = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
    runGit(fixture.root, [
      'mv',
      'packages/tests/example/original-structure.test.ts',
      'packages/tests/example/renamed-structure.test.ts',
    ]);
    writeFileSync(
      path.join(fixture.root, 'packages/tests/example/renamed-structure.test.ts'),
      [
        "import { readFileSync } from 'node:fs';",
        "const source = readFileSync('packages/example/src/public.ts', 'utf8');",
        "expect(source).toContain('publicApi');",
      ].join('\n'),
    );
    writeFileSync(
      path.join(fixture.root, 'packages/tests/example/copied-structure.test.ts'),
      [
        "import { readFileSync } from 'node:fs';",
        "const source = readFileSync('packages/example/src/public.ts', 'utf8');",
        "expect(source).toContain('publicApi');",
        "expect(source).toContain('removedOnRename');",
      ].join('\n'),
    );
    const head = commitFixture(fixture.root, 'rename and copy structural tests');

    const result = runChecker(fixture, ['--changed', base, head]);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('change=renamed');
    expect(result.stdout).toContain('change=deleted');
    expect(result.stdout).toContain('origin=copy');
    expect(result.stdout).not.toContain('deleted-or-replaced-semantic-coverage');
  });

  it('reports an explicit changed-file selection without scanning unrelated tests', () => {
    const fixture = createGitFixture({
      'packages/example/src/public.ts': 'export const publicApi = true;\n',
      'packages/tests/example/selected.test.ts': [
        "import { readFileSync } from 'node:fs';",
        "const source = readFileSync('packages/example/src/public.ts', 'utf8');",
        "expect(source).toContain('publicApi');",
      ].join('\n'),
      'packages/tests/example/unrelated.test.ts': [
        "import { readFileSync } from 'node:fs';",
        "const source = readFileSync('packages/example/src/public.ts', 'utf8');",
        "expect(source).toContain('unrelated');",
      ].join('\n'),
    });

    const result = runChecker(fixture, ['--files', 'packages/tests/example/selected.test.ts']);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('mode=changed-files');
    expect(result.stdout).toContain('change=selected');
    expect(result.stdout).toContain('selected.test.ts');
    expect(result.stdout).not.toContain('unrelated.test.ts');
  });
});

function createGitFixture(files: Record<string, string>): { readonly root: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'rallar-test-structure-coupling-'));
  fixtureRoots.push(root);
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, source);
  }
  writeRegistry(root, []);
  runGit(root, ['init']);
  runGit(root, ['config', 'user.email', 'test@example.com']);
  runGit(root, ['config', 'user.name', 'Test User']);
  commitFixture(root, 'initial fixture');
  return { root };
}

function writeRegistry(root: string, entries: readonly Record<string, unknown>[]) {
  const registryPath = path.join(root, 'docs/test-structure-coupling-exceptions.md');
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(
    registryPath,
    [
      '# Test structure-coupling exception registry',
      '',
      '```test-structure-coupling-registry-v1',
      JSON.stringify({ version: 1, entries }, null, 2),
      '```',
      '',
    ].join('\n'),
  );
}

function runChecker(
  fixture: { readonly root: string },
  args: readonly string[] = [],
): { readonly status: number | null; readonly stdout: string } {
  const result = spawnSync(process.execPath, [checkerPath, ...args], {
    cwd: fixture.root,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: `${result.stdout}${result.stderr}` };
}

function runRepoChecker(args: readonly string[]): {
  readonly status: number | null;
  readonly stdout: string;
} {
  const result = spawnSync(process.execPath, [checkerPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: `${result.stdout}${result.stderr}` };
}

function candidateLines(output: string): readonly string[] {
  return output.split('\n').filter((line) => line.startsWith('CANDIDATE '));
}

function readCandidates(output: string): readonly TestCandidate[] {
  return candidateLines(output).map((line) => {
    const [identifier, location, kind] = line.split(' | ');
    const id = identifier.slice('CANDIDATE '.length);
    const [path, lineNumber, column] = location.split(':');
    return { id, path, line: Number(lineNumber), column: Number(column), kind };
  });
}

function durableEntry(candidate: TestCandidate): Record<string, unknown> {
  return {
    ...candidate,
    disposition: 'durable-boundary',
    boundary: 'public',
    owner: 'example-owner',
    rationale: 'The named public boundary is intentionally stable.',
    semanticCoverage: 'packages/tests/example/public-contract.test.ts',
  };
}

function temporaryEntry(candidate: TestCandidate): Record<string, unknown> {
  return {
    ...candidate,
    disposition: 'temporary-ratchet',
    owner: 'example-owner',
    rationale: 'The ratchet protects a migration while semantic coverage is added.',
    semanticCoverage: 'packages/tests/example/public-contract.test.ts',
    removalCondition: 'Remove after the named semantic contract test is complete.',
  };
}

function commitFixture(root: string, message: string): string {
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', message]);
  return runGit(root, ['rev-parse', 'HEAD']).trim();
}

function runGit(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

interface TestCandidate {
  readonly id: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly kind: string;
}
