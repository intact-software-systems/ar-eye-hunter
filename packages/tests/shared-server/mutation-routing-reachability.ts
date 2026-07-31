import { AppInboxType } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';
import type { MutationRouteInventoryEntry } from './mutation-routing-inventory.ts';
import {
  findAstNode,
  findRouteRegistration,
  hasReachableAstNode,
  type MutationRoutingAstNode as AstNode,
} from './mutation-routing-call-graph.ts';
import {
  hasLiveAppInboxRegistration,
  type MutationRoutingProgramLoader,
} from './mutation-routing-live-registration.ts';

interface MutationRouteReachabilityInput {
  readonly item: MutationRouteInventoryEntry;
  readonly source: AstNode;
  readonly enqueueSource: AstNode;
  readonly ownerSource: AstNode;
  readonly dispatchSource: AstNode;
  readonly containsMarker: (node: AstNode, marker: string) => boolean;
  readonly matchesMarker: (node: AstNode, marker: string) => boolean;
  readonly loadProgram: MutationRoutingProgramLoader;
}

export function findMutationRouteReachabilityIssues({
  item,
  source,
  enqueueSource,
  ownerSource,
  dispatchSource,
  containsMarker,
  matchesMarker,
  loadProgram,
}: MutationRouteReachabilityInput): readonly string[] {
  const routeKey = `${item.transport}:${item.entrypoint}:${item.type}`;
  const handlers = findRegisteredHandlers(item, source, containsMarker, matchesMarker);
  if (handlers.length === 0) {
    return [`${routeKey} registered callback cannot be resolved`];
  }
  const handoff = handlers
    .map((handler) => findReachableHandoff({ item, source, enqueueSource, handler, matchesMarker }))
    .find((candidate) => candidate !== undefined);
  const issues: string[] = [];
  if (
    !handoff ||
    !hasExpectedTypeWhenExplicit(handoff, item.type, matchesMarker) ||
    !hasOwnerCommandDiscriminator(ownerSource, item, containsMarker)
  ) {
    issues.push(
      `${routeKey} registered handler is not connected to ` +
        `${item.enqueueMarker} with AppInboxType.${item.type}`,
    );
  }
  if (
    !hasOwnerDispatch({
      program: dispatchSource,
      filePath: item.dispatchSourcePath,
      type: item.type,
      dispatchPath: item.ownerDispatchPath,
      matchesMarker,
      loadProgram,
    })
  ) {
    issues.push(`${routeKey} owner dispatch is not connected to ${item.owner}`);
  }
  return issues;
}
const AUTH_COMMAND_KIND_BY_TYPE: Readonly<Partial<Record<AppInboxType, string>>> = {
  [AppInboxType.AUTH_USER_REGISTER]: 'register-user',
  [AppInboxType.AUTH_SESSION_ISSUE]: 'issue-session',
  [AppInboxType.AUTH_SESSION_LOGOUT]: 'logout-session',
  [AppInboxType.AUTH_WS_TICKET_ISSUE]: 'issue-ws-ticket',
  [AppInboxType.AUTH_WS_TICKET_CONSUME]: 'consume-ws-ticket',
  [AppInboxType.AUTH_AGENT_SESSION_TICKETS_ISSUE]: 'issue-agent-tickets',
  [AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME]: 'consume-agent-ticket',
};

function hasOwnerCommandDiscriminator(
  ownerSource: AstNode,
  item: MutationRouteInventoryEntry,
  hasMarker: (node: AstNode, marker: string) => boolean,
): boolean {
  const expected = AUTH_COMMAND_KIND_BY_TYPE[item.type];
  if (!expected) return true;
  const publicHandoffs = findFunctionLikes(ownerSource, item.enqueueMarker);
  return (
    publicHandoffs.length === 0 ||
    publicHandoffs.some((method) => hasMarker(method, `'${expected}'`))
  );
}

function findRegisteredHandlers(
  item: MutationRouteInventoryEntry,
  program: AstNode,
  containsMarker: (node: AstNode, marker: string) => boolean,
  matchesMarker: (node: AstNode, marker: string) => boolean,
): readonly AstNode[] {
  if (item.transport === 'HTTP') {
    const [method, routePath] = item.entrypoint.split(' ');
    const registration = findRouteRegistration(program, method.toLowerCase(), routePath);
    return registration ? asNodes(registration.arguments).slice(1, 2) : [];
  }
  if (item.transport === 'MAINTENANCE') {
    const named = findFunctionLikes(program, item.registrationMarker);
    return named.length > 0
      ? named
      : findFunctionsContaining(program, item.registrationMarker, containsMarker);
  }
  if (item.transport === 'WS_LIFECYCLE') {
    const registration = findCall(program, 'onWebsocketCallbacksDo', () => true);
    const callbacks =
      registration &&
      asNodes(registration.arguments).find((node) => node.type === 'ObjectExpression');
    const onClose = callbacks && readObjectCallback(callbacks, 'onClose');
    return onClose ? [onClose] : [];
  }
  const topicRegistration = findCall(program, 'onInboxMessageDo', (call) =>
    containsMarker(call, item.registrationMarker),
  );
  if (topicRegistration) {
    const callbacks = asNodes(topicRegistration.arguments).find(
      (node) => node.type === 'ObjectExpression',
    );
    const onMessage = callbacks && readObjectCallback(callbacks, 'onMessage');
    return onMessage ? [onMessage] : [];
  }
  const install = findCall(program, 'on', () => true);
  const handlerFactory = install && asNodes(install.arguments)[1];
  const handlerName =
    handlerFactory?.type === 'CallExpression'
      ? readCallName(asNode(handlerFactory.callee))
      : readCallName(handlerFactory);
  const handlers = handlerName ? findFunctionLikes(program, handlerName) : [];
  return handlers.filter((handler) =>
    hasReachableAstNode(program, handler, (node) => matchesMarker(node, item.registrationMarker)),
  );
}

interface FindReachableHandoffInput {
  readonly item: MutationRouteInventoryEntry;
  readonly source: AstNode;
  readonly enqueueSource: AstNode;
  readonly handler: AstNode;
  readonly matchesMarker: (node: AstNode, marker: string) => boolean;
}

function findReachableHandoff({
  item,
  source,
  enqueueSource,
  handler,
  matchesMarker,
}: FindReachableHandoffInput): ReachableHandoff | undefined {
  if (item.sourcePath === item.enqueueSourcePath) {
    return hasReachableAstNode(source, handler, (node) =>
      hasHandoffCall(node, item.enqueueMarker, matchesMarker),
    )
      ? { program: source, root: handler }
      : undefined;
  }
  const bridgeNames = collectCallNames(handler);
  for (const bridgeName of bridgeNames) {
    for (const target of findFunctionLikes(enqueueSource, bridgeName)) {
      if (
        hasReachableAstNode(enqueueSource, target, (node) =>
          hasHandoffCall(node, item.enqueueMarker, matchesMarker),
        )
      )
        return { program: enqueueSource, root: target };
    }
  }
  return undefined;
}

function hasExpectedTypeWhenExplicit(
  handoff: ReachableHandoff,
  expectedType: AppInboxType,
  matchesMarker: (node: AstNode, marker: string) => boolean,
): boolean {
  const hasAnyExplicitType = hasReachableAstNode(handoff.program, handoff.root, (node) =>
    readMemberPath(node).startsWith('AppInboxType.'),
  );
  return (
    !hasAnyExplicitType ||
    hasReachableAstNode(handoff.program, handoff.root, (node) =>
      matchesMarker(node, `AppInboxType.${expectedType}`),
    )
  );
}

interface ReachableHandoff {
  readonly program: AstNode;
  readonly root: AstNode;
}

interface HasOwnerDispatchInput {
  readonly program: AstNode;
  readonly filePath: string;
  readonly type: AppInboxType;
  readonly dispatchPath: string;
  readonly matchesMarker: (node: AstNode, marker: string) => boolean;
  readonly loadProgram: MutationRoutingProgramLoader;
}

function hasOwnerDispatch({
  program,
  filePath,
  type,
  dispatchPath,
  matchesMarker,
  loadProgram,
}: HasOwnerDispatchInput): boolean {
  const calls = findAll(
    program,
    (node) =>
      node.type === 'CallExpression' && readMemberName(asNode(node.callee)) === 'onStateMessage',
  );
  return calls.some((call) => {
    const arguments_ = asNodes(call.arguments);
    const typeArgument = arguments_[0];
    const handler = arguments_.at(-1);
    const exactType = matchesMarker(typeArgument ?? call, `AppInboxType.${type}`);
    const loopType =
      !!typeArgument &&
      hasLiveAppInboxRegistration(program, filePath, call, typeArgument, type, loadProgram);
    if (!handler || (!exactType && !loopType)) return false;
    const roots =
      handler.type === 'Identifier' ? findFunctionLikes(program, readName(handler)) : [handler];
    return roots.some((root) =>
      hasReachableAstNode(program, root, (node) => {
        const path = readMemberPath(asNode(node.callee));
        return path === dispatchPath;
      }),
    );
  });
}

function hasHandoffCall(
  node: AstNode,
  marker: string,
  matchesMarker: (node: AstNode, marker: string) => boolean,
): boolean {
  if (marker.startsWith('AppInboxType.') || marker.includes('(')) {
    return matchesMarker(node, marker);
  }
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return false;
  const callee = asNode(node.callee);
  const path = callee ? readMemberPath(callee) : '';
  return path === marker || path.endsWith(`.${marker}`);
}

function findFunctionLikes(program: AstNode, name: string): readonly AstNode[] {
  return findAll(program, (node) => {
    if (node.type === 'FunctionDeclaration') return readName(node.id) === name;
    if (
      node.type === 'ClassMethod' ||
      node.type === 'ClassPrivateMethod' ||
      node.type === 'ObjectMethod'
    )
      return readName(node.key) === name;
    if (node.type !== 'VariableDeclarator' && node.type !== 'ObjectProperty') return false;
    const value = asNode(node.type === 'VariableDeclarator' ? node.init : node.value);
    return (
      readName(node.type === 'VariableDeclarator' ? node.id : node.key) === name &&
      !!value &&
      (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression')
    );
  }).map((node) => {
    if (node.type === 'VariableDeclarator') return asNode(node.init)!;
    if (node.type === 'ObjectProperty') return asNode(node.value)!;
    return node;
  });
}

function findFunctionsContaining(
  program: AstNode,
  marker: string,
  hasMarker: (node: AstNode, marker: string) => boolean,
): readonly AstNode[] {
  return findAll(program, (node) => isFunction(node) && hasMarker(node, marker));
}

function readObjectCallback(object: AstNode, name: string): AstNode | undefined {
  const property = asNodes(object.properties).find((candidate) => readName(candidate.key) === name);
  if (!property) return undefined;
  return property.type === 'ObjectMethod' ? property : asNode(property.value);
}

function findCall(
  program: AstNode,
  name: string,
  predicate: (call: AstNode) => boolean,
): AstNode | undefined {
  return findAstNode(
    program,
    (node) =>
      node.type === 'CallExpression' &&
      readMemberName(asNode(node.callee)) === name &&
      predicate(node),
  );
}

function collectCallNames(value: AstNode): ReadonlySet<string> {
  return new Set(
    findAll(
      value,
      (node) => node.type === 'CallExpression' || node.type === 'OptionalCallExpression',
    )
      .map((call) => readCallName(asNode(call.callee)))
      .filter(Boolean),
  );
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

function readMemberPath(node: AstNode | undefined): string {
  if (!node) return '';
  if (node.type === 'Identifier') return readName(node);
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return '';
  const object = asNode(node.object);
  const prefix = object ? readMemberPath(object) : '';
  const property = readName(node.property);
  return property ? (prefix ? `${prefix}.${property}` : property) : '';
}

function readCallName(node: AstNode | undefined): string {
  return readName(node) || readMemberName(node);
}

function readMemberName(node: AstNode | undefined): string {
  return node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression'
    ? readName(node.property)
    : '';
}

function readName(value: unknown): string {
  const node = asNode(value);
  return node && typeof node.name === 'string' ? node.name : '';
}

function isFunction(node: AstNode): boolean {
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
