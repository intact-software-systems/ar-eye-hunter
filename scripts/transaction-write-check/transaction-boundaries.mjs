import { Node, SyntaxKind } from 'ts-morph';

import {
    assignedOutputDeclarations,
    declarationInitializer,
    declarationName,
    expressionIdentifiers,
    functionBody,
    identifierDependsOnDeclarations,
    isExactType,
    isFunctionDeclaration,
    isKnownTransactionType,
    resolveCallableBodies,
    resolveCallTargets,
    resolvedDeclarations,
    sourcePath,
    unwrapExpression,
    unwrapValueExpression
} from './typescript-provenance.mjs';

const IMMEDIATE_CALLBACK_METHODS = new Set([
    'every',
    'filter',
    'find',
    'findIndex',
    'flatMap',
    'forEach',
    'map',
    'reduce',
    'reduceRight',
    'some'
]);
const INDEXED_DB_WRITE_METHODS = new Set(['add', 'clear', 'delete', 'put']);
const INDEXED_DB_READ_METHODS = new Set([
    'count',
    'get',
    'getAll',
    'getAllKeys',
    'getKey',
    'openCursor',
    'openKeyCursor'
]);
const INDEXED_DB_REQUEST_EVENTS = new Set(['error', 'success']);
const TRANSACTION_CONTROL_METHODS = new Set(['begin', 'savepoint', 'transaction']);
const APP_INBOX_TRANSACTION_WRITER_TYPE = /AppInbox(?:Mutation)?TransactionWriter/u;
const APP_INBOX_WRITE_METHOD = 'writeComputedMutation';

const SPECIALIZED_TRANSACTION_OWNERS = new Map([
    [
        'packages/shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts',
        new Set(['transaction'])
    ],
    [
        'packages/shared-server/queuebox/postgres/p-sql-queue-box.ts',
        new Set([
            'reserveEntries',
            'reserveTimeoutEntries',
            'reserveOverdueRetryEntries',
            'reserveRetryExhaustionFinalizations',
            'releaseEntries',
            'enqueue',
            'enqueueIfAbsent'
        ])
    ],
    [
        'packages/shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts',
        new Set([
            'deleteByKey',
            'replace',
            'replacePendingIfMatch',
            'tryWriteIfAbsentOrReplaceExpired',
            'upsert',
            'write',
            'writeIfAbsentOrMatch',
            'writeIfAbsentOrReplaceExpired',
            'writeMaterializedIfAbsentOrReplaceExpired'
        ])
    ],
    [
        'packages/shared-server/queuebox/postgres/resource-inbox-finished-replacement.ts',
        new Set(['replaceFinishedResourceEntryIfMatch'])
    ]
]);

const TRANSACTION_FORWARDING_CALLBACKS = new Map([
    [
        'packages/shared-server/postgres/run-in-p-sql-transaction.ts',
        new Map([['runInPSqlTransaction', new Set(['write'])]])
    ],
    [
        'apps/api-v1/src/db/pglite-sql-adapter.ts',
        new Map([['attachPGliteBegin', new Set(['fn'])]])
    ],
    [
        'packages/shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts',
        new Map([['inTransaction', new Set(['write'])]])
    ],
    [
        'packages/shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts',
        new Map([['begin', new Set(['fn'])]])
    ]
]);

export function appInboxWriteBoundary(call) {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression) || expression.getName() !== APP_INBOX_WRITE_METHOD) {
        return undefined;
    }
    const receiver = expression.getExpression();
    if (!APP_INBOX_TRANSACTION_WRITER_TYPE.test(receiver.getType().getText(receiver))) {
        return undefined;
    }
    return call.getArguments()[2];
}

export function transactionBoundary(call) {
    const expression = call.getExpression();
    if (Node.isIdentifier(expression) && expression.getText() === 'runInPSqlTransaction') {
        const database = call.getArguments()[0];
        const callback = call.getArguments()[1];
        return database && isCallbackReference(callback) && isKnownTransactionType(database)
            ? { kind: 'callback', callback }
            : undefined;
    }
    if (!Node.isPropertyAccessExpression(expression)) {
        return undefined;
    }
    const method = expression.getName();
    if (method === 'transaction') {
        const mode = call.getArguments()[1]?.getText().replaceAll(/["']/gu, '');
        if (mode === 'readonly' && isExactType(expression.getExpression(), 'IDBDatabase')) {
            return { kind: 'readonly' };
        }
        if (mode === 'readwrite' && isExactType(expression.getExpression(), 'IDBDatabase')) {
            return { kind: 'indexed-db' };
        }
        const callback = call.getArguments()[0];
        if (
            isCallbackReference(callback) &&
            (isKnownTransactionType(expression.getExpression()) ||
                isReviewedTransactionBoundaryCall(call) ||
                isResourceInboxTransactionCall(call))
        ) {
            return { kind: 'callback', callback };
        }
        return undefined;
    }
    if (method !== 'begin') {
        return undefined;
    }
    const callback = call.getArguments()[0];
    if (
        !isCallbackReference(callback) ||
        (!isKnownTransactionType(expression.getExpression()) &&
            !isReviewedTransactionBoundaryCall(call) &&
            !isResourceInboxTransactionCall(call))
    ) {
        return undefined;
    }
    return { kind: 'callback', callback };
}

function isReviewedTransactionBoundaryCall(call) {
    const expression = call.getExpression();
    const symbol = Node.isPropertyAccessExpression(expression)
        ? expression.getNameNode().getSymbol()
        : expression.getSymbol();
    const resolved = symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol;
    return (resolved?.getDeclarations() ?? []).some((declaration) => {
        const owners = TRANSACTION_FORWARDING_CALLBACKS.get(sourcePath(declaration.getSourceFile()));
        const owner = isFunctionDeclaration(declaration)
            ? declaration
            : declaration.getFirstAncestor(isFunctionDeclaration);
        return owners !== undefined && owner !== undefined && owners.has(declarationName(owner));
    });
}

export function indexedDbRequestCallbacks(node, project) {
    if (node.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) {
        return [];
    }
    const left = node.getLeft();
    if (
        !Node.isPropertyAccessExpression(left) ||
        !['onerror', 'onsuccess'].includes(left.getName()) ||
        !isExactType(left.getExpression(), 'IDBRequest')
    ) {
        return [];
    }
    return resolveCallableBodies(node.getRight(), project);
}

export function indexedDbRequestListenerCallbacks(call, project) {
    const expression = call.getExpression();
    if (
        !Node.isPropertyAccessExpression(expression) ||
        expression.getName() !== 'addEventListener' ||
        !isExactType(expression.getExpression(), 'IDBRequest')
    ) {
        return [];
    }
    const event = call.getArguments()[0];
    if (!Node.isStringLiteral(event) || !INDEXED_DB_REQUEST_EVENTS.has(event.getLiteralText())) {
        return [];
    }
    return resolveCallableBodies(call.getArguments()[1], project);
}

export function indexedDbUpgradeListener(call) {
    const expression = call.getExpression();
    if (
        !Node.isPropertyAccessExpression(expression) ||
        expression.getName() !== 'addEventListener' ||
        !isExactType(expression.getExpression(), 'IDBOpenDBRequest')
    ) {
        return undefined;
    }
    const event = call.getArguments()[0];
    return Node.isStringLiteral(event) && event.getLiteralText() === 'upgradeneeded'
        ? call.getArguments()[1]
        : undefined;
}

export function indexedDbTransactionAnalysisEnd(owner, transactionCall, project) {
    const transactionDeclarations = assignedOutputDeclarations(transactionCall);
    if (transactionDeclarations.length === 0) {
        return owner.getEnd();
    }
    const completion = owner.getDescendantsOfKind(SyntaxKind.AwaitExpression)
        .filter((awaitExpression) =>
            awaitExpression.getStart() > transactionCall.getEnd() &&
            awaitExpression.getFirstAncestor(isFunctionDeclaration) === owner
        )
        .find((awaitExpression) =>
            expressionWaitsForIndexedDbCompletion({
                expression: awaitExpression.getExpression(),
                transactionDeclarations,
                project,
                visited: new Set()
            })
        );
    return completion?.getEnd() ?? owner.getEnd();
}

function expressionWaitsForIndexedDbCompletion(input) {
    const { expression, transactionDeclarations, project, visited } = input;
    const value = unwrapValueExpression(expression);
    if (Node.isIdentifier(value)) {
        return resolvedDeclarations(value).some((declaration) => {
            if (visited.has(declaration)) {
                return false;
            }
            visited.add(declaration);
            const initializer = declarationInitializer(declaration);
            return initializer !== undefined && expressionWaitsForIndexedDbCompletion({
                expression: initializer,
                transactionDeclarations,
                project,
                visited
            });
        });
    }
    return Node.isCallExpression(value) &&
        callRegistersIndexedDbCompletion(value, transactionDeclarations, project);
}

function callRegistersIndexedDbCompletion(call, transactionDeclarations, project) {
    const transactionIndexes = call.getArguments().flatMap((argument, index) =>
        expressionIdentifiers(argument).some((identifier) =>
                identifierDependsOnDeclarations(identifier, transactionDeclarations, new Set())
            )
            ? [index]
            : []
    );
    if (transactionIndexes.length === 0) {
        return false;
    }
    return resolveCallTargets(call, project).bodies.some((callable) => {
        const transactionParameters = transactionIndexes
            .map((index) => callable.getParameters()[index])
            .filter((parameter) => parameter !== undefined);
        return callable.getDescendantsOfKind(SyntaxKind.BinaryExpression).some((assignment) => {
            if (assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) {
                return false;
            }
            const left = assignment.getLeft();
            if (!Node.isPropertyAccessExpression(left) || left.getName() !== 'oncomplete') {
                return false;
            }
            return expressionIdentifiers(left.getExpression()).some((identifier) =>
                identifierDependsOnDeclarations(identifier, transactionParameters, new Set())
            );
        });
    });
}

export function transactionExecutedCallbackArguments(call) {
    const callbacks = call.getArguments().filter((argument) =>
        isCallbackReference(argument) && !isTransactionArgument(argument)
    );
    const expression = call.getExpression();
    if (
        Node.isPropertyAccessExpression(expression) &&
        IMMEDIATE_CALLBACK_METHODS.has(expression.getName())
    ) {
        return callbacks;
    }
    return call.getArguments().some(isTransactionArgument) ? callbacks : [];
}

export function isTransactionWriteDeclaration(declaration) {
    const name = declarationName(declaration);
    if (!/^(?:write|commit|insert|update|delete|remove|put|finish)/u.test(name)) {
        return false;
    }
    return declaration.getParameters().some((parameter) => {
        const typeNode = parameter.getTypeNode();
        return /^(?:transaction|tx|sql)$/iu.test(parameter.getName()) &&
            (typeNode === undefined || !Node.isFunctionTypeNode(typeNode)) &&
            isKnownTransactionType(parameter);
    });
}

export function isCallbackReference(node) {
    return node !== undefined && (
        Node.isArrowFunction(node) ||
        Node.isFunctionExpression(node) ||
        node.getType().getCallSignatures().length > 0
    );
}

export function isSpecializedTransactionBoundary(call) {
    const allowedOwners = SPECIALIZED_TRANSACTION_OWNERS.get(sourcePath(call.getSourceFile()));
    if (!allowedOwners) {
        return false;
    }
    const owner = namedContainingFunction(call);
    return owner !== undefined && allowedOwners.has(declarationName(owner));
}

function isResourceInboxTransactionCall(call) {
    return SPECIALIZED_TRANSACTION_OWNERS.has(sourcePath(call.getSourceFile()));
}

export function isSpecializedTransactionImplementation(callable) {
    const allowedOwners = SPECIALIZED_TRANSACTION_OWNERS.get(sourcePath(callable.getSourceFile()));
    const owner = declarationName(callable).length > 0 ? callable : namedContainingFunction(callable);
    return allowedOwners !== undefined && owner !== undefined && allowedOwners.has(declarationName(owner));
}

export function isUnresolvedCallableParameterInvocation(call) {
    return callableParameterDeclarations(call.getExpression()).some((declaration) =>
        !isPromiseSettlementParameter(declaration) &&
        !isReviewedTransactionForwardingCallback(call, declaration.getName())
    );
}

export function isReviewedCallableParameterInvocation(call) {
    const declarations = callableParameterDeclarations(call.getExpression());
    return declarations.length > 0 && declarations.every((declaration) =>
        isPromiseSettlementParameter(declaration) ||
        isReviewedTransactionForwardingCallback(call, declaration.getName())
    );
}

export function isReviewedTransactionForwardingReference(call, callback) {
    const declarations = callableParameterDeclarations(callback);
    return declarations.length > 0 &&
        declarations.every((declaration) => isReviewedTransactionForwardingCallback(call, declaration.getName()));
}

function callableParameterDeclarations(expression) {
    const unwrapped = unwrapExpression(expression);
    if (!Node.isIdentifier(unwrapped)) {
        return [];
    }
    return resolvedDeclarations(unwrapped).filter(
        (declaration) =>
            Node.isParameterDeclaration(declaration) &&
            declaration.getType().getCallSignatures().length > 0
    );
}

export function isDirectTransactionOperation(call) {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) {
        return false;
    }
    const receiver = expression.getExpression();
    if (isKnownTransactionType(receiver)) {
        return true;
    }
    return Node.isIdentifier(receiver) && resolvedDeclarations(receiver).some(
        (declaration) => Node.isParameterDeclaration(declaration) && isTransactionParameter(declaration)
    );
}

export function isDirectDatabaseResultCall(call) {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) {
        return false;
    }
    const receiver = expression.getExpression();
    if (isExactType(receiver, 'IDBObjectStore')) {
        return INDEXED_DB_READ_METHODS.has(expression.getName());
    }
    return isDirectTransactionOperation(call) &&
        !isExactType(receiver, 'IDBTransaction') &&
        !TRANSACTION_CONTROL_METHODS.has(expression.getName());
}

export function isPersistedWriteOperation(call) {
    if (isDirectTransactionOperation(call)) {
        const expression = call.getExpression();
        return !TRANSACTION_CONTROL_METHODS.has(expression.getName());
    }
    const expression = call.getExpression();
    return Node.isPropertyAccessExpression(expression) &&
        INDEXED_DB_WRITE_METHODS.has(expression.getName()) &&
        isExactType(expression.getExpression(), 'IDBObjectStore');
}

export function isTransactionArgument(argument) {
    if (isKnownTransactionType(argument)) {
        return true;
    }
    return Node.isIdentifier(argument) && resolvedDeclarations(argument).some(
        (declaration) => Node.isParameterDeclaration(declaration) && isTransactionParameter(declaration)
    );
}

export function isTransactionParameter(parameter) {
    if (isKnownTransactionType(parameter)) {
        return true;
    }
    const owner = parameter.getFirstAncestor(isFunctionDeclaration);
    if (!owner || owner.getParameters()[0] !== parameter) {
        return false;
    }
    const parent = owner.getParent();
    if (!Node.isCallExpression(parent)) {
        return false;
    }
    const boundary = transactionBoundary(parent);
    return boundary?.kind === 'callback' && unwrapExpression(boundary.callback) === owner;
}

function isPromiseSettlementParameter(parameter) {
    const owner = parameter.getFirstAncestor(isFunctionDeclaration);
    if (!owner) {
        return false;
    }
    const creation = owner.getParent();
    return Node.isNewExpression(creation) && creation.getExpression().getText() === 'Promise';
}

function isReviewedTransactionForwardingCallback(call, parameterName) {
    const owners = TRANSACTION_FORWARDING_CALLBACKS.get(sourcePath(call.getSourceFile()));
    const owner = namedContainingFunction(call);
    if (!owners || !owner) {
        return false;
    }
    return owners.get(declarationName(owner))?.has(parameterName) ?? false;
}

function namedContainingFunction(node) {
    return node.getAncestors().find((ancestor) =>
        isFunctionDeclaration(ancestor) && declarationName(ancestor).length > 0
    );
}

export function isUpgradeCallbackAssignment(assignment) {
    if (assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) {
        return false;
    }
    const left = assignment.getLeft();
    return Node.isPropertyAccessExpression(left) &&
        left.getName() === 'onupgradeneeded' &&
        isExactType(left.getExpression(), 'IDBOpenDBRequest');
}
