import { createHash } from 'node:crypto';

import { parse } from '@babel/parser';

import { findUnknownUsages } from '../../../scripts/repo-style-check/contract-rules.mjs';

interface BoundaryOwner {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly node: ParsedNode;
}

interface OwnedBoundaryOccurrence {
  readonly owner: BoundaryOwner;
  readonly usageLine: number;
  readonly usageText: string;
}

export interface BoundaryOccurrence {
  readonly owner: string;
  readonly span: string;
  readonly usageLine: number;
  readonly usageText: string;
  readonly ownerContentHash: string;
}

interface ParsedNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

export function readBoundaryOccurrences(
  source: string,
  errorPrefix: string,
): readonly BoundaryOccurrence[] {
  return readOwnedBoundaryOccurrences(source, errorPrefix).map(({ owner, ...usage }) => ({
    ...usage,
    owner: owner.name,
    span: `${owner.startLine}-${owner.endLine}`,
    ownerContentHash: hash(canonicalOwnerContent(owner.node)),
  }));
}

export function readBoundaryOwnerContentByName(
  source: string,
  errorPrefix: string,
): ReadonlyMap<string, string> {
  const ownerByName = new Map<string, BoundaryOwner>();

  for (const { owner } of readOwnedBoundaryOccurrences(source, errorPrefix)) {
    const existing = ownerByName.get(owner.name);
    if (existing !== undefined && existing.node !== owner.node) {
      throw new Error(`${errorPrefix}: duplicate owner ${owner.name}`);
    }
    ownerByName.set(owner.name, owner);
  }

  return new Map(
    [...ownerByName].map(([name, owner]) => [name, canonicalOwnerContent(owner.node)]),
  );
}

function readOwnedBoundaryOccurrences(
  source: string,
  errorPrefix: string,
): readonly OwnedBoundaryOccurrence[] {
  const owners = readFunctionOwners(source);
  return findUnknownUsages(source.split('\n')).map((usage) => ({
    owner: readBoundaryOwner(owners, usage.line, errorPrefix),
    usageLine: usage.line,
    usageText: usage.text,
  }));
}

function readBoundaryOwner(
  owners: readonly BoundaryOwner[],
  usageLine: number,
  errorPrefix: string,
): BoundaryOwner {
  const owner = owners
    .filter(({ startLine, endLine }) => usageLine >= startLine && usageLine <= endLine)
    .toSorted((left, right) => ownerLength(left) - ownerLength(right))[0];
  if (owner === undefined) throw new Error(`${errorPrefix}: unowned boundary`);
  return owner;
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
  if (node.type === 'FunctionDeclaration') return boundaryOwner(identifierName(node.id), node);
  if (node.type !== 'ClassMethod' && node.type !== 'ClassPrivateMethod') return undefined;
  const methodName = identifierName(node.key);
  return boundaryOwner(className === undefined ? methodName : `${className}.${methodName}`, node);
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

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
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
