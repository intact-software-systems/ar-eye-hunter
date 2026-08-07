import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from '@babel/parser';

import { findUnknownUsages } from '../../../scripts/repo-style-check/contract-rules.mjs';

export const persistenceBase = 'a90042398448776b0972aaaaa0f5cca762163fde';
export const persistenceManifestPath =
  'plans/repo-style-lineages/rallar-auth-server-pr-b-persistence.json';
export const persistenceSourceRoot = 'packages/shared-server/rallar-system/repositories';
export const persistenceTargetRoot = 'packages/shared-server/rallar-system/auth/persistence';

export interface PersistenceLineage {
  mergeBase: string;
  source: { path: string; blob: string };
  targets: string[];
}

interface BoundaryOwner {
  name: string;
  startLine: number;
  endLine: number;
  node: ParsedNode;
}

interface ParsedNode {
  type: string;
  [key: string]: unknown;
}

export const persistenceLineages = [
  persistenceLineage(
    'AuthSessionRepository.ts',
    '6721085e4a0ffac584da9e159f39ce3e70b80be4',
    'auth-session-repository.ts',
  ),
  persistenceLineage(
    'AuthUserRepository.ts',
    '960ce5a419477719ca8532c63b64ba599a8ae582',
    'auth-user-repository.ts',
  ),
  persistenceLineage(
    'auth-legacy-compatibility.ts',
    '7ef04186cdfeda6aec8c9420936db78428e6bfef',
    'auth-legacy-compatibility.ts',
  ),
  persistenceLineage(
    'auth-persistence-contracts.ts',
    '26a16af1ee09a0f9d101aec6e0fac1b18cb3f3ab',
    'auth-persistence-contracts.ts',
  ),
  persistenceLineage(
    'auth-session-persistence.ts',
    '12aa8dbbe55114411f9bf71512b17e177e2f3258',
    'auth-session-persistence.ts',
  ),
  persistenceLineage(
    'auth-session-types.ts',
    'd484d00732deaa254abe350ba196ca84a13b1d8a',
    'auth-session-types.ts',
  ),
  persistenceLineage(
    'auth-ticket-persistence.ts',
    '32db40789e181712b1665c84967ce3123b82219a',
    'auth-ticket-persistence.ts',
  ),
] as const;

// Temporary structural supplement owned by the auth child. PR C removes it after
// the PR B resulting-main workflow and later ledger preserve equivalent evidence.
export function validatePersistenceLineages(
  lineages: readonly PersistenceLineage[],
  targetOverrides = new Map<string, string>(),
): void {
  for (const lineage of lineages) {
    if (lineage.mergeBase !== persistenceBase) throw new Error('persistence base');
    const source = readBase(lineage.source.path);
    if (gitBlob(lineage.source.path) !== lineage.source.blob) {
      throw new Error('persistence source blob');
    }
    if (lineage.targets.length !== 1 || !existsSync(absolute(lineage.targets[0]))) {
      throw new Error('persistence target');
    }
    const target = targetOverrides.get(lineage.targets[0]) ?? read(lineage.targets[0]);
    validatePersistenceTargetDerivation(source, target);
  }
}

function validatePersistenceTargetDerivation(source: string, target: string): void {
  const sourceOwners = boundaryOwnersByName(source);
  const targetOwners = boundaryOwnersByName(target);

  for (const [name, targetOwner] of targetOwners) {
    const sourceOwner = sourceOwners.get(name);
    if (
      sourceOwner === undefined ||
      canonicalOwnerContent(sourceOwner.node) !== canonicalOwnerContent(targetOwner.node)
    ) {
      throw new Error(`persistence target derivation: ${name}`);
    }
  }
}

function boundaryOwnersByName(source: string): ReadonlyMap<string, BoundaryOwner> {
  const owners = readFunctionOwners(source);
  const boundaryOwners = new Map<string, BoundaryOwner>();

  for (const usage of findUnknownUsages(source.split('\n'))) {
    const owner = owners
      .filter(({ startLine, endLine }) => usage.line >= startLine && usage.line <= endLine)
      .toSorted((left, right) => ownerLength(left) - ownerLength(right))[0];
    if (owner === undefined) throw new Error('persistence target derivation: unowned boundary');
    const existing = boundaryOwners.get(owner.name);
    if (existing !== undefined && existing.node !== owner.node) {
      throw new Error(`persistence target derivation: duplicate owner ${owner.name}`);
    }
    boundaryOwners.set(owner.name, owner);
  }

  return boundaryOwners;
}

function readFunctionOwners(source: string): readonly BoundaryOwner[] {
  const owners: BoundaryOwner[] = [];
  const program = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program;
  collectFunctionOwners(program as ParsedNode, undefined, owners);
  return owners;
}

function collectFunctionOwners(
  node: ParsedNode,
  className: string | undefined,
  owners: BoundaryOwner[],
): void {
  const nextClassName = classDeclarationName(node) ?? className;
  const owner = toBoundaryOwner(node, nextClassName);
  if (owner !== undefined) owners.push(owner);

  for (const [key, value] of Object.entries(node)) {
    if (ignoredAstKeys.has(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value)
        if (isParsedNode(child)) collectFunctionOwners(child, nextClassName, owners);
    } else if (isParsedNode(value)) {
      collectFunctionOwners(value, nextClassName, owners);
    }
  }
}

function toBoundaryOwner(
  node: ParsedNode,
  className: string | undefined,
): BoundaryOwner | undefined {
  if (node.type === 'FunctionDeclaration') {
    return boundaryOwner(identifierName(node.id), node);
  }
  if (node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod') {
    const methodName = identifierName(node.key);
    return boundaryOwner(className === undefined ? methodName : `${className}.${methodName}`, node);
  }
  return undefined;
}

function boundaryOwner(name: string | undefined, node: ParsedNode): BoundaryOwner | undefined {
  const loc = node.loc as { start?: { line?: number }; end?: { line?: number } } | undefined;
  const startLine = loc?.start?.line;
  const endLine = loc?.end?.line;
  return name === undefined || startLine === undefined || endLine === undefined
    ? undefined
    : { name, startLine, endLine, node };
}

function canonicalOwnerContent(node: ParsedNode): string {
  return JSON.stringify(node, (key, value) => (ignoredAstKeys.has(key) ? undefined : value));
}

function classDeclarationName(node: ParsedNode): string | undefined {
  return node.type === 'ClassDeclaration' ? identifierName(node.id) : undefined;
}

function identifierName(value: unknown): string | undefined {
  if (!isParsedNode(value)) return undefined;
  if (value.type === 'Identifier' || value.type === 'PrivateName') {
    const name = value.name ?? (isParsedNode(value.id) ? value.id.name : undefined);
    return typeof name === 'string' ? name : undefined;
  }
  return typeof value.value === 'string' ? value.value : undefined;
}

function isParsedNode(value: unknown): value is ParsedNode {
  return (
    typeof value === 'object' && value !== null && typeof (value as ParsedNode).type === 'string'
  );
}

function ownerLength(owner: BoundaryOwner): number {
  return owner.endLine - owner.startLine;
}

function readBase(filePath: string): string {
  return execFileSync('git', ['show', `${persistenceBase}:${filePath}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function gitBlob(filePath: string): string {
  return execFileSync('git', ['rev-parse', `${persistenceBase}:${filePath}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();
}

function read(filePath: string): string {
  return readFileSync(absolute(filePath), 'utf8');
}

function absolute(filePath: string): string {
  return path.join(process.cwd(), filePath);
}

function persistenceLineage(sourceName: string, blob: string, targetName: string) {
  return {
    mergeBase: persistenceBase,
    source: { path: `${persistenceSourceRoot}/${sourceName}`, blob },
    targets: [`${persistenceTargetRoot}/${targetName}`],
  };
}

const ignoredAstKeys = new Set([
  'end',
  'extra',
  'innerComments',
  'leadingComments',
  'loc',
  'start',
  'trailingComments',
]);
