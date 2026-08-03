import {
  findRouteRegistration,
  type MutationRoutingAstNode as AstNode,
} from './mutation-routing-call-graph.ts';

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

  const owners = findNamedTopLevelFunctions(program, registrationMarker);
  if (owners.length !== 1) return undefined;
  const statements = readBlockStatements(asNode(owners[0]?.body));
  if (statements.length !== 1 || statements[0]?.type !== 'ExpressionStatement') return undefined;
  const registration = asNode(statements[0].expression);
  if (
    registration?.type !== 'CallExpression' ||
    readMemberObject(registration) !== 'app' ||
    readMemberName(asNode(registration.callee)) !== method ||
    resolveModuleString(program, asNodes(registration.arguments)[0]) !== routePath
  ) {
    return undefined;
  }
  return asNodes(registration.arguments)[1];
}

export function isExactGroupStateRouteOperation(
  handler: AstNode,
  translator: AstNode,
  route: GroupStateRouteOperation,
): boolean {
  const operation = route.operationDiscriminant;
  return Boolean(
    operation &&
    hasExactGroupRouteSubmission(handler, operation) &&
    hasExactGroupTranslatorOperation(translator, operation, route.type),
  );
}

function hasExactGroupRouteSubmission(handler: AstNode, operation: string): boolean {
  const handlerStatements = readBlockStatements(asNode(handler.body));
  if (handlerStatements.length !== 1 || handlerStatements[0]?.type !== 'TryStatement') {
    return false;
  }
  const tryStatements = readBlockStatements(asNode(handlerStatements[0].block));
  const calls = readLiveSequentialCalls(tryStatements);
  if (!calls) return false;
  const submissions = calls.filter(
    (call) => readMemberName(asNode(call.callee)) === 'processGroupAppInbox',
  );
  if (submissions.length !== 1) return false;
  const commands = calls.filter(
    (call) => readCallName(asNode(call.callee)) === 'toGroupStateCommand',
  );
  return (
    commands.length === 1 &&
    readOperationLiteral(commands[0]) === operation &&
    isSubmittedCommand(submissions[0]!, commands[0]!, tryStatements)
  );
}

function isSubmittedCommand(
  submission: AstNode,
  command: AstNode,
  statements: readonly AstNode[],
): boolean {
  if (findCallsOutsideFunctions(submission.arguments).includes(command)) return true;
  const binding = findCommandBinding(statements, command);
  return Boolean(binding && hasIdentifierOutsideFunctions(submission.arguments, binding));
}

function findCommandBinding(statements: readonly AstNode[], command: AstNode): string | undefined {
  for (const statement of statements) {
    if (statement.type === 'ReturnStatement' || statement.type === 'ThrowStatement')
      return undefined;
    if (statement.type !== 'VariableDeclaration') continue;
    const binding = asNodes(statement.declarations).find(
      (declaration) => asNode(declaration.init) === command,
    );
    if (binding) return readName(asNode(binding.id)) || undefined;
  }
  return undefined;
}

function hasIdentifierOutsideFunctions(value: unknown, expectedName: string): boolean {
  let found = false;
  visitOutsideFunctions(value, (node) => {
    if (node.type === 'Identifier' && readName(node) === expectedName) found = true;
  });
  return found;
}

function hasExactGroupTranslatorOperation(
  program: AstNode,
  operation: string,
  expectedType: string,
): boolean {
  const translators = findNamedTopLevelFunctions(program, 'toGroupStateCommand');
  if (translators.length !== 1) return false;
  const statements = readBlockStatements(asNode(translators[0]?.body));
  if (statements.length !== 1 || statements[0]?.type !== 'SwitchStatement') return false;
  const cases = asNodes(statements[0].cases).filter(
    (switchCase) => readString(asNode(switchCase.test)) === operation,
  );
  if (cases.length !== 1) return false;
  const helperName = readSwitchHelperName(cases[0]!);
  if (!helperName) return false;
  const helpers = findNamedTopLevelFunctions(program, helperName);
  if (helpers.length !== 1) return false;
  const result = readLiveReturnObject(helpers[0]!);
  return readObjectMemberPath(result, 'type') === `AppInboxType.${expectedType}`;
}

function readSwitchHelperName(switchCase: AstNode): string | undefined {
  const consequent = asNodes(switchCase.consequent);
  if (consequent.length !== 1 || consequent[0]?.type !== 'ReturnStatement') return undefined;
  const returned = asNode(consequent[0].argument);
  return returned?.type === 'CallExpression' ? readName(asNode(returned.callee)) : undefined;
}

function readLiveReturnObject(owner: AstNode): AstNode | undefined {
  for (const statement of readBlockStatements(asNode(owner.body))) {
    if (statement.type === 'ReturnStatement') {
      const returned = asNode(statement.argument);
      return returned?.type === 'ObjectExpression' ? returned : undefined;
    }
    if (statement.type === 'ThrowStatement') return undefined;
    if (statement.type !== 'VariableDeclaration' && statement.type !== 'ExpressionStatement') {
      return undefined;
    }
  }
  return undefined;
}

function readLiveSequentialCalls(statements: readonly AstNode[]): readonly AstNode[] | undefined {
  const calls: AstNode[] = [];
  for (const statement of statements) {
    if (statement.type === 'ReturnStatement') {
      calls.push(...findCallsOutsideFunctions(statement.argument));
      return calls;
    }
    if (statement.type === 'ThrowStatement') return calls;
    if (statement.type !== 'VariableDeclaration' && statement.type !== 'ExpressionStatement') {
      return undefined;
    }
    calls.push(...findCallsOutsideFunctions(statement));
  }
  return calls;
}

function findCallsOutsideFunctions(value: unknown): readonly AstNode[] {
  const calls: AstNode[] = [];
  visitOutsideFunctions(value, (node) => {
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') calls.push(node);
  });
  return calls;
}

function visitOutsideFunctions(value: unknown, visitor: (node: AstNode) => void): void {
  const visit = (current: unknown, isRoot = false): void => {
    if (!current || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    const node = current as AstNode;
    if (!isRoot && isFunctionNode(node)) return;
    visitor(node);
    for (const [name, child] of Object.entries(node)) {
      if (!['loc', 'start', 'end', 'comments', 'tokens'].includes(name)) visit(child);
    }
  };
  visit(value, true);
}

function readOperationLiteral(command: AstNode | undefined): string | undefined {
  const input = asNodes(command?.arguments)[0];
  if (input?.type !== 'ObjectExpression') return undefined;
  const values = asNodes(input.properties)
    .filter(
      (property) =>
        property.type === 'ObjectProperty' && readName(asNode(property.key)) === 'operation',
    )
    .map((property) => readString(asNode(property.value)))
    .filter((value): value is string => value !== undefined);
  return values.length === 1 ? values[0] : undefined;
}

function readObjectMemberPath(object: AstNode | undefined, propertyName: string): string {
  if (object?.type !== 'ObjectExpression') return '';
  const properties = asNodes(object.properties).filter(
    (property) =>
      property.type === 'ObjectProperty' && readName(asNode(property.key)) === propertyName,
  );
  return properties.length === 1 ? readMemberPath(asNode(properties[0]?.value)) : '';
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
    return resolveModuleString(program, asNode(binding.init), new Set(resolving).add(name));
  }
  if (value.type === 'TemplateLiteral') return resolveTemplateLiteral(program, value, resolving);
  if (value.type !== 'BinaryExpression' || value.operator !== '+') return undefined;
  const left = resolveModuleString(program, asNode(value.left), resolving);
  const right = resolveModuleString(program, asNode(value.right), resolving);
  return left === undefined || right === undefined ? undefined : `${left}${right}`;
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

function readBlockStatements(block: AstNode | undefined): readonly AstNode[] {
  return block?.type === 'BlockStatement' ? asNodes(block.body) : [];
}

function readTemplateElement(node: AstNode | undefined): string | undefined {
  if (node?.type !== 'TemplateElement') return undefined;
  const value = asNode(node.value);
  return typeof value?.cooked === 'string' ? value.cooked : undefined;
}

function readMemberObject(call: AstNode): string {
  const callee = asNode(call.callee);
  return callee?.type === 'MemberExpression' ? readName(asNode(callee.object)) : '';
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
