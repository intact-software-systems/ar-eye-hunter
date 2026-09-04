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
const PRECOMPUTABLE_NAME = /^(?:compute|prepare|serialize|canonicalize|hash|encode)(?:$|[A-Z_])/u;
const TRANSACTION_TYPE = /(?:PSqlSql|IDBTransaction)/u;
const DATABASE_RECEIVER_TYPE = /(?:Sql|Database|Repository|Runtime|PGlite)/u;
const SPECIALIZED_RESOURCE_INBOX_ROOT = 'packages/shared-server/queuebox/postgres/';

export function analyzeTransactionWrites(project, sourceFiles = project.getSourceFiles()) {
    const findings = new Map();
    const roots = [];

    for (const sourceFile of sourceFiles) {
        const path = sourcePath(sourceFile);
        if (!isAnalyzedSource(path)) {
            continue;
        }
        const specialized = path.startsWith(SPECIALIZED_RESOURCE_INBOX_ROOT);
        for (const declaration of sourceFile.getDescendants().filter(isFunctionDeclaration)) {
            if (!specialized && isTransactionWriteDeclaration(declaration)) {
                roots.push(analysisRoot(declaration));
            }
        }
        for (const assignment of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
            if (!specialized && isUpgradeCallbackAssignment(assignment)) {
                const callback = assignment.getRight();
                if (Node.isArrowFunction(callback) || Node.isFunctionExpression(callback)) {
                    roots.push(analysisRoot(callback));
                }
            }
        }
        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const boundary = transactionBoundary(call);
            if (!boundary) {
                continue;
            }
            if (!specialized) {
                reportTransactionLoop(call, findings);
            }
            if (specialized || boundary.kind === 'readonly') {
                continue;
            }
            if (boundary.kind === 'indexed-db') {
                const owner = call.getFirstAncestor(isFunctionDeclaration);
                if (owner) {
                    roots.push(analysisRoot(owner, call.getEnd(), call));
                }
                continue;
            }
            const callbacks = resolveCallableBodies(boundary.callback, project);
            if (isCallbackReference(boundary.callback) && callbacks.length === 0) {
                addFinding({
                    findings,
                    node: boundary.callback,
                    rule: 'transaction.unresolved-provenance',
                    operation: nodeOperation(boundary.callback),
                    boundary: call
                });
            }
            for (const callback of callbacks) {
                roots.push(analysisRoot(callback, callback.getStart(), call));
            }
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
    const { body, start, findings, boundary, project, callables } = input;
    analyzeExecutionNode({ node: body, start, findings, boundary, project, callables });
    body.forEachDescendant((node, traversal) => {
        if (isFunctionDeclaration(node)) {
            traversal.skip();
            return;
        }
        analyzeExecutionNode({ node, start, findings, boundary, project, callables });
    });
}

function analyzeExecutionNode(input) {
    const { node, start, findings, boundary, project, callables } = input;
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

    analyzeCall({ call: node, findings, boundary, project, callables });
}

function analyzeCall(input) {
    const { call, findings, boundary, project, callables } = input;
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
    else {
        for (const callable of resolveCallableBodies(call.getExpression(), project)) {
            callables.push(analysisRoot(callable));
        }
    }

    for (const callback of call.getArguments().filter(isCallbackReference)) {
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
        Node.isForInStatement(ancestor) ||
        Node.isForOfStatement(ancestor) ||
        Node.isWhileStatement(ancestor) ||
        Node.isDoStatement(ancestor)
    );
    if (loop && isRetryLoop(loop)) {
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
        (!isTransactionPort(node) && node.getType().getCallSignatures().length > 0)
    );
}

function isTransactionPort(node) {
    const type = node.getType();
    const typeName = type.getAliasSymbol()?.getName() ?? type.getSymbol()?.getName() ?? '';
    return TRANSACTION_TYPE.test(typeName);
}

function isRetryLoop(loop) {
    const owner = loop.getFirstAncestor(isFunctionDeclaration);
    return /(?:retry|attempt)/iu.test(loop.getText()) ||
        (owner !== undefined && /(?:retry|attempt)/iu.test(declarationName(owner)));
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
    return (path.startsWith('packages/') || path.startsWith('apps/api-v1/src/')) &&
        !path.startsWith('packages/tests/') &&
        !path.startsWith('packages/shared-test/') &&
        !path.startsWith('packages/shared-rtc-bench/') &&
        !/(?:^|\/)(?:generated|vendor|fixtures?|mocks?)(?:\/|$)/u.test(path) &&
        !/\.(?:test|spec|d)\.ts$/u.test(path);
}

function compareFindings(left, right) {
    return left.path.localeCompare(right.path) ||
        left.line - right.line ||
        left.column - right.column ||
        left.operation.localeCompare(right.operation);
}
