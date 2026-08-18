import { AppInboxType } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';

import type { MutationRoutingAstNode } from './mutation-routing-call-graph.ts';
import type { MutationRouteInventoryEntry } from './mutation-routing-inventory.ts';
import type { MutationRoutingProgramLoader } from './mutation-routing-live-registration.ts';

const CRDT_ADMIN_MUTATIONS_PATH = 'apps/api-v1/src/crdt/create-crdt-admin-mutations.ts';
const CRDT_ADMIN_ROUTES_PATH = 'apps/api-v1/src/routes/crdt-admin-routes.ts';

const GENERAL_ADMIN_METHOD_BY_OPERATION: Readonly<Record<string, string>> = {
  compact: 'compactCrdt',
  lifecycle: 'updateCrdtLifecycle',
  erase: 'eraseCrdt',
};

interface ExactCrdtAdminRouteOperationInput {
  readonly item: MutationRouteInventoryEntry;
  readonly source: MutationRoutingAstNode;
  readonly enqueueSource: MutationRoutingAstNode;
  readonly typeOwnerSource: MutationRoutingAstNode;
  readonly handler: MutationRoutingAstNode;
  readonly loadProgram: MutationRoutingProgramLoader;
}

interface ExactLiveOperationCallInput {
  readonly root: MutationRoutingAstNode;
  readonly callName: string;
  readonly expectedOperationValues: readonly string[];
}

interface NamedOwnerOperationCallInput {
  readonly program: MutationRoutingAstNode;
  readonly ownerName: string;
  readonly callName: string;
  readonly expectedOperationValues: readonly string[];
}

interface LiveFunctionFacts {
  readonly calls: MutationRoutingAstNode[];
  readonly declarations: MutationRoutingAstNode[];
}

interface LiveReturnCompletion {
  readonly kind: 'return';
  readonly value: MutationRoutingAstNode | undefined;
}

type LiveCompletion =
  | Readonly<{ kind: 'continue' }>
  | Readonly<{ kind: 'abrupt' }>
  | Readonly<{ kind: 'ambiguous' }>
  | LiveReturnCompletion;

export function isCrdtAdminOperationRoute(item: MutationRouteInventoryEntry): boolean {
  return (
    item.ownerSourcePath ===
      'packages/shared-server/rallar-system/crdt/inbox/app-crdt-inbox-service.ts' &&
    item.transport === 'HTTP' &&
    item.operationDiscriminant !== undefined
  );
}

export function isExactCrdtAdminRouteOperation(input: ExactCrdtAdminRouteOperationInput): boolean {
  const operation = input.item.operationDiscriminant;
  if (!operation) {
    return false;
  }
  const adminMutations = input.loadProgram(CRDT_ADMIN_MUTATIONS_PATH);
  if (!adminMutations) {
    return false;
  }
  return (
    hasExactRouteOperation(input, operation) &&
    hasExactAdminMutationSubmission(adminMutations, operation) &&
    hasExactCommandOperation(adminMutations, operation) &&
    hasExactAppInboxType(input.typeOwnerSource, operation, input.item.type)
  );
}

function hasExactRouteOperation(
  input: ExactCrdtAdminRouteOperationInput,
  operation: string,
): boolean {
  if (input.item.sourcePath === CRDT_ADMIN_ROUTES_PATH) {
    return (
      hasExactLiveOperationCall({
        root: input.handler,
        callName: 'processCrdtAdminMutation',
        expectedOperationValues: [`literal:${operation}`],
      }) &&
      hasNamedOwnerOperationCall({
        program: input.source,
        ownerName: 'processCrdtAdminMutation',
        callName: 'writeCrdtAdminMutation',
        expectedOperationValues: ['member:input.operation'],
      })
    );
  }
  return hasExactGeneralAdminRouteOperation(input, operation);
}

function hasExactGeneralAdminRouteOperation(
  input: ExactCrdtAdminRouteOperationInput,
  operation: string,
): boolean {
  const gatewayMethod = GENERAL_ADMIN_METHOD_BY_OPERATION[operation];
  if (!gatewayMethod || !hasSingleLiveCall(input.handler, gatewayMethod)) {
    return false;
  }
  return hasNamedOwnerOperationCall({
    program: input.enqueueSource,
    ownerName: gatewayMethod,
    callName: 'writeCrdtAdminMutation',
    expectedOperationValues: [`literal:${operation}`],
  });
}

function hasNamedOwnerOperationCall(input: NamedOwnerOperationCallInput): boolean {
  const owners = findFunctionLikes(input.program, input.ownerName);
  return (
    owners.length === 1 &&
    hasExactLiveOperationCall({
      root: owners[0]!,
      callName: input.callName,
      expectedOperationValues: input.expectedOperationValues,
    })
  );
}

function hasExactAdminMutationSubmission(
  program: MutationRoutingAstNode,
  operation: string,
): boolean {
  const owners = findFunctionLikes(program, 'writeCrdtAdminMutation');
  if (owners.length !== 1) {
    return false;
  }
  const facts = readLiveFunctionFacts(owners[0]!);
  const commandOperationByBinding = readCreatedCommandOperations(facts);
  const submissions = facts.calls.filter((call) =>
    isCallNamed(call, 'writeCrdtCommandUntilCompletion'),
  );
  if (submissions.length !== 1) {
    return false;
  }
  const commandBinding = readName(unwrapExpression(asNodes(submissions[0]!.arguments)[0]));
  const submittedOperation = commandOperationByBinding.get(commandBinding);
  return [`literal:${operation}`, 'member:mutation.operation'].includes(submittedOperation ?? '');
}

function readCreatedCommandOperations(facts: LiveFunctionFacts): ReadonlyMap<string, string> {
  const operationByBinding = new Map<string, string>();
  for (const declaration of facts.declarations) {
    const binding = readName(asNode(declaration.id));
    const creation = unwrapExpression(asNode(declaration.init));
    if (!binding || !creation || !isCallNamed(creation, 'createCrdtAdminCommand')) {
      continue;
    }
    const operation = readEffectiveOperation(asNodes(creation.arguments)[0]);
    if (operation) {
      operationByBinding.set(binding, operation);
    }
  }
  return operationByBinding;
}

function hasExactCommandOperation(program: MutationRoutingAstNode, operation: string): boolean {
  const owners = findFunctionLikes(program, 'createCrdtAdminCommand');
  if (owners.length !== 1) {
    return false;
  }
  const returned = readLiveSwitchReturn(owners[0]!, 'input.operation', operation);
  const creation = unwrapExpression(returned);
  if (!creation || !isCallNamed(creation, 'createCrdtMutationCommand')) {
    return false;
  }
  const operationValue = readEffectiveOperation(asNodes(creation.arguments)[0]);
  return [`literal:${operation}`, 'member:input.operation'].includes(operationValue ?? '');
}

function hasExactAppInboxType(
  program: MutationRoutingAstNode,
  operation: string,
  type: AppInboxType,
): boolean {
  const owners = findFunctionLikes(program, 'toCrdtAppInboxType');
  if (owners.length !== 1) {
    return false;
  }
  const returned = readLiveSwitchReturn(owners[0]!, 'command.operation', operation);
  return readMemberPath(unwrapExpression(returned)) === `AppInboxType.${type}`;
}

function readLiveSwitchReturn(
  owner: MutationRoutingAstNode,
  discriminant: string,
  operation: string,
): MutationRoutingAstNode | undefined {
  const switches = findAll(
    owner,
    (node) =>
      node.type === 'SwitchStatement' && readMemberPath(asNode(node.discriminant)) === discriminant,
  );
  if (switches.length !== 1) {
    return undefined;
  }
  const cases = asNodes(switches[0]!.cases);
  const start = cases.findIndex((caseNode) => readString(asNode(caseNode.test)) === operation);
  return start < 0 ? undefined : readFallthroughReturn(cases.slice(start));
}

function readFallthroughReturn(
  cases: readonly MutationRoutingAstNode[],
): MutationRoutingAstNode | undefined {
  for (const caseNode of cases) {
    const completion = readStatementListCompletion(asNodes(caseNode.consequent));
    if (completion.kind === 'return') {
      return completion.value;
    }
    if (completion.kind !== 'continue') {
      return undefined;
    }
  }
  return undefined;
}

function readStatementListCompletion(
  statements: readonly MutationRoutingAstNode[],
): LiveCompletion {
  for (const statement of statements) {
    const completion = readStatementCompletion(statement);
    if (completion.kind !== 'continue') {
      return completion;
    }
  }
  return { kind: 'continue' };
}

function readStatementCompletion(statement: MutationRoutingAstNode): LiveCompletion {
  if (statement.type === 'ReturnStatement') {
    return { kind: 'return', value: asNode(statement.argument) };
  }
  if (statement.type === 'ThrowStatement' || statement.type === 'BreakStatement') {
    return { kind: 'abrupt' };
  }
  if (statement.type === 'BlockStatement') {
    return readStatementListCompletion(asNodes(statement.body));
  }
  if (statement.type === 'IfStatement') {
    return readIfStatementCompletion(statement);
  }
  if (statement.type === 'TryStatement' || statement.type === 'SwitchStatement') {
    return { kind: 'ambiguous' };
  }
  return { kind: 'continue' };
}

function readIfStatementCompletion(statement: MutationRoutingAstNode): LiveCompletion {
  const condition = readBoolean(asNode(statement.test));
  if (condition === true) {
    return readStatementCompletion(asNode(statement.consequent)!);
  }
  if (condition === false) {
    const alternate = asNode(statement.alternate);
    return alternate ? readStatementCompletion(alternate) : { kind: 'continue' };
  }
  return { kind: 'ambiguous' };
}

function hasExactLiveOperationCall(input: ExactLiveOperationCallInput): boolean {
  const calls = readLiveFunctionFacts(input.root).calls.filter((call) =>
    isCallNamed(call, input.callName),
  );
  if (calls.length !== 1) {
    return false;
  }
  const operation = readEffectiveOperation(asNodes(calls[0]!.arguments)[0]);
  return input.expectedOperationValues.includes(operation ?? '');
}

function hasSingleLiveCall(root: MutationRoutingAstNode, callName: string): boolean {
  return (
    readLiveFunctionFacts(root).calls.filter((call) => isCallNamed(call, callName)).length === 1
  );
}

function readEffectiveOperation(object: MutationRoutingAstNode | undefined): string | undefined {
  if (object?.type !== 'ObjectExpression') {
    return undefined;
  }
  let operation: string | undefined;
  for (const property of asNodes(object.properties)) {
    if (property.type === 'SpreadElement') {
      const spread = readMemberPath(asNode(property.argument));
      operation =
        spread === 'mutation' || spread === 'input' ? `member:${spread}.operation` : undefined;
      continue;
    }
    if (property.computed) {
      return undefined;
    }
    if (property.type === 'ObjectProperty' && readName(asNode(property.key)) === 'operation') {
      operation = readOperationValue(asNode(property.value));
    }
  }
  return operation;
}

function readOperationValue(value: MutationRoutingAstNode | undefined): string | undefined {
  const literal = readString(value);
  if (literal !== undefined) {
    return `literal:${literal}`;
  }
  const member = readMemberPath(value);
  return member ? `member:${member}` : undefined;
}

function readLiveFunctionFacts(root: MutationRoutingAstNode): LiveFunctionFacts {
  const facts: LiveFunctionFacts = { calls: [], declarations: [] };
  visitLiveFunction(root, facts);
  return facts;
}

function visitLiveFunction(root: MutationRoutingAstNode, facts: LiveFunctionFacts): void {
  const body = asNode(root.body);
  if (body?.type === 'BlockStatement') {
    visitLiveStatementList(asNodes(body.body), facts);
    return;
  }
  visitLiveExpression(body ?? root, facts);
}

function visitLiveStatementList(
  statements: readonly MutationRoutingAstNode[],
  facts: LiveFunctionFacts,
): boolean {
  for (const statement of statements) {
    if (!visitLiveStatement(statement, facts)) {
      return false;
    }
  }
  return true;
}

function visitLiveStatement(statement: MutationRoutingAstNode, facts: LiveFunctionFacts): boolean {
  if (statement.type === 'VariableDeclaration') {
    for (const declaration of asNodes(statement.declarations)) {
      facts.declarations.push(declaration);
      visitLiveExpression(asNode(declaration.init), facts);
    }
    return true;
  }
  if (statement.type === 'ExpressionStatement') {
    visitLiveExpression(asNode(statement.expression), facts);
    return true;
  }
  if (statement.type === 'ReturnStatement' || statement.type === 'ThrowStatement') {
    visitLiveExpression(asNode(statement.argument), facts);
    return false;
  }
  if (statement.type === 'BlockStatement') {
    return visitLiveStatementList(asNodes(statement.body), facts);
  }
  if (statement.type === 'IfStatement') {
    return visitLiveIfStatement(statement, facts);
  }
  return true;
}

function visitLiveIfStatement(
  statement: MutationRoutingAstNode,
  facts: LiveFunctionFacts,
): boolean {
  visitLiveExpression(asNode(statement.test), facts);
  const condition = readBoolean(asNode(statement.test));
  if (condition === true) {
    return visitLiveStatement(asNode(statement.consequent)!, facts);
  }
  if (condition === false) {
    const alternate = asNode(statement.alternate);
    return alternate ? visitLiveStatement(alternate, facts) : true;
  }
  const consequentContinues = visitLiveStatement(asNode(statement.consequent)!, facts);
  const alternate = asNode(statement.alternate);
  const alternateContinues = alternate ? visitLiveStatement(alternate, facts) : true;
  return consequentContinues || alternateContinues;
}

function visitLiveExpression(
  expression: MutationRoutingAstNode | undefined,
  facts: LiveFunctionFacts,
): void {
  const node = unwrapExpression(expression);
  if (!node) {
    return;
  }
  if (isFunctionNode(node)) {
    visitLiveFunction(node, facts);
    return;
  }
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
    facts.calls.push(node);
    for (const argument of asNodes(node.arguments)) {
      visitLiveExpression(argument, facts);
    }
    return;
  }
  if (node.type === 'ConditionalExpression') {
    visitLiveConditionalExpression(node, facts);
    return;
  }
  visitLiveExpressionChildren(node, facts);
}

function visitLiveConditionalExpression(
  expression: MutationRoutingAstNode,
  facts: LiveFunctionFacts,
): void {
  visitLiveExpression(asNode(expression.test), facts);
  const condition = readBoolean(asNode(expression.test));
  if (condition !== false) {
    visitLiveExpression(asNode(expression.consequent), facts);
  }
  if (condition !== true) {
    visitLiveExpression(asNode(expression.alternate), facts);
  }
}

function visitLiveExpressionChildren(
  expression: MutationRoutingAstNode,
  facts: LiveFunctionFacts,
): void {
  for (const [key, child] of Object.entries(expression)) {
    if (['loc', 'start', 'end', 'comments', 'tokens', 'type'].includes(key)) {
      continue;
    }
    for (const node of Array.isArray(child) ? asNodes(child) : [asNode(child)]) {
      if (node && !isFunctionNode(node)) {
        visitLiveExpression(node, facts);
      }
    }
  }
}

function findFunctionLikes(
  program: MutationRoutingAstNode,
  name: string,
): readonly MutationRoutingAstNode[] {
  return findAll(program, (node) => functionLikeName(node) === name).map((node) => {
    if (node.type === 'VariableDeclarator') {
      return asNode(node.init)!;
    }
    if (node.type === 'ObjectProperty') {
      return asNode(node.value)!;
    }
    return node;
  });
}

function functionLikeName(node: MutationRoutingAstNode): string {
  if (node.type === 'FunctionDeclaration') {
    return readName(asNode(node.id));
  }
  if (
    node.type === 'ClassMethod' ||
    node.type === 'ClassPrivateMethod' ||
    node.type === 'ObjectMethod'
  ) {
    return readName(asNode(node.key));
  }
  if (node.type !== 'VariableDeclarator' && node.type !== 'ObjectProperty') {
    return '';
  }
  const value = asNode(node.type === 'VariableDeclarator' ? node.init : node.value);
  return value && (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression')
    ? readName(asNode(node.type === 'VariableDeclarator' ? node.id : node.key))
    : '';
}

function findAll(
  value: unknown,
  predicate: (node: MutationRoutingAstNode) => boolean,
): MutationRoutingAstNode[] {
  const found: MutationRoutingAstNode[] = [];
  visit(value, (node) => {
    if (predicate(node)) {
      found.push(node);
    }
  });
  return found;
}

function visit(value: unknown, visitor: (node: MutationRoutingAstNode) => void): void {
  if (!value || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      visit(child, visitor);
    }
    return;
  }
  const node = value as MutationRoutingAstNode;
  if (typeof node.type === 'string') {
    visitor(node);
  }
  for (const [key, child] of Object.entries(node)) {
    if (!['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) {
      visit(child, visitor);
    }
  }
}

function isCallNamed(node: MutationRoutingAstNode, name: string): boolean {
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') {
    return false;
  }
  return readCallName(asNode(node.callee)) === name;
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

function unwrapExpression(
  node: MutationRoutingAstNode | undefined,
): MutationRoutingAstNode | undefined {
  if (
    node?.type === 'AwaitExpression' ||
    node?.type === 'TSAsExpression' ||
    node?.type === 'TSTypeAssertion' ||
    node?.type === 'ParenthesizedExpression'
  ) {
    return unwrapExpression(asNode(node.argument ?? node.expression));
  }
  return node;
}

function readMemberPath(node: MutationRoutingAstNode | undefined): string {
  if (!node) {
    return '';
  }
  if (node.type === 'Identifier') {
    return readName(node);
  }
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') {
    return '';
  }
  const object = readMemberPath(asNode(node.object));
  const property = readName(asNode(node.property));
  return object && property ? `${object}.${property}` : '';
}

function readCallName(node: MutationRoutingAstNode | undefined): string {
  return readName(node) || readMemberName(node);
}

function readMemberName(node: MutationRoutingAstNode | undefined): string {
  return node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression'
    ? readName(asNode(node.property))
    : '';
}

function readName(node: MutationRoutingAstNode | undefined): string {
  return node && typeof node.name === 'string' ? node.name : '';
}

function readString(node: MutationRoutingAstNode | undefined): string | undefined {
  return node && typeof node.value === 'string' ? node.value : undefined;
}

function readBoolean(node: MutationRoutingAstNode | undefined): boolean | undefined {
  return node?.type === 'BooleanLiteral' && typeof node.value === 'boolean'
    ? node.value
    : undefined;
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
