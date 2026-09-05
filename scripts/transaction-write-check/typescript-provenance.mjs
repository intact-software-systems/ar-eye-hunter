import { Node, SyntaxKind } from 'ts-morph';

const TRANSACTION_TYPE_NAMES = ['PSqlSql', 'IDBTransaction'];
const CANONICAL_TYPE_SOURCES = new Map([
    ['PSqlSql', 'packages/shared-server/postgres/p-sql-sql.ts'],
    ['IDBDatabase', '/typescript/lib/lib.dom.d.ts'],
    ['IDBObjectStore', '/typescript/lib/lib.dom.d.ts'],
    ['IDBOpenDBRequest', '/typescript/lib/lib.dom.d.ts'],
    ['IDBRequest', '/typescript/lib/lib.dom.d.ts'],
    ['IDBTransaction', '/typescript/lib/lib.dom.d.ts']
]);

export function isKnownTransactionType(node) {
    return TRANSACTION_TYPE_NAMES.some((name) => isExactType(node, name));
}

export function isExactType(node, expectedName) {
    return typeContainsExactType({
        type: node.getType(),
        location: node,
        expectedName,
        visitedTypes: new Set(),
        visitedSymbols: new Set()
    });
}

function typeContainsExactType(input) {
    const { type, location, expectedName, visitedTypes, visitedSymbols } = input;
    if (visitedTypes.has(type)) {
        return false;
    }
    visitedTypes.add(type);
    for (const candidate of [type.getAliasSymbol(), type.getSymbol()]) {
        const symbol = candidate?.isAlias() ? candidate.getAliasedSymbol() : candidate;
        if (!symbol || visitedSymbols.has(symbol)) {
            continue;
        }
        if (isCanonicalTypeSymbol(symbol, expectedName, location)) {
            return true;
        }
        visitedSymbols.add(symbol);
        for (const declaration of symbol.getDeclarations()) {
            if (
                Node.isTypeAliasDeclaration(declaration) &&
                declaration.getTypeNode() &&
                typeContainsExactType({
                    type: declaration.getTypeNode().getType(),
                    location: declaration.getTypeNode(),
                    expectedName,
                    visitedTypes,
                    visitedSymbols
                })
            ) {
                return true;
            }
        }
    }
    for (const constituent of type.getIntersectionTypes()) {
        if (typeContainsExactType({ type: constituent, location, expectedName, visitedTypes, visitedSymbols })) {
            return true;
        }
    }
    for (const baseType of type.getBaseTypes()) {
        if (typeContainsExactType({ type: baseType, location, expectedName, visitedTypes, visitedSymbols })) {
            return true;
        }
    }
    if (isCanonicalTypeSourceLoaded(expectedName, location)) {
        return false;
    }
    const typeText = type.getText(location);
    return new RegExp(`^(?:import\\("[^"]+"\\)\\.)?${expectedName}$`, 'u').test(typeText);
}

function isCanonicalTypeSymbol(symbol, expectedName, location) {
    if (symbol.getName() !== expectedName) {
        return false;
    }
    if (!CANONICAL_TYPE_SOURCES.has(expectedName)) {
        return false;
    }
    if (!isCanonicalTypeSourceLoaded(expectedName, location)) {
        return true;
    }
    const expectedSource = CANONICAL_TYPE_SOURCES.get(expectedName);
    return symbol.getDeclarations().some((declaration) =>
        declaration.getSourceFile().getFilePath().replaceAll('\\', '/').endsWith(expectedSource)
    );
}

function isCanonicalTypeSourceLoaded(expectedName, location) {
    const expectedSource = CANONICAL_TYPE_SOURCES.get(expectedName);
    return expectedSource !== undefined &&
        location.getProject().getSourceFiles().some((sourceFile) =>
            sourceFile.getFilePath().replaceAll('\\', '/').endsWith(expectedSource)
        );
}

export function resolveCallTargets(call, project) {
    const expression = call.getExpression();
    const immediate = unwrapExpression(expression);
    if (Node.isArrowFunction(immediate) || Node.isFunctionExpression(immediate)) {
        return { bodies: [immediate], unresolved: false };
    }
    if (
        Node.isPropertyAccessExpression(immediate) &&
        ['apply', 'call'].includes(immediate.getName())
    ) {
        const invoked = unwrapExpression(immediate.getExpression());
        if (Node.isArrowFunction(invoked) || Node.isFunctionExpression(invoked)) {
            return { bodies: [invoked], unresolved: false };
        }
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

export function resolveCallableBodies(node, project, visitedSymbols = new Set()) {
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

export function resolvedDeclarations(identifier) {
    const symbol = identifier.getSymbol();
    const resolved = symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol;
    return resolved?.getDeclarations() ?? [];
}

export function assignedOutputDeclarations(expression) {
    let current = expression;
    while (current.getParent() && isTransparentExpression(current.getParent())) {
        current = current.getParent();
    }
    const parent = current.getParent();
    if (Node.isBinaryExpression(parent) && parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
        const shorthandDeclarations = parent.getLeft()
            .getDescendantsOfKind(SyntaxKind.ShorthandPropertyAssignment)
            .flatMap((property) => property.getValueSymbol()?.getDeclarations() ?? []);
        return [
            ...new Set([
                ...expressionIdentifiers(parent.getLeft()).flatMap(resolvedDeclarations),
                ...shorthandDeclarations
            ])
        ]
            .filter((declaration) => Node.isVariableDeclaration(declaration) || Node.isBindingElement(declaration));
    }
    if (Node.isVariableDeclaration(parent) && parent.getInitializer() === current) {
        const name = parent.getNameNode();
        return Node.isIdentifier(name)
            ? [parent]
            : name.getDescendantsOfKind(SyntaxKind.BindingElement);
    }
    return [];
}

export function declarationInitializer(declaration) {
    if (Node.isVariableDeclaration(declaration)) {
        return declaration.getInitializer();
    }
    if (Node.isBindingElement(declaration)) {
        return declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)?.getInitializer();
    }
    return undefined;
}

export function expressionIdentifiers(expression) {
    return [
        ...(Node.isIdentifier(expression) ? [expression] : []),
        ...expression.getDescendantsOfKind(SyntaxKind.Identifier)
    ];
}

export function identifierDependsOnDeclarations(identifier, targets, visited) {
    return resolvedDeclarations(identifier).some((declaration) => {
        if (targets.includes(declaration)) {
            return true;
        }
        if (visited.has(declaration)) {
            return false;
        }
        visited.add(declaration);
        const initializer = declarationInitializer(declaration);
        return initializer !== undefined &&
            expressionIdentifiers(initializer).some((dependency) =>
                identifierDependsOnDeclarations(dependency, targets, visited)
            );
    });
}

export function unwrapExpression(expression) {
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

export function unwrapValueExpression(expression) {
    if (Node.isAwaitExpression(expression)) {
        return unwrapValueExpression(expression.getExpression());
    }
    return unwrapExpression(expression);
}

function isTransparentExpression(node) {
    return Node.isAsExpression(node) ||
        Node.isAwaitExpression(node) ||
        Node.isNonNullExpression(node) ||
        Node.isParenthesizedExpression(node) ||
        Node.isSatisfiesExpression(node) ||
        Node.isTypeAssertion(node);
}

export function isFunctionDeclaration(node) {
    return Node.isFunctionDeclaration(node) ||
        Node.isMethodDeclaration(node) ||
        Node.isArrowFunction(node) ||
        Node.isFunctionExpression(node);
}

export function functionBody(node) {
    return typeof node.getBody === 'function' ? node.getBody() : undefined;
}

export function declarationName(declaration) {
    if (Node.isFunctionDeclaration(declaration) || Node.isMethodDeclaration(declaration)) {
        return declaration.getName() ?? '';
    }
    const parent = declaration.getParent();
    return Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent)
        ? parent.getName()
        : '';
}

export function sourcePath(sourceFile) {
    return sourceFile.getFilePath()
        .replaceAll('\\', '/')
        .replace(/^.*\/(packages|apps\/api-v1\/src)\//u, '$1/');
}

export function isAnalyzedSource(path) {
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

function isTypeScriptStandardLibraryDeclaration(sourceFile) {
    const path = sourceFile.getFilePath().replaceAll('\\', '/');
    return /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/u.test(path);
}
