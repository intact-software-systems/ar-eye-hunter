import type { MutationRoutingAstNode as AstNode } from './mutation-routing-call-graph.ts';

interface FindGroupRouteHandlerInput {
  readonly program: AstNode;
  readonly method: string;
  readonly routePath: string;
  readonly privateOwnerName: string;
  readonly familyOwnerName: string;
}

interface DirectRouteRegistration {
  readonly handler: AstNode;
  readonly method: string;
  readonly ownerName: string;
  readonly routePath: string;
}

export function findDirectGroupRouteHandler({
  program,
  method,
  routePath,
  privateOwnerName,
  familyOwnerName,
}: FindGroupRouteHandlerInput): AstNode | undefined {
  const familyOwners = findExportedFunctions(program, familyOwnerName);
  if (familyOwners.length !== 1) return undefined;
  const calledOwners = readDirectFamilyOwnerCalls(familyOwners[0]!);
  if (!calledOwners || count(calledOwners, privateOwnerName) !== 1) return undefined;
  if (!hasOnlyDirectRouteOwners(program, calledOwners)) return undefined;
  const exact = readAllDirectRegistrations(program).filter(
    (registration) => registration.method === method && registration.routePath === routePath,
  );
  return exact.length === 1 && exact[0]?.ownerName === privateOwnerName
    ? exact[0].handler
    : undefined;
}

function readDirectFamilyOwnerCalls(owner: AstNode): readonly string[] | undefined {
  const calledOwners: string[] = [];
  for (const statement of readBlockStatements(asNode(owner.body))) {
    if (statement.type !== 'ExpressionStatement') return undefined;
    const call = asNode(statement.expression);
    if (call?.type !== 'CallExpression') return undefined;
    const callee = asNode(call.callee);
    if (callee?.type !== 'Identifier') return undefined;
    calledOwners.push(readName(callee));
  }
  return calledOwners.length > 0 ? calledOwners : undefined;
}

function hasOnlyDirectRouteOwners(program: AstNode, ownerNames: readonly string[]): boolean {
  return ownerNames.every((ownerName) => {
    const owners = findTopLevelFunctions(program, ownerName);
    return owners.length === 1 && readDirectRegistration(program, owners[0]!) !== undefined;
  });
}

function readAllDirectRegistrations(program: AstNode): readonly DirectRouteRegistration[] {
  return asNodes(program.body)
    .map(readTopLevelDeclaration)
    .filter((node): node is AstNode => node?.type === 'FunctionDeclaration')
    .map((owner) => readDirectRegistration(program, owner))
    .filter((registration): registration is DirectRouteRegistration => registration !== undefined);
}

function readDirectRegistration(
  program: AstNode,
  owner: AstNode,
): DirectRouteRegistration | undefined {
  const statements = readBlockStatements(asNode(owner.body));
  if (statements.length !== 1 || statements[0]?.type !== 'ExpressionStatement') return undefined;
  const call = asNode(statements[0].expression);
  const callee = asNode(call?.callee);
  if (call?.type !== 'CallExpression' || callee?.type !== 'MemberExpression') return undefined;
  if (readName(asNode(callee.object)) !== 'app') return undefined;
  const handler = asNodes(call.arguments)[1];
  const routePath = resolveModuleString(program, asNodes(call.arguments)[0]);
  const method = readName(asNode(callee.property));
  const ownerName = readName(asNode(owner.id));
  return handler && routePath && method && ownerName
    ? { handler, method, ownerName, routePath }
    : undefined;
}

function resolveModuleString(
  program: AstNode,
  value: AstNode | undefined,
  resolving = new Set<string>(),
): string | undefined {
  if (!value) return undefined;
  const direct = readString(value);
  if (direct !== undefined) return direct;
  if (value.type === 'Identifier') {
    const name = readName(value);
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

function resolveTemplate(
  program: AstNode,
  template: AstNode,
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

function findModuleConst(program: AstNode, name: string): AstNode | undefined {
  for (const statement of asNodes(program.body)) {
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue;
    const binding = asNodes(statement.declarations).find(
      (declaration) => readName(asNode(declaration.id)) === name,
    );
    if (binding) return binding;
  }
  return undefined;
}

function findExportedFunctions(program: AstNode, name: string): readonly AstNode[] {
  return asNodes(program.body)
    .filter((statement) => statement.type === 'ExportNamedDeclaration')
    .map((statement) => asNode(statement.declaration))
    .filter(
      (node): node is AstNode =>
        node?.type === 'FunctionDeclaration' && readName(asNode(node.id)) === name,
    );
}

function findTopLevelFunctions(program: AstNode, name: string): readonly AstNode[] {
  return asNodes(program.body)
    .map(readTopLevelDeclaration)
    .filter(
      (node): node is AstNode =>
        node?.type === 'FunctionDeclaration' && readName(asNode(node.id)) === name,
    );
}

function readTopLevelDeclaration(statement: AstNode): AstNode | undefined {
  return statement.type === 'ExportNamedDeclaration' ? asNode(statement.declaration) : statement;
}

function readBlockStatements(block: AstNode | undefined): readonly AstNode[] {
  return block?.type === 'BlockStatement' ? asNodes(block.body) : [];
}

function readTemplateElement(node: AstNode | undefined): string | undefined {
  if (node?.type !== 'TemplateElement') return undefined;
  const value = asNode(node.value);
  return typeof value?.cooked === 'string' ? value.cooked : undefined;
}

function readName(node: AstNode | undefined): string {
  return node && typeof node.name === 'string' ? node.name : '';
}

function readString(node: AstNode | undefined): string | undefined {
  return node && typeof node.value === 'string' ? node.value : undefined;
}

function count(values: readonly string[], expected: string): number {
  return values.filter((value) => value === expected).length;
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
