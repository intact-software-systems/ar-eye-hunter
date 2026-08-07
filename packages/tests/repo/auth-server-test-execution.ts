import {
  type AuthTestAstNode,
  readAstChildren,
  readAstNode,
  readAstNodes,
  readAstString,
} from './auth-server-test-ast.ts';
import type { AuthTestBindingResolver } from './auth-server-test-expression-canonicalization.ts';
import {
  createAuthTestExecutionIndex,
  type AuthTestExecutionIndex,
  type AuthTestModuleIndex,
} from './auth-server-test-execution-index.ts';
import type { AuthTestSourceModule } from './auth-server-test-module-graph.ts';
import {
  addAuthTestBinding,
  addAuthTestDestructuredConstants,
  bindAuthTestParameters,
  materializeAuthTestValue,
} from './auth-server-test-parameter-bindings.ts';

export interface ExecutedAuthTestNode {
  readonly expandsHelper: boolean;
  readonly node: AuthTestAstNode;
  readonly parent: AuthTestAstNode | undefined;
  readonly resolveBinding: AuthTestBindingResolver;
}

export interface AuthTestExecutionContext {
  readonly index: AuthTestExecutionIndex;
}

interface AuthTestExecutionState {
  readonly active: ReadonlySet<AuthTestAstNode>;
  readonly index: AuthTestExecutionIndex;
  readonly output: ExecutedAuthTestNode[];
}

interface AuthTestWalkContext {
  readonly bindings: ReadonlyMap<string, AuthTestAstNode>;
  readonly owner: AuthTestAstNode;
  readonly state: AuthTestExecutionState;
}

interface FactoryBindingContext {
  readonly active: ReadonlySet<AuthTestAstNode>;
  readonly callerBindings: ReadonlyMap<string, AuthTestAstNode>;
  readonly index: AuthTestExecutionIndex;
}

export function createAuthTestExecutionContext(
  modules: readonly AuthTestSourceModule[],
): AuthTestExecutionContext {
  const index = createAuthTestExecutionIndex(modules);
  return { index };
}

export function resolveAuthTestCallback(
  expression: AuthTestAstNode | undefined,
  context: AuthTestExecutionContext,
): AuthTestAstNode | undefined {
  if (expression === undefined) return undefined;
  if (isFunction(expression)) return expression;
  const name = readIdentifierName(expression);
  return name === undefined ? undefined : context.index.entry.functionsByName.get(name);
}

export function executeAuthTestCallback(
  callback: AuthTestAstNode | undefined,
  context: AuthTestExecutionContext,
): readonly ExecutedAuthTestNode[] {
  if (callback === undefined) return [];
  const nodes: ExecutedAuthTestNode[] = [];
  executeFunction(callback, new Map(), {
    active: new Set(),
    index: context.index,
    output: nodes,
  });
  return nodes;
}

function executeFunction(
  target: AuthTestAstNode,
  parameterValues: ReadonlyMap<string, AuthTestAstNode>,
  state: AuthTestExecutionState,
): void {
  if (state.active.has(target)) return;
  const module = state.index.indexByFunction.get(target) ?? state.index.entry;
  const bindings = new Map<string, AuthTestAstNode>([
    ...module.globalValues,
    ...module.functionsByName,
    ...module.importedValues,
    ...(state.index.functionClosures.get(target) ?? []),
  ]);
  for (const [name, value] of module.valuesByFunction.get(target) ?? []) {
    addAuthTestBinding({ target: bindings, name, unresolved: value, source: bindings });
  }
  for (const [name, value] of parameterValues) {
    addAuthTestBinding({ target: bindings, name, unresolved: value, source: parameterValues });
  }
  addFactoryResultBindings(bindings, state.index);
  addAuthTestDestructuredConstants(target, bindings);
  const body = readAstNode(target, 'body');
  if (body === undefined) return;
  walkExecutedNode(body, undefined, {
    owner: target,
    bindings,
    state: { ...state, active: new Set([...state.active, target]) },
  });
}

function addFactoryResultBindings(
  bindings: Map<string, AuthTestAstNode>,
  index: AuthTestExecutionIndex,
  active: ReadonlySet<AuthTestAstNode> = new Set(),
): void {
  for (const [name, value] of [...bindings]) {
    const call = unwrapCallExpression(value);
    const calleeName =
      call === undefined ? undefined : readIdentifierName(readAstNode(call, 'callee'));
    const factory = calleeName === undefined ? undefined : readBoundFunction(calleeName, bindings);
    const returned = factory === undefined ? undefined : readReturnedObject(factory);
    if (
      call === undefined ||
      factory === undefined ||
      returned === undefined ||
      active.has(factory)
    ) {
      continue;
    }
    const nextActive = new Set([...active, factory]);
    const factoryBindings = createFactoryBindings(call, factory, {
      callerBindings: bindings,
      index,
      active: nextActive,
    });
    const materialized = materializeAuthTestValue(returned, factoryBindings);
    bindings.set(name, materialized);
    for (const property of readAstNodes(materialized, 'properties')) {
      const key = readPropertyName(readAstNode(property, 'key'));
      const propertyValue = readAstNode(property, 'value');
      if (key !== undefined && propertyValue !== undefined) {
        addAuthTestBinding({
          target: bindings,
          name: `${name}.${key}`,
          unresolved: propertyValue,
          source: bindings,
        });
      }
    }
  }
}

function createFactoryBindings(
  call: AuthTestAstNode,
  factory: AuthTestAstNode,
  context: FactoryBindingContext,
): ReadonlyMap<string, AuthTestAstNode> {
  const module = context.index.indexByFunction.get(factory) ?? context.index.entry;
  const bindings = new Map<string, AuthTestAstNode>([
    ...module.globalValues,
    ...module.functionsByName,
    ...module.importedValues,
  ]);
  for (const [name, value] of module.valuesByFunction.get(factory) ?? []) {
    addAuthTestBinding({ target: bindings, name, unresolved: value, source: bindings });
  }
  for (const [name, value] of bindAuthTestParameters(
    readAstNodes(factory, 'params'),
    readAstNodes(call, 'arguments'),
    context.callerBindings,
  )) {
    addAuthTestBinding({
      target: bindings,
      name,
      unresolved: value,
      source: context.callerBindings,
    });
  }
  addFactoryResultBindings(bindings, context.index, context.active);
  return bindings;
}

function readReturnedObject(factory: AuthTestAstNode): AuthTestAstNode | undefined {
  let returned: AuthTestAstNode | undefined;
  const body = readAstNode(factory, 'body');
  if (body === undefined) return undefined;
  descend(body);
  return returned;

  function descend(node: AuthTestAstNode): void {
    if (returned !== undefined || (isFunction(node) && node !== factory)) return;
    if (node.type === 'ReturnStatement') {
      const argument = readAstNode(node, 'argument');
      if (argument?.type === 'ObjectExpression') returned = argument;
      return;
    }
    for (const child of readAstChildren(node)) descend(child);
  }
}

function unwrapCallExpression(node: AuthTestAstNode): AuthTestAstNode | undefined {
  let current = node;
  while (current.type === 'AwaitExpression' || isTransparent(current)) {
    const inner = readAstNode(current, 'argument') ?? readAstNode(current, 'expression');
    if (inner === undefined) break;
    current = inner;
  }
  return isCall(current) ? current : undefined;
}

function walkExecutedNode(
  node: AuthTestAstNode,
  parent: AuthTestAstNode | undefined,
  context: AuthTestWalkContext,
): void {
  const resolveBinding: AuthTestBindingResolver = (name) => context.bindings.get(name);
  context.state.output.push({
    expandsHelper: isExpandableHelperCall(node, context.bindings, context.state),
    node,
    parent,
    resolveBinding,
  });
  if (isFunction(node) && node !== context.owner) {
    return;
  }
  for (const child of readAstChildren(node)) {
    walkExecutedNode(child, node, context);
  }
  if (isCall(node)) executeCalledHelper(node, context.bindings, context.state);
}

function isExpandableHelperCall(
  node: AuthTestAstNode,
  bindings: ReadonlyMap<string, AuthTestAstNode>,
  state: AuthTestExecutionState,
): boolean {
  if (!isCall(node)) return false;
  const target = readCalledFunction(node, bindings);
  return target !== undefined && !state.active.has(target);
}

function executeCalledHelper(
  call: AuthTestAstNode,
  callerBindings: ReadonlyMap<string, AuthTestAstNode>,
  state: AuthTestExecutionState,
): void {
  const target = readCalledFunction(call, callerBindings);
  if (target === undefined || state.active.has(target)) return;
  for (const argument of readAstNodes(call, 'arguments')) {
    const resolved =
      argument.type === 'Identifier'
        ? callerBindings.get(readAstString(argument, 'name') ?? '')
        : argument;
    if (resolved !== undefined && isFunction(resolved)) {
      state.index.functionClosures.set(resolved, callerBindings);
    }
  }
  const values = bindAuthTestParameters(
    readAstNodes(target, 'params'),
    readAstNodes(call, 'arguments'),
    callerBindings,
  );
  executeFunction(target, values, state);
}

function readCalledFunction(
  call: AuthTestAstNode,
  bindings: ReadonlyMap<string, AuthTestAstNode>,
): AuthTestAstNode | undefined {
  const name = readIdentifierName(readAstNode(call, 'callee'));
  return name === undefined ? undefined : readBoundFunction(name, bindings);
}

function readBoundFunction(
  name: string,
  bindings: ReadonlyMap<string, AuthTestAstNode>,
): AuthTestAstNode | undefined {
  let value = bindings.get(name);
  const seen = new Set([name]);
  while (value?.type === 'Identifier') {
    const alias = readAstString(value, 'name');
    if (alias === undefined || seen.has(alias)) return undefined;
    seen.add(alias);
    value = bindings.get(alias);
  }
  return value !== undefined && isFunction(value) ? value : undefined;
}

function readIdentifierName(node: AuthTestAstNode | undefined): string | undefined {
  return node?.type === 'Identifier' ? readAstString(node, 'name') : undefined;
}

function readPropertyName(node: AuthTestAstNode | undefined): string | undefined {
  if (node?.type === 'Identifier') return readAstString(node, 'name');
  return node?.type === 'StringLiteral' ? readAstString(node, 'value') : undefined;
}

function isTransparent(node: AuthTestAstNode): boolean {
  return (
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSTypeAssertion'
  );
}

function isCall(node: AuthTestAstNode): boolean {
  return node.type === 'CallExpression' || node.type === 'OptionalCallExpression';
}

function isFunction(node: AuthTestAstNode): boolean {
  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'FunctionDeclaration' ||
    node.type === 'ObjectMethod' ||
    node.type === 'ClassMethod' ||
    node.type === 'ClassPrivateMethod'
  );
}
