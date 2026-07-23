export type MutationRoutingAstNode = {
  readonly type: string;
  readonly [key: string]: unknown;
};

export function findRouteRegistration(
  program: MutationRoutingAstNode,
  method: string,
  routePath: string,
): MutationRoutingAstNode | undefined {
  return findAstNode(program, (node) => {
    if (node.type !== 'CallExpression') return false;
    const callee = asNode(node.callee);
    const arguments_ = asNodes(node.arguments);
    return readMemberName(callee) === method && readString(arguments_[0]) === routePath;
  });
}

export function hasReachableAstNode(
  program: MutationRoutingAstNode,
  handler: MutationRoutingAstNode,
  predicate: (node: MutationRoutingAstNode) => boolean,
): boolean {
  const functions = collectLocalFunctions(program);
  const pending = [handler];
  const visited = new Set<MutationRoutingAstNode>();
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    if (findAstNode(current, predicate)) return true;
    for (const callName of collectCallNames(current)) {
      const target = functions.get(callName);
      if (target && !visited.has(target)) pending.push(target);
    }
  }
  return false;
}

export function findAstNode(
  value: unknown,
  predicate: (node: MutationRoutingAstNode) => boolean,
): MutationRoutingAstNode | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAstNode(item, predicate);
      if (found) return found;
    }
    return undefined;
  }
  const node = value as MutationRoutingAstNode;
  if (typeof node.type === 'string' && predicate(node)) return node;
  for (const [name, child] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'comments', 'tokens'].includes(name)) continue;
    const found = findAstNode(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function collectLocalFunctions(
  program: MutationRoutingAstNode,
): ReadonlyMap<string, MutationRoutingAstNode> {
  const functions = new Map<string, MutationRoutingAstNode>();
  visitAll(program, (node) => {
    if (node.type === 'FunctionDeclaration') {
      const name = readIdentifier(asNode(node.id));
      if (name) functions.set(name, node);
    } else if (node.type === 'VariableDeclarator') {
      const name = readIdentifier(asNode(node.id));
      const init = asNode(node.init);
      if (
        name && init &&
        (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')
      ) functions.set(name, init);
    }
  });
  return functions;
}

function collectCallNames(node: MutationRoutingAstNode): readonly string[] {
  const names = new Set<string>();
  visitAll(node, (candidate) => {
    if (candidate.type === 'CallExpression' || candidate.type === 'OptionalCallExpression') {
      const name = readCallName(asNode(candidate.callee));
      if (name) names.add(name);
    }
  });
  return [...names];
}

function visitAll(value: unknown, visit: (node: MutationRoutingAstNode) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) visitAll(item, visit);
    return;
  }
  const node = value as MutationRoutingAstNode;
  if (typeof node.type === 'string') visit(node);
  for (const [name, child] of Object.entries(node)) {
    if (!['loc', 'start', 'end', 'comments', 'tokens'].includes(name)) visitAll(child, visit);
  }
}

function readCallName(node: MutationRoutingAstNode | undefined): string {
  return readIdentifier(node) || readMemberName(node);
}

function readMemberName(node: MutationRoutingAstNode | undefined): string {
  return node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression'
    ? readIdentifier(asNode(node.property))
    : '';
}

function readIdentifier(node: MutationRoutingAstNode | undefined): string {
  return node && typeof node.name === 'string' ? node.name : '';
}

function readString(node: MutationRoutingAstNode | undefined): string {
  return node && typeof node.value === 'string' ? node.value : '';
}

function asNode(value: unknown): MutationRoutingAstNode | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as MutationRoutingAstNode
    : undefined;
}

function asNodes(value: unknown): readonly MutationRoutingAstNode[] {
  return Array.isArray(value)
    ? value.map(asNode).filter((node): node is MutationRoutingAstNode => node !== undefined)
    : [];
}
