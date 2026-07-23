import {
  asCapabilityNode as asNode,
  asCapabilityNodes as asNodes,
  type MutationBoundaryCapabilityAstNode as AstNode,
  unwrapCapabilityExpression as unwrap,
} from './mutation-boundary-capability-ast.ts';
import {
  type CapabilityFlowAccess,
  type ClosureExecutionWrite,
  isCapturedFlowWrite,
  readFlowPatternWrites,
} from './mutation-boundary-capability-closures.ts';
import {
  type CallableAliasWrite,
  type CallableResolution,
  type CallableResolutionContext,
  collectCallableTargets,
  type LocalCallableDefinition,
  mergeCallableResolutions,
  resolveCallable,
  unknownLocalCallableResolution,
} from './mutation-boundary-callable-resolution.ts';

interface InvocationContext extends CallableResolutionContext {
  readonly isConditional: (node: AstNode) => boolean;
}

type SummaryWrite = Omit<ClosureExecutionWrite, 'position'>;

export function collectClosureExecutionWrites(
  program: AstNode,
  access: CapabilityFlowAccess,
  isConditional: (node: AstNode) => boolean,
): readonly ClosureExecutionWrite[] {
  const programKey = access.functionKey(program);
  const definitions = discoverFunctions(program, programKey, access);
  const context: InvocationContext = {
    access,
    aliases: collectCallableAliases(program, access, isConditional),
    byFunctionKey: new Map(definitions.map((definition) => [
      definition.functionKey,
      definition,
    ])),
    byReference: indexReferences(definitions),
    isConditional,
    resolveCall: resolveReturnedCallable,
  };
  const roots: AstNode[] = [
    program,
    ...definitions.filter((definition) =>
      definition.parentFunctionKey === programKey &&
      ['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'].includes(
        definition.node.type,
      )
    ).map((definition) => definition.node),
  ];
  const writes: ClosureExecutionWrite[] = [];
  for (const root of roots) {
    walkExecution(root, (node) => {
      if (!isCall(node)) return;
      for (const effect of summarizeInvocations(node, context, new Set())) {
        writes.push({ ...effect, position: readPosition(node) });
      }
    });
  }
  return writes;
}

function discoverFunctions(
  program: AstNode,
  programKey: string,
  access: CapabilityFlowAccess,
): readonly LocalCallableDefinition[] {
  const definitions = new Map<string, LocalCallableDefinition>();
  const scan = (value: unknown, parentFunctionKey: string): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) scan(child, parentFunctionKey);
      return;
    }
    const node = value as AstNode;
    if (node.type === 'VariableDeclarator') {
      const reference = access.expressionKey(node.id);
      const init = unwrap(asNode(node.init));
      if (isFunction(init)) {
        recordFunction(
          init,
          reference,
          readPosition(node),
          parentFunctionKey,
          definitions,
          access,
        );
      } else if (init?.type === 'ObjectExpression') {
        recordObjectFunctions(
          init,
          reference,
          readPosition(node),
          parentFunctionKey,
          definitions,
          access,
        );
      }
    }
    if (isFunction(node)) {
      const functionKey = access.functionKey(node);
      const reference = node.type === 'FunctionDeclaration'
        ? access.expressionKey(node.id)
        : access.definitionKey(node);
      recordFunction(
        node,
        reference,
        node.type === 'FunctionDeclaration' ? Number.NEGATIVE_INFINITY : readPosition(node),
        parentFunctionKey,
        definitions,
        access,
      );
      for (const [key, child] of Object.entries(node)) {
        if (!IGNORED_KEYS.has(key)) scan(child, functionKey);
      }
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (!IGNORED_KEYS.has(key)) scan(child, parentFunctionKey);
    }
  };
  scan(program, programKey);
  return [...definitions.values()];
}

function recordObjectFunctions(
  object: AstNode,
  reference: string,
  availableAt: number,
  parentFunctionKey: string,
  definitions: Map<string, LocalCallableDefinition>,
  access: CapabilityFlowAccess,
): void {
  if (!reference) return;
  for (const property of asNodes(object.properties)) {
    const name = access.propertyName(property.key, property.computed === true);
    const value = property.type === 'ObjectMethod' ? property : unwrap(asNode(property.value));
    if (!name || !isFunction(value)) continue;
    recordFunction(
      value,
      `${reference}.${name}`,
      availableAt,
      parentFunctionKey,
      definitions,
      access,
    );
  }
}

function recordFunction(
  node: AstNode,
  reference: string,
  availableAt: number,
  parentFunctionKey: string,
  definitions: Map<string, LocalCallableDefinition>,
  access: CapabilityFlowAccess,
): void {
  const functionKey = access.functionKey(node);
  const current = definitions.get(functionKey);
  const references = new Map(current?.references);
  if (reference) {
    references.set(reference, Math.min(references.get(reference) ?? availableAt, availableAt));
  }
  definitions.set(functionKey, {
    functionKey,
    node,
    parentFunctionKey: current?.parentFunctionKey ?? parentFunctionKey,
    references,
  });
}

function indexReferences(
  definitions: readonly LocalCallableDefinition[],
): ReadonlyMap<string, readonly LocalCallableDefinition[]> {
  const references = new Map<string, LocalCallableDefinition[]>();
  for (const definition of definitions) {
    for (const reference of definition.references.keys()) {
      const candidates = references.get(reference) ?? [];
      candidates.push(definition);
      references.set(reference, candidates);
    }
  }
  return references;
}

function collectCallableAliases(
  program: AstNode,
  access: CapabilityFlowAccess,
  isConditional: (node: AstNode) => boolean,
): ReadonlyMap<string, readonly CallableAliasWrite[]> {
  const aliases = new Map<string, CallableAliasWrite[]>();
  walkAll(program, (node) => {
    const target = node.type === 'VariableDeclarator'
      ? asNode(node.id)
      : node.type === 'AssignmentExpression'
      ? asNode(node.left)
      : undefined;
    const source = node.type === 'VariableDeclarator'
      ? asNode(node.init)
      : node.type === 'AssignmentExpression'
      ? asNode(node.right)
      : undefined;
    const key = access.expressionKey(target);
    if (!key || !source) return;
    const writes = aliases.get(key) ?? [];
    writes.push({
      conditional: isConditional(node),
      position: readPosition(node),
      source,
    });
    aliases.set(key, writes);
  });
  return aliases;
}

function summarizeInvocations(
  call: AstNode,
  context: InvocationContext,
  activeFunctions: ReadonlySet<string>,
): readonly SummaryWrite[] {
  const resolution = resolveCallable(asNode(call.callee), readPosition(call), context, new Set());
  const writes: SummaryWrite[] = [];
  for (const target of resolution.targets.values()) {
    if (activeFunctions.has(target.definition.functionKey)) continue;
    writes.push(...summarizeFunction(
      target.definition,
      bindCallArguments(target.definition, call, context),
      activeFunctions,
      context.isConditional(call) || target.conditional || resolution.unknown,
    ));
  }
  if (resolution.targets.size > 0 || resolution.localProvenance) return writes;
  for (const argument of asNodes(call.arguments)) {
    const passed = resolveCallable(argument, readPosition(call), context, new Set());
    if (!passed.localProvenance) continue;
    for (const target of collectCallableTargets(passed).values()) {
      if (activeFunctions.has(target.definition.functionKey)) continue;
      writes.push(...summarizeFunction(
        target.definition,
        context,
        activeFunctions,
        true,
      ));
    }
  }
  return writes;
}

function bindCallArguments(
  definition: LocalCallableDefinition,
  call: AstNode,
  context: InvocationContext,
  resolving = new Set<string>(),
): InvocationContext {
  const bindings = new Map(context.bindings);
  const arguments_ = asNodes(call.arguments);
  for (const [index, parameter] of asNodes(definition.node.params).entries()) {
    const key = context.access.expressionKey(parameter);
    if (!key) continue;
    bindings.set(
      key,
      resolveCallable(arguments_[index], readPosition(call), context, new Set(resolving)),
    );
  }
  return { ...context, bindings };
}

function resolveReturnedCallable(
  call: AstNode,
  position: number,
  baseContext: CallableResolutionContext,
  resolving: Set<string>,
): CallableResolution {
  const context = baseContext as InvocationContext;
  const callees = resolveCallable(asNode(call.callee), position, context, new Set(resolving));
  const returns: CallableResolution[] = [];
  for (const target of callees.targets.values()) {
    const returnKey = `return:${target.definition.functionKey}`;
    if (resolving.has(returnKey)) {
      returns.push(unknownLocalCallableResolution());
      continue;
    }
    const nextResolving = new Set(resolving).add(returnKey);
    const targetContext = bindCallArguments(
      target.definition,
      call,
      context,
      nextResolving,
    );
    walkExecution(target.definition.node, (node) => {
      if (node.type !== 'ReturnStatement') return;
      returns.push(resolveCallable(
        asNode(node.argument),
        readPosition(node),
        targetContext,
        nextResolving,
      ));
    });
  }
  if (returns.length === 0) {
    return callees.localProvenance ? unknownLocalCallableResolution() : callees;
  }
  return mergeCallableResolutions(
    returns,
    callees.unknown || [...callees.targets.values()].some((target) => target.conditional),
  );
}

function summarizeFunction(
  definition: LocalCallableDefinition,
  context: InvocationContext,
  activeFunctions: ReadonlySet<string>,
  invocationConditional: boolean,
): readonly SummaryWrite[] {
  const nextActive = new Set(activeFunctions).add(definition.functionKey);
  const writes: SummaryWrite[] = [];
  walkExecution(definition.node, (node) => {
    const pattern = node.type === 'VariableDeclarator'
      ? asNode(node.id)
      : node.type === 'AssignmentExpression'
      ? asNode(node.left)
      : undefined;
    const value = node.type === 'VariableDeclarator'
      ? asNode(node.init)
      : node.type === 'AssignmentExpression'
      ? asNode(node.right)
      : undefined;
    for (const write of readFlowPatternWrites(pattern, value, context.access)) {
      if (!isCapturedFlowWrite(write, node, context.access)) continue;
      writes.push({
        ...write,
        conditional: invocationConditional || context.isConditional(node),
      });
    }
    if (!isCall(node)) return;
    for (const nested of summarizeInvocations(node, context, nextActive)) {
      writes.push({
        ...nested,
        conditional: invocationConditional || context.isConditional(node) || nested.conditional,
      });
    }
  });
  return writes;
}

function walkExecution(value: AstNode, visit: (node: AstNode) => void): void {
  const rootFunction = isFunction(value) ? value : undefined;
  const scan = (child: unknown): void => {
    if (!child || typeof child !== 'object') return;
    if (Array.isArray(child)) {
      for (const item of child) scan(item);
      return;
    }
    const node = child as AstNode;
    if (isFunction(node) && node !== rootFunction) return;
    visit(node);
    for (const [key, nested] of Object.entries(node)) {
      if (!IGNORED_KEYS.has(key)) scan(nested);
    }
  };
  scan(rootFunction ? rootFunction.body : value);
}

function walkAll(value: unknown, visit: (node: AstNode) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const child of value) walkAll(child, visit);
    return;
  }
  const node = value as AstNode;
  if (typeof node.type === 'string') visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (!IGNORED_KEYS.has(key)) walkAll(child, visit);
  }
}

function isCall(node: AstNode): boolean {
  return node.type === 'CallExpression' || node.type === 'OptionalCallExpression';
}

function isFunction(node: AstNode | undefined): node is AstNode {
  return !!node && [
    'ArrowFunctionExpression',
    'FunctionDeclaration',
    'FunctionExpression',
    'ObjectMethod',
    'ClassMethod',
    'ClassPrivateMethod',
  ].includes(node.type);
}

function readPosition(node: AstNode): number {
  return typeof node.start === 'number' ? node.start : Number.MAX_SAFE_INTEGER;
}
const IGNORED_KEYS = new Set(['loc', 'start', 'end', 'comments', 'tokens']);
