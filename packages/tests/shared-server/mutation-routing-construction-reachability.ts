import type { MutationRoutingAstNode as AstNode } from './mutation-routing-call-graph.ts';

export function hasConstructionReachableNode(
  program: AstNode,
  owner: AstNode,
  target: AstNode,
): boolean {
  const localFunctions = collectTopLevelFunctions(program);
  const pending = [owner];
  const visited = new Set<AstNode>();
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const scan = scanConstructionBody(current, target);
    if (scan.matched) return true;
    for (const callName of scan.directCallNames) {
      const candidates = localFunctions.get(callName) ?? [];
      if (candidates.length === 1 && !visited.has(candidates[0]!)) {
        pending.push(candidates[0]!);
      }
    }
  }
  return false;
}

function scanConstructionBody(
  root: AstNode,
  target: AstNode,
): Readonly<{ matched: boolean; directCallNames: ReadonlySet<string> }> {
  let matched = false;
  const directCallNames = new Set<string>();
  const scan = (value: unknown, isRoot = false): void => {
    if (!value || typeof value !== 'object' || matched) return;
    if (Array.isArray(value)) {
      for (const child of value) scan(child);
      return;
    }
    const node = value as AstNode;
    if (!isRoot && isFunctionNode(node)) return;
    if (node === target) {
      matched = true;
      return;
    }
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const callName = readDirectCallName(asNode(node.callee));
      if (callName) directCallNames.add(callName);
    }
    for (const [name, child] of Object.entries(node)) {
      if (!['loc', 'start', 'end', 'comments', 'tokens'].includes(name)) scan(child);
    }
  };
  scan(root, true);
  return { matched, directCallNames };
}

function collectTopLevelFunctions(program: AstNode): ReadonlyMap<string, readonly AstNode[]> {
  const functions = new Map<string, AstNode[]>();
  for (const statement of asNodes(program.body)) {
    const declaration = readTopLevelDeclaration(statement);
    if (declaration?.type === 'FunctionDeclaration') {
      addFunction(functions, readName(asNode(declaration.id)), declaration);
      continue;
    }
    if (declaration?.type !== 'VariableDeclaration') continue;
    for (const variable of asNodes(declaration.declarations)) {
      const value = asNode(variable.init);
      if (value?.type !== 'ArrowFunctionExpression' && value?.type !== 'FunctionExpression') {
        continue;
      }
      addFunction(functions, readName(asNode(variable.id)), value);
    }
  }
  return functions;
}

function addFunction(functions: Map<string, AstNode[]>, name: string, owner: AstNode): void {
  if (!name) return;
  functions.set(name, [...(functions.get(name) ?? []), owner]);
}

function readTopLevelDeclaration(statement: AstNode): AstNode | undefined {
  return statement.type === 'ExportNamedDeclaration' ? asNode(statement.declaration) : statement;
}

function isFunctionNode(node: AstNode): boolean {
  return [
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
    'ObjectMethod',
    'ClassMethod',
    'ClassPrivateMethod',
  ].includes(node.type);
}

function readDirectCallName(node: AstNode | undefined): string {
  return node?.type === 'Identifier' ? readName(node) : '';
}

function readName(node: AstNode | undefined): string {
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
