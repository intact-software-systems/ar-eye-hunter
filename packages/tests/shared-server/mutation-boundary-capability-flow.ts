import {
  asCapabilityNode as asNode,
  asCapabilityNodes as asNodes,
  type MutationBoundaryCapabilityAstNode as AstNode,
  unwrapCapabilityExpression as unwrap,
} from './mutation-boundary-capability-ast.ts';

export type FlowCapabilityMethod = Readonly<{ capability: string; method: string }>;

export interface CapabilityFlowAccess {
  directMethod(value: unknown): FlowCapabilityMethod | undefined;
  expressionKey(value: unknown): string;
  fallbackMethod(key: string): FlowCapabilityMethod | undefined;
  functionKey(value: unknown): string;
  memberMethod(sourceKey: string, property: string): FlowCapabilityMethod | undefined;
  ownerFunctionKey(value: unknown): string;
  propertyName(value: unknown, computed: boolean): string;
}

interface MethodSource {
  readonly direct?: FlowCapabilityMethod;
  readonly key: string;
}

interface MethodWrite {
  readonly conditional: boolean;
  readonly position: number;
  readonly source: MethodSource;
}

export function findFlowSensitiveCapabilityCalls(
  program: AstNode,
  access: CapabilityFlowAccess,
): readonly FlowCapabilityMethod[] {
  const conditionalNodes = findConditionalNodes(program);
  const writes = new Map<string, MethodWrite[]>();
  walk(program, (node) => {
    if (node.type === 'VariableDeclarator') {
      collectPatternWrites(
        asNode(node.id),
        asNode(node.init),
        node,
        conditionalNodes.has(node),
        writes,
        access,
      );
    } else if (node.type === 'AssignmentExpression') {
      collectPatternWrites(
        asNode(node.left),
        asNode(node.right),
        node,
        conditionalNodes.has(node),
        writes,
        access,
      );
    }
  });

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

function collectPatternWrites(
  pattern: AstNode | undefined,
  value: AstNode | undefined,
  writeNode: AstNode,
  controlConditional: boolean,
  writes: Map<string, MethodWrite[]>,
  access: CapabilityFlowAccess,
  sourceOverride?: MethodSource,
): void {
  if (!pattern) return;
  if (pattern.type === 'AssignmentPattern') {
    collectPatternWrites(
      asNode(pattern.left),
      asNode(pattern.right),
      writeNode,
      controlConditional,
      writes,
      access,
    );
    return;
  }
  if (pattern.type === 'Identifier') {
    const targetKey = access.expressionKey(pattern);
    addWrite(
      targetKey,
      sourceOverride ?? readSource(value, access),
      writeNode,
      controlConditional || isClosureWrite(pattern, writeNode, access),
      writes,
    );
    const object = unwrap(value);
    if (object?.type === 'ObjectExpression') {
      for (const property of asNodes(object.properties)) {
        const name = access.propertyName(property.key, property.computed === true);
        if (!name) continue;
        addWrite(
          `${targetKey}.${name}`,
          readSource(asNode(property.value), access),
          property,
          controlConditional || isClosureWrite(pattern, writeNode, access),
          writes,
        );
      }
    }
    return;
  }
  if (pattern.type === 'MemberExpression' || pattern.type === 'OptionalMemberExpression') {
    addWrite(
      access.expressionKey(pattern),
      sourceOverride ?? readSource(value, access),
      writeNode,
      controlConditional || isClosureWrite(pattern, writeNode, access),
      writes,
    );
    return;
  }
  if (pattern.type !== 'ObjectPattern') return;
  const sourceKey = sourceOverride?.key ?? access.expressionKey(value);
  for (const property of asNodes(pattern.properties)) {
    if (property.type !== 'ObjectProperty') continue;
    const name = access.propertyName(property.key, property.computed === true);
    const target = asNode(property.value);
    if (!name || !target) continue;
    collectPatternWrites(
      target,
      undefined,
      writeNode,
      controlConditional,
      writes,
      access,
      {
        direct: access.memberMethod(sourceKey, name),
        key: sourceKey ? `${sourceKey}.${name}` : '',
      },
    );
  }
}

function addWrite(
  targetKey: string,
  source: MethodSource,
  node: AstNode,
  conditional: boolean,
  writes: Map<string, MethodWrite[]>,
): void {
  if (!targetKey) return;
  const entries = writes.get(targetKey) ?? [];
  entries.push({ conditional, position: readPosition(node), source });
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
  for (const write of writes.get(key) ?? []) {
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
  source: MethodSource,
  position: number,
  writes: ReadonlyMap<string, readonly MethodWrite[]>,
  access: CapabilityFlowAccess,
  resolving: Set<string>,
): ReadonlySet<FlowCapabilityMethod> {
  if (source.direct) return new Set([source.direct]);
  return source.key ? resolveKey(source.key, position, writes, access, resolving) : new Set();
}

function readSource(value: AstNode | undefined, access: CapabilityFlowAccess): MethodSource {
  return {
    direct: access.directMethod(value),
    key: access.expressionKey(value),
  };
}

function isClosureWrite(
  target: AstNode,
  writeNode: AstNode,
  access: CapabilityFlowAccess,
): boolean {
  const owner = access.ownerFunctionKey(rootIdentifier(target));
  const writer = access.functionKey(writeNode);
  return !!owner && !!writer && owner !== writer;
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
