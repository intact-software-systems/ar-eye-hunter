import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

import { isPlannedCapability } from '../plan-adaptation/adaptive-plan-record.mjs';
import { readTopLevelSymbolEvidence } from './capability-declarations.mjs';

const contractKeys = new Set(['entry', 'failures', 'results', 'version']);
const referenceKeys = new Set(['path', 'symbol']);

export function selectNavigationCapability(capabilities, owner) {
  const matches = capabilities.filter(
    (capability) =>
      !isPlannedCapability(capability) &&
      capability.kind !== 'guidance' &&
      capability.owner === owner,
  );
  if (matches.length === 0) {
    throw new Error(`navigation evidence owner ${owner} is not a declared active code capability`);
  }
  if (matches.length > 1) {
    throw new Error(`navigation evidence owner ${owner} is ambiguous`);
  }
  return matches[0];
}

export function createRepositoryNavigationEvidence(input) {
  const { capability } = input;
  if (typeof capability.navigationMap !== 'string') {
    throw new Error(
      `navigation evidence owner ${capability.owner} does not declare a navigation map`,
    );
  }
  const repositoryFiles = new Set(input.repositoryFiles);
  if (!repositoryFiles.has(capability.navigationMap)) {
    throw new Error(
      `${capability.owner} navigation map ${capability.navigationMap} ` +
        'does not resolve to a tracked or nonignored untracked repository file',
    );
  }
  const markdown = readSafeRepositoryFile(
    input.repoRoot,
    capability.navigationMap,
    input.fileOperations,
  );
  const contract = parseNavigationContract(capability.owner, markdown);
  if (contract.entry.path !== capability.entry) {
    throw new Error(
      `${capability.owner} navigation entry path must match declared entry ${capability.entry}`,
    );
  }
  const entry = validateReference({
    input,
    repositoryFiles,
    reference: contract.entry,
    role: 'entry',
  });
  const results = contract.results.map((reference) =>
    validateReference({ input, repositoryFiles, reference, role: 'result' }),
  );
  const failures = contract.failures.map((reference) =>
    validateReference({ input, repositoryFiles, reference, role: 'failure' }),
  );
  if (!/^[a-f0-9]{64}$/u.test(input.affectedCodeDigest)) {
    throw new Error(
      'navigation evidence requires a 64-character lowercase hexadecimal affected-code digest',
    );
  }
  return {
    schemaVersion: 'repository-navigation-evidence-v1',
    owner: capability.owner,
    root: capability.root,
    entry,
    results: toSortedReferences(results),
    failures: toSortedReferences(failures),
    testRoot: capability.testRoot,
    focusedCommand: capability.focusedCommand,
    navigationMap: { state: 'present', path: capability.navigationMap },
    affectedCodeDigest: input.affectedCodeDigest,
  };
}

function parseNavigationContract(owner, markdown) {
  const blocks = readNavigationBlocks(markdown);
  if (blocks.length !== 1) {
    throw new Error(
      `${owner} navigation map must contain exactly one standalone ` +
        'repository-navigation-v1 block',
    );
  }
  let contract;
  try {
    contract = JSON.parse(blocks[0]);
  } catch (error) {
    throw new Error(
      `${owner} repository-navigation-v1 block contains invalid JSON: ${toError(error).message}`,
    );
  }
  if (!isPlainObject(contract)) {
    throw new Error(`${owner} repository-navigation-v1 block must contain an object`);
  }
  const unknownKeys = Object.keys(contract).filter((key) => !contractKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `${owner} repository-navigation-v1 block has unknown keys: ${unknownKeys.sort().join(', ')}`,
    );
  }
  if (contract.version !== 1) {
    throw new Error(`${owner} repository-navigation-v1 version must be 1`);
  }
  const entry = parseReference(owner, contract.entry, 'entry');
  const results = parseReferenceList(owner, contract.results, 'results');
  const failures = parseReferenceList(owner, contract.failures, 'failures');
  return { entry, results, failures };
}

function readNavigationBlocks(markdown) {
  const blocks = [];
  let contractLines;
  let otherFence;
  for (const line of markdown.split(/\r?\n/u)) {
    if (contractLines !== undefined) {
      if (line === '```') {
        blocks.push(contractLines.join('\n'));
        contractLines = undefined;
      } else {
        contractLines.push(line);
      }
      continue;
    }
    if (otherFence !== undefined) {
      if (line === otherFence) {
        otherFence = undefined;
      }
      continue;
    }
    if (line === '```repository-navigation-v1') {
      contractLines = [];
      continue;
    }
    const fence = /^((`{3,}|~{3,}))(?:.*)$/u.exec(line)?.[1];
    if (fence !== undefined) {
      otherFence = fence;
    }
  }
  return contractLines === undefined ? blocks : [];
}

function parseReferenceList(owner, value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${owner} repository-navigation-v1 ${field} must be a non-empty array`);
  }
  const references = value.map((reference) => parseReference(owner, reference, field));
  const keys = references.map(({ path: repositoryPath, symbol }) => `${repositoryPath}#${symbol}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error(
      `${owner} repository-navigation-v1 ${field} must not contain duplicate ` +
        'path#symbol references',
    );
  }
  return references;
}

function parseReference(owner, value, field) {
  if (!isPlainObject(value)) {
    throw new Error(`${owner} repository-navigation-v1 ${field} must contain path and symbol`);
  }
  const unknownKeys = Object.keys(value).filter((key) => !referenceKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `${owner} repository-navigation-v1 ${field} has unknown keys: ` +
        unknownKeys.sort().join(', '),
    );
  }
  if (typeof value.path !== 'string' || typeof value.symbol !== 'string' || value.symbol === '') {
    throw new Error(`${owner} repository-navigation-v1 ${field} must contain path and symbol`);
  }
  validateRepositoryPath(value.path);
  return { path: value.path, symbol: value.symbol };
}

function validateReference({ input, repositoryFiles, reference, role }) {
  if (!isCapabilitySourcePath(input.capability, reference.path)) {
    throw new Error(
      `${input.capability.owner} navigation ${role} path ${reference.path} is outside ` +
        `${input.capability.owner}`,
    );
  }
  if (!repositoryFiles.has(reference.path)) {
    throw new Error(
      `${input.capability.owner} navigation ${role} path ${reference.path} does not resolve`,
    );
  }
  const source = readSafeRepositoryFile(input.repoRoot, reference.path, input.fileOperations);
  const evidence = readTopLevelSymbolEvidence(reference.path, source);
  if (evidence.status !== 'resolved' || !evidence.symbols.has(reference.symbol)) {
    throw new Error(
      `${input.capability.owner} navigation ${role} symbol ${reference.symbol} is not a ` +
        `navigable top-level owner in ${reference.path}`,
    );
  }
  return reference;
}

export function readSafeRepositoryFile(repoRoot, repositoryPath, fileOperations = {}) {
  validateRepositoryPath(repositoryPath);
  const canonicalRoot = realpathSync(repoRoot);
  const segments = repositoryPath.split('/');
  let absolutePath = canonicalRoot;
  const identities = [readPathIdentity(canonicalRoot, repositoryPath)];
  for (const segment of segments) {
    absolutePath = path.join(absolutePath, segment);
    identities.push(readPathIdentity(absolutePath, repositoryPath));
  }
  assertPathConfined(canonicalRoot, absolutePath, repositoryPath);
  if ((identities.at(-1).mode & 0o444) === 0) {
    throw new Error(`repository navigation path ${repositoryPath} is not readable`);
  }
  fileOperations.beforeOpen?.({ repositoryPath, absolutePath });
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  let descriptor;
  try {
    descriptor = openSync(absolutePath, constants.O_RDONLY | noFollow);
    const descriptorStat = fstatSync(descriptor);
    if (!descriptorStat.isFile()) {
      throw new Error(`repository navigation path ${repositoryPath} must be a file`);
    }
    if ((descriptorStat.mode & 0o444) === 0) {
      throw new Error(`repository navigation path ${repositoryPath} is not readable`);
    }
    if (!sameIdentity(identities.at(-1), descriptorStat)) {
      throw changedPathError(repositoryPath);
    }
    const content = readFileSync(descriptor, 'utf8');
    fileOperations.afterRead?.({ repositoryPath, absolutePath });
    assertPathConfined(canonicalRoot, absolutePath, repositoryPath);
    verifyPathIdentities(identities, repositoryPath);
    return content;
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new Error(`repository navigation path ${repositoryPath} must not be a symlink`);
    }
    if (error?.code === 'EACCES') {
      throw new Error(`repository navigation path ${repositoryPath} is not readable`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function readPathIdentity(absolutePath, repositoryPath) {
  const stat = lstatSync(absolutePath, { throwIfNoEntry: false });
  if (stat === undefined) {
    throw new Error(`repository navigation path ${repositoryPath} does not resolve`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`repository navigation path ${repositoryPath} must not be a symlink`);
  }
  return { absolutePath, dev: stat.dev, ino: stat.ino, mode: stat.mode };
}

function verifyPathIdentities(identities, repositoryPath) {
  for (const identity of identities) {
    const current = lstatSync(identity.absolutePath, { throwIfNoEntry: false });
    if (current === undefined || current.isSymbolicLink() || !sameIdentity(identity, current)) {
      throw changedPathError(repositoryPath);
    }
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function assertPathConfined(canonicalRoot, absolutePath, repositoryPath) {
  let canonicalPath;
  try {
    canonicalPath = realpathSync(absolutePath);
  } catch {
    throw changedPathError(repositoryPath);
  }
  const relativePath = path.relative(canonicalRoot, canonicalPath);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`repository navigation path ${repositoryPath} escapes the repository root`);
  }
}

function changedPathError(repositoryPath) {
  return new Error(
    `repository navigation path ${repositoryPath} changed while reading navigation evidence`,
  );
}

function validateRepositoryPath(repositoryPath) {
  if (
    repositoryPath === '' ||
    repositoryPath.includes('\\') ||
    path.posix.isAbsolute(repositoryPath) ||
    path.posix.normalize(repositoryPath) !== repositoryPath ||
    repositoryPath.split('/').includes('..')
  ) {
    throw new Error(
      `repository navigation path ${repositoryPath} must be a repository-relative POSIX path`,
    );
  }
}

function isCapabilitySourcePath(capability, repositoryPath) {
  return repositoryPath === capability.entry || repositoryPath.startsWith(`${capability.root}/`);
}

function toSortedReferences(references) {
  return references.toSorted((left, right) =>
    Buffer.compare(
      Buffer.from(`${left.path}\0${left.symbol}`),
      Buffer.from(`${right.path}\0${right.symbol}`),
    ),
  );
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
