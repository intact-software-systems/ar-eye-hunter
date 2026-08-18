import { AppInboxType } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';

import { hasReachableAstNode, type MutationRoutingAstNode } from './mutation-routing-call-graph.ts';
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

interface ReachableOperationCallInput {
  readonly program: MutationRoutingAstNode;
  readonly root: MutationRoutingAstNode;
  readonly callName: string;
  readonly operation: string;
}

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
    hasExactAdminMutationSubmission(adminMutations) &&
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
      hasReachableOperationCall({
        program: input.source,
        root: input.handler,
        callName: 'processCrdtAdminMutation',
        operation,
      }) &&
      findFunctionLikes(input.source, 'processCrdtAdminMutation').some((owner) =>
        hasReachableCall(input.source, owner, 'writeCrdtAdminMutation'),
      )
    );
  }
  const gatewayMethod = GENERAL_ADMIN_METHOD_BY_OPERATION[operation];
  return Boolean(
    gatewayMethod &&
    hasReachableCall(input.source, input.handler, gatewayMethod) &&
    findFunctionLikes(input.enqueueSource, gatewayMethod).some((owner) =>
      hasReachableOperationCall({
        program: input.enqueueSource,
        root: owner,
        callName: 'writeCrdtAdminMutation',
        operation,
      }),
    ),
  );
}

function hasExactAdminMutationSubmission(program: MutationRoutingAstNode): boolean {
  return findFunctionLikes(program, 'writeCrdtAdminMutation').some(
    (owner) =>
      hasReachableCall(program, owner, 'createCrdtAdminCommand') &&
      hasReachableCall(program, owner, 'writeCrdtCommandUntilCompletion'),
  );
}

function hasExactCommandOperation(program: MutationRoutingAstNode, operation: string): boolean {
  const owners = findFunctionLikes(program, 'createCrdtAdminCommand');
  if (owners.length !== 1) {
    return false;
  }
  const cases = findAll(
    owners[0],
    (node) => node.type === 'SwitchCase' && readString(asNode(node.test)) === operation,
  );
  return (
    cases.length === 1 &&
    findAll(cases[0], (node) => isCommandCreationForOperation(node, operation)).length === 1
  );
}

function isCommandCreationForOperation(node: MutationRoutingAstNode, operation: string): boolean {
  if (!isCallNamed(node, 'createCrdtMutationCommand')) {
    return false;
  }
  const input = asNodes(node.arguments)[0];
  const operationValue = readObjectPropertyValue(input, 'operation');
  return (
    readString(operationValue) === operation || readMemberPath(operationValue) === 'input.operation'
  );
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
  const cases = findAll(
    owners[0],
    (node) => node.type === 'SwitchCase' && readString(asNode(node.test)) === operation,
  );
  if (cases.length !== 1) {
    return false;
  }
  const returns = findAll(cases[0], (node) => node.type === 'ReturnStatement');
  return (
    returns.length === 1 && readMemberPath(asNode(returns[0]?.argument)) === `AppInboxType.${type}`
  );
}

function hasReachableOperationCall(input: ReachableOperationCallInput): boolean {
  return hasReachableAstNode(input.program, input.root, (node) => {
    if (!isCallNamed(node, input.callName)) {
      return false;
    }
    const operationValue = readObjectPropertyValue(asNodes(node.arguments)[0], 'operation');
    return readString(operationValue) === input.operation;
  });
}

function hasReachableCall(
  program: MutationRoutingAstNode,
  root: MutationRoutingAstNode,
  callName: string,
): boolean {
  return hasReachableAstNode(program, root, (node) => isCallNamed(node, callName));
}

function isCallNamed(node: MutationRoutingAstNode, name: string): boolean {
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') {
    return false;
  }
  return readCallName(asNode(node.callee)) === name;
}

function readObjectPropertyValue(
  object: MutationRoutingAstNode | undefined,
  propertyName: string,
): MutationRoutingAstNode | undefined {
  if (object?.type !== 'ObjectExpression') {
    return undefined;
  }
  const properties = asNodes(object.properties);
  if (properties.some((property) => property.computed)) {
    return undefined;
  }
  const matchingIndexes = properties.flatMap((property, index) =>
    property.type === 'ObjectProperty' && readName(asNode(property.key)) === propertyName
      ? [index]
      : [],
  );
  if (matchingIndexes.length !== 1) {
    return undefined;
  }
  const matchingIndex = matchingIndexes[0]!;
  if (properties.slice(matchingIndex + 1).some((property) => property.type === 'SpreadElement')) {
    return undefined;
  }
  const property = properties[matchingIndex];
  return property?.type === 'ObjectProperty' ? asNode(property.value) : undefined;
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
