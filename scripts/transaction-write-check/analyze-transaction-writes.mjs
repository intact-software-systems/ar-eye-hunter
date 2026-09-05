import { Node, SyntaxKind } from 'ts-morph';

const PRECOMPUTABLE_CALLS = new Set([
    'Date.now',
    'JSON.parse',
    'JSON.stringify',
    'Math.random',
    'crypto.getRandomValues',
    'crypto.randomUUID',
    'crypto.subtle.digest',
    'structuredClone'
]);

const PRECOMPUTABLE_METHODS = new Set(['sort', 'toSorted']);
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
const TRANSACTION_TYPE_NAMES = ['PSqlSql', 'IDBTransaction'];
const DATABASE_RECEIVER_TYPE = /(?:Sql|Database|Repository|Runtime|PGlite)/u;
const INDEXED_DB_WRITE_METHODS = new Set(['add', 'clear', 'delete', 'put']);
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
            'enqueueIf',
            'enqueueOrUpdate',
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
    ],
    [
        'packages/shared-server/queuebox/postgres/resource-inbox-results-repository.ts',
        new Set(['begin'])
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

export function analyzeTransactionWrites(project, sourceFiles = project.getSourceFiles()) {
    const findings = new Map();
    const roots = [];

    for (const sourceFile of sourceFiles) {
        const path = sourcePath(sourceFile);
        if (!isAnalyzedSource(path)) {
            continue;
        }
        for (const declaration of sourceFile.getDescendants().filter(isFunctionDeclaration)) {
            if (isTransactionWriteDeclaration(declaration)) {
                roots.push(analysisRoot(declaration));
            }
        }
        for (const assignment of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
            if (isUpgradeCallbackAssignment(assignment)) {
                const callback = assignment.getRight();
                if (Node.isArrowFunction(callback) || Node.isFunctionExpression(callback)) {
                    roots.push(analysisRoot(callback));
                }
            }
        }
        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const appInboxCallback = appInboxWriteBoundary(call);
            if (appInboxCallback) {
                addCallbackRoots({ callback: appInboxCallback, call, roots, findings, project });
            }
            const boundary = transactionBoundary(call);
            if (!boundary) {
                continue;
            }
            reportTransactionLoop(call, findings);
            if (boundary.kind === 'readonly' || isSpecializedTransactionBoundary(call)) {
                continue;
            }
            if (boundary.kind === 'indexed-db') {
                const owner = call.getFirstAncestor(isFunctionDeclaration);
                if (owner) {
                    roots.push(analysisRoot(owner, call.getEnd(), call));
                }
                continue;
            }
            addCallbackRoots({ callback: boundary.callback, call, roots, findings, project });
        }
    }

    const visited = new Set();
    for (const root of roots) {
        analyzeBody({
            root: root.node,
            start: root.start,
            findings,
            visited,
            boundary: root.boundary,
            project
        });
    }
    return [...findings.values()].sort(compareFindings);
}

function addCallbackRoots(input) {
    const { callback, call, roots, findings, project } = input;
    const callbacks = resolveCallableBodies(callback, project);
    if (
        isCallbackReference(callback) &&
        callbacks.length === 0 &&
        !isReviewedTransactionForwardingReference(call, callback)
    ) {
        addFinding({
            findings,
            node: callback,
            rule: 'transaction.unresolved-provenance',
            operation: nodeOperation(callback),
            boundary: call
        });
    }
    for (const resolvedCallback of callbacks) {
        roots.push(analysisRoot(resolvedCallback, resolvedCallback.getStart(), call));
    }
}

function analyzeBody(input) {
    const { root, start, findings, visited, boundary, project } = input;
    const callables = [analysisRoot(root, start)];
    for (let index = 0; index < callables.length; index += 1) {
        const callable = callables[index];
        const body = functionBody(callable.node);
        if (!body) {
            continue;
        }
        const identity = [
            body.getSourceFile().getFilePath(),
            body.getStart(),
            callable.start,
            boundaryLabel(boundary)
        ].join(':');
        if (visited.has(identity)) {
            continue;
        }
        visited.add(identity);

        analyzeCallableBody({
            root: callable.node,
            body,
            start: callable.start,
            findings,
            boundary,
            project,
            callables
        });
    }
}

function analyzeCallableBody(input) {
    const { root, body, start, findings, boundary, project, callables } = input;
    analyzeExecutionNode({ root, node: body, start, findings, boundary, project, callables });
    body.forEachDescendant((node, traversal) => {
        if (isFunctionDeclaration(node)) {
            traversal.skip();
            return;
        }
        analyzeExecutionNode({ root, node, start, findings, boundary, project, callables });
    });
}

function analyzeExecutionNode(input) {
    const { root, node, start, findings, boundary, project, callables } = input;
    if (node.getStart() < start) {
        return;
    }
    if (Node.isNewExpression(node)) {
        const operation = node.getExpression().getText();
        if (operation === 'Date' || operation === 'TextEncoder') {
            addFinding({
                findings,
                node,
                rule: 'transaction.precomputable-work',
                operation,
                boundary
            });
        }
        return;
    }
    if (!Node.isCallExpression(node)) {
        return;
    }

    analyzeCall({ root, call: node, findings, boundary, project, callables });
}

function analyzeCall(input) {
    const { root, call, findings, boundary, project, callables } = input;
    const operation = callOperation(call);
    reportProhibitedCall({ root, call, findings, boundary, project, operation });
    followCallTarget({ call, findings, boundary, project, callables, operation });
    followTransactionCallbacks({ call, findings, boundary, project, callables, operation });
}

function reportProhibitedCall(input) {
    const { root, call, findings, boundary, project, operation } = input;
    const precomputable = precomputableOperation(call, operation);
    if (precomputable) {
        addFinding({
            findings,
            node: call,
            rule: 'transaction.precomputable-work',
            operation: precomputable,
            boundary
        });
    }
    else if (hasParameterOnlyPersistedValueTransformation(call, root)) {
        addFinding({
            findings,
            node: call,
            rule: 'transaction.precomputable-work',
            operation: `${operation} argument`,
            boundary
        });
    }
    else if (isPersistedAuthoredHelperResult(call, root, project)) {
        addFinding({
            findings,
            node: call,
            rule: 'transaction.precomputable-work',
            operation,
            boundary
        });
    }
}

function followCallTarget(input) {
    const { call, findings, boundary, project, callables, operation } = input;
    if (isReviewedCallableParameterInvocation(call)) {
        return;
    }
    if (isUnresolvedCallableParameterInvocation(call)) {
        addFinding({
            findings,
            node: call,
            rule: 'transaction.unresolved-provenance',
            operation,
            boundary
        });
        return;
    }
    const targets = resolveCallTargets(call, project);
    for (const callable of targets.bodies) {
        callables.push(analysisRoot(callable));
    }
    if (targets.unresolved && !isDirectTransactionOperation(call)) {
        addFinding({
            findings,
            node: call,
            rule: 'transaction.unresolved-provenance',
            operation,
            boundary
        });
    }
}

function followTransactionCallbacks(input) {
    const { call, findings, boundary, project, callables, operation } = input;
    for (const callback of transactionExecutedCallbackArguments(call)) {
        const callbackBodies = resolveCallableBodies(callback, project);
        if (callbackBodies.length === 0) {
            addFinding({
                findings,
                node: callback,
                rule: 'transaction.unresolved-provenance',
                operation: nodeOperation(callback),
                boundary
            });
            continue;
        }
        for (const callbackBody of callbackBodies) {
            callables.push(analysisRoot(callbackBody));
        }
    }
}

function transactionExecutedCallbackArguments(call) {
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

function hasParameterOnlyPersistedValueTransformation(call, root) {
    if (!isPersistedWriteOperation(call)) {
        return false;
    }
    return call.getArguments().some((argument) => {
        const persistedValue = resolveConstructedPersistedValue(argument);
        return persistedValue !== undefined &&
            referencesPreTransactionInput(persistedValue, root) &&
            !referencesDirectDatabaseResult(persistedValue, root);
    });
}

function isConstructedPersistedValue(argument) {
    return Node.isObjectLiteralExpression(argument) ||
        Node.isArrayLiteralExpression(argument) ||
        Node.isBinaryExpression(argument) ||
        Node.isConditionalExpression(argument) ||
        Node.isTemplateExpression(argument);
}

function resolveConstructedPersistedValue(expression, visited = new Set()) {
    if (isConstructedPersistedValue(expression)) {
        return expression;
    }
    if (!Node.isIdentifier(expression)) {
        return undefined;
    }
    for (const declaration of resolvedDeclarations(expression)) {
        if (!Node.isVariableDeclaration(declaration) || visited.has(declaration)) {
            continue;
        }
        visited.add(declaration);
        const initializer = declaration.getInitializer();
        if (!initializer) {
            continue;
        }
        const resolved = resolveConstructedPersistedValue(initializer, visited);
        if (resolved) {
            return resolved;
        }
    }
    return undefined;
}

function referencesPreTransactionInput(expression, root) {
    return referencesPreTransactionInputThroughDeclarations(expression, root, new Set());
}

function referencesPreTransactionInputThroughDeclarations(expression, root, visited) {
    return expressionIdentifiers(expression).some((identifier) =>
        resolvedDeclarations(identifier).some((declaration) => {
            if (visited.has(declaration)) {
                return false;
            }
            visited.add(declaration);
            if (Node.isParameterDeclaration(declaration)) {
                const owner = declaration.getFirstAncestor(isFunctionDeclaration);
                return owner !== root || !isTransactionParameter(declaration);
            }
            if (!Node.isVariableDeclaration(declaration)) {
                return false;
            }
            if (declaration.getFirstAncestor(isFunctionDeclaration) !== root) {
                return true;
            }
            const initializer = declaration.getInitializer();
            if (initializer) {
                return referencesPreTransactionInputThroughDeclarations(initializer, root, visited);
            }
            const forOf = declaration.getFirstAncestorByKind(SyntaxKind.ForOfStatement);
            return forOf !== undefined &&
                referencesPreTransactionInputThroughDeclarations(forOf.getExpression(), root, visited);
        })
    );
}

function referencesDirectDatabaseResult(expression, root) {
    return expressionIdentifiers(expression).some((identifier) => {
        return resolvedDeclarations(identifier).some((declaration) => {
            if (
                !Node.isVariableDeclaration(declaration) ||
                declaration.getFirstAncestor(isFunctionDeclaration) !== root
            ) {
                return false;
            }
            const initializer = declaration.getInitializer();
            if (!initializer) {
                return false;
            }
            const calls = [
                ...(Node.isCallExpression(initializer) ? [initializer] : []),
                ...initializer.getDescendantsOfKind(SyntaxKind.CallExpression)
            ];
            return calls.some(isDirectDatabaseResultCall);
        });
    });
}

function isPersistedAuthoredHelperResult(call, root, project) {
    const targets = resolveCallTargets(call, project);
    if (
        isPersistedWriteOperation(call) ||
        targets.bodies.length === 0 ||
        callableClosureContainsExplicitPrecomputableWork(targets.bodies, project) ||
        call.getArguments().some((argument) => referencesDirectDatabaseResult(argument, root))
    ) {
        return false;
    }
    if (isWithinPersistedWriteArgument(call)) {
        return true;
    }
    const declaration = initializedVariableDeclaration(call);
    return declaration !== undefined &&
        root.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) =>
            identifier.getStart() > declaration.getStart() &&
            resolvedDeclarations(identifier).includes(declaration) &&
            isWithinPersistedWriteArgument(identifier)
        );
}

function callableClosureContainsExplicitPrecomputableWork(callables, project, visited = new Set()) {
    for (const callable of callables) {
        const identity = `${callable.getSourceFile().getFilePath()}:${callable.getStart()}`;
        if (visited.has(identity)) {
            continue;
        }
        visited.add(identity);
        const body = functionBody(callable);
        if (!body) {
            continue;
        }
        for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            if (call.getFirstAncestor(isFunctionDeclaration) !== callable) {
                continue;
            }
            if (precomputableOperation(call, callOperation(call))) {
                return true;
            }
            const targets = resolveCallTargets(call, project);
            if (callableClosureContainsExplicitPrecomputableWork(targets.bodies, project, visited)) {
                return true;
            }
            const callbacks = transactionExecutedCallbackArguments(call)
                .flatMap((callback) => resolveCallableBodies(callback, project));
            if (callableClosureContainsExplicitPrecomputableWork(callbacks, project, visited)) {
                return true;
            }
        }
    }
    return false;
}

function initializedVariableDeclaration(expression) {
    let current = expression;
    while (current.getParent() && isTransparentExpression(current.getParent())) {
        current = current.getParent();
    }
    const parent = current.getParent();
    return Node.isVariableDeclaration(parent) && parent.getInitializer() === current
        ? parent
        : undefined;
}

function isTransparentExpression(node) {
    return Node.isAsExpression(node) ||
        Node.isAwaitExpression(node) ||
        Node.isNonNullExpression(node) ||
        Node.isParenthesizedExpression(node) ||
        Node.isSatisfiesExpression(node) ||
        Node.isTypeAssertion(node);
}

function isWithinPersistedWriteArgument(node) {
    return node.getAncestors().some((ancestor) =>
        Node.isCallExpression(ancestor) &&
        isPersistedWriteOperation(ancestor) &&
        ancestor.getArguments().some((argument) =>
            argument.getStart() <= node.getStart() && argument.getEnd() >= node.getEnd()
        )
    );
}

function resolvedDeclarations(identifier) {
    const symbol = identifier.getSymbol();
    const resolved = symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol;
    return resolved?.getDeclarations() ?? [];
}

function expressionIdentifiers(expression) {
    return [
        ...(Node.isIdentifier(expression) ? [expression] : []),
        ...expression.getDescendantsOfKind(SyntaxKind.Identifier)
    ];
}

function isTransactionParameter(parameter) {
    if (isKnownTransactionType(parameter)) {
        return true;
    }
    if (
        /^(?:transaction|tx|sql)$/iu.test(parameter.getName()) &&
        hasDatabaseReceiverType(parameter)
    ) {
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

function hasDatabaseReceiverType(node) {
    const type = node.getType();
    const candidate = type.getAliasSymbol() ?? type.getSymbol();
    const symbol = candidate?.isAlias() ? candidate.getAliasedSymbol() : candidate;
    return symbol !== undefined && DATABASE_RECEIVER_TYPE.test(symbol.getName());
}

function analysisRoot(node, start = node.getStart(), boundary = node) {
    return { node, start, boundary };
}

function precomputableOperation(call, operation) {
    if (PRECOMPUTABLE_CALLS.has(operation) || operation.startsWith('Temporal.Now.')) {
        return operation;
    }
    const expression = call.getExpression();
    const name = Node.isPropertyAccessExpression(expression)
        ? expression.getName()
        : Node.isIdentifier(expression)
        ? expression.getText()
        : '';
    if (PRECOMPUTABLE_METHODS.has(name)) {
        return name;
    }
    if (
        name === 'encode' &&
        Node.isPropertyAccessExpression(expression) &&
        Node.isNewExpression(expression.getExpression()) &&
        expression.getExpression().getExpression().getText() === 'TextEncoder'
    ) {
        return undefined;
    }
    return undefined;
}

function appInboxWriteBoundary(call) {
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

function transactionBoundary(call) {
    const expression = call.getExpression();
    if (Node.isIdentifier(expression) && expression.getText() === 'runInPSqlTransaction') {
        const database = call.getArguments()[0];
        const callback = call.getArguments()[1];
        return database && isCallbackReference(callback) && looksLikeDatabaseReceiver(database)
            ? { kind: 'callback', callback }
            : undefined;
    }
    if (!Node.isPropertyAccessExpression(expression)) {
        return undefined;
    }
    const method = expression.getName();
    if (method === 'transaction') {
        const mode = call.getArguments()[1]?.getText().replaceAll(/["']/gu, '');
        if (mode === 'readonly') {
            return { kind: 'readonly' };
        }
        if (mode === 'readwrite') {
            return { kind: 'indexed-db' };
        }
        const callback = call.getArguments()[0];
        if (isCallbackReference(callback) && looksLikeDatabaseReceiver(expression.getExpression())) {
            return { kind: 'callback', callback };
        }
        return undefined;
    }
    if (method !== 'begin') {
        return undefined;
    }
    const callback = call.getArguments()[0];
    if (!isCallbackReference(callback) || !looksLikeDatabaseReceiver(expression.getExpression())) {
        return undefined;
    }
    return { kind: 'callback', callback };
}

function looksLikeDatabaseReceiver(receiver) {
    const typeText = receiver.getType().getText(receiver);
    if (DATABASE_RECEIVER_TYPE.test(typeText)) {
        return true;
    }
    const name = receiver.getText();
    return /(?:database|repository|runtime|sql|pglite)/iu.test(name);
}

function reportTransactionLoop(call, findings) {
    const loop = call.getFirstAncestor((ancestor) =>
        Node.isForStatement(ancestor) ||
        Node.isForOfStatement(ancestor) ||
        Node.isWhileStatement(ancestor) ||
        Node.isDoStatement(ancestor)
    );
    if (loop && (!Node.isForOfStatement(loop) || isRetryShapedForOfTransaction(call, loop))) {
        addFinding({
            findings,
            node: call,
            rule: 'transaction.inner-retry',
            operation: callOperation(call),
            boundary: call
        });
    }
}

function isRetryShapedForOfTransaction(call, loop) {
    const initializer = loop.getInitializer();
    if (!Node.isVariableDeclarationList(initializer)) {
        return true;
    }
    const declarations = initializer.getDeclarations();
    if (declarations.some((declaration) => /(?:attempt|retries?|retry)/iu.test(declaration.getName()))) {
        return true;
    }
    return !call.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) =>
        resolvedDeclarations(identifier).some((declaration) => declarations.includes(declaration))
    );
}

function isTransactionWriteDeclaration(declaration) {
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

function isCallbackReference(node) {
    return node !== undefined && (
        Node.isArrowFunction(node) ||
        Node.isFunctionExpression(node) ||
        node.getType().getCallSignatures().length > 0
    );
}

function isSpecializedTransactionBoundary(call) {
    const allowedOwners = SPECIALIZED_TRANSACTION_OWNERS.get(sourcePath(call.getSourceFile()));
    if (!allowedOwners) {
        return false;
    }
    const owner = namedContainingFunction(call);
    return owner !== undefined && allowedOwners.has(declarationName(owner));
}

function isUnresolvedCallableParameterInvocation(call) {
    return callableParameterDeclarations(call.getExpression()).some((declaration) =>
        !isPromiseSettlementParameter(declaration) &&
        !isReviewedTransactionForwardingCallback(call, declaration.getName())
    );
}

function isReviewedCallableParameterInvocation(call) {
    const declarations = callableParameterDeclarations(call.getExpression());
    return declarations.length > 0 && declarations.every((declaration) =>
        isPromiseSettlementParameter(declaration) ||
        isReviewedTransactionForwardingCallback(call, declaration.getName())
    );
}

function isReviewedTransactionForwardingReference(call, callback) {
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

function unwrapExpression(expression) {
    if (
        Node.isAsExpression(expression) ||
        Node.isNonNullExpression(expression) ||
        Node.isParenthesizedExpression(expression) ||
        Node.isSatisfiesExpression(expression) ||
        Node.isTypeAssertion(expression)
    ) {
        return unwrapExpression(expression.getExpression());
    }
    return expression;
}

function resolveCallTargets(call, project) {
    const expression = call.getExpression();
    const immediate = unwrapExpression(expression);
    if (Node.isArrowFunction(immediate) || Node.isFunctionExpression(immediate)) {
        return { bodies: [immediate], unresolved: false };
    }
    const symbol = Node.isPropertyAccessExpression(expression)
        ? expression.getNameNode().getSymbol()
        : expression.getSymbol();
    const resolved = symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol;
    const bodies = [];
    let hasAuthoredDeclaration = false;
    let hasExternalDeclaration = false;
    for (const declaration of resolved?.getDeclarations() ?? []) {
        const sourceFile = declaration.getSourceFile();
        const source = sourcePath(sourceFile);
        if (!isAuthoredSource(source) || !project.getSourceFile(sourceFile.getFilePath())) {
            if (!isTypeScriptStandardLibraryDeclaration(sourceFile)) {
                hasExternalDeclaration = true;
            }
            continue;
        }
        hasAuthoredDeclaration = true;
        if (isFunctionDeclaration(declaration) && functionBody(declaration)) {
            bodies.push(declaration);
            continue;
        }
        if (
            Node.isVariableDeclaration(declaration) ||
            Node.isPropertyAssignment(declaration) ||
            Node.isPropertyDeclaration(declaration)
        ) {
            const initializer = declaration.getInitializer();
            if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
                bodies.push(initializer);
            }
        }
    }
    return {
        bodies,
        unresolved: bodies.length === 0 && (
            resolved === undefined || hasAuthoredDeclaration || hasExternalDeclaration
        )
    };
}

function isTypeScriptStandardLibraryDeclaration(sourceFile) {
    const path = sourceFile.getFilePath().replaceAll('\\', '/');
    return /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/u.test(path);
}

function isDirectTransactionOperation(call) {
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

function isDirectDatabaseResultCall(call) {
    if (!isDirectTransactionOperation(call)) {
        return false;
    }
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) {
        return false;
    }
    return !isExactType(expression.getExpression(), 'IDBTransaction');
}

function isPersistedWriteOperation(call) {
    if (isDirectTransactionOperation(call)) {
        const expression = call.getExpression();
        return !Node.isPropertyAccessExpression(expression) ||
            !TRANSACTION_CONTROL_METHODS.has(expression.getName());
    }
    const expression = call.getExpression();
    return Node.isPropertyAccessExpression(expression) &&
        INDEXED_DB_WRITE_METHODS.has(expression.getName()) &&
        isExactType(expression.getExpression(), 'IDBObjectStore');
}

function isKnownTransactionType(node) {
    return TRANSACTION_TYPE_NAMES.some((name) => isExactType(node, name));
}

function isExactType(node, expectedName, visited = new Set()) {
    const type = node.getType();
    for (const candidate of [type.getAliasSymbol(), type.getSymbol()]) {
        const symbol = candidate?.isAlias() ? candidate.getAliasedSymbol() : candidate;
        if (!symbol || visited.has(symbol)) {
            continue;
        }
        if (symbol.getName() === expectedName) {
            return true;
        }
        visited.add(symbol);
        for (const declaration of symbol.getDeclarations()) {
            if (
                Node.isTypeAliasDeclaration(declaration) &&
                declaration.getTypeNode() &&
                isExactType(declaration.getTypeNode(), expectedName, visited)
            ) {
                return true;
            }
        }
    }
    const typeText = type.getText(node);
    return new RegExp(`^(?:import\\("[^"]+"\\)\\.)?${expectedName}$`, 'u').test(typeText);
}

function isTransactionArgument(argument) {
    if (isKnownTransactionType(argument)) {
        return true;
    }
    return Node.isIdentifier(argument) && resolvedDeclarations(argument).some(
        (declaration) => Node.isParameterDeclaration(declaration) && isTransactionParameter(declaration)
    );
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

function isUpgradeCallbackAssignment(assignment) {
    if (assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) {
        return false;
    }
    const left = assignment.getLeft();
    return Node.isPropertyAccessExpression(left) && left.getName() === 'onupgradeneeded';
}

function resolveCallableBodies(node, project, visitedSymbols = new Set()) {
    if (!node) {
        return [];
    }
    if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
        return [node];
    }
    if (
        Node.isAsExpression(node) ||
        Node.isNonNullExpression(node) ||
        Node.isParenthesizedExpression(node) ||
        Node.isSatisfiesExpression(node) ||
        Node.isTypeAssertion(node)
    ) {
        return resolveCallableBodies(node.getExpression(), project, visitedSymbols);
    }
    return resolveDeclarations(node.getSymbol(), project, visitedSymbols);
}

function resolveDeclarations(symbol, project, visitedSymbols) {
    if (!symbol) {
        return [];
    }
    const resolved = symbol.isAlias() ? symbol.getAliasedSymbol() : symbol;
    if (!resolved || visitedSymbols.has(resolved)) {
        return [];
    }
    visitedSymbols.add(resolved);

    const bodies = [];
    for (const declaration of resolved.getDeclarations()) {
        const source = sourcePath(declaration.getSourceFile());
        if (!isAnalyzedSource(source) || !project.getSourceFile(declaration.getSourceFile().getFilePath())) {
            continue;
        }
        if (isFunctionDeclaration(declaration) && functionBody(declaration)) {
            bodies.push(declaration);
            continue;
        }
        if (
            Node.isVariableDeclaration(declaration) ||
            Node.isPropertyAssignment(declaration) ||
            Node.isPropertyDeclaration(declaration)
        ) {
            const initializer = declaration.getInitializer();
            if (initializer) {
                bodies.push(...resolveCallableBodies(initializer, project, visitedSymbols));
            }
        }
    }
    return bodies;
}

function isFunctionDeclaration(node) {
    return Node.isFunctionDeclaration(node) ||
        Node.isMethodDeclaration(node) ||
        Node.isArrowFunction(node) ||
        Node.isFunctionExpression(node);
}

function functionBody(node) {
    return typeof node.getBody === 'function' ? node.getBody() : undefined;
}

function declarationName(declaration) {
    if (Node.isFunctionDeclaration(declaration) || Node.isMethodDeclaration(declaration)) {
        return declaration.getName() ?? '';
    }
    const parent = declaration.getParent();
    return Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent)
        ? parent.getName()
        : '';
}

function callOperation(call) {
    return nodeOperation(call.getExpression());
}

function nodeOperation(node) {
    return node.getText().replaceAll(/\s+/gu, ' ');
}

function addFinding(input) {
    const { findings, node, rule, operation, boundary } = input;
    const sourceFile = node.getSourceFile();
    const position = sourceFile.getLineAndColumnAtPos(node.getStart());
    const finding = {
        rule,
        path: sourcePath(sourceFile),
        line: position.line,
        column: position.column,
        operation,
        boundary: boundaryLabel(boundary)
    };
    findings.set(`${finding.rule}:${finding.path}:${node.getStart()}:${finding.boundary}`, finding);
}

function boundaryLabel(boundary) {
    const sourceFile = boundary.getSourceFile();
    const position = sourceFile.getLineAndColumnAtPos(boundary.getStart());
    return `${sourcePath(sourceFile)}:${position.line}`;
}

function sourcePath(sourceFile) {
    return sourceFile.getFilePath()
        .replaceAll('\\', '/')
        .replace(/^.*\/(packages|apps\/api-v1\/src)\//u, '$1/');
}

function isAnalyzedSource(path) {
    return isAuthoredSource(path) &&
        !path.startsWith('packages/tests/') &&
        !path.startsWith('packages/shared-test/') &&
        !path.startsWith('packages/shared-rtc-bench/') &&
        !/(?:^|\/)(?:generated|vendor|fixtures?|mocks?)(?:\/|$)/u.test(path) &&
        !/\.(?:test|spec|d)\.ts$/u.test(path);
}

function isAuthoredSource(path) {
    return path.startsWith('packages/') || path.startsWith('apps/api-v1/src/');
}

function compareFindings(left, right) {
    return left.path.localeCompare(right.path) ||
        left.line - right.line ||
        left.column - right.column ||
        left.operation.localeCompare(right.operation);
}

export function isBlockingTransactionWriteFinding(finding) {
    return finding.rule !== 'transaction.unresolved-provenance';
}
