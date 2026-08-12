import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';

const modulePattern = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const productionRoots = new Set(['apps', 'examples', 'packages', 'scripts']);

export function readChangedPaths(repoRoot, base) {
  const output = runGit(repoRoot, ['diff', '--name-status', '-z', '--find-renames', base, '--']);
  const tokens = output.split('\0').filter(Boolean);
  const changes = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (status.startsWith('R') || status.startsWith('C')) {
      changes.push({ status, oldPath: tokens[index++], path: tokens[index++] });
    } else {
      changes.push({ status, path: tokens[index++] });
    }
  }
  const knownPaths = new Set(changes.map((change) => change.path));
  const untracked = runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  for (const untrackedPath of untracked.split('\0').filter(Boolean)) {
    if (!knownPaths.has(untrackedPath)) {
      changes.push({ status: 'A', path: untrackedPath });
    }
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

export function computeAffectedCodeDigest(repoRoot, base, changes) {
  const tuples = changes
    .filter((change) => isAffectedCodePath(change.path))
    .map((change) => readContentTuple(repoRoot, change))
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
    allowedRoots.push(capability.root, capability.testRoot);
    allowedPaths.add(capability.entry);
  }
  return allChangedPaths(changes).filter((changedPath) => {
    if (allowedPaths.has(changedPath)) {
      return false;
    }
    return !allowedRoots.some((root) => isWithin(changedPath, root));
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
    affectedCodeDigest: computeAffectedCodeDigest(input.repoRoot, input.base, input.changes),
    computedTriggers: computeCheckpointTriggers(input),
    undeclaredChangedPaths: computeUndeclaredChangedPaths(
      input.changes,
      input.record,
      input.planPath,
    ),
  };
}

function readContentTuple(repoRoot, change) {
  if (change.status.startsWith('D')) {
    return { path: change.path, mode: '000000', content: Buffer.alloc(0) };
  }
  const absolutePath = path.join(repoRoot, change.path);
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    return { path: change.path, mode: '120000', content: Buffer.from(readlinkSync(absolutePath)) };
  }
  const mode = stat.mode & 0o111 ? '100755' : '100644';
  return { path: change.path, mode, content: readFileSync(absolutePath) };
}

function allChangedPaths(changes) {
  return [
    ...new Set(changes.flatMap((change) => [change.oldPath, change.path]).filter(Boolean)),
  ].sort();
}

function hasDirectoryCreationOrMovement(repoRoot, base, changes) {
  const basePaths = new Set(
    runGit(repoRoot, ['ls-tree', '-r', '--name-only', base]).split('\n').filter(Boolean),
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

function isAffectedCodePath(changedPath) {
  return isProductionModule(changedPath) || /(?:^|\/)package\.json$/u.test(changedPath);
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
