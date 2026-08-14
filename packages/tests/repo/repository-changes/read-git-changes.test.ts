import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  readChangedPaths,
  readChangedPathsBetweenRevisions,
} from '../../../../scripts/repository-changes/read-git-changes.mjs';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Git change reads', () => {
  it('reports tracked, renamed, and untracked worktree paths without plan semantics', () => {
    const fixture = createRepository();
    writeFixture(fixture.root, 'docs/guide.md', 'updated\n');
    runGit(fixture.root, ['mv', 'src/original.ts', 'src/renamed.ts']);
    writeFixture(fixture.root, 'scripts/new-tool.sh', '#!/bin/sh\nexit 0\n');
    chmodSync(path.join(fixture.root, 'scripts/new-tool.sh'), 0o755);
    symlinkSync('../docs/guide.md', path.join(fixture.root, 'src/guide-link'));

    expect(readChangedPaths(fixture.root, fixture.base)).toEqual([
      {
        status: 'M',
        oldMode: '100644',
        newMode: '100644',
        path: 'docs/guide.md',
      },
      {
        status: 'A',
        oldMode: '000000',
        newMode: '100755',
        path: 'scripts/new-tool.sh',
      },
      {
        status: 'A',
        oldMode: '000000',
        newMode: '120000',
        path: 'src/guide-link',
      },
      {
        status: 'R100',
        oldMode: '100644',
        newMode: '100644',
        oldPath: 'src/original.ts',
        path: 'src/renamed.ts',
      },
    ]);
  });

  it('reports only committed changes between two validated revisions', () => {
    const fixture = createRepository();
    writeFixture(fixture.root, 'docs/guide.md', 'committed\n');
    runGit(fixture.root, ['add', '.']);
    runGit(fixture.root, ['commit', '--quiet', '-m', 'change guide']);
    const head = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
    writeFixture(fixture.root, 'untracked.txt', 'not part of the comparison\n');

    expect(readChangedPathsBetweenRevisions(fixture.root, fixture.base, head)).toEqual([
      {
        status: 'M',
        oldMode: '100644',
        newMode: '100644',
        path: 'docs/guide.md',
      },
    ]);
  });

  it.each(['', '-n', 'HEAD\nmain'])('rejects an unsafe revision %j', (revision) => {
    const fixture = createRepository();

    expect(() => readChangedPaths(fixture.root, revision)).toThrow(/Git base/u);
  });
});

function createRepository(): { readonly root: string; readonly base: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'repository-changes-'));
  fixtureRoots.push(root);
  runGit(root, ['init', '--quiet']);
  runGit(root, ['config', 'user.email', 'test@example.com']);
  runGit(root, ['config', 'user.name', 'Test User']);
  writeFixture(root, 'docs/guide.md', 'initial\n');
  writeFixture(root, 'src/original.ts', 'export const original = true;\n');
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '--quiet', '-m', 'initial']);
  return { root, base: runGit(root, ['rev-parse', 'HEAD']).trim() };
}

function writeFixture(root: string, relativePath: string, contents: string): void {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function runGit(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}
