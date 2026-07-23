import {
  asCapabilityNode as asNode,
  asCapabilityNodes as asNodes,
  type MutationBoundaryCapabilityAstNode as AstNode,
  unwrapCapabilityExpression as unwrap,
} from './mutation-boundary-capability-ast.ts';

export type FlowCapabilityMethod = Readonly<{ capability: string; method: string }>;

export interface CapabilityFlowAccess {
  definitionKey(value: unknown): string;
  directMethod(value: unknown): FlowCapabilityMethod | undefined;
  expressionKey(value: unknown): string;
  fallbackMethod(key: string): FlowCapabilityMethod | undefined;
  functionKey(value: unknown): string;
  memberMethod(sourceKey: string, property: string): FlowCapabilityMethod | undefined;
  ownerFunctionKey(value: unknown): string;
  propertyName(value: unknown, computed: boolean): string;
}

export interface FlowMethodSource {
  readonly direct?: FlowCapabilityMethod;
  readonly key: string;
}

export interface FlowPatternWrite {
  readonly owner: AstNode;
  readonly source: FlowMethodSource;
  readonly targetKey: string;
}

export interface ClosureExecutionWrite extends FlowPatternWrite {
  readonly conditional: boolean;
  readonly position: number;
}

interface LocalFunction {
  readonly availableAt: number;
  readonly functionKey: string;
  readonly node: AstNode;
  readonly parentFunctionKey: string;
  readonly referenceKey: string;
}

type SummaryWrite = Omit<ClosureExecutionWrite, 'position'>;

export function readFlowPatternWrites(
  pattern: AstNode | undefined,
  value: AstNode | undefined,
  access: CapabilityFlowAccess,
  sourceOverride?: FlowMethodSource,
): readonly FlowPatternWrite[] {
  if (!pattern) return [];
  if (pattern.type === 'AssignmentPattern') {
    return readFlowPatternWrites(asNode(pattern.left), asNode(pattern.right), access);
  }
  if (pattern.type === 'Identifier') {
    const targetKey = access.expressionKey(pattern);
    const writes: FlowPatternWrite[] = [{
      owner: pattern,
      source: sourceOverride ?? readSource(value, access),
      targetKey,
    }];
    const object = unwrap(value);
    if (object?.type === 'ObjectExpression') {
      for (const property of asNodes(object.properties)) {
        const name = access.propertyName(property.key, property.computed === true);
        if (!name) continue;
        writes.push({
          owner: pattern,
          source: readSource(asNode(property.value), access),
          targetKey: `${targetKey}.${name}`,
        });
      }
    }
    return writes;
  }
  if (pattern.type === 'MemberExpression' || pattern.type === 'OptionalMemberExpression') {
    return [{
      owner: rootIdentifier(pattern) ?? pattern,
      source: sourceOverride ?? readSource(value, access),
      targetKey: access.expressionKey(pattern),
    }];
  }
  if (pattern.type !== 'ObjectPattern') return [];
  const writes: FlowPatternWrite[] = [];
  const sourceKey = sourceOverride?.key ?? access.expressionKey(value);
  for (const property of asNodes(pattern.properties)) {
    if (property.type !== 'ObjectProperty') continue;
    const name = access.propertyName(property.key, property.computed === true);
    const target = asNode(property.value);
    if (!name || !target) continue;
    writes.push(...readFlowPatternWrites(target, undefined, access, {
      direct: access.memberMethod(sourceKey, name),
      key: sourceKey ? `${sourceKey}.${name}` : '',
    }));
  }
  return writes;
}

export function isCapturedFlowWrite(
  write: FlowPatternWrite,
  writeNode: AstNode,
  access: CapabilityFlowAccess,
): boolean {
  const owner = access.ownerFunctionKey(write.owner);
  const writer = access.functionKey(writeNode);
  return !!owner && !!writer && owner !== writer;
}

export function collectClosureExecutionWrites(
  program: AstNode,
  access: CapabilityFlowAccess,
  isConditional: (node: AstNode) => boolean,
): readonly ClosureExecutionWrite[] {
  const programKey = access.functionKey(program);
  const definitions = discoverFunctions(program, programKey, access);
  const byReference = new Map(
    definitions.filter((definition) => definition.referenceKey).map((definition) => [
      definition.referenceKey,
      definition,
    ]),
  );
  const roots: AstNode[] = [
    program,
    ...definitions.filter((definition) => definition.parentFunctionKey === programKey)
      .map((definition) => definition.node),
  ];
  const writes: ClosureExecutionWrite[] = [];
  for (const root of roots) {
    walkExecution(root, (node) => {
      if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return;
      const effects = summarizeInvocations(
        node,
        byReference,
        access,
        isConditional,
        new Set(),
        0,
      );
      for (const effect of effects) {
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
): readonly LocalFunction[] {
  const definitions = new Map<string, LocalFunction>();
  const scan = (value: unknown, parentFunctionKey: string): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) scan(child, parentFunctionKey);
      return;
    }
    const node = value as AstNode;
    if (node.type === 'VariableDeclarator') {
      const init = unwrap(asNode(node.init));
      if (isFunction(init)) {
        recordFunction(
          init,
          access.expressionKey(node.id),
          readPosition(node),
          parentFunctionKey,
          definitions,
          access,
        );
      }
    }
    if (isFunction(node)) {
      const functionKey = access.functionKey(node);
      const referenceKey = node.type === 'FunctionDeclaration'
        ? access.expressionKey(node.id)
        : access.definitionKey(node);
      recordFunction(
        node,
        referenceKey,
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

function recordFunction(
  node: AstNode,
  referenceKey: string,
  availableAt: number,
  parentFunctionKey: string,
  definitions: Map<string, LocalFunction>,
  access: CapabilityFlowAccess,
): void {
  const functionKey = access.functionKey(node);
  const current = definitions.get(functionKey);
  definitions.set(functionKey, {
    availableAt: current ? Math.min(current.availableAt, availableAt) : availableAt,
    functionKey,
    node,
    parentFunctionKey,
    referenceKey: current?.referenceKey || referenceKey,
  });
}

function summarizeInvocations(
  call: AstNode,
  definitions: ReadonlyMap<string, LocalFunction>,
  access: CapabilityFlowAccess,
  isConditional: (node: AstNode) => boolean,
  stack: Set<string>,
  depth: number,
): readonly SummaryWrite[] {
  const effects: SummaryWrite[] = [];
  const direct = definitions.get(access.expressionKey(call.callee));
  if (direct && direct.availableAt <= readPosition(call)) {
    effects.push(...summarizeFunction(
      direct,
      definitions,
      access,
      isConditional,
      stack,
      depth,
      isConditional(call),
    ));
  }
  for (const argument of asNodes(call.arguments)) {
    const literal = unwrap(argument);
    const callback = isFunction(literal)
      ? {
        availableAt: readPosition(literal),
        functionKey: access.functionKey(literal),
        node: literal,
        parentFunctionKey: access.functionKey(call),
        referenceKey: '',
      }
      : definitions.get(access.expressionKey(argument));
    if (!callback || callback.availableAt > readPosition(call)) continue;
    effects.push(...summarizeFunction(
      callback,
      definitions,
      access,
      isConditional,
      stack,
      depth,
      true,
    ));
  }
  return effects;
}

function summarizeFunction(
  definition: LocalFunction,
  definitions: ReadonlyMap<string, LocalFunction>,
  access: CapabilityFlowAccess,
  isConditional: (node: AstNode) => boolean,
  stack: Set<string>,
  depth: number,
  invocationConditional: boolean,
): readonly SummaryWrite[] {
  if (depth >= 8 || stack.has(definition.functionKey)) return [];
  const nextStack = new Set(stack).add(definition.functionKey);
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
    if (pattern) {
      for (const write of readFlowPatternWrites(pattern, value, access)) {
        if (!isCapturedFlowWrite(write, node, access)) continue;
        writes.push({
          ...write,
          conditional: invocationConditional || isConditional(node),
        });
      }
    }
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return;
    for (
      const nested of summarizeInvocations(
        node,
        definitions,
        access,
        isConditional,
        nextStack,
        depth + 1,
      )
    ) {
      writes.push({
        ...nested,
        conditional: invocationConditional || isConditional(node) || nested.conditional,
      });
    }
  });
  return writes;
}

function walkExecution(value: AstNode, visit: (node: AstNode) => void): void {
  const rootFunctionKey = isFunction(value) ? value : undefined;
  const scan = (child: unknown): void => {
    if (!child || typeof child !== 'object') return;
    if (Array.isArray(child)) {
      for (const item of child) scan(item);
      return;
    }
    const node = child as AstNode;
    if (isFunction(node) && node !== rootFunctionKey) return;
    visit(node);
    for (const [key, nested] of Object.entries(node)) {
      if (!IGNORED_KEYS.has(key)) scan(nested);
    }
  };
  scan(isFunction(value) ? value.body : value);
}

function readSource(value: AstNode | undefined, access: CapabilityFlowAccess): FlowMethodSource {
  return { direct: access.directMethod(value), key: access.expressionKey(value) };
}

function rootIdentifier(value: AstNode): AstNode | undefined {
  const node = unwrap(value);
  if (node?.type === 'Identifier') return node;
  if (node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression') {
    const object = asNode(node.object);
    return object ? rootIdentifier(object) : undefined;
  }
  return undefined;
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
