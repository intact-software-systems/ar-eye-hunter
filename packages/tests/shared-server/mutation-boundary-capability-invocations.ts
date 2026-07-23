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
import {
  appendCallableAlias,
  isCapturedCallableWrite,
  projectCallableResolution,
  readCallablePatternWrites,
} from './mutation-boundary-callable-storage.ts';
import {
  discoverLocalCallables,
  indexCallableReferences,
} from './mutation-boundary-callable-definitions.ts';

interface InvocationContext extends CallableResolutionContext {
  readonly aliases: Map<string, CallableAliasWrite[]>;
  readonly isConditional: (node: AstNode) => boolean;
}

type SummaryWrite = Omit<ClosureExecutionWrite, 'position'>;
interface CallableStoreEffect {
  readonly conditional: boolean;
  readonly resolution: CallableResolution;
  readonly targetKey: string;
}
type InvocationEffect =
  | Readonly<{ kind: 'flow'; write: SummaryWrite }>
  | Readonly<{ kind: 'store'; write: CallableStoreEffect }>;

export function collectClosureExecutionWrites(
  program: AstNode,
  access: CapabilityFlowAccess,
  isConditional: (node: AstNode) => boolean,
): readonly ClosureExecutionWrite[] {
  const programKey = access.functionKey(program);
  const definitions = discoverLocalCallables(program, programKey, access);
  const aliases = new Map<string, CallableAliasWrite[]>();
  const context: InvocationContext = {
    access,
    aliases,
    byFunctionKey: new Map(definitions.map((definition) => [
      definition.functionKey,
      definition,
    ])),
    byReference: indexCallableReferences(definitions),
    isConditional,
    resolveCall: resolveReturnedCallable,
  };
  collectCallableAliases(program, context);
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
        if (effect.kind === 'store') {
          appendCallableAlias(aliases, effect.write.targetKey, {
            ...effect.write,
            position: readPosition(node),
            source: undefined,
          });
        } else {
          writes.push({ ...effect.write, position: readPosition(node) });
        }
      }
    });
  }
  return writes;
}

function collectCallableAliases(
  program: AstNode,
  context: InvocationContext,
): void {
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
    for (const write of readCallablePatternWrites(target, source, context.access)) {
      if (isCapturedCallableWrite(write.owner, node, context.access)) continue;
      appendCallableAlias(context.aliases, write.targetKey, {
        conditional: context.isConditional(node),
        position: readPosition(node),
        projection: write.projection,
        source: write.source,
      });
    }
  });
}

function summarizeInvocations(
  call: AstNode,
  context: InvocationContext,
  activeFunctions: ReadonlySet<string>,
): readonly InvocationEffect[] {
  const resolution = resolveCallable(asNode(call.callee), readPosition(call), context, new Set());
  const effects: InvocationEffect[] = [];
  for (const target of resolution.targets.values()) {
    if (activeFunctions.has(target.definition.functionKey)) continue;
    effects.push(...summarizeFunction(
      target.definition,
      bindCallArguments(target.definition, call, context),
      activeFunctions,
      context.isConditional(call) || target.conditional || resolution.unknown,
    ));
  }
  if (resolution.targets.size > 0 || resolution.localProvenance) return effects;
  for (const argument of asNodes(call.arguments)) {
    const passed = resolveCallable(argument, readPosition(call), context, new Set());
    if (!passed.localProvenance) continue;
    for (const target of collectCallableTargets(passed).values()) {
      if (activeFunctions.has(target.definition.functionKey)) continue;
      effects.push(...summarizeFunction(
        target.definition,
        context,
        activeFunctions,
        true,
      ));
    }
  }
  return effects;
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
  const rawCallee = unwrap(asNode(call.callee));
  if (
    (rawCallee?.type === 'MemberExpression' ||
      rawCallee?.type === 'OptionalMemberExpression') &&
    context.access.propertyName(rawCallee.property, rawCallee.computed === true) === 'bind'
  ) {
    return resolveCallable(asNode(rawCallee.object), position, context, resolving);
  }
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
    const body = unwrap(asNode(target.definition.node.body));
    if (body?.type !== 'BlockStatement') {
      returns.push(resolveCallable(body, readPosition(body), targetContext, nextResolving));
      continue;
    }
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
): readonly InvocationEffect[] {
  const nextActive = new Set(activeFunctions).add(definition.functionKey);
  const localAliases = new Map<string, CallableAliasWrite[]>(
    [...context.aliases].map(([key, writes]) => [key, [...writes]]),
  );
  const localContext: InvocationContext = { ...context, aliases: localAliases };
  const effects: InvocationEffect[] = [];
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
      effects.push({
        kind: 'flow',
        write: {
          ...write,
          conditional: invocationConditional || context.isConditional(node),
        },
      });
    }
    for (const write of readCallablePatternWrites(pattern, value, context.access)) {
      if (!isCapturedCallableWrite(write.owner, node, context.access)) continue;
      let resolution = resolveCallable(
        write.source,
        readPosition(node),
        localContext,
        new Set(),
      );
      resolution = projectCallableResolution(resolution, write.projection);
      if (!resolution.localProvenance) continue;
      const effect: CallableStoreEffect = {
        conditional: invocationConditional || context.isConditional(node),
        resolution,
        targetKey: write.targetKey,
      };
      effects.push({ kind: 'store', write: effect });
      appendCallableAlias(localAliases, write.targetKey, {
        ...effect,
        position: readPosition(node),
        source: undefined,
      });
    }
    if (!isCall(node)) return;
    for (const nested of summarizeInvocations(node, localContext, nextActive)) {
      if (nested.kind === 'store') {
        const write = {
          ...nested.write,
          conditional: invocationConditional || context.isConditional(node) ||
            nested.write.conditional,
        };
        effects.push({ kind: 'store', write });
        appendCallableAlias(localAliases, write.targetKey, {
          ...write,
          position: readPosition(node),
          source: undefined,
        });
      } else {
        effects.push({
          kind: 'flow',
          write: {
            ...nested.write,
            conditional: invocationConditional || context.isConditional(node) ||
              nested.write.conditional,
          },
        });
      }
    }
  });
  return effects;
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
