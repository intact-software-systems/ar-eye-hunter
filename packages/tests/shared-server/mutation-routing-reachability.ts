import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';

import { findAstNode, hasReachableAstNode, type MutationRoutingAstNode } from './mutation-routing-call-graph.ts';
import { isCrdtAdminOperationRoute, isExactCrdtAdminRouteOperation } from './mutation-routing-crdt-operation.ts';
import { findExactHttpRouteHandler, isExactGroupStateRouteOperation } from './mutation-routing-http-registration.ts';
import type { MutationRouteInventoryEntry } from './mutation-routing-inventory.ts';
import { hasLiveAppInboxRegistration, type MutationRoutingProgramLoader } from './mutation-routing-live-registration.ts';

interface MutationRouteReachabilityInput {
    readonly item: MutationRouteInventoryEntry;
    readonly source: MutationRoutingAstNode;
    readonly enqueueSource: MutationRoutingAstNode;
    readonly ownerSource: MutationRoutingAstNode;
    readonly typeOwnerSource: MutationRoutingAstNode;
    readonly dispatchSource: MutationRoutingAstNode;
    readonly containsMarker: (node: MutationRoutingAstNode, marker: string) => boolean;
    readonly matchesMarker: (node: MutationRoutingAstNode, marker: string) => boolean;
    readonly loadProgram: MutationRoutingProgramLoader;
}

export function findMutationRouteReachabilityIssues({
    item,
    source,
    enqueueSource,
    ownerSource,
    typeOwnerSource,
    dispatchSource,
    containsMarker,
    matchesMarker,
    loadProgram
}: MutationRouteReachabilityInput): readonly string[] {
    const routeKey = `${item.transport}:${item.entrypoint}:${item.type}`;
    const handlers = findRegisteredHandlers({ item, program: source, containsMarker, matchesMarker });
    if (handlers.length === 0) {
        return [`${routeKey} registered callback cannot be resolved`];
    }
    const operation = item.operationDiscriminant;
    const operationHandlers = operation
        ? handlers.filter((handler) =>
            isCrdtAdminOperationRoute(item)
                ? isExactCrdtAdminRouteOperation({
                    item,
                    source,
                    enqueueSource,
                    typeOwnerSource,
                    handler,
                    loadProgram
                })
                : isExactGroupStateRouteOperation(handler, enqueueSource, item)
        )
        : handlers;
    const handoff = operation
        ? undefined
        : operationHandlers
            .map((handler) => findReachableHandoff({ item, source, enqueueSource, handler, matchesMarker }))
            .find((candidate) => candidate !== undefined);
    const routeConnected = operation
        ? operationHandlers.length === 1
        : Boolean(handoff && hasExpectedTypeWhenExplicit(handoff, item.type, matchesMarker));
    const issues: string[] = [];
    if (operation && operationHandlers.length !== 1) {
        issues.push(`${routeKey} operation is not connected to ${item.enqueueMarker}`);
    }
    if (!routeConnected || !hasAuthCommandDiscriminator(typeOwnerSource, item, matchesMarker)) {
        issues.push(
            `${routeKey} registered handler is not connected to ` +
                `${item.enqueueMarker} with AppInboxType.${item.type}`
        );
    }
    if (
        !hasOwnerDispatch({
            program: dispatchSource,
            filePath: item.dispatchSourcePath,
            type: item.type,
            dispatchPath: item.ownerDispatchPath,
            matchesMarker,
            loadProgram
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
    [AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME]: 'consume-agent-ticket'
};

function hasAuthCommandDiscriminator(
    typeOwnerSource: MutationRoutingAstNode,
    item: MutationRouteInventoryEntry,
    matchesMarker: (node: MutationRoutingAstNode, marker: string) => boolean
): boolean {
    const expected = AUTH_COMMAND_KIND_BY_TYPE[item.type];
    if (!expected) {
        return true;
    }
    const publicHandoffs = findFunctionLikes(typeOwnerSource, item.enqueueMarker);
    return (
        publicHandoffs.length === 0 ||
        publicHandoffs.some((method) =>
            findAll(
                method,
                (node) =>
                    node.type === 'CallExpression' &&
                    readMemberName(asNode(node.callee)) === 'reserveAuthIntent'
            ).some((call) => {
                const arguments_ = asNodes(call.arguments);
                const identity = arguments_[0];
                const materializer = arguments_[1];
                return (
                    !!identity &&
                    hasExactObjectProperty(identity, 'type', (value) => matchesMarker(value, `AppInboxType.${item.type}`)) &&
                    !!materializer &&
                    hasReachableAstNode(typeOwnerSource, materializer, (node) =>
                        hasExactObjectProperty(
                            node,
                            'kind',
                            (value) => readStringLiteral(value) === expected
                        ))
                );
            })
        )
    );
}

interface FindRegisteredHandlersInput {
    readonly item: MutationRouteInventoryEntry;
    readonly program: MutationRoutingAstNode;
    readonly containsMarker: (node: MutationRoutingAstNode, marker: string) => boolean;
    readonly matchesMarker: (node: MutationRoutingAstNode, marker: string) => boolean;
}

function findRegisteredHandlers({
    item,
    program,
    containsMarker,
    matchesMarker
}: FindRegisteredHandlersInput): readonly MutationRoutingAstNode[] {
    if (item.transport === 'HTTP') {
        const [method, routePath] = item.entrypoint.split(' ');
        const handler = findExactHttpRouteHandler({
            program,
            method: method.toLowerCase(),
            routePath,
            registrationMarker: item.registrationMarker,
            familyRegistrationMarker: item.familyRegistrationMarker
        });
        return handler ? [handler] : [];
    }
    if (item.transport === 'MAINTENANCE') {
        const named = findFunctionLikes(program, item.registrationMarker);
        return named.length > 0
            ? named
            : findFunctionsContaining(program, item.registrationMarker, containsMarker);
    }
    if (item.transport === 'WS_LIFECYCLE') {
        const registration = findCall(program, 'onWebsocketCallbacksDo', () => true);
        const callbacks = registration &&
            asNodes(registration.arguments).find((node) => node.type === 'ObjectExpression');
        const onClose = callbacks && readObjectCallback(callbacks, 'onClose');
        return onClose ? [onClose] : [];
    }
    const topicRegistration = findCall(program, 'onInboxMessageDo', (call) => containsMarker(call, item.registrationMarker));
    if (topicRegistration) {
        const callbacks = asNodes(topicRegistration.arguments).find(
            (node) => node.type === 'ObjectExpression'
        );
        const onMessage = callbacks && readObjectCallback(callbacks, 'onMessage');
        return onMessage ? [onMessage] : [];
    }
    const install = findCall(program, 'on', () => true);
    const handlerFactory = install && asNodes(install.arguments)[1];
    const handlerName = handlerFactory?.type === 'CallExpression'
        ? readCallName(asNode(handlerFactory.callee))
        : readCallName(handlerFactory);
    const handlers = handlerName ? findFunctionLikes(program, handlerName) : [];
    return handlers.filter((handler) => hasReachableAstNode(program, handler, (node) => matchesMarker(node, item.registrationMarker)));
}

interface FindReachableHandoffInput {
    readonly item: MutationRouteInventoryEntry;
    readonly source: MutationRoutingAstNode;
    readonly enqueueSource: MutationRoutingAstNode;
    readonly handler: MutationRoutingAstNode;
    readonly matchesMarker: (node: MutationRoutingAstNode, marker: string) => boolean;
}

function findReachableHandoff({
    item,
    source,
    enqueueSource,
    handler,
    matchesMarker
}: FindReachableHandoffInput): ReachableHandoff | undefined {
    if (item.sourcePath === item.enqueueSourcePath) {
        return hasReachableAstNode(source, handler, (node) => hasHandoffCall(node, item.enqueueMarker, matchesMarker))
            ? { program: source, root: handler }
            : undefined;
    }
    for (const bridgeName of findFunctionLikeNames(enqueueSource)) {
        const bridgeIsReachable = hasReachableAstNode(source, handler, (node) => {
            if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') {
                return false;
            }
            return readCallName(asNode(node.callee)) === bridgeName;
        });
        if (!bridgeIsReachable) {
            continue;
        }
        for (const target of findFunctionLikes(enqueueSource, bridgeName)) {
            if (
                hasReachableAstNode(enqueueSource, target, (node) => hasHandoffCall(node, item.enqueueMarker, matchesMarker))
            ) {
                return { program: enqueueSource, root: target };
            }
        }
    }
    return undefined;
}

function hasExpectedTypeWhenExplicit(
    handoff: ReachableHandoff,
    expectedType: AppInboxType,
    matchesMarker: (node: MutationRoutingAstNode, marker: string) => boolean
): boolean {
    const hasAnyExplicitType = hasReachableAstNode(
        handoff.program,
        handoff.root,
        (node) => hasExactObjectProperty(node, 'type', (value) => readMemberPath(value).startsWith('AppInboxType.'))
    );
    return (
        !hasAnyExplicitType ||
        hasReachableAstNode(
            handoff.program,
            handoff.root,
            (node) => hasExactObjectProperty(node, 'type', (value) => matchesMarker(value, `AppInboxType.${expectedType}`))
        )
    );
}

function hasExactObjectProperty(
    node: MutationRoutingAstNode,
    name: string,
    matchesValue: (value: MutationRoutingAstNode) => boolean
): boolean {
    if (node.type !== 'ObjectExpression') {
        return false;
    }
    const property = asNodes(node.properties).find(
        (candidate) => candidate.type === 'ObjectProperty' && readName(candidate.key) === name
    );
    const value = property && asNode(property.value);
    return value ? matchesValue(value) : false;
}

function readStringLiteral(node: MutationRoutingAstNode): string | undefined {
    return node.type === 'StringLiteral' && typeof node.value === 'string'
        ? node.value
        : undefined;
}

interface ReachableHandoff {
    readonly program: MutationRoutingAstNode;
    readonly root: MutationRoutingAstNode;
}

interface HasOwnerDispatchInput {
    readonly program: MutationRoutingAstNode;
    readonly filePath: string;
    readonly type: AppInboxType;
    readonly dispatchPath: string;
    readonly matchesMarker: (node: MutationRoutingAstNode, marker: string) => boolean;
    readonly loadProgram: MutationRoutingProgramLoader;
}

function hasOwnerDispatch({
    program,
    filePath,
    type,
    dispatchPath,
    matchesMarker,
    loadProgram
}: HasOwnerDispatchInput): boolean {
    const calls = findAll(
        program,
        (node) => node.type === 'CallExpression' && readMemberName(asNode(node.callee)) === 'onStateMessage'
    );
    return calls.some((call) => {
        const arguments_ = asNodes(call.arguments);
        const typeArgument = arguments_[0];
        const handler = arguments_.at(-1);
        const exactType = matchesMarker(typeArgument ?? call, `AppInboxType.${type}`);
        const loopType = !!typeArgument &&
            hasLiveAppInboxRegistration(program, filePath, call, typeArgument, type, loadProgram);
        if (!handler || (!exactType && !loopType)) {
            return false;
        }
        const roots = handler.type === 'Identifier' ? findFunctionLikes(program, readName(handler)) : [handler];
        return roots.some((root) =>
            hasReachableAstNode(program, root, (node) => {
                const path = readMemberPath(asNode(node.callee));
                return path === dispatchPath;
            })
        );
    });
}

function hasHandoffCall(
    node: MutationRoutingAstNode,
    marker: string,
    matchesMarker: (node: MutationRoutingAstNode, marker: string) => boolean
): boolean {
    if (marker.startsWith('AppInboxType.') || marker.includes('(')) {
        return matchesMarker(node, marker);
    }
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') {
        return false;
    }
    const callee = asNode(node.callee);
    const path = callee ? readMemberPath(callee) : '';
    return path === marker || path.endsWith(`.${marker}`);
}

function findFunctionLikeNames(program: MutationRoutingAstNode): ReadonlySet<string> {
    const names = findAll(program, (node) => functionLikeName(node) !== '')
        .map(functionLikeName)
        .filter(Boolean);
    return new Set(names);
}

function functionLikeName(node: MutationRoutingAstNode): string {
    if (node.type === 'FunctionDeclaration') {
        return readName(node.id);
    }
    if (
        node.type === 'ClassMethod' ||
        node.type === 'ClassPrivateMethod' ||
        node.type === 'ObjectMethod'
    ) {
        return readName(node.key);
    }
    if (node.type !== 'VariableDeclarator' && node.type !== 'ObjectProperty') {
        return '';
    }
    const value = asNode(node.type === 'VariableDeclarator' ? node.init : node.value);
    return value && (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression')
        ? readName(node.type === 'VariableDeclarator' ? node.id : node.key)
        : '';
}

function findFunctionLikes(
    program: MutationRoutingAstNode,
    name: string
): readonly MutationRoutingAstNode[] {
    return findAll(program, (node) => {
        if (node.type === 'FunctionDeclaration') {
            return readName(node.id) === name;
        }
        if (
            node.type === 'ClassMethod' ||
            node.type === 'ClassPrivateMethod' ||
            node.type === 'ObjectMethod'
        ) {
            return readName(node.key) === name;
        }
        if (node.type !== 'VariableDeclarator' && node.type !== 'ObjectProperty') {
            return false;
        }
        const value = asNode(node.type === 'VariableDeclarator' ? node.init : node.value);
        return (
            readName(node.type === 'VariableDeclarator' ? node.id : node.key) === name &&
            !!value &&
            (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression')
        );
    }).map((node) => {
        if (node.type === 'VariableDeclarator') {
            return asNode(node.init)!;
        }
        if (node.type === 'ObjectProperty') {
            return asNode(node.value)!;
        }
        return node;
    });
}

function findFunctionsContaining(
    program: MutationRoutingAstNode,
    marker: string,
    hasMarker: (node: MutationRoutingAstNode, marker: string) => boolean
): readonly MutationRoutingAstNode[] {
    return findAll(program, (node) => isFunction(node) && hasMarker(node, marker));
}

function readObjectCallback(
    object: MutationRoutingAstNode,
    name: string
): MutationRoutingAstNode | undefined {
    const property = asNodes(object.properties).find((candidate) => readName(candidate.key) === name);
    if (!property) {
        return undefined;
    }
    return property.type === 'ObjectMethod' ? property : asNode(property.value);
}

function findCall(
    program: MutationRoutingAstNode,
    name: string,
    predicate: (call: MutationRoutingAstNode) => boolean
): MutationRoutingAstNode | undefined {
    return findAstNode(
        program,
        (node) =>
            node.type === 'CallExpression' &&
            readMemberName(asNode(node.callee)) === name &&
            predicate(node)
    );
}

function findAll(
    value: unknown,
    predicate: (node: MutationRoutingAstNode) => boolean
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
    const object = asNode(node.object);
    const prefix = object ? readMemberPath(object) : '';
    const property = readName(node.property);
    return property ? (prefix ? `${prefix}.${property}` : property) : '';
}

const readCallName = (node: MutationRoutingAstNode | undefined): string => readName(node) || readMemberName(node);

function readMemberName(node: MutationRoutingAstNode | undefined): string {
    return node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression'
        ? readName(node.property)
        : '';
}

function readName(value: unknown): string {
    const node = asNode(value);
    return node && typeof node.name === 'string' ? node.name : '';
}

function isFunction(node: MutationRoutingAstNode): boolean {
    return [
        'FunctionDeclaration',
        'FunctionExpression',
        'ArrowFunctionExpression',
        'ObjectMethod',
        'ClassMethod',
        'ClassPrivateMethod'
    ].includes(node.type);
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
