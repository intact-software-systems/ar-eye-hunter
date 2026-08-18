import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { isProductionCodeFile } from './repository-scan.mjs';

const manifestDirectory = 'plans/repo-style-lineages';
const worktreeTarget = 'WORKTREE';
const commitPattern = /^[0-9a-f]{40}$/u;
const manifestKeys = ['lineages', 'version'];
const lineageKeys = ['mergeBase', 'source', 'targets'];
const sourceKeys = ['blob', 'path'];

export class StructuralLineageValidationError extends Error {
  constructor(issues) {
    super(
      [
        'Invalid repository style structural lineage manifest:',
        ...issues.map((issue) => `- ${issue}`),
      ].join('\n'),
    );
    this.name = 'StructuralLineageValidationError';
  }
}

export function readStructuralLineageMap(input) {
  const manifestDocuments = readManifestDocuments(input);
  const issues = [];
  const matchingLineages = [];

  for (const document of manifestDocuments) {
    const parsed = parseManifest(document, issues);
    if (parsed === undefined) {
      continue;
    }
    for (const [index, lineageValue] of parsed.lineages.entries()) {
      const location = `${document.relativePath}: lineages[${index}]`;
      const lineage = parseLineage({
        value: lineageValue,
        location,
        repoRoot: input.repoRoot,
        issues,
      });
      if (lineage !== undefined && lineage.mergeBase === input.mergeBase) {
        matchingLineages.push({ ...lineage, location });
      }
    }
  }

  validateMatchingLineages(input, matchingLineages, issues);
  if (issues.length > 0) {
    throw new StructuralLineageValidationError(issues.toSorted());
  }

  return new Map(
    matchingLineages.flatMap((lineage) =>
      lineage.targets.map((targetPath) => [targetPath, lineage.source.path]),
    ),
  );
}

function readManifestDocuments(input) {
  if (input.targetReference !== worktreeTarget) {
    return readRevisionManifestDocuments(input);
  }
  const relativePaths = readWorktreeManifestPaths(input.repoRoot);
  return relativePaths.map((relativePath) => ({
    relativePath,
    source: readFileSync(path.join(input.repoRoot, relativePath), 'utf8'),
  }));
}

function readRevisionManifestDocuments(input) {
  const treeResult = runGitResult(input.repoRoot, [
    'ls-tree',
    '-rz',
    '--name-only',
    input.targetCommit,
    '--',
    manifestDirectory,
  ]);
  if (treeResult.status !== 0) {
    throw new StructuralLineageValidationError([
      `cannot read structural lineage manifest paths from target ${input.targetCommit}`,
    ]);
  }
  return treeResult.stdout
    .split('\0')
    .filter((relativePath) => relativePath.endsWith('.json'))
    .toSorted()
    .map((relativePath) => ({
      relativePath,
      source: readRevisionManifestSource({
        repoRoot: input.repoRoot,
        targetCommit: input.targetCommit,
        relativePath,
      }),
    }));
}

function readRevisionManifestSource(input) {
  const sourceResult = runGitResult(input.repoRoot, [
    'show',
    `${input.targetCommit}:${input.relativePath}`,
  ]);
  if (sourceResult.status !== 0) {
    throw new StructuralLineageValidationError([
      `${input.relativePath}: cannot read manifest from target ${input.targetCommit}`,
    ]);
  }
  return sourceResult.stdout;
}

function readWorktreeManifestPaths(repoRoot) {
  const directory = path.join(repoRoot, manifestDirectory);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    return [];
  }
  return readNestedWorktreeManifestPaths({ repoRoot, directory }).toSorted();
}

function readNestedWorktreeManifestPaths(input) {
  const relativePaths = [];
  for (const entry of readdirSync(input.directory, { withFileTypes: true })) {
    const entryPath = path.join(input.directory, entry.name);
    if (entry.isDirectory()) {
      relativePaths.push(
        ...readNestedWorktreeManifestPaths({ repoRoot: input.repoRoot, directory: entryPath }),
      );
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      relativePaths.push(toPosixRelativePath(input.repoRoot, entryPath));
    }
  }
  return relativePaths;
}

function toPosixRelativePath(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join(path.posix.sep);
}

function parseManifest(document, issues) {
  let value;
  try {
    value = JSON.parse(document.source);
  } catch (error) {
    issues.push(`${document.relativePath}: invalid JSON (${toErrorMessage(error)})`);
    return undefined;
  }
  if (!isRecord(value)) {
    issues.push(`${document.relativePath}: manifest must be an object`);
    return undefined;
  }
  validateExactKeys({ value, expectedKeys: manifestKeys, location: document.relativePath, issues });
  if (value.version !== 1) {
    issues.push(`${document.relativePath}: version must equal 1`);
  }
  if (!Array.isArray(value.lineages)) {
    issues.push(`${document.relativePath}: lineages must be an array`);
    return undefined;
  }
  return { lineages: value.lineages };
}

function parseLineage({ value, location, repoRoot, issues }) {
  if (!isRecord(value)) {
    issues.push(`${location}: lineage must be an object`);
    return undefined;
  }
  validateExactKeys({ value, expectedKeys: lineageKeys, location, issues });
  if (typeof value.mergeBase !== 'string' || !commitPattern.test(value.mergeBase)) {
    issues.push(`${location}: mergeBase must be a lowercase 40-character Git commit ID`);
    return undefined;
  }
  const source = parseSource({ value: value.source, location, repoRoot, issues });
  const targets = parseTargets({ value: value.targets, location, repoRoot, issues });
  if (source === undefined || targets === undefined) {
    return undefined;
  }
  return { mergeBase: value.mergeBase, source, targets };
}

function parseSource({ value, location, repoRoot, issues }) {
  if (!isRecord(value)) {
    issues.push(`${location}: source must be an object`);
    return undefined;
  }
  validateExactKeys({
    value,
    expectedKeys: sourceKeys,
    location: `${location}.source`,
    issues,
  });
  const sourcePath = readProductionPath({
    value: value.path,
    role: 'source',
    location,
    repoRoot,
    issues,
  });
  if (typeof value.blob !== 'string' || !commitPattern.test(value.blob)) {
    issues.push(`${location}: source blob must be a lowercase 40-character Git object ID`);
    return undefined;
  }
  return sourcePath === undefined ? undefined : { path: sourcePath, blob: value.blob };
}

function parseTargets({ value, location, repoRoot, issues }) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${location}: targets must be a non-empty array`);
    return undefined;
  }
  const targets = [];
  for (const targetValue of value) {
    const targetPath = readProductionPath({
      value: targetValue,
      role: 'target',
      location,
      repoRoot,
      issues,
    });
    if (targetPath !== undefined) {
      targets.push(targetPath);
    }
  }
  return targets.length === value.length ? targets : undefined;
}

function readProductionPath({ value, role, location, repoRoot, issues }) {
  if (typeof value !== 'string' || !isNormalizedRelativePath(value)) {
    issues.push(`${location}: ${role} path must be a normalized repository-relative path`);
    return undefined;
  }
  if (!isProductionCodeFile(path.join(repoRoot, value))) {
    issues.push(`${location}: ${role} path must name production code`);
    return undefined;
  }
  return value;
}

function validateMatchingLineages(input, lineages, issues) {
  const sourceLocations = new Map();
  const targetLocations = new Map();
  for (const lineage of lineages) {
    addDuplicateIssue({
      locations: sourceLocations,
      key: lineage.source.path,
      location: lineage.location,
      message: 'source has multiple lineage entries',
      issues,
    });
    validateSource(input, lineage, issues);
    validateTargets({ input, lineage, targetLocations, issues });
  }
}

function validateSource(input, lineage, issues) {
  const sourceSpec = `${input.mergeBase}:${lineage.source.path}`;
  const sourceResult = runGitResult(input.repoRoot, ['rev-parse', '--verify', sourceSpec]);
  if (sourceResult.status !== 0) {
    issues.push(`${lineage.location}: source does not exist at merge base: ${lineage.source.path}`);
  } else if (sourceResult.stdout.trim() !== lineage.source.blob) {
    issues.push(`${lineage.location}: source blob does not match: ${lineage.source.path}`);
  }
}

function validateTargets({ input, lineage, targetLocations, issues }) {
  const localTargets = new Set();
  for (const targetPath of lineage.targets) {
    if (targetPath === lineage.source.path) {
      issues.push(`${lineage.location}: target must differ from source path: ${targetPath}`);
    }
    if (localTargets.has(targetPath)) {
      issues.push(`${lineage.location}: duplicate target: ${targetPath}`);
    }
    localTargets.add(targetPath);
    addDuplicateIssue({
      locations: targetLocations,
      key: targetPath,
      location: lineage.location,
      message: 'target belongs to multiple lineages',
      issues,
    });
    if (input.renameByTargetPath.has(targetPath)) {
      issues.push(`${lineage.location}: target conflicts with detected Git rename: ${targetPath}`);
    }
    if (!targetPathExists(input, targetPath)) {
      issues.push(`${lineage.location}: target does not exist: ${targetPath}`);
    }
  }
}

function addDuplicateIssue({ locations, key, location, message, issues }) {
  const previousLocation = locations.get(key);
  if (previousLocation !== undefined) {
    issues.push(`${location}: ${message}: ${key} (first declared at ${previousLocation})`);
  } else {
    locations.set(key, location);
  }
}

function targetPathExists(input, relativePath) {
  if (input.targetReference === 'WORKTREE') {
    const absolutePath = path.join(input.repoRoot, relativePath);
    return existsSync(absolutePath) && statSync(absolutePath).isFile();
  }
  return (
    runGitResult(input.repoRoot, ['cat-file', '-e', `${input.targetCommit}:${relativePath}`])
      .status === 0
  );
}

function validateExactKeys({ value, expectedKeys, location, issues }) {
  const actualKeys = Object.keys(value).toSorted();
  if (actualKeys.join('\0') !== expectedKeys.join('\0')) {
    issues.push(`${location}: expected exactly keys ${expectedKeys.join(', ')}`);
  }
}

function isNormalizedRelativePath(value) {
  return (
    value.length > 0 &&
    !value.includes('\\') &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value !== '.' &&
    !value.startsWith('../')
  );
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function runGitResult(repoRoot, args) {
  return spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function toErrorMessage(value) {
  return value instanceof Error ? value.message : String(value);
}
