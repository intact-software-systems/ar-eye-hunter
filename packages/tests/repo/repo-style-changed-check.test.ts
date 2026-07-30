import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const checkerPath = path.join(repoRoot, 'scripts/check-changed-repo-style.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('changed repository style checker', () => {
  it('passes when a changed file retains an existing finding without worsening it', () => {
    const fixture = createGitFixture({
      'apps/example/legacy-file.ts': overlongSource('legacy'),
    });
    commitAll(fixture, 'base');
    appendSource(fixture, 'apps/example/legacy-file.ts', 'const added = true;\n');

    const result = runChangedChecker(fixture);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: no new repository style findings');
  });

  it('passes when an equivalent legacy finding changes descriptive text', () => {
    const fixture = createGitFixture({
      'apps/example/legacy-file.ts': 'const previousValue: unknown = true;\n',
    });
    commitAll(fixture, 'base');
    writeFixture(fixture, 'apps/example/legacy-file.ts', 'const renamedValue: unknown = true;\n');

    const result = runChangedChecker(fixture);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: no new repository style findings');
  });

  it('fails when a changed file introduces a finding', () => {
    const fixture = createGitFixture({
      'apps/example/feature.ts': 'export const value = true;\n',
    });
    commitAll(fixture, 'base');
    writeFixture(fixture, 'apps/example/feature.ts', overlongSource('introduced'));

    const result = runChangedChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL: 1 new or worsened repository style finding');
    expect(result.stdout).toContain('Line 1 exceeds 100 chars');
  });

  it('fails when an existing finding becomes measurably worse', () => {
    const fixture = createGitFixture({
      'apps/example/feature.ts': overlongSource('x'.repeat(1)),
    });
    commitAll(fixture, 'base');
    writeFixture(fixture, 'apps/example/feature.ts', overlongSource('x'.repeat(20)));

    const result = runChangedChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('new or worsened repository style finding');
  });

  it('passes when a finding is removed', () => {
    const fixture = createGitFixture({
      'apps/example/feature.ts': overlongSource('removed'),
    });
    commitAll(fixture, 'base');
    writeFixture(fixture, 'apps/example/feature.ts', 'const value = true;\n');

    expect(runChangedChecker(fixture).status).toBe(0);
  });

  it('preserves content finding identity across a rename but checks the new filename', () => {
    const fixture = createGitFixture({
      'apps/example/legacy-file.ts': overlongSource('legacy'),
    });
    commitAll(fixture, 'base');
    runGit(fixture, ['mv', 'apps/example/legacy-file.ts', 'apps/example/renamed-file.ts']);

    expect(runChangedChecker(fixture).status).toBe(0);

    runGit(fixture, ['mv', 'apps/example/renamed-file.ts', 'apps/example/BadName.ts']);
    const invalidRename = runChangedChecker(fixture);

    expect(invalidRename.status).toBe(1);
    expect(invalidRename.stdout).toContain('layout.filename-style');
  });

  it('checks untracked production files and ignores deleted findings', () => {
    const fixture = createGitFixture({
      'apps/example/deleted.ts': overlongSource('deleted'),
    });
    commitAll(fixture, 'base');
    runGit(fixture, ['rm', 'apps/example/deleted.ts']);

    expect(runChangedChecker(fixture).status).toBe(0);

    writeFixture(fixture, 'apps/example/untracked.ts', overlongSource('untracked'));
    expect(runChangedChecker(fixture).status).toBe(1);
  });

  it('rejects an invalid base revision', () => {
    const fixture = createGitFixture({
      'apps/example/feature.ts': 'export const value = true;\n',
    });
    commitAll(fixture, 'base');

    const result = executeChecker(fixture, 'missing-base');

    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain('Could not resolve base reference');
  });

  it('runs against an explicit clean HEAD target', () => {
    const fixture = createGitFixture({
      'apps/example/feature.ts': 'export const value = true;\n',
    });
    commitAll(fixture, 'base');
    writeFixture(fixture, 'apps/example/feature.ts', overlongSource('head'));
    commitAll(fixture, 'introduce finding');

    const result = executeChecker(fixture, 'HEAD^', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Line 1 exceeds 100 chars');
  });

  it('reads explicit HEAD content instead of dirty working-tree content', () => {
    const fixture = createGitFixture({
      'apps/example/feature.ts': 'export const value = true;\n',
    });
    commitAll(fixture, 'base');
    writeFixture(fixture, 'apps/example/feature.ts', overlongSource('head'));
    commitAll(fixture, 'introduce finding');
    writeFixture(fixture, 'apps/example/feature.ts', 'export const dirtyValue = true;\n');

    const result = executeChecker(fixture, 'HEAD^', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Line 1 exceeds 100 chars');
  });

  it('ignores non-code files when scanning an explicit commit', () => {
    const fixture = createGitFixture({
      'apps/example/feature.ts': 'export const value = true;\n',
    });
    commitAll(fixture, 'base');
    writeFixture(
      fixture,
      'plans/large-plan.md',
      `${'unknown guidance\n'.repeat(500)}`,
    );
    commitAll(fixture, 'add documentation');

    const result = executeChecker(fixture, 'HEAD^', 'HEAD');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: no new repository style findings');
  });
});

function createGitFixture(files: Readonly<Record<string, string>>): string {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'repo-style-changed-fixture-'));
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

function appendSource(fixtureRoot: string, relativePath: string, source: string): void {
  const filePath = path.join(fixtureRoot, relativePath);
  writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}${source}`);
}

function commitAll(fixtureRoot: string, message: string): void {
  runGit(fixtureRoot, ['add', '.']);
  runGit(fixtureRoot, ['commit', '-m', message]);
}

function runChangedChecker(fixtureRoot: string) {
  return executeChecker(fixtureRoot, 'HEAD');
}

function executeChecker(fixtureRoot: string, ...args: string[]) {
  return spawnSync(process.execPath, [checkerPath, ...args], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  });
}

function runGit(fixtureRoot: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd: fixtureRoot, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
}

function overlongSource(label: string): string {
  return `const value = '${label}${'x'.repeat(110)}';\n`;
}
