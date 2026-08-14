import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readGitRepositorySnapshot } from '../../../../scripts/governance-decisions/git-repository-snapshot.mjs';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Git repository snapshot', () => {
  it('reads tracked blobs larger than the Node child-process default buffer', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'governance-snapshot-'));
    roots.push(root);
    runGit(root, ['init', '--quiet']);
    runGit(root, ['config', 'user.name', 'Fixture']);
    runGit(root, ['config', 'user.email', 'fixture@example.com']);
    const content = 'x'.repeat(1_200_000);
    writeFileSync(path.join(root, 'large.txt'), content);
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '--quiet', '-m', 'large blob']);
    const head = runGit(root, ['rev-parse', 'HEAD']).trim();

    const snapshot = readGitRepositorySnapshot({ repoRoot: root, commitOid: head });

    expect(snapshot.entries).toEqual([expect.objectContaining({ path: 'large.txt', content })]);
  });
});

function runGit(root: string, args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}
