import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from '@babel/parser';

import {
  isSemanticNode as isNode,
  visitSemanticNodes as visit,
  type SemanticNode,
} from './group-topology-server-test-ast.ts';

export type SemanticAtomKind =
  'assertion' | 'barrier' | 'case' | 'fixture' | 'raw-literal' | 'variant';

export interface SemanticAtom {
  readonly id: string;
  readonly kind: SemanticAtomKind;
  readonly fingerprint: string;
  readonly matchKeys: readonly string[];
}

const repoRoot = process.cwd();

export function semanticAtoms(testCase: SemanticNode): SemanticAtom[] {
  const title = testCase.arguments?.[0];
  const caseId = isNode(title) && title.type === 'StringLiteral' ? String(title.value) : 'unknown';
  const atoms: SemanticAtom[] = [atom('case', testCase, caseId, [`case:${caseId}`])];
  const callback = testCase.arguments?.[1];
  if (isNode(callback)) {
    visitWithAncestors(callback, [], (node, ancestors) => addNodeAtoms(atoms, node, ancestors));
  }
  for (const [index, fingerprint] of eachVariantFingerprints(testCase).entries()) {
    atoms.push(
      atom('variant', testCase, `${index}:${fingerprint}`, [`variant:${index}:${fingerprint}`]),
    );
  }
  return atoms;
}

export function declarationSemanticAtoms(source: string, symbol: string): SemanticAtom[] {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const declaration = findDeclaration(ast.program as SemanticNode, symbol);
  if (!declaration) {
    throw new Error(`Missing semantic support declaration: ${symbol}`);
  }
  const atoms: SemanticAtom[] = [
    atom('fixture', declaration, `declaration:${symbol}:${nodeDigest(declaration)}`, [
      `fixture:${normalizeFixtureName(symbol)}`,
    ]),
  ];
  visitWithAncestors(declaration, [], (node, ancestors) => addNodeAtoms(atoms, node, ancestors));
  return atoms;
}

export function countKind(atoms: readonly SemanticAtom[], kind: SemanticAtomKind): number {
  return atoms.filter((candidate) => candidate.kind === kind).length;
}

export function sourceKey(sourcePath: string, caseId: string): string {
  return `${sourcePath}\0${caseId}`;
}

export function testCallsites(source: string): number {
  return [...source.matchAll(/\b(?:it|test)(?:\.each)?\s*\(/gu)].length;
}

export function assertionCallsites(source: string): number {
  return [...source.matchAll(/\bexpect(?:TypeOf)?\s*\(/gu)].length;
}

export function readAtCommit(commit: string, relativePath: string): string {
  return execFileSync('git', ['show', `${commit}:${relativePath}`], { encoding: 'utf8' });
}

export function read(relativePath: string): string {
  return readFileSync(absolute(relativePath), 'utf8');
}

export function absolute(relativePath: string): string {
  return path.join(repoRoot, relativePath);
}

function addNodeAtoms(
  atoms: SemanticAtom[],
  node: SemanticNode,
  ancestors: readonly SemanticNode[],
): void {
  const context = semanticContext(ancestors);
  const matchContext = semanticMatchContext(ancestors);
  if (node.type === 'CallExpression') {
    const callee = callName(node.callee);
    if (/^expect(?:TypeOf)?\(\)\./u.test(callee)) {
      atoms.push(atom('assertion', node, `${callee}:${nodeDigest(node)}`, [`assertion:${callee}`]));
    }
    if (/^(?:create|deepFreeze|storedConfig)/u.test(callee)) {
      const fixture = normalizeFixtureName(callee);
      atoms.push(
        atom('fixture', node, `${context}:${callee}:${nodeDigest(node)}`, [
          `fixture:${matchContext.role}:${matchContext.slot}:${fixture}`,
          `fixture:${matchContext.role}:${fixture}`,
          `fixture:${fixture}`,
        ]),
      );
    }
  }
  if (isLiteral(node)) {
    const value = literalValue(node);
    const keys = literalMatchKeys(matchContext, value);
    atoms.push(atom('raw-literal', node, `${context}:${value}`, keys));
    if (/barrier|phase|transaction|clock|ambient/iu.test(value)) {
      atoms.push(atom('barrier', node, `${context}:${value}`, [`barrier:${value}`]));
    }
  }
  if (node.type === 'Identifier' && /barrier|clock/iu.test(String(node.name))) {
    const name = String(node.name);
    atoms.push(atom('barrier', node, `${context}:${name}`, [`barrier:${name}`]));
  }
}

function atom(
  kind: SemanticAtomKind,
  node: SemanticNode,
  fingerprint: string,
  matchKeys: readonly string[],
): SemanticAtom {
  const location = `${node.loc?.start.line ?? 0}:${node.loc?.start.column ?? 0}`;
  return { id: `${kind}:${location}:${fingerprint}`, kind, fingerprint, matchKeys };
}

function eachVariantFingerprints(testCase: SemanticNode): string[] {
  const callee = testCase.callee;
  if (!isNode(callee) || callee.type !== 'CallExpression') {
    return [];
  }
  const values = unwrapExpression(callee.arguments?.[0]);
  if (!isNode(values) || values.type !== 'ArrayExpression' || !Array.isArray(values.elements)) {
    return [];
  }
  return values.elements.filter(isNode).map(nodeDigest);
}

function unwrapExpression(value: unknown): unknown {
  let current = value;
  while (
    isNode(current) &&
    ['TSAsExpression', 'TSSatisfiesExpression', 'TypeCastExpression'].includes(current.type)
  ) {
    current = current.expression;
  }
  return current;
}

function callName(value: unknown): string {
  if (!isNode(value)) {
    return '';
  }
  if (value.type === 'Identifier') {
    return String(value.name);
  }
  if (value.type === 'CallExpression') {
    return `${callName(value.callee)}()`;
  }
  if (value.type !== 'MemberExpression') {
    return '';
  }
  return `${callName(value.object)}.${callName(value.property)}`;
}

function isLiteral(node: SemanticNode): boolean {
  return ['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral'].includes(node.type);
}

function findDeclaration(root: SemanticNode, symbol: string): SemanticNode | undefined {
  let match: SemanticNode | undefined;
  visit(root, (node) => {
    if (match) {
      return;
    }
    if (node.type === 'FunctionDeclaration' && identifierName(node.id) === symbol) {
      match = node;
      return;
    }
    if (node.type === 'VariableDeclarator' && identifierName(node.id) === symbol) {
      match = node;
    }
  });
  return match;
}

function identifierName(value: unknown): string {
  return isNode(value) && value.type === 'Identifier' ? String(value.name) : '';
}

function semanticContext(ancestors: readonly SemanticNode[]): string {
  const labels: string[] = [];
  for (let index = ancestors.length - 1; index >= 0 && labels.length < 3; index -= 1) {
    const label = contextLabel(ancestors[index]);
    if (label) {
      labels.push(label);
    }
  }
  return labels.reverse().join('/');
}

function semanticMatchContext(
  ancestors: readonly SemanticNode[],
): Readonly<{ role: string; slot: string }> {
  const property = nearestContextValue(ancestors, 'ObjectProperty');
  const variable = nearestContextValue(ancestors, 'VariableDeclarator');
  const call = nearestContextValue(ancestors, 'CallExpression');
  const role = ancestors.some(
    (node) =>
      node.type === 'CallExpression' && /^expect(?:TypeOf)?\(\)\./u.test(callName(node.callee)),
  )
    ? 'assertion'
    : ancestors.some((node) => node.type === 'FunctionDeclaration')
      ? 'support'
      : 'setup';
  return { role, slot: property || variable || normalizeFixtureName(call) || '-' };
}

function nearestContextValue(
  ancestors: readonly SemanticNode[],
  type: 'CallExpression' | 'ObjectProperty' | 'VariableDeclarator',
): string {
  const node = ancestors.findLast((candidate) => candidate.type === type);
  if (!node) {
    return '';
  }
  if (type === 'CallExpression') {
    return callName(node.callee);
  }
  return type === 'ObjectProperty' ? propertyName(node.key) : identifierName(node.id);
}

function literalMatchKeys(
  context: Readonly<{ role: string; slot: string }>,
  value: string,
): readonly string[] {
  return [
    `literal:${context.role}:${context.slot}:${value}`,
    `literal:${context.role}:${value}`,
    `literal:${context.slot}:${value}`,
    `literal:${value}`,
  ];
}

function normalizeFixtureName(name: string): string {
  if (name.startsWith('deepFreeze')) {
    return 'deepFreeze';
  }
  if (name === 'createTopologyTestAuthorityGuard') {
    return 'createGroupAuthorityGuard';
  }
  return name.replaceAll('TopologyTest', '').replaceAll('Topology', '').replaceAll('Test', '');
}

function contextLabel(node: SemanticNode): string {
  if (node.type === 'ObjectProperty') {
    return `property:${propertyName(node.key)}`;
  }
  if (node.type === 'VariableDeclarator') {
    return `variable:${identifierName(node.id)}`;
  }
  if (node.type === 'CallExpression') {
    return `call:${callName(node.callee)}`;
  }
  if (node.type === 'FunctionDeclaration') {
    return `function:${identifierName(node.id)}`;
  }
  return '';
}

function propertyName(value: unknown): string {
  if (!isNode(value)) {
    return '';
  }
  return value.type === 'Identifier' ? String(value.name) : literalValue(value);
}

function literalValue(node: SemanticNode): string {
  return node.type === 'NullLiteral' ? 'null' : JSON.stringify(node.value);
}

function nodeDigest(node: SemanticNode): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(withoutLocations(node)));
  return hash.digest('hex').slice(0, 16);
}

function withoutLocations(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutLocations);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['loc', 'start', 'end', 'extra', 'comments', 'tokens'].includes(key))
      .map(([key, child]) => [key, withoutLocations(child)]),
  );
}

function visitWithAncestors(
  value: unknown,
  ancestors: readonly SemanticNode[],
  visitor: (node: SemanticNode, ancestors: readonly SemanticNode[]) => void,
): void {
  if (!isNode(value)) {
    return;
  }
  visitor(value, ancestors);
  for (const [key, child] of Object.entries(value)) {
    if (isNonRuntimeAstField(key)) {
      continue;
    }
    if (Array.isArray(child)) {
      child.forEach((entry) => visitWithAncestors(entry, [...ancestors, value], visitor));
    } else {
      visitWithAncestors(child, [...ancestors, value], visitor);
    }
  }
}

function isNonRuntimeAstField(key: string): boolean {
  return [
    'comments',
    'end',
    'implements',
    'loc',
    'predicate',
    'returnType',
    'start',
    'superTypeParameters',
    'tokens',
    'typeAnnotation',
    'typeArguments',
    'typeParameters',
  ].includes(key);
}
