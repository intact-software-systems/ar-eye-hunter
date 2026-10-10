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
        ['apply', 'call'].includes(immediate.getName()) &&
        immediate.getExpression().getType().getCallSignatures().length > 0
    ) {
        const invoked = unwrapExpression(immediate.getExpression());
        const bodies = resolveCallableBodies(invoked, project);
        return { bodies, unresolved: bodies.length === 0 };
    }
    if (
        Node.isPropertyAccessExpression(immediate) &&
        immediate.getExpression().getText() === 'Reflect' &&
        immediate.getName() === 'apply'
    ) {
        const bodies = resolveCallableBodies(call.getArguments()[0], project);
        return { bodies, unresolved: bodies.length === 0 };
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

// Execution bindings carry only callable values and constructed owners. Passing
// either value binds a callee parameter; its body is reached only by invocation.
export function resolveExecutionTargets(call, project, bindings = new Map()) {
    const callExpression = call.getExpression();
    const indirect = Node.isPropertyAccessExpression(callExpression) &&
        ['apply', 'call'].includes(callExpression.getName()) &&
        callExpression.getExpression().getType().getCallSignatures().length > 0;
    const expression = executionValue(indirect ? callExpression.getExpression() : callExpression, bindings);
    const targets = Node.isNewExpression(call) && Node.isClassExpression(expression)
        ? { bodies: expression.getConstructors(), unresolved: false }
        : Node.isNewExpression(call)
        ? {
            bodies: resolvedDeclarations(expression).flatMap((declaration) =>
                Node.isClassDeclaration(declaration) || Node.isClassExpression(declaration)
                    ? declaration.getConstructors()
                    : []
            ),
            unresolved: false
        }
        : expression !== call.getExpression()
        ? { bodies: resolveCallableBodies(expression, project), unresolved: true }
        : resolveCallTargets(call, project);
    const invocations = targets.bodies.map((node) => {
        const values = new Map(bindings);
        const arguments_ = indirect && callExpression.getName() === 'call'
            ? call.getArguments().slice(1)
            : indirect && Node.isArrayLiteralExpression(call.getArguments()[1])
            ? call.getArguments()[1].getElements()
            : call.getArguments();
        bindExecutionParameters({ callable: node, arguments_, bindings, values });
        if (Node.isConstructorDeclaration(node)) {
            bindConstructedOwner({ receiver: call, owner: node.getParent(), bindings, values });
        }
        if (Node.isMethodDeclaration(node)) {
            const access = call.getExpression();
            if (Node.isPropertyAccessExpression(access)) {
                bindConstructedOwner({ receiver: access.getExpression(), owner: node.getParent(), bindings, values });
            }
        }
        return { node, bindings: values };
    });
    return { invocations, unresolved: targets.unresolved && invocations.length === 0 };
}

/**
 * @typedef {object} BindExecutionParametersInput
 * @property {import('ts-morph').FunctionDeclaration | import('ts-morph').ConstructorDeclaration | import('ts-morph').MethodDeclaration | import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression} callable
 * @property {readonly import('ts-morph').Node[]} arguments_
 * @property {Map<import('ts-morph').Node, import('ts-morph').Node>} bindings
 * @property {Map<import('ts-morph').Node, import('ts-morph').Node>} values
 */

/** @param {BindExecutionParametersInput} input */
function bindExecutionParameters(input) {
    const { callable, arguments_, bindings, values } = input;
    callable.getParameters().forEach((parameter, index) => {
        const argument = arguments_[index];
        if (!argument) {
            return;
        }
        const value = executionValue(argument, bindings);
        if (parameter.getType().getCallSignatures().length > 0 || Node.isNewExpression(value)) {
            values.set(parameter, value);
        }
    });
}

/**
 * @typedef {object} BindConstructedOwnerInput
 * @property {import('ts-morph').Node} receiver
 * @property {import('ts-morph').ClassDeclaration | import('ts-morph').ClassExpression} owner
 * @property {Map<import('ts-morph').Node, import('ts-morph').Node>} bindings
 * @property {Map<import('ts-morph').Node, import('ts-morph').Node>} values
 */

/** @param {BindConstructedOwnerInput} input */
function bindConstructedOwner(input) {
    const { receiver, owner, bindings, values } = input;
    const origin = receiver.getKind() === SyntaxKind.ThisKeyword
        ? bindings.get(owner)
        : executionValue(receiver, bindings);
    if (
        !origin || !Node.isNewExpression(origin) || !(Node.isClassDeclaration(owner) || Node.isClassExpression(owner))
    ) {
        return;
    }
    values.set(owner, origin);
    for (const constructor of owner.getConstructors()) {
        const constructorValues = new Map(bindings);
        bindExecutionParameters({
            callable: constructor,
            arguments_: origin.getArguments(),
            bindings,
            values: constructorValues
        });
        for (const parameter of constructor.getParameters()) {
            if (parameter.isParameterProperty() && constructorValues.has(parameter)) {
                values.set(parameter, constructorValues.get(parameter));
            }
        }
        for (const assignment of constructor.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
            const left = assignment.getLeft();
            if (
                assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken ||
                !Node.isPropertyAccessExpression(left) ||
                left.getExpression().getKind() !== SyntaxKind.ThisKeyword
            ) {
                continue;
            }
            for (const field of resolvedDeclarations(left.getNameNode())) {
                values.set(field, executionValue(assignment.getRight(), constructorValues));
            }
        }
    }
}

function executionValue(expression, bindings, visited = new Set()) {
    const value = unwrapValueExpression(expression);
    const declarations = Node.isPropertyAccessExpression(value)
        ? resolvedDeclarations(value.getNameNode())
        : resolvedDeclarations(value);
    for (const declaration of declarations) {
        if (visited.has(declaration)) {
            continue;
        }
        visited.add(declaration);
        const bound = bindings.get(declaration);
        const initializer = declarationInitializer(declaration);
        if (bound || initializer) {
            return executionValue(bound ?? initializer, bindings, visited);
        }
    }
    return value;
}

export function resolveExecutionCallbacks(callback, project, bindings) {
    return resolveCallableBodies(executionValue(callback, bindings), project)
        .map((node) => ({ node, bindings }));
}

export function executionBindingIdentity(bindings) {
    return [...bindings.entries()].map(([declaration, value]) =>
        `${declaration.getSourceFile().getFilePath()}:${declaration.getStart()}=${value.getSourceFile().getFilePath()}:${value.getStart()}`
    ).sort().join('|');
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
        Node.isConstructorDeclaration(node) ||
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
