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
const PRECOMPUTABLE_NAME = /^(?:compute|prepare|serialize|canonicalize|hash|encode)(?:$|[A-Z_])/u;
const TRANSACTION_TYPE = /(?:PSqlSql|IDBTransaction)/u;
const DATABASE_RECEIVER_TYPE = /(?:Sql|Database|Repository|Runtime|PGlite)/u;
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
        new Set(['writeMaterializedIfAbsentOrReplaceExpired'])
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
        const identity = `${body.getSourceFile().getFilePath()}:${body.getStart()}:${callable.start}`;
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
    else if (!isReviewedCallableParameterInvocation(call)) {
        if (isUnresolvedCallableParameterInvocation(call)) {
            addFinding({
                findings,
                node: call,
                rule: 'transaction.unresolved-provenance',
                operation,
                boundary
            });
        }
        else {
            const targets = resolveCallTargets(call, project);
            for (const callable of targets.bodies) {
                callables.push(analysisRoot(callable));
            }
            if (targets.unresolved && !isAllowedTransactionOperation(call)) {
                addFinding({
                    findings,
                    node: call,
                    rule: 'transaction.unresolved-provenance',
                    operation,
                    boundary
                });
            }
        }
    }

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
    if (!isAllowedTransactionOperation(call)) {
        return false;
    }
    return call.getArguments().some((argument) =>
        isConstructedPersistedValue(argument) &&
        referencesPreTransactionInput(argument, root) &&
        !referencesDirectDatabaseResult(argument, root)
    );
}

function isConstructedPersistedValue(argument) {
    return Node.isObjectLiteralExpression(argument) ||
        Node.isArrayLiteralExpression(argument) ||
        Node.isBinaryExpression(argument) ||
        Node.isConditionalExpression(argument) ||
        Node.isTemplateExpression(argument);
}

function referencesPreTransactionInput(expression, root) {
    return expressionIdentifiers(expression).some((identifier) => {
        return resolvedDeclarations(identifier).some((declaration) => {
            if (Node.isParameterDeclaration(declaration)) {
                const owner = declaration.getFirstAncestor(isFunctionDeclaration);
                return owner !== root || !isTransactionParameter(declaration);
            }
            return Node.isVariableDeclaration(declaration) &&
                declaration.getFirstAncestor(isFunctionDeclaration) !== root;
        });
    });
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
            return calls.some(isAllowedTransactionOperation);
        });
    });
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
    const typeNode = parameter.getTypeNode();
    const typeText = typeNode?.getText() ?? parameter.getType().getText(parameter);
    return /^(?:transaction|tx|sql)$/iu.test(parameter.getName()) || TRANSACTION_TYPE.test(typeText);
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
    return PRECOMPUTABLE_NAME.test(name) ? name : undefined;
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
        return { kind: 'callback', callback: call.getArguments()[1] };
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
        Node.isWhileStatement(ancestor) ||
        Node.isDoStatement(ancestor)
    );
    if (loop) {
        addFinding({
            findings,
            node: call,
            rule: 'transaction.inner-retry',
            operation: callOperation(call),
            boundary: call
        });
    }
}

function isTransactionWriteDeclaration(declaration) {
    const name = declarationName(declaration);
    if (!/^(?:write|commit|insert|update|delete|remove|put|finish)/u.test(name)) {
        return false;
    }
    return declaration.getParameters().some((parameter) => {
        const typeNode = parameter.getTypeNode();
        const typeText = typeNode?.getText() ?? parameter.getType().getText(parameter);
        return /^(?:transaction|tx|sql)$/iu.test(parameter.getName()) &&
            (typeNode === undefined || !Node.isFunctionTypeNode(typeNode)) &&
            TRANSACTION_TYPE.test(typeText);
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
    if (!Node.isIdentifier(expression)) {
        return [];
    }
    return resolvedDeclarations(expression).filter(
        (declaration) =>
            Node.isParameterDeclaration(declaration) &&
            declaration.getType().getCallSignatures().length > 0
    );
}

function resolveCallTargets(call, project) {
    const expression = call.getExpression();
    const symbol = Node.isPropertyAccessExpression(expression)
        ? expression.getNameNode().getSymbol()
        : expression.getSymbol();
    const resolved = symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol;
    const bodies = [];
    let hasAuthoredDeclaration = false;
    for (const declaration of resolved?.getDeclarations() ?? []) {
        const sourceFile = declaration.getSourceFile();
        const source = sourcePath(sourceFile);
        if (!isAuthoredSource(source) || !project.getSourceFile(sourceFile.getFilePath())) {
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
        unresolved: hasAuthoredDeclaration && bodies.length === 0
    };
}

function isAllowedTransactionOperation(call) {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) {
        return false;
    }
    const method = expression.getName();
    if (
        !/^(?:write|insert|update|upsert|delete|remove|put|finish|append|execute|query|savepoint|rollback)/u.test(
            method
        )
    ) {
        return false;
    }
    if (looksLikeDatabaseReceiver(expression.getExpression())) {
        return true;
    }
    return call.getArguments().some(isTransactionArgument);
}

function isTransactionArgument(argument) {
    if (TRANSACTION_TYPE.test(argument.getType().getText(argument))) {
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
    findings.set(`${finding.rule}:${finding.path}:${node.getStart()}`, finding);
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
