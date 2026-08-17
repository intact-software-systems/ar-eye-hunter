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
    return (
      readMemberName(callee) === method && resolveModuleString(program, arguments_[0]) === routePath
    );
  });
}

export function resolveModuleString(
  program: MutationRoutingAstNode,
  value: MutationRoutingAstNode | undefined,
  resolving = new Set<string>(),
): string | undefined {
  if (!value) return undefined;
  const direct = readString(value);
  if (direct !== undefined) return direct;
  if (value.type === 'Identifier') {
    const name = readIdentifier(value);
    if (!name || resolving.has(name)) return undefined;
    const binding = findModuleConst(program, name);
    return binding
      ? resolveModuleString(program, asNode(binding.init), new Set(resolving).add(name))
      : undefined;
  }
  if (value.type === 'TemplateLiteral') return resolveTemplate(program, value, resolving);
  if (value.type !== 'BinaryExpression' || value.operator !== '+') return undefined;
  const left = resolveModuleString(program, asNode(value.left), resolving);
  const right = resolveModuleString(program, asNode(value.right), resolving);
  return left === undefined || right === undefined ? undefined : `${left}${right}`;
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
    const scan = scanExecutedNodes(current, predicate);
    if (scan.matched) return true;
    pending.push(...scan.callbacks.filter((callback) => !visited.has(callback)));
    for (const callName of scan.callNames) {
      const target = functions.get(callName);
      if (target && !visited.has(target)) pending.push(target);
    }
  }
  return false;
}

function scanExecutedNodes(
  root: MutationRoutingAstNode,
  predicate: (node: MutationRoutingAstNode) => boolean,
): Readonly<{
  matched: boolean;
  callNames: ReadonlySet<string>;
  callbacks: readonly MutationRoutingAstNode[];
}> {
  let matched = false;
  const callNames = new Set<string>();
  const callbacks: MutationRoutingAstNode[] = [];
  const scan = (value: unknown, isRoot = false): void => {
    if (!value || typeof value !== 'object' || matched) return;
    if (Array.isArray(value)) {
      for (const child of value) scan(child);
      return;
    }
    const node = value as MutationRoutingAstNode;
    if (!isRoot && isFunctionNode(node)) return;
    if (typeof node.type === 'string' && predicate(node)) {
      matched = true;
      return;
    }
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const name = readCallName(asNode(node.callee));
      if (name) callNames.add(name);
      callbacks.push(...asNodes(node.arguments).filter(isFunctionNode));
    } else if (node.type === 'ReturnStatement') {
      const returned = asNode(node.argument);
      if (returned && isFunctionNode(returned)) callbacks.push(returned);
    }
    for (const [name, child] of Object.entries(node)) {
      if (!['loc', 'start', 'end', 'comments', 'tokens'].includes(name)) scan(child);
    }
  };
  scan(root, true);
  return { matched, callNames, callbacks };
}

function isFunctionNode(node: MutationRoutingAstNode): boolean {
  return [
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
    'ObjectMethod',
    'ClassMethod',
    'ClassPrivateMethod',
  ].includes(node.type);
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
        name &&
        init &&
        (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')
      )
        functions.set(name, init);
    } else if (
      node.type === 'ClassMethod' ||
      node.type === 'ClassPrivateMethod' ||
      node.type === 'ObjectMethod'
    ) {
      const name = readIdentifier(asNode(node.key));
      if (name) functions.set(name, node);
    } else if (node.type === 'ObjectProperty') {
      const name = readIdentifier(asNode(node.key));
      const value = asNode(node.value);
      if (
        name &&
        value &&
        (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression')
      )
        functions.set(name, value);
    }
  });
  return functions;
}

function resolveTemplate(
  program: MutationRoutingAstNode,
  template: MutationRoutingAstNode,
  resolving: ReadonlySet<string>,
): string | undefined {
  const expressions = asNodes(template.expressions);
  const quasis = asNodes(template.quasis);
  if (quasis.length !== expressions.length + 1) return undefined;
  let resolved = readTemplateElement(quasis[0]);
  if (resolved === undefined) return undefined;
  for (const [index, expression] of expressions.entries()) {
    const expressionValue = resolveModuleString(program, expression, new Set(resolving));
    const following = readTemplateElement(quasis[index + 1]);
    if (expressionValue === undefined || following === undefined) return undefined;
    resolved += expressionValue + following;
  }
  return resolved;
}

function findModuleConst(
  program: MutationRoutingAstNode,
  name: string,
): MutationRoutingAstNode | undefined {
  for (const statement of asNodes(program.body)) {
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue;
    const binding = asNodes(statement.declarations).find(
      (declaration) => readIdentifier(asNode(declaration.id)) === name,
    );
    if (binding) return binding;
  }
  return undefined;
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

function readString(node: MutationRoutingAstNode | undefined): string | undefined {
  return node && typeof node.value === 'string' ? node.value : undefined;
}

function readTemplateElement(node: MutationRoutingAstNode | undefined): string | undefined {
  if (node?.type !== 'TemplateElement') return undefined;
  const value = asNode(node.value);
  return typeof value?.cooked === 'string' ? value.cooked : undefined;
}

function asNode(value: unknown): MutationRoutingAstNode | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as MutationRoutingAstNode)
    : undefined;
}

function asNodes(value: unknown): readonly MutationRoutingAstNode[] {
  return Array.isArray(value)
    ? value.map(asNode).filter((node): node is MutationRoutingAstNode => node !== undefined)
    : [];
}
