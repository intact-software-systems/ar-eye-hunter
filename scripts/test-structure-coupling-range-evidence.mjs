import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import {
  compareCandidates,
  isTestPath,
  scanSources,
} from './test-structure-coupling-source-analysis.mjs';

export function resolveCommit(reference, name) {
  const commit = tryGit(['rev-parse', '--verify', `${reference}^{commit}`]);
  if (!commit) {
    failGitEvidence(`${name} reference does not resolve to a commit: ${reference}`);
  }
  return commit.toString('utf8').trim();
}

export function readRangeChanges(base, head) {
  const fields = runGitBuffer([
    'diff',
    '--name-status',
    '-z',
    '-M',
    '-C',
    '--find-copies-harder',
    base,
    head,
  ])
    .toString('utf8')
    .split('\0');
  const changes = [];
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++];
    if (!status) {
      continue;
    }
    const kind = status[0];
    const source = fields[index++];
    const target = readTargetPath({ kind, source, fields, index });
    if (kind === 'R' || kind === 'C') {
      index += 1;
    }
    if ([source, target].filter(Boolean).some(isTestPath)) {
      changes.push({ kind, source, target });
    }
  }
  return changes;
}

function readTargetPath({ kind, source, fields, index }) {
  if (kind === 'R' || kind === 'C') {
    return fields[index];
  }
  return kind === 'D' ? undefined : source;
}

export function readReportCandidates(reviewInput) {
  if (reviewInput.mode === 'full') {
    return scanWorkingPaths(readWorkingTestPaths());
  }
  if (reviewInput.mode === 'changed-files') {
    return withCandidateChange(
      scanWorkingPaths(reviewInput.paths.filter(isTestPath).toSorted()),
      'selected',
    );
  }
  const candidates = [];
  const errors = [];
  const reviewedPaths = [];
  for (const change of reviewInput.changes) {
    const result = readChangeCandidates({ reviewInput, change });
    candidates.push(...result.candidates);
    errors.push(...result.errors);
    reviewedPaths.push(...result.reviewedPaths);
  }
  return {
    candidates: candidates.toSorted(compareCandidates),
    errors: errors.toSorted(),
    reviewedPaths: [...new Set(reviewedPaths)].toSorted(),
  };
}

function readChangeCandidates({ reviewInput, change }) {
  const previousResult = isTestPath(change.source)
    ? scanRevisionPaths(reviewInput.base, [change.source])
    : emptyScan();
  const currentResult =
    change.target && isTestPath(change.target)
      ? scanRevisionPaths(reviewInput.head, [change.target])
      : emptyScan();
  const changeName = readChangeName(change.kind);
  const candidates = currentResult.candidates.map((candidate) => ({
    ...candidate,
    change: changeName,
    origin: change.kind === 'C' ? 'copy' : undefined,
  }));
  if (change.kind === 'R' || change.kind === 'M' || change.kind === 'D') {
    candidates.push(...readDeletedCandidates(previousResult.candidates, currentResult.candidates));
  }
  return {
    candidates,
    errors: [...previousResult.errors, ...currentResult.errors],
    reviewedPaths: [...previousResult.reviewedPaths, ...currentResult.reviewedPaths],
  };
}

function readChangeName(kind) {
  if (kind === 'R') {
    return 'renamed';
  }
  return kind === 'C' || kind === 'A' ? 'new' : 'touched';
}

function readDeletedCandidates(previous, current) {
  const currentCounts = countSemanticKeys(current);
  const deleted = [];
  for (const candidate of previous) {
    const count = currentCounts.get(candidate.semanticKey) ?? 0;
    if (count > 0) {
      currentCounts.set(candidate.semanticKey, count - 1);
    } else {
      deleted.push({ ...candidate, change: 'deleted' });
    }
  }
  return deleted;
}

function countSemanticKeys(candidates) {
  const counts = new Map();
  for (const candidate of candidates) {
    counts.set(candidate.semanticKey, (counts.get(candidate.semanticKey) ?? 0) + 1);
  }
  return counts;
}

function emptyScan() {
  return { candidates: [], errors: [], reviewedPaths: [] };
}

export function readCompleteCurrentCandidates(reviewInput) {
  return reviewInput.mode === 'changed-range'
    ? scanRevisionPaths(reviewInput.head, readRevisionTestPaths(reviewInput.head))
    : scanWorkingPaths(readWorkingTestPaths());
}

function readWorkingTestPaths() {
  return runGit(['ls-files', '-z']).split('\0').filter(isTestPath).toSorted();
}

function readRevisionTestPaths(revision) {
  return runGit(['ls-tree', '-r', '-z', '--name-only', revision])
    .split('\0')
    .filter(isTestPath)
    .toSorted();
}

function scanWorkingPaths(paths) {
  const sources = paths
    .filter(existsSync)
    .map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  return scanSources(sources);
}

function scanRevisionPaths(revision, paths) {
  const sources = paths.flatMap((file) => {
    const source = readRevisionFile(revision, file);
    return source ? [{ file, source }] : [];
  });
  return scanSources(sources);
}

export function readRevisionFile(revision, file) {
  return tryGit(['show', `${revision}:${file}`])?.toString('utf8');
}

function withChange(change) {
  return (candidate) => ({ ...candidate, change });
}

function withCandidateChange(result, change) {
  return {
    candidates: result.candidates.map(withChange(change)),
    errors: result.errors,
    reviewedPaths: result.reviewedPaths,
  };
}

function runGit(args) {
  return runGitBuffer(args).toString('utf8');
}

function runGitBuffer(args) {
  const output = tryGit(args);
  if (!output) {
    failGitEvidence(`could not read Git evidence: git ${args.join(' ')}`);
  }
  return output;
}

function tryGit(args) {
  try {
    return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

function failGitEvidence(message) {
  console.log(`FAIL: ${message}`);
  process.exit(1);
}
