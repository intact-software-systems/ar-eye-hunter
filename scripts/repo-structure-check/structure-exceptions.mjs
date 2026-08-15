import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const exceptionRegistryPath = 'docs/repo-structure-exceptions.json';
const exceptionFields = ['owner', 'reviewOrRemovalCondition', 'ruleId', 'target'];

export function readStructureExceptions(repoRoot) {
  const absolutePath = resolveRegistryPath(repoRoot);
  if (absolutePath === undefined) {
    return { exceptions: [], issues: [] };
  }
  let registry;
  try {
    registry = JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    return {
      exceptions: [],
      issues: [`${exceptionRegistryPath} contains invalid JSON: ${toError(error).message}`],
    };
  }
  if (!isRecord(registry) || registry.version !== 1 || !Array.isArray(registry.exceptions)) {
    return {
      exceptions: [],
      issues: [`${exceptionRegistryPath} must contain version 1 and an exceptions array`],
    };
  }
  const exceptions = [];
  const issues = [];
  const identities = new Set();
  for (const [index, exception] of registry.exceptions.entries()) {
    const name = `${exceptionRegistryPath} exceptions[${index}]`;
    const entryIssues = validateException(exception, name);
    const identity = `${exception?.ruleId}\0${exception?.target}`;
    if (entryIssues.length === 0 && identities.has(identity)) {
      entryIssues.push(`${name} duplicates an earlier rule and target`);
    }
    issues.push(...entryIssues);
    if (entryIssues.length === 0) {
      identities.add(identity);
      exceptions.push(exception);
    }
  }
  return { exceptions, issues };
}

function validateException(exception, name) {
  if (!isRecord(exception)) {
    return [`${name} must be an object`];
  }
  const issues = [];
  const unsupported = Object.keys(exception)
    .filter((field) => !exceptionFields.includes(field))
    .sort();
  if (unsupported.length > 0) {
    issues.push(`${name} contains unsupported fields: ${unsupported.join(', ')}`);
  }
  const missing = exceptionFields.filter((field) => !Object.hasOwn(exception, field));
  if (missing.length > 0) {
    issues.push(`${name} is missing fields: ${missing.join(', ')}`);
  }
  if (exception.ruleId !== 'topology.singleton-subtree') {
    issues.push(`${name}.ruleId must be topology.singleton-subtree`);
  }
  if (!isConfinedRepoPath(exception.target)) {
    issues.push(`${name}.target must be a confined repository-relative path`);
  }
  for (const field of ['owner', 'reviewOrRemovalCondition']) {
    if (typeof exception[field] !== 'string' || exception[field].trim() === '') {
      issues.push(`${name}.${field} must be a non-empty string`);
    }
  }
  return issues;
}

function resolveRegistryPath(repoRoot) {
  const repositoryRoot = realpathSync(repoRoot);
  const absolutePath = path.join(repositoryRoot, exceptionRegistryPath);
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return undefined;
    }
    throw new Error('repository structure exception registry must be a confined regular file');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(absolutePath) !== absolutePath) {
    throw new Error('repository structure exception registry must be a confined regular file');
  }
  return absolutePath;
}

function isConfinedRepoPath(value) {
  return (
    typeof value === 'string' &&
    value !== '' &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
