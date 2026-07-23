import type { MutationRoutingAstNode as AstNode } from './mutation-routing-call-graph.ts';

export type RegistrationTypeCollection =
  | Readonly<{ kind: 'known'; types: ReadonlySet<string> }>
  | Readonly<{ kind: 'unknown'; types: ReadonlySet<string> }>;

export type RegistrationCollectionEvaluator = (
  value: AstNode | undefined,
) => RegistrationTypeCollection;

export const UNKNOWN_REGISTRATION_TYPES: RegistrationTypeCollection = {
  kind: 'unknown',
  types: new Set(),
};

export function knownRegistrationTypes(
  types: Iterable<string>,
): RegistrationTypeCollection {
  return { kind: 'known', types: new Set(types) };
}

export function unknownRegistrationTypes(
  provenTypes: Iterable<string> = [],
): RegistrationTypeCollection {
  return { kind: 'unknown', types: new Set(provenTypes) };
}

export function filterRegistrationTypes(
  collection: RegistrationTypeCollection,
  callback: AstNode | undefined,
  evaluateCollection: RegistrationCollectionEvaluator,
): RegistrationTypeCollection {
  const predicate = readCallback(callback);
  if (!predicate) return UNKNOWN_REGISTRATION_TYPES;
  const filtered = new Set<string>();
  let unknown = collection.kind === 'unknown';
  for (const type of collection.types) {
    const result = evaluateBoolean(
      predicate.body,
      predicate.parameter,
      type,
      evaluateCollection,
    );
    if (result === undefined) unknown = true;
    else if (result) filtered.add(type);
  }
  return unknown ? unknownRegistrationTypes(filtered) : knownRegistrationTypes(filtered);
}

export function mapRegistrationTypes(
  collection: RegistrationTypeCollection,
  callback: AstNode | undefined,
  evaluateCollection: RegistrationCollectionEvaluator,
): RegistrationTypeCollection {
  const mapper = readCallback(callback);
  if (!mapper) return UNKNOWN_REGISTRATION_TYPES;
  const mapped = new Set<string>();
  let unknown = collection.kind === 'unknown';
  for (const type of collection.types) {
    const result = evaluateMappedValue(
      mapper.body,
      mapper.parameter,
      type,
      evaluateCollection,
    );
    if (result.kind === 'unknown') unknown = true;
    else for (const mappedType of result.types) mapped.add(mappedType);
  }
  return unknown ? unknownRegistrationTypes(mapped) : knownRegistrationTypes(mapped);
}

interface RegistrationCallback {
  readonly parameter: string;
  readonly body: AstNode;
}

function readCallback(value: AstNode | undefined): RegistrationCallback | undefined {
  if (
    value?.type !== 'ArrowFunctionExpression' &&
    value?.type !== 'FunctionExpression'
  ) return undefined;
  const parameter = readName(asNodes(value.params)[0]);
  let body = unwrap(asNode(value.body));
  if (body?.type === 'BlockStatement') {
    const statements = asNodes(body.body);
    body = statements.length === 1 && statements[0]?.type === 'ReturnStatement'
      ? unwrap(asNode(statements[0].argument))
      : undefined;
  }
  return body ? { parameter, body } : undefined;
}

function evaluateBoolean(
  value: AstNode,
  parameter: string,
  candidate: string,
  evaluateCollection: RegistrationCollectionEvaluator,
): boolean | undefined {
  const node = unwrap(value);
  if (!node) return undefined;
  if (node.type === 'BooleanLiteral') return node.value === true;
  if (node.type === 'UnaryExpression' && node.operator === '!') {
    const result = asNode(node.argument) && evaluateBoolean(
      asNode(node.argument)!,
      parameter,
      candidate,
      evaluateCollection,
    );
    return result === undefined ? undefined : !result;
  }
  if (node.type === 'LogicalExpression') {
    const left = asNode(node.left) && evaluateBoolean(
      asNode(node.left)!,
      parameter,
      candidate,
      evaluateCollection,
    );
    const right = asNode(node.right) && evaluateBoolean(
      asNode(node.right)!,
      parameter,
      candidate,
      evaluateCollection,
    );
    if (node.operator === '&&') {
      if (left === false || right === false) return false;
      return left === true && right === true ? true : undefined;
    }
    if (node.operator === '||') {
      if (left === true || right === true) return true;
      return left === false && right === false ? false : undefined;
    }
    return undefined;
  }
  if (
    node.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(String(node.operator))
  ) {
    const left = readTypeValue(asNode(node.left), parameter, candidate);
    const right = readTypeValue(asNode(node.right), parameter, candidate);
    if (left === undefined || right === undefined) return undefined;
    const equal = left === right;
    return node.operator === '===' || node.operator === '==' ? equal : !equal;
  }
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return undefined;
  const callee = asNode(node.callee);
  if (readMemberName(callee) !== 'includes') return undefined;
  const sought = readTypeValue(asNodes(node.arguments)[0], parameter, candidate);
  if (sought === undefined) return undefined;
  const collection = evaluateCollection(asNode(callee?.object));
  if (collection.types.has(sought)) return true;
  return collection.kind === 'known' ? false : undefined;
}

function evaluateMappedValue(
  value: AstNode,
  parameter: string,
  candidate: string,
  evaluateCollection: RegistrationCollectionEvaluator,
): RegistrationTypeCollection {
  const node = unwrap(value);
  if (!node) return UNKNOWN_REGISTRATION_TYPES;
  const direct = readTypeValue(node, parameter, candidate);
  if (direct !== undefined) return knownRegistrationTypes([direct]);
  if (node.type === 'ArrayExpression' || node.type === 'TupleExpression') {
    const mapped = new Set<string>();
    for (const element of asNodes(node.elements)) {
      const result = evaluateMappedValue(element, parameter, candidate, evaluateCollection);
      if (result.kind === 'unknown') return result;
      for (const type of result.types) mapped.add(type);
    }
    return knownRegistrationTypes(mapped);
  }
  if (node.type !== 'ConditionalExpression') return UNKNOWN_REGISTRATION_TYPES;
  const test = asNode(node.test) && evaluateBoolean(
    asNode(node.test)!,
    parameter,
    candidate,
    evaluateCollection,
  );
  if (test === undefined) return UNKNOWN_REGISTRATION_TYPES;
  return evaluateMappedValue(
    asNode(test ? node.consequent : node.alternate)!,
    parameter,
    candidate,
    evaluateCollection,
  );
}

function readTypeValue(
  value: AstNode | undefined,
  parameter: string,
  candidate: string,
): string | undefined {
  const node = unwrap(value);
  if (node?.type === 'Identifier' && readName(node) === parameter) return candidate;
  if (node?.type !== 'MemberExpression' && node?.type !== 'OptionalMemberExpression') {
    return undefined;
  }
  return readName(node.object) === 'AppInboxType' ? readName(node.property) : undefined;
}

function unwrap(value: AstNode | undefined): AstNode | undefined {
  if (
    value?.type === 'TSAsExpression' || value?.type === 'TSTypeAssertion' ||
    value?.type === 'TypeCastExpression' || value?.type === 'TSNonNullExpression' ||
    value?.type === 'ParenthesizedExpression'
  ) return unwrap(asNode(value.expression));
  return value;
}

function readMemberName(node: AstNode | undefined): string {
  return node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression'
    ? readName(node.property)
    : '';
}

function readName(value: unknown): string {
  const node = asNode(value);
  return node && typeof node.name === 'string' ? node.name : '';
}

function asNode(value: unknown): AstNode | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AstNode : undefined;
}

function asNodes(value: unknown): readonly AstNode[] {
  return Array.isArray(value)
    ? value.map(asNode).filter((node): node is AstNode => node !== undefined)
    : [];
}
