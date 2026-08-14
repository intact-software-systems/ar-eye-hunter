import { execFileSync } from 'node:child_process';

export function readGitRepositorySnapshot(snapshotInput) {
  const commitOid = readCommitOid(snapshotInput.repoRoot, snapshotInput.commitOid);
  const entries = readCommitEntries(snapshotInput.repoRoot, commitOid);
  const parentOids = runGit(snapshotInput.repoRoot, [
    'show',
    '-s',
    '--format=%P',
    '--end-of-options',
    commitOid,
  ])
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const commitDate = runGit(snapshotInput.repoRoot, [
    'show',
    '-s',
    '--format=%cs',
    '--end-of-options',
    commitOid,
  ]).trim();
  return { headOid: commitOid, parentOids, commitDate, entries };
}

function readCommitOid(repoRoot, revision) {
  if (
    typeof revision !== 'string' ||
    revision === '' ||
    revision.startsWith('-') ||
    /[\0\r\n]/u.test(revision)
  ) {
    throw new Error('snapshot commit must be a safe Git revision');
  }
  const commitOid = runGit(repoRoot, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${revision}^{commit}`,
  ]).trim();
  if (!/^[0-9a-f]{40}$/u.test(commitOid)) {
    throw new Error('snapshot commit did not resolve to a full Git object ID');
  }
  return commitOid;
}

function readCommitEntries(repoRoot, commitOid) {
  const tree = runGit(repoRoot, ['ls-tree', '-rz', '--full-tree', commitOid]);
  return tree
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d{6}) blob ([0-9a-f]{40})\t(.+)$/u);
      if (!match) {
        throw new Error('Git tree contains an unsupported entry');
      }
      return {
        path: match[3],
        mode: match[1],
        blobOid: match[2],
        content: runGit(repoRoot, ['cat-file', 'blob', match[2]]),
      };
    })
    .sort((left, right) => compareText(left.path, right.path));
}

function runGit(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 134_217_728 });
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
