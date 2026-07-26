import {
  findAstNode,
  type MutationRoutingAstNode as AstNode,
} from './mutation-routing-call-graph.ts';
import {
  evaluateObjectEntriesMap,
  evaluateStaticObjectCollection,
} from './mutation-routing-object-collection.ts';
import {
  evaluateMapEntriesProjection,
  evaluateMapProjection,
  readStaticCollectionMethod,
} from './mutation-routing-map-collection.ts';
import {
  createMutationBoundaryLexicalValues,
  type MutationBoundaryLexicalValues,
} from './mutation-boundary-lexical-values.ts';
import { readInvocationLexicals } from './mutation-routing-invocation-lexical.ts';
import {
  filterRegistrationTypes,
  knownRegistrationTypes,
  mapRegistrationTypes,
  type RegistrationTypeCollection,
  UNKNOWN_REGISTRATION_TYPES,
  unknownRegistrationTypes,
} from './mutation-routing-registration-predicate.ts';
import {
  evaluateLexicalIdentifier,
  evaluateLexicalMember,
  isProvenGlobalBuiltin,
  isStaticObjectEntries,
  type MutationRoutingProgramLoader,
  readAppInboxType,
} from './mutation-routing-lexical-evaluation.ts';

export type { MutationRoutingProgramLoader } from './mutation-routing-lexical-evaluation.ts';

export function hasLiveAppInboxRegistration(
  program: AstNode,
  filePath: string,
  call: AstNode,
  typeArgument: AstNode,
  expectedType: string,
  loadProgram: MutationRoutingProgramLoader,
): boolean {
  if (typeArgument.type !== 'Identifier') return false;
  const lexical = createMutationBoundaryLexicalValues(program);
  const binding = readName(typeArgument);
  const loop = findAstNode(
    program,
    (node) =>
      node.type === 'ForOfStatement' &&
      containsNode(node.body, call) &&
      readBoundNames(node.left).has(binding),
  );
  if (loop) {
    const invocationLexicals = readInvocationLexicals(program, loop, lexical);
    return hasKnownType(
      mergeTypes(
        invocationLexicals.map((invocationLexical) =>
          evaluateTypes(
            asNode(loop.right),
            program,
            filePath,
            loadProgram,
            invocationLexical,
          )
        ),
      ),
      expectedType,
    );
  }
  const iteration = findAstNode(program, (node) => {
    if (
      node.type !== 'CallExpression' ||
      readMemberName(asNode(node.callee)) !== 'forEach'
    ) {
      return false;
    }
    return asNodes(node.arguments).some(
      (argument) =>
        isFunction(argument) &&
        readBoundNames(asNodes(argument.params)[0]).has(binding) &&
        containsNode(argument.body, call),
    );
  });
  const callee = asNode(iteration?.callee);
  return (
    !!callee &&
    hasKnownType(
      evaluateTypes(
        asNode(callee.object),
        program,
        filePath,
        loadProgram,
        lexical,
      ),
      expectedType,
    )
  );
}

function evaluateTypes(
  value: AstNode | undefined,
  program: AstNode,
  filePath: string,
  loadProgram: MutationRoutingProgramLoader,
  lexical: MutationBoundaryLexicalValues,
  resolving = new Set<string>(),
): RegistrationTypeCollection {
  const node = unwrap(value);
  if (!node) return UNKNOWN_REGISTRATION_TYPES;
  const lexicalContext = {
    program,
    filePath,
    loadProgram,
    lexical,
    evaluate: (
      candidate: AstNode | undefined,
      nextProgram: AstNode,
      nextPath: string,
      nextLexical: MutationBoundaryLexicalValues,
      nextResolving: Set<string>,
    ) =>
      evaluateTypes(
        candidate,
        nextProgram,
        nextPath,
        loadProgram,
        nextLexical,
        nextResolving,
      ),
  };
  const direct = readAppInboxType(node);
  if (direct) return knownRegistrationTypes([direct]);
  if (node.type === 'ArrayExpression' || node.type === 'TupleExpression') {
    return mergeTypes(
      asNodes(node.elements).map((element) =>
        evaluateTypes(
          element,
          program,
          filePath,
          loadProgram,
          lexical,
          resolving,
        )
      ),
    );
  }
  if (node.type === 'ObjectExpression') return UNKNOWN_REGISTRATION_TYPES;
  if (node.type === 'SpreadElement') {
    return evaluateTypes(
      asNode(node.argument),
      program,
      filePath,
      loadProgram,
      lexical,
      resolving,
    );
  }
  if (node.type === 'Identifier') {
    return evaluateLexicalIdentifier(node, lexicalContext, resolving);
  }
  if (
    node.type === 'MemberExpression' ||
    node.type === 'OptionalMemberExpression'
  ) {
    return evaluateLexicalMember(node, lexicalContext, resolving);
  }
  if (node.type === 'NewExpression') {
    if (isProvenGlobalBuiltin(asNode(node.callee), 'Map', lexical)) {
      return UNKNOWN_REGISTRATION_TYPES;
    }
    if (!isProvenGlobalBuiltin(asNode(node.callee), 'Set', lexical)) {
      return UNKNOWN_REGISTRATION_TYPES;
    }
    return mergeTypes(
      asNodes(node.arguments).map((argument) =>
        evaluateTypes(
          argument,
          program,
          filePath,
          loadProgram,
          lexical,
          resolving,
        )
      ),
    );
  }
  if (node.type === 'ConditionalExpression') {
    const test = asNode(node.test);
    if (test?.type === 'BooleanLiteral') {
      return evaluateTypes(
        asNode(test.value === true ? node.consequent : node.alternate),
        program,
        filePath,
        loadProgram,
        lexical,
        resolving,
      );
    }
    const consequent = evaluateTypes(
      asNode(node.consequent),
      program,
      filePath,
      loadProgram,
      lexical,
      resolving,
    );
    const alternate = evaluateTypes(
      asNode(node.alternate),
      program,
      filePath,
      loadProgram,
      lexical,
      resolving,
    );
    return equalKnownTypes(consequent, alternate) ? consequent : UNKNOWN_REGISTRATION_TYPES;
  }
  if (
    node.type !== 'CallExpression' &&
    node.type !== 'OptionalCallExpression'
  ) {
    return UNKNOWN_REGISTRATION_TYPES;
  }
  const callee = asNode(node.callee);
  const method = readStaticCollectionMethod(callee, lexical) || readMemberName(callee);
  const collectionMethod = method &&
    ['filter', 'map', 'flatMap', 'values', 'keys', 'entries'].includes(method);
  const staticObjectCollection = ['values', 'keys', 'entries'].includes(method) &&
    isProvenGlobalBuiltin(asNode(callee?.object), 'Object', lexical);
  if (!collectionMethod) return UNKNOWN_REGISTRATION_TYPES;
  const source = collectionMethod && !staticObjectCollection
    ? asNode(callee?.object)
    : asNodes(node.arguments)[0];
  const evaluateCollection = (candidate: AstNode | undefined) =>
    evaluateTypes(
      candidate,
      program,
      filePath,
      loadProgram,
      lexical,
      resolving,
    );
  const mapProjection = evaluateMapProjection(
    method,
    source,
    lexical,
    evaluateCollection,
  );
  if (mapProjection) return mapProjection;
  if (method === 'map' || method === 'flatMap') {
    const entriesProjection = evaluateMapEntriesProjection(
      source,
      asNodes(node.arguments)[0],
      lexical,
      evaluateCollection,
    );
    if (entriesProjection) return entriesProjection;
  }
  const types = evaluateTypes(
    source,
    program,
    filePath,
    loadProgram,
    lexical,
    resolving,
  );
  if (
    (method === 'map' || method === 'flatMap') &&
    isStaticObjectEntries(source, lexical)
  ) {
    return evaluateObjectEntriesMap(
      asNodes(source?.arguments)[0],
      asNodes(node.arguments)[0],
      evaluateCollection,
    );
  }
  if (staticObjectCollection) {
    return evaluateStaticObjectCollection(method, source, evaluateCollection);
  }
  if (method === 'filter') {
    return filterRegistrationTypes(
      types,
      asNodes(node.arguments)[0],
      evaluateCollection,
    );
  }
  if (method === 'map' || method === 'flatMap') {
    return mapRegistrationTypes(
      types,
      asNodes(node.arguments)[0],
      evaluateCollection,
    );
  }
  return types;
}

function readBoundNames(value: unknown): ReadonlySet<string> {
  const names = new Set<string>();
  visit(value, (node) => {
    if (node.type === 'Identifier') names.add(readName(node));
  });
  return names;
}

function containsNode(value: unknown, expected: AstNode): boolean {
  return findAstNode(value, (node) => node === expected) !== undefined;
}

function mergeTypes(
  collections: readonly RegistrationTypeCollection[],
): RegistrationTypeCollection {
  const types = new Set<string>();
  let unknown = false;
  for (const collection of collections) {
    if (collection.kind === 'unknown') unknown = true;
    for (const type of collection.types) types.add(type);
  }
  return unknown ? unknownRegistrationTypes(types) : knownRegistrationTypes(types);
}

function equalKnownTypes(
  left: RegistrationTypeCollection,
  right: RegistrationTypeCollection,
): boolean {
  if (left.kind === 'unknown' || right.kind === 'unknown') return false;
  return (
    left.types.size === right.types.size &&
    [...left.types].every((type) => right.types.has(type))
  );
}

function hasKnownType(
  collection: RegistrationTypeCollection,
  expectedType: string,
): boolean {
  return collection.types.has(expectedType);
}

function unwrap(value: AstNode | undefined): AstNode | undefined {
  if (
    value?.type === 'TSAsExpression' ||
    value?.type === 'TSTypeAssertion' ||
    value?.type === 'TypeCastExpression' ||
    value?.type === 'TSNonNullExpression' ||
    value?.type === 'ParenthesizedExpression'
  ) {
    return unwrap(asNode(value.expression));
  }
  return value;
}

function isFunction(node: AstNode): boolean {
  return ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.type);
}

function readMemberName(node: AstNode | undefined): string {
  return node?.type === 'MemberExpression' ||
      node?.type === 'OptionalMemberExpression'
    ? readName(node.property)
    : '';
}

function visit(value: unknown, visitor: (node: AstNode) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const child of value) visit(child, visitor);
    return;
  }
  const node = value as AstNode;
  if (typeof node.type === 'string') visitor(node);
  for (const [key, child] of Object.entries(node)) {
    if (!['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) {
      visit(child, visitor);
    }
  }
}

function readName(value: unknown): string {
  const node = asNode(value);
  return node && typeof node.name === 'string' ? node.name : '';
}
function asNode(value: unknown): AstNode | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AstNode)
    : undefined;
}

function asNodes(value: unknown): readonly AstNode[] {
  return Array.isArray(value)
    ? value.map(asNode).filter((node): node is AstNode => node !== undefined)
    : [];
}
