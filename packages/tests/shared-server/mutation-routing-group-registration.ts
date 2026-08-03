import path from 'node:path';

import type { MutationRoutingAstNode as AstNode } from './mutation-routing-call-graph.ts';

interface FindGroupRouteHandlerInput {
  readonly program: AstNode;
  readonly method: string;
  readonly routePath: string;
  readonly privateOwnerName: string;
  readonly familyOwnerName: string;
  readonly familyPrivateOwnerNames?: readonly string[];
}

interface GroupRegistrationRootContract {
  readonly familyOwnerName: string;
  readonly familySourcePath: string;
  readonly program: AstNode;
  readonly rootOwnerName: string;
  readonly rootSourcePath: string;
}

interface DirectRouteRegistration {
  readonly handler: AstNode;
  readonly method: string;
  readonly ownerName: string;
  readonly routePath: string;
}

interface DirectOwnerCall {
  readonly argumentNames: readonly string[];
  readonly ownerName: string;
}

const ROOT_FAMILY_CALLS = [
  [
    'registerGroupStateReadRoutes',
    './register-group-state-read-routes.ts',
    'app',
    'resolvedDependencies',
    'authorization',
  ],
  [
    'registerGroupStateMutationRoutes',
    './register-group-state-mutation-routes.ts',
    'app',
    'resolvedDependencies',
    'authorization',
  ],
  [
    'registerGroupAdmissionRoutes',
    './register-group-admission-routes.ts',
    'app',
    'resolvedDependencies',
  ],
  [
    'registerGroupMembershipRoutes',
    './register-group-membership-routes.ts',
    'app',
    'resolvedDependencies',
    'authorization',
  ],
  [
    'registerGroupPresenceRoutes',
    './register-group-presence-routes.ts',
    'app',
    'resolvedDependencies',
    'authorization',
  ],
] as const;

export function hasExactGroupRegistrationRoot({
  familyOwnerName,
  familySourcePath,
  program,
  rootOwnerName,
  rootSourcePath,
}: GroupRegistrationRootContract): boolean {
  const familyContract = ROOT_FAMILY_CALLS.find(([name]) => name === familyOwnerName);
  if (
    !familyContract ||
    familyContract[1] !== relativeImportPath(rootSourcePath, familySourcePath)
  ) {
    return false;
  }
  if (!hasExactRootFamilyImports(program)) return false;
  const roots = findExportedFunctions(program, rootOwnerName);
  if (roots.length !== 1) return false;
  const root = roots[0]!;
  if (!sameNames(readParameterNames(root), ['app', 'dependencies'])) return false;
  const statements = readBlockStatements(asNode(root.body));
  if (statements.length !== 2 + ROOT_FAMILY_CALLS.length) return false;
  if (
    !hasExactConstCall(statements[0], 'resolvedDependencies', 'createGroupStateRouteDependencies', [
      'dependencies',
    ])
  )
    return false;
  if (
    !hasExactConstCall(statements[1], 'authorization', 'createGroupStateRouteAuthorization', [
      'resolvedDependencies',
    ])
  )
    return false;
  return ROOT_FAMILY_CALLS.every(([name, , ...argumentNames], index) =>
    isExactDirectCall(statements[index + 2], name, argumentNames),
  );
}

export function findDirectGroupRouteHandler({
  program,
  method,
  routePath,
  privateOwnerName,
  familyOwnerName,
  familyPrivateOwnerNames,
}: FindGroupRouteHandlerInput): AstNode | undefined {
  const familyOwners = findExportedFunctions(program, familyOwnerName);
  if (familyOwners.length !== 1) return undefined;
  const familyOwner = familyOwners[0]!;
  const familyParameters = readParameterNames(familyOwner);
  if (!sameNames(familyParameters, expectedFamilyParameters(familyOwnerName))) return undefined;
  const calledOwners = readDirectFamilyOwnerCalls(familyOwner);
  if (!calledOwners || countOwnerCalls(calledOwners, privateOwnerName) !== 1) return undefined;
  if (
    familyPrivateOwnerNames &&
    !sameNames(
      calledOwners.map((call) => call.ownerName),
      familyPrivateOwnerNames,
    )
  )
    return undefined;
  if (!hasOnlyDirectRouteOwners(program, calledOwners, familyParameters)) return undefined;
  const exact = readAllDirectRegistrations(program).filter(
    (registration) => registration.method === method && registration.routePath === routePath,
  );
  return exact.length === 1 && exact[0]?.ownerName === privateOwnerName
    ? exact[0].handler
    : undefined;
}

function hasExactRootFamilyImports(program: AstNode): boolean {
  return ROOT_FAMILY_CALLS.every(([name, sourcePath]) =>
    hasExactNamedImport(program, name, sourcePath),
  );
}

function hasExactNamedImport(
  program: AstNode,
  expectedName: string,
  expectedSourcePath: string,
): boolean {
  const bindings = asNodes(program.body).flatMap((statement) => {
    if (statement.type !== 'ImportDeclaration') return [];
    const sourcePath = readString(asNode(statement.source));
    return asNodes(statement.specifiers)
      .filter((specifier) => readName(asNode(specifier.local)) === expectedName)
      .map((specifier) => ({ sourcePath, specifier }));
  });
  if (bindings.length !== 1) return false;
  const binding = bindings[0]!;
  return (
    binding.sourcePath === expectedSourcePath &&
    binding.specifier.type === 'ImportSpecifier' &&
    readName(asNode(binding.specifier.imported)) === expectedName
  );
}

function relativeImportPath(rootSourcePath: string, familySourcePath: string): string {
  const relative = path.posix.relative(path.posix.dirname(rootSourcePath), familySourcePath);
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function readDirectFamilyOwnerCalls(owner: AstNode): readonly DirectOwnerCall[] | undefined {
  const calledOwners: DirectOwnerCall[] = [];
  for (const statement of readBlockStatements(asNode(owner.body))) {
    if (statement.type !== 'ExpressionStatement') return undefined;
    const call = asNode(statement.expression);
    if (call?.type !== 'CallExpression') return undefined;
    const callee = asNode(call.callee);
    if (callee?.type !== 'Identifier') return undefined;
    const argumentNames = asNodes(call.arguments).map(readName);
    if (argumentNames.some((name) => !name)) return undefined;
    calledOwners.push({ argumentNames, ownerName: readName(callee) });
  }
  return calledOwners.length > 0 ? calledOwners : undefined;
}

function hasOnlyDirectRouteOwners(
  program: AstNode,
  calls: readonly DirectOwnerCall[],
  familyParameters: readonly string[],
): boolean {
  return calls.every((call) => {
    const owners = findTopLevelFunctions(program, call.ownerName);
    if (owners.length !== 1) return false;
    const parameters = readParameterNames(owners[0]!);
    return (
      parameters.every((name) => familyParameters.includes(name)) &&
      sameNames(call.argumentNames, parameters) &&
      readDirectRegistration(program, owners[0]!) !== undefined
    );
  });
}

function hasExactConstCall(
  statement: AstNode | undefined,
  bindingName: string,
  callName: string,
  argumentNames: readonly string[],
): boolean {
  if (statement?.type !== 'VariableDeclaration' || statement.kind !== 'const') return false;
  const declarations = asNodes(statement.declarations);
  if (declarations.length !== 1 || readName(asNode(declarations[0]?.id)) !== bindingName)
    return false;
  const call = asNode(declarations[0]?.init);
  return call?.type === 'CallExpression' && isExactCall(call, callName, argumentNames);
}

function isExactDirectCall(
  statement: AstNode | undefined,
  callName: string,
  argumentNames: readonly string[],
): boolean {
  return (
    statement?.type === 'ExpressionStatement' &&
    isExactCall(asNode(statement.expression), callName, argumentNames)
  );
}

function isExactCall(
  call: AstNode | undefined,
  callName: string,
  argumentNames: readonly string[],
): boolean {
  return (
    call?.type === 'CallExpression' &&
    asNode(call.callee)?.type === 'Identifier' &&
    readName(asNode(call.callee)) === callName &&
    sameNames(asNodes(call.arguments).map(readName), argumentNames)
  );
}

function expectedFamilyParameters(familyOwnerName: string): readonly string[] {
  return familyOwnerName === 'registerGroupAdmissionRoutes'
    ? ['app', 'dependencies']
    : ['app', 'dependencies', 'authorization'];
}

function readParameterNames(owner: AstNode): readonly string[] {
  return asNodes(owner.params).map((parameter) => {
    const binding = parameter.type === 'AssignmentPattern' ? asNode(parameter.left) : parameter;
    return readName(binding);
  });
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((name, index) => name === expected[index])
  );
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

function countOwnerCalls(calls: readonly DirectOwnerCall[], expected: string): number {
  return calls.filter((call) => call.ownerName === expected).length;
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
