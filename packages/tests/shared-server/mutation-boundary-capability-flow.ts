import {
  asCapabilityNode as asNode,
  type MutationBoundaryCapabilityAstNode as AstNode,
  unwrapCapabilityExpression as unwrap,
} from './mutation-boundary-capability-ast.ts';
import {
  type CapabilityFlowAccess,
  collectClosureExecutionWrites,
  type FlowCapabilityMethod,
  type FlowMethodSource,
  isCapturedFlowWrite,
  readFlowPatternWrites,
} from './mutation-boundary-capability-closures.ts';

export type { FlowCapabilityMethod } from './mutation-boundary-capability-closures.ts';

interface MethodWrite {
  readonly conditional: boolean;
  readonly order: number;
  readonly position: number;
  readonly source: FlowMethodSource;
}

export function findFlowSensitiveCapabilityCalls(
  program: AstNode,
  access: CapabilityFlowAccess,
): readonly FlowCapabilityMethod[] {
  const conditionalNodes = findConditionalNodes(program);
  const writes = new Map<string, MethodWrite[]>();
  let nextOrder = 0;
  walk(program, (node) => {
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
    if (!pattern) return;
    for (const write of readFlowPatternWrites(pattern, value, access)) {
      if (isCapturedFlowWrite(write, node, access)) continue;
      addWrite(
        write.targetKey,
        write.source,
        readPosition(node),
        conditionalNodes.has(node),
        nextOrder++,
        writes,
      );
    }
  });
  for (
    const write of collectClosureExecutionWrites(
      program,
      access,
      (node) => conditionalNodes.has(node),
    )
  ) {
    addWrite(
      write.targetKey,
      write.source,
      write.position,
      write.conditional,
      nextOrder++,
      writes,
    );
  }

  const calls = new Map<string, FlowCapabilityMethod>();
  walk(program, (node) => {
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return;
    const position = readPosition(node);
    for (const method of resolveCallee(asNode(node.callee), position, writes, access)) {
      calls.set(methodKey(method), method);
    }
  });
  return [...calls.values()];
}

function addWrite(
  targetKey: string,
  source: FlowMethodSource,
  position: number,
  conditional: boolean,
  order: number,
  writes: Map<string, MethodWrite[]>,
): void {
  if (!targetKey) return;
  const entries = writes.get(targetKey) ?? [];
  entries.push({ conditional, order, position, source });
  writes.set(targetKey, entries);
}

function resolveCallee(
  value: AstNode | undefined,
  position: number,
  writes: ReadonlyMap<string, readonly MethodWrite[]>,
  access: CapabilityFlowAccess,
): ReadonlySet<FlowCapabilityMethod> {
  const node = unwrap(value);
  if (!node) return new Set();
  const key = access.expressionKey(node);
  if (key && writes.has(key)) return resolveKey(key, position, writes, access, new Set());
  const direct = access.directMethod(node) ?? (key ? access.fallbackMethod(key) : undefined);
  return direct ? new Set([direct]) : new Set();
}

function resolveKey(
  key: string,
  position: number,
  writes: ReadonlyMap<string, readonly MethodWrite[]>,
  access: CapabilityFlowAccess,
  resolving: Set<string>,
): ReadonlySet<FlowCapabilityMethod> {
  const resolutionKey = `${key}:${position}`;
  if (resolving.has(resolutionKey)) return new Set();
  resolving.add(resolutionKey);
  let state = new Map<string, FlowCapabilityMethod>();
  const orderedWrites = [...writes.get(key) ?? []].toSorted((left, right) =>
    left.position - right.position || left.order - right.order
  );
  for (const write of orderedWrites) {
    if (write.position >= position) continue;
    const source = resolveSource(write.source, write.position, writes, access, resolving);
    if (!write.conditional) {
      state = new Map([...source].map((method) => [methodKey(method), method]));
    } else for (const method of source) state.set(methodKey(method), method);
  }
  resolving.delete(resolutionKey);
  if (state.size > 0 || writes.has(key)) return new Set(state.values());
  const fallback = access.fallbackMethod(key);
  return fallback ? new Set([fallback]) : new Set();
}

function resolveSource(
  source: FlowMethodSource,
  position: number,
  writes: ReadonlyMap<string, readonly MethodWrite[]>,
  access: CapabilityFlowAccess,
  resolving: Set<string>,
): ReadonlySet<FlowCapabilityMethod> {
  if (source.direct) return new Set([source.direct]);
  return source.key ? resolveKey(source.key, position, writes, access, resolving) : new Set();
}

function findConditionalNodes(program: AstNode): WeakSet<object> {
  const conditional = new WeakSet<object>();
  const scan = (value: unknown, isConditional: boolean): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) scan(child, isConditional);
      return;
    }
    const node = value as AstNode;
    if (isConditional) conditional.add(node);
    const branchKeys = conditionalChildKeys(node);
    for (const [key, child] of Object.entries(node)) {
      if (IGNORED_KEYS.has(key)) continue;
      scan(child, isConditional || branchKeys.has(key));
    }
  };
  scan(program, false);
  return conditional;
}

function conditionalChildKeys(node: AstNode): ReadonlySet<string> {
  if (node.type === 'IfStatement') return new Set(['consequent', 'alternate']);
  if (node.type === 'ConditionalExpression') return new Set(['consequent', 'alternate']);
  if (node.type === 'LogicalExpression') return new Set(['right']);
  if (['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement'].includes(node.type)) {
    return new Set(['body']);
  }
  if (node.type === 'SwitchCase') return new Set(['consequent']);
  if (node.type === 'TryStatement') return new Set(['block', 'handler']);
  return new Set();
}

function walk(value: unknown, visit: (node: AstNode) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit);
    return;
  }
  const node = value as AstNode;
  if (typeof node.type === 'string') visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (!IGNORED_KEYS.has(key)) walk(child, visit);
  }
}

function readPosition(node: AstNode): number {
  return typeof node.start === 'number' ? node.start : Number.MAX_SAFE_INTEGER;
}

function methodKey(method: FlowCapabilityMethod): string {
  return `${method.capability}.${method.method}`;
}

const IGNORED_KEYS = new Set(['loc', 'start', 'end', 'comments', 'tokens']);
