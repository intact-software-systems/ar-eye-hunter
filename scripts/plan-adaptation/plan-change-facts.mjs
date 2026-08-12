import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';

const modulePattern = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const productionRoots = new Set(['apps', 'examples', 'packages', 'scripts']);

export function readChangedPaths(repoRoot, base) {
  validateGitBase(repoRoot, base);
  const output = runGit(repoRoot, [
    'diff',
    '--raw',
    '-z',
    '--find-renames',
    '--end-of-options',
    base,
    '--',
  ]);
  const tokens = output.split('\0').filter(Boolean);
  const changes = [];
  for (let index = 0; index < tokens.length;) {
    const metadata = parseRawMetadata(tokens[index++]);
    const status = metadata.status;
    if (status.startsWith('R') || status.startsWith('C')) {
      changes.push({ ...metadata, oldPath: tokens[index++], path: tokens[index++] });
    } else {
      changes.push({ ...metadata, path: tokens[index++] });
    }
  }
  const knownPaths = new Set(changes.map((change) => change.path));
  const untracked = runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  for (const untrackedPath of untracked.split('\0').filter(Boolean)) {
    if (!knownPaths.has(untrackedPath)) {
      changes.push({
        status: 'A',
        oldMode: '000000',
        newMode: readUntrackedGitMode(repoRoot, untrackedPath),
        path: untrackedPath,
      });
    }
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

export function computeAffectedCodeDigest(digestInput) {
  const { repoRoot, changes, record } = digestInput;
  const tuples = changes
    .flatMap((change) => toContentTuples(repoRoot, change, record))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const hash = createHash('sha256');
  for (const tuple of tuples) {
    hash.update(tuple.path);
    hash.update('\0');
    hash.update(tuple.mode);
    hash.update('\0');
    hash.update(String(tuple.content.byteLength));
    hash.update('\0');
    hash.update(tuple.content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function computeQualificationReasons(repoRoot, base, changes) {
  const reasons = [];
  const changedPaths = allChangedPaths(changes);
  if (changedPaths.some((changedPath) => isWrittenPlan(changedPath))) {
    reasons.push('written-plan');
  }
  if (hasDirectoryCreationOrMovement(repoRoot, base, changes)) {
    reasons.push('directory-creation-or-movement');
  }
  const productionModules = changes.filter(
    (change) => isAddedOrMoved(change) && isProductionModule(change.path),
  );
  if (productionModules.length >= 3) {
    reasons.push('three-production-modules');
  }
  if (hasCapabilityCrossing(changes)) {
    reasons.push('package-or-capability-crossing');
  }
  if (changedPaths.some(isPublicOwnershipPath)) {
    reasons.push('public-ownership-change');
  }
  return reasons;
}

export function computeUndeclaredChangedPaths(changes, record, planPath = '') {
  const allowedPaths = new Set([planPath, 'plans/README.md', 'package.json', '.gitignore']);
  const allowedRoots = [];
  for (const capability of record.capabilities ?? []) {
    if (capability.kind === 'guidance') {
      allowedRoots.push(
        capability.skillRoot,
        capability.contractTestRoot,
        capability.evaluationRoot,
      );
      allowedPaths.add(capability.skillEntry);
      for (const contractPath of capability.contractPaths ?? []) {
        allowedPaths.add(contractPath);
      }
    } else {
      allowedRoots.push(capability.root, capability.testRoot);
      allowedPaths.add(capability.entry);
      for (const factContract of capability.factContracts ?? []) {
        allowedPaths.add(factContract);
      }
    }
  }
  return allChangedPaths(changes).filter((changedPath) => {
    if (allowedPaths.has(changedPath)) {
      return false;
    }
    return !allowedRoots.filter(Boolean).some((root) => isWithin(changedPath, root));
  });
}

export function computeCheckpointTriggers(input) {
  const triggers = [];
  const qualification = computeQualificationReasons(input.repoRoot, input.base, input.changes);
  const changedPaths = allChangedPaths(input.changes);
  if (qualification.includes('directory-creation-or-movement')) {
    triggers.push('folder-change');
  }
  if (hasCapabilityCrossing(input.changes)) {
    triggers.push('ownership-change');
  }
  if (changedPaths.some(isPublicOwnershipPath)) {
    triggers.push('public-contract-change');
  }
  if (changedPaths.some((changedPath) => /(?:^|[-_/])lifecycle(?:[-_.\/]|$)/u.test(changedPath))) {
    triggers.push('lifecycle-change');
  }
  if (input.record.coldNavigationEvidence?.status === 'failed') {
    triggers.push('navigation-degradation');
  }
  if (input.record.architecture?.invalidatedAssumptions?.length > 0) {
    triggers.push('invalid-assumption');
  }
  if (computeUndeclaredChangedPaths(input.changes, input.record, input.planPath ?? '').length > 0) {
    triggers.push('scope-growth');
  }
  if ((input.record.completedSlicesSinceCheckpoint?.length ?? 0) >= 2) {
    triggers.push('two-completed-slices');
  }
  return triggers;
}

export function computePlanFacts(input) {
  return {
    diffBase: input.base,
    affectedCodeDigest: computeAffectedCodeDigest({
      repoRoot: input.repoRoot,
      changes: input.changes,
      record: input.record,
    }),
    computedTriggers: computeCheckpointTriggers(input),
    undeclaredChangedPaths: computeUndeclaredChangedPaths(
      input.changes,
      input.record,
      input.planPath,
    ),
  };
}

function toContentTuples(repoRoot, change, record) {
  const tuples = [];
  if (change.oldPath && isAffectedCodePath(change.oldPath, record)) {
    tuples.push({ path: change.oldPath, mode: '000000', content: Buffer.alloc(0) });
  }
  if (!isAffectedCodePath(change.path, record)) {
    return tuples;
  }
  if (change.status.startsWith('D')) {
    tuples.push({ path: change.path, mode: '000000', content: Buffer.alloc(0) });
    return tuples;
  }
  const absolutePath = path.join(repoRoot, change.path);
  const content =
    change.newMode === '120000'
      ? Buffer.from(readlinkSync(absolutePath))
      : readFileSync(absolutePath);
  tuples.push({ path: change.path, mode: change.newMode, content });
  return tuples;
}

function allChangedPaths(changes) {
  return [
    ...new Set(changes.flatMap((change) => [change.oldPath, change.path]).filter(Boolean)),
  ].sort();
}

function hasDirectoryCreationOrMovement(repoRoot, base, changes) {
  const basePaths = new Set(
    runGit(repoRoot, ['ls-tree', '-r', '--name-only', '--end-of-options', base])
      .split('\n')
      .filter(Boolean),
  );
  return changes.some((change) => {
    if (change.status.startsWith('R')) {
      return path.dirname(change.oldPath) !== path.dirname(change.path);
    }
    if (!change.status.startsWith('A')) {
      return false;
    }
    const parent = path.dirname(change.path);
    return parent !== '.' && ![...basePaths].some((basePath) => isWithin(basePath, parent));
  });
}

function hasCapabilityCrossing(changes) {
  const roots = new Set(allChangedPaths(changes).map(toCapabilityRoot).filter(Boolean));
  const movedAcrossRoot = changes.some(
    (change) =>
      change.oldPath && toCapabilityRoot(change.oldPath) !== toCapabilityRoot(change.path),
  );
  return movedAcrossRoot || roots.size >= 2;
}

function toCapabilityRoot(changedPath) {
  const parts = changedPath.split('/');
  if (parts[0] === 'apps' || parts[0] === 'packages') {
    return parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  if (parts[0] === 'scripts' || parts[0] === 'examples') {
    return parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  return undefined;
}

function isWrittenPlan(changedPath) {
  return (
    changedPath.startsWith('plans/') &&
    changedPath.endsWith('.md') &&
    changedPath !== 'plans/README.md'
  );
}

function isAddedOrMoved(change) {
  return change.status.startsWith('A') || change.status.startsWith('R');
}

function isProductionModule(changedPath) {
  const parts = changedPath.split('/');
  if (!productionRoots.has(parts[0]) || !modulePattern.test(changedPath)) {
    return false;
  }
  return !changedPath.includes('/tests/') && !/\.(?:spec|test)\.[^.]+$/u.test(changedPath);
}

function isAffectedCodePath(changedPath, record) {
  return (
    isProductionModule(changedPath) ||
    /(?:^|\/)package\.json$/u.test(changedPath) ||
    (record?.capabilities ?? []).some(
      (capability) =>
        capability.kind === 'guidance' && isGuidanceCapabilityPath(changedPath, capability),
    )
  );
}

function isGuidanceCapabilityPath(changedPath, capability) {
  return (
    changedPath === capability.skillEntry ||
    changedPath === capability.evaluationRoot ||
    changedPath === capability.contractTestRoot ||
    (typeof capability.skillRoot === 'string' && isWithin(changedPath, capability.skillRoot)) ||
    (typeof capability.evaluationRoot === 'string' &&
      isWithin(changedPath, capability.evaluationRoot)) ||
    (typeof capability.contractTestRoot === 'string' &&
      isWithin(changedPath, capability.contractTestRoot)) ||
    (capability.contractPaths ?? []).includes(changedPath)
  );
}

function isPublicOwnershipPath(changedPath) {
  const basename = path.basename(changedPath);
  return (
    basename === 'package.json' ||
    basename === 'mod.ts' ||
    /^(?:index|public-api)(?:\.[^.]+)?$/u.test(basename)
  );
}

function isWithin(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function runGit(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function parseRawMetadata(value) {
  const match = value.match(/^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z]\d*)$/u);
  if (!match) {
    throw new Error('Git returned malformed raw diff metadata');
  }
  return { oldMode: match[1], newMode: match[2], status: match[3] };
}

function readUntrackedGitMode(repoRoot, relativePath) {
  const stat = lstatSync(path.join(repoRoot, relativePath));
  if (stat.isSymbolicLink()) {
    return '120000';
  }
  return stat.mode & 0o111 ? '100755' : '100644';
}

export function validateGitBase(repoRoot, base) {
  if (typeof base !== 'string' || base === '') {
    throw new Error('Git base must be a non-empty revision');
  }
  if (base.startsWith('-')) {
    throw new Error('Git base must not begin with an option prefix');
  }
  if (/[\0\r\n]/u.test(base)) {
    throw new Error('Git base contains forbidden control characters');
  }
  try {
    runGit(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]);
  } catch {
    throw new Error(`Git base is not a valid commit: ${base}`);
  }
}
