import {
  findRouteRegistration,
  hasReachableAstNode,
  type MutationRoutingAstNode as AstNode,
} from './mutation-routing-call-graph.ts';
import { hasConstructionReachableNode } from './mutation-routing-construction-reachability.ts';

interface FindHttpRouteHandlerInput {
  readonly program: AstNode;
  readonly method: string;
  readonly routePath: string;
  readonly registrationMarker: string;
  readonly namedOwnerRequired: boolean;
}

interface GroupStateRouteOperation {
  readonly operationDiscriminant?: string;
  readonly type: string;
}

export function findExactHttpRouteHandler({
  program,
  method,
  routePath,
  registrationMarker,
  namedOwnerRequired,
}: FindHttpRouteHandlerInput): AstNode | undefined {
  if (!namedOwnerRequired) {
    const direct = findRouteRegistration(program, method, routePath);
    return direct ? asNodes(direct.arguments)[1] : undefined;
  }

  const registrationOwners = findNamedTopLevelFunctions(program, registrationMarker);
  if (registrationOwners.length !== 1) return undefined;
  const registrationOwner = registrationOwners[0]!;
  const registrations = findAll(
    program,
    (node) =>
      node.type === 'CallExpression' &&
      readMemberName(asNode(node.callee)) === method &&
      resolveModuleString(program, asNodes(node.arguments)[0]) === routePath,
  ).filter((registration) =>
    hasConstructionReachableNode(program, registrationOwner, registration),
  );
  if (registrations.length !== 1) return undefined;
  return asNodes(registrations[0]?.arguments)[1];
}

export function readGroupStateRouteOperation(handler: AstNode): string | undefined {
  const calls = findAll(
    handler,
    (node) =>
      node.type === 'CallExpression' && readCallName(asNode(node.callee)) === 'toGroupStateCommand',
  );
  if (calls.length !== 1) return undefined;
  const commandInput = asNodes(calls[0]?.arguments)[0];
  if (commandInput?.type !== 'ObjectExpression') return undefined;
  const operations = asNodes(commandInput.properties)
    .filter(
      (property) =>
        property.type === 'ObjectProperty' && readName(asNode(property.key)) === 'operation',
    )
    .map((property) => readString(asNode(property.value)))
    .filter(Boolean);
  return operations.length === 1 ? operations[0] : undefined;
}

export function hasGroupStateTranslatorOperation(
  program: AstNode,
  operation: string,
  expectedType: string,
): boolean {
  const cases = findAll(
    program,
    (node) => node.type === 'SwitchCase' && readString(asNode(node.test)) === operation,
  );
  return (
    cases.length === 1 &&
    hasReachableAstNode(
      program,
      cases[0]!,
      (node) => readMemberPath(node) === `AppInboxType.${expectedType}`,
    )
  );
}

export function isExactGroupStateRouteOperation(
  handler: AstNode,
  translator: AstNode,
  route: GroupStateRouteOperation,
): boolean {
  const operation = route.operationDiscriminant;
  if (!operation) return false;
  return (
    readGroupStateRouteOperation(handler) === operation &&
    hasGroupStateTranslatorOperation(translator, operation, route.type)
  );
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
    if (!binding) return undefined;
    const nextResolving = new Set(resolving).add(name);
    return resolveModuleString(program, asNode(binding.init), nextResolving);
  }
  if (value.type === 'TemplateLiteral') {
    return resolveTemplateLiteral(program, value, resolving);
  }
  if (value.type === 'BinaryExpression' && value.operator === '+') {
    const left = resolveModuleString(program, asNode(value.left), resolving);
    const right = resolveModuleString(program, asNode(value.right), resolving);
    return left === undefined || right === undefined ? undefined : `${left}${right}`;
  }
  return undefined;
}

function resolveTemplateLiteral(
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

function findNamedTopLevelFunctions(program: AstNode, name: string): readonly AstNode[] {
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

function readTemplateElement(node: AstNode | undefined): string | undefined {
  if (node?.type !== 'TemplateElement') return undefined;
  const value = asNode(node.value);
  return typeof value?.cooked === 'string' ? value.cooked : undefined;
}

function readMemberPath(node: AstNode | undefined): string {
  if (!node) return '';
  if (node.type === 'Identifier') return readName(node);
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return '';
  const object = readMemberPath(asNode(node.object));
  const property = readName(asNode(node.property));
  return object && property ? `${object}.${property}` : '';
}

function readCallName(node: AstNode | undefined): string {
  return readName(node) || readMemberName(node);
}

function readMemberName(node: AstNode | undefined): string {
  return node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression'
    ? readName(asNode(node.property))
    : '';
}

function readName(node: AstNode | undefined): string {
  return node && typeof node.name === 'string' ? node.name : '';
}

function readString(node: AstNode | undefined): string | undefined {
  return node && typeof node.value === 'string' ? node.value : undefined;
}

function findAll(value: unknown, predicate: (node: AstNode) => boolean): AstNode[] {
  const found: AstNode[] = [];
  visit(value, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

function visit(value: unknown, visitor: (node: AstNode) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const child of value) visit(child, visitor);
    return;
  }
  const node = value as AstNode;
  if (typeof node.type === 'string') visitor(node);
  for (const [key, child] of Object.entries(node)) {
    if (!['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) visit(child, visitor);
  }
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
