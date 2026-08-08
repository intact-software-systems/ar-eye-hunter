import { parse } from '@babel/parser';

export interface SemanticNode {
  readonly type: string;
  readonly loc?: { start: { line: number; column: number } };
  readonly [key: string]: unknown;
}

export interface OversizedGeneralFunction {
  readonly line: number;
  readonly physicalLines: number;
  readonly type: string;
}

export function oversizedGeneralFunctions(
  source: string,
  maximumPhysicalLines = 60,
): OversizedGeneralFunction[] {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const oversized: OversizedGeneralFunction[] = [];
  visitFunctions(ast.program as SemanticNode, undefined, (node, parent) => {
    if (isDescribeCallback(node, parent) || !node.loc) {
      return;
    }
    const physicalLines = node.loc.end.line - node.loc.start.line + 1;
    if (physicalLines > maximumPhysicalLines) {
      oversized.push({ line: node.loc.start.line, physicalLines, type: node.type });
    }
  });
  return oversized;
}

function visitFunctions(
  value: unknown,
  parent: SemanticNode | undefined,
  visitor: (node: SemanticNode, parent: SemanticNode | undefined) => void,
): void {
  if (!isSemanticNode(value)) {
    return;
  }
  if (isFunctionNode(value)) {
    visitor(value, parent);
  }
  for (const [key, child] of Object.entries(value)) {
    if (['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) {
      continue;
    }
    if (Array.isArray(child)) {
      child.forEach((entry) => visitFunctions(entry, value, visitor));
    } else {
      visitFunctions(child, value, visitor);
    }
  }
}

function isFunctionNode(node: SemanticNode): boolean {
  return [
    'ArrowFunctionExpression',
    'ClassMethod',
    'FunctionDeclaration',
    'FunctionExpression',
    'ObjectMethod',
  ].includes(node.type);
}

function isDescribeCallback(node: SemanticNode, parent: SemanticNode | undefined): boolean {
  return (
    (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') &&
    parent?.type === 'CallExpression' &&
    isSemanticNode(parent.callee) &&
    parent.callee.type === 'Identifier' &&
    parent.callee.name === 'describe'
  );
}

export function testCases(source: string): Map<string, SemanticNode> {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const cases = new Map<string, SemanticNode>();
  visitSemanticNodes(ast.program as SemanticNode, (node) => {
    if (node.type !== 'CallExpression' || !isTestCall(node)) {
      return;
    }
    const title = node.arguments?.[0];
    if (!isSemanticNode(title) || title.type !== 'StringLiteral') {
      return;
    }
    const caseId = String(title.value);
    if (cases.has(caseId)) {
      throw new Error(`Duplicate test case: ${caseId}`);
    }
    cases.set(caseId, node);
  });
  return cases;
}

export function supportDeclarationNames(source: string): ReadonlySet<string> {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const names = new Set<string>();
  const program = ast.program as SemanticNode;
  for (const statement of (program.body as readonly unknown[]) ?? []) {
    const candidate =
      isSemanticNode(statement) && statement.type === 'ExportNamedDeclaration'
        ? statement.declaration
        : statement;
    if (!isSemanticNode(candidate)) {
      continue;
    }
    if (candidate.type === 'FunctionDeclaration') {
      addDeclarationName(names, candidate.id);
    }
    if (candidate.type === 'VariableDeclaration') {
      for (const declaration of (candidate.declarations as readonly unknown[]) ?? []) {
        if (isSemanticNode(declaration)) {
          addDeclarationName(names, declaration.id);
        }
      }
    }
  }
  return names;
}

function addDeclarationName(names: Set<string>, identifier: unknown): void {
  if (!isSemanticNode(identifier) || identifier.type !== 'Identifier') {
    throw new Error('Unsupported support declaration identifier');
  }
  const name = String(identifier.name);
  if (names.has(name)) {
    throw new Error(`Duplicate support declaration: ${name}`);
  }
  names.add(name);
}

export function requireCase(
  casesByPath: ReadonlyMap<string, Map<string, SemanticNode>>,
  ownerPath: string,
  caseId: string,
): SemanticNode {
  const testCase = requireCases(casesByPath, ownerPath).get(caseId);
  if (!testCase) {
    throw new Error(`Missing test case: ${ownerPath}:${caseId}`);
  }
  return testCase;
}

export function requireCases(
  casesByPath: ReadonlyMap<string, Map<string, SemanticNode>>,
  ownerPath: string,
): Map<string, SemanticNode> {
  const cases = casesByPath.get(ownerPath);
  if (!cases) {
    throw new Error(`Missing test owner: ${ownerPath}`);
  }
  return cases;
}

export function visitSemanticNodes(value: unknown, visitor: (node: SemanticNode) => void): void {
  if (!isSemanticNode(value)) {
    return;
  }
  visitor(value);
  for (const [key, child] of Object.entries(value)) {
    if (['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) {
      continue;
    }
    if (Array.isArray(child)) {
      child.forEach((entry) => visitSemanticNodes(entry, visitor));
    } else {
      visitSemanticNodes(child, visitor);
    }
  }
}

export function isSemanticNode(value: unknown): value is SemanticNode {
  return (
    Boolean(value) && typeof value === 'object' && typeof (value as SemanticNode).type === 'string'
  );
}

function isTestCall(node: SemanticNode): boolean {
  const callee = node.callee;
  if (!isSemanticNode(callee)) {
    return false;
  }
  if (callee.type === 'Identifier') {
    return callee.name === 'it' || callee.name === 'test';
  }
  return callee.type === 'CallExpression' && callName(callee.callee) === 'it.each';
}

function callName(value: unknown): string {
  if (!isSemanticNode(value)) {
    return '';
  }
  if (value.type === 'Identifier') {
    return String(value.name);
  }
  if (value.type !== 'MemberExpression') {
    return '';
  }
  return `${callName(value.object)}.${callName(value.property)}`;
}
