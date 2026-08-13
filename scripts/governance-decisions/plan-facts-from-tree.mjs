import { createHash } from 'node:crypto';
import path from 'node:path';

const modulePattern = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const productionRoots = new Set(['apps', 'examples', 'packages', 'scripts']);

export function computePlanFactsFromTree(treeInput) {
  const changes = computeTreeChanges(treeInput.baseEntries, treeInput.entries);
  return {
    diffBase: treeInput.baseOid,
    affectedCodeDigest: computeAffectedCodeDigest(changes, treeInput.record),
    computedTriggers: computeCheckpointTriggers(changes, treeInput),
    undeclaredChangedPaths: computeUndeclaredChangedPaths(
      changes,
      treeInput.record,
      treeInput.planPath,
    ),
  };
}

function computeTreeChanges(baseEntries, entries) {
  const baseByPath = new Map(baseEntries.map((entry) => [entry.path, entry]));
  const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const allPaths = new Set([...baseByPath.keys(), ...entriesByPath.keys()]);
  const changes = [];
  for (const entryPath of [...allPaths].sort(compareText)) {
    const before = baseByPath.get(entryPath);
    const after = entriesByPath.get(entryPath);
    if (before?.mode === after?.mode && before?.blobOid === after?.blobOid) {
      continue;
    }
    changes.push({
      path: entryPath,
      status: before === undefined ? 'A' : after === undefined ? 'D' : 'M',
      oldMode: before?.mode ?? '000000',
      newMode: after?.mode ?? '000000',
      content: after?.content ?? '',
    });
  }
  return changes;
}

function computeAffectedCodeDigest(changes, record) {
  const hash = createHash('sha256');
  for (const change of changes.filter((entry) => isAffectedCodePath(entry.path, record))) {
    const mode = change.status === 'D' ? '000000' : change.newMode;
    const content = change.status === 'D' ? '' : change.content;
    const bytes = Buffer.from(content);
    hash.update(change.path);
    hash.update('\0');
    hash.update(mode);
    hash.update('\0');
    hash.update(String(bytes.byteLength));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function computeCheckpointTriggers(changes, treeInput) {
  const triggers = [];
  if (hasDirectoryCreation(treeInput.baseEntries, changes)) {
    triggers.push('folder-change');
  }
  if (hasCapabilityCrossing(changes, treeInput.record)) {
    triggers.push('ownership-change');
  }
  if (changes.some((change) => isPublicOwnershipPath(change.path))) {
    triggers.push('public-contract-change');
  }
  if (changes.some((change) => /(?:^|[-_/])lifecycle(?:[-_.\/]|$)/u.test(change.path))) {
    triggers.push('lifecycle-change');
  }
  if (treeInput.record.coldNavigationEvidence?.status === 'failed') {
    triggers.push('navigation-degradation');
  }
  if (treeInput.record.architecture?.invalidatedAssumptions?.length > 0) {
    triggers.push('invalid-assumption');
  }
  if (computeUndeclaredChangedPaths(changes, treeInput.record, treeInput.planPath).length > 0) {
    triggers.push('scope-growth');
  }
  if ((treeInput.record.completedSlicesSinceCheckpoint?.length ?? 0) >= 2) {
    triggers.push('two-completed-slices');
  }
  return triggers;
}

function computeUndeclaredChangedPaths(changes, record, planPath) {
  const allowedPaths = new Set([planPath, 'plans/README.md', 'package.json', '.gitignore']);
  const allowedRoots = [];
  for (const capability of record.capabilities ?? []) {
    if (capability.kind === 'guidance') {
      allowedRoots.push(capability.contractTestRoot, capability.evaluationRoot);
      allowedPaths.add(
        capability.guidanceRole === 'router' ? capability.routingEntry : capability.skillEntry,
      );
      if (capability.guidanceRole !== 'router') {
        allowedRoots.push(capability.skillRoot);
      }
    } else {
      allowedRoots.push(capability.root, capability.testRoot);
      allowedPaths.add(capability.entry);
      allowedPaths.add(capability.navigationMap);
      for (const factContract of capability.factContracts ?? []) {
        allowedPaths.add(factContract);
      }
    }
    for (const contractPath of capability.contractPaths ?? []) {
      allowedPaths.add(contractPath);
    }
  }
  return changes
    .map((change) => change.path)
    .filter((changedPath) => {
      if (allowedPaths.has(changedPath)) {
        return false;
      }
      return !allowedRoots
        .filter((root) => typeof root === 'string')
        .some((root) => isWithin(changedPath, root));
    });
}

function hasDirectoryCreation(baseEntries, changes) {
  const basePaths = baseEntries.map((entry) => entry.path);
  return changes.some((change) => {
    if (change.status !== 'A') {
      return false;
    }
    const parent = path.posix.dirname(change.path);
    return parent !== '.' && !basePaths.some((basePath) => isWithin(basePath, parent));
  });
}

function hasCapabilityCrossing(changes, record) {
  const roots = new Set(changes.map((change) => toCapabilityRoot(change.path)).filter(Boolean));
  const declaredOwners = new Set(
    changes.flatMap((change) =>
      (record.capabilities ?? [])
        .filter((capability) => isCapabilityOwnershipPath(change.path, capability))
        .map((capability) => capability.owner),
    ),
  );
  return roots.size >= 2 || declaredOwners.size >= 2;
}

function isAffectedCodePath(changedPath, record) {
  return (
    isProductionModule(changedPath) ||
    /(?:^|\/)package\.json$/u.test(changedPath) ||
    (record.capabilities ?? []).some((capability) =>
      isCapabilityContentPath(changedPath, capability),
    )
  );
}

function isProductionModule(changedPath) {
  const parts = changedPath.split('/');
  return (
    productionRoots.has(parts[0]) &&
    modulePattern.test(changedPath) &&
    !changedPath.includes('/tests/') &&
    !/\.(?:spec|test)\.[^.]+$/u.test(changedPath)
  );
}

function isCapabilityContentPath(changedPath, capability) {
  if (capability.kind === 'guidance') {
    return (
      changedPath ===
        (capability.guidanceRole === 'router' ? capability.routingEntry : capability.skillEntry) ||
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
  return (
    isCapabilityOwnershipPath(changedPath, capability) ||
    (capability.factContracts ?? []).includes(changedPath)
  );
}

function isCapabilityOwnershipPath(changedPath, capability) {
  if (capability.kind === 'guidance') {
    return isCapabilityContentPath(changedPath, capability);
  }
  return (
    changedPath === capability.entry ||
    changedPath === capability.navigationMap ||
    (typeof capability.root === 'string' && isWithin(changedPath, capability.root)) ||
    (typeof capability.testRoot === 'string' && isWithin(changedPath, capability.testRoot)) ||
    (capability.contractPaths ?? []).includes(changedPath)
  );
}

function toCapabilityRoot(changedPath) {
  const parts = changedPath.split('/');
  return productionRoots.has(parts[0]) && parts.length > 1 ? `${parts[0]}/${parts[1]}` : undefined;
}

function isPublicOwnershipPath(changedPath) {
  const basename = path.posix.basename(changedPath);
  return (
    basename === 'package.json' ||
    basename === 'mod.ts' ||
    /^(?:index|public-api)(?:\.[^.]+)?$/u.test(basename)
  );
}

function isWithin(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
