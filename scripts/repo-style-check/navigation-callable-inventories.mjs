const membershipMutationNames = new Set([
    'add',
    'clear',
    'delete',
    'pop',
    'push',
    'set',
    'shift',
    'splice',
    'unshift'
]);
const membershipInsertionNames = new Set(['add', 'push', 'set', 'splice', 'unshift']);
const inventoryProjectionNames = new Set(['entries', 'values']);
const operationInventoryPattern =
    /(?:^|[^a-z])(?:mount|register|install|wire|configure)|(?:Route|Installer|Registrar|Operation)/u;
const callableObjectTypePattern = /(?:Plugin|Middleware|Lifecycle|Callbacks?|Handlers?)/u;
const declarativeFactoryResultPattern = /(?:Plugin|Middleware|Lifecycle)/u;
const ignoredPathParts = new Set([
    '__fixtures__',
    '__mocks__',
    '__tests__',
    'fixture',
    'fixtures',
    'mock',
    'mocks',
    'test',
    'tests'
]);
const propertyAssignmentsByProject = new WeakMap();

export function readCallableInventoryObservations(node, resolveBoundExpression = (expression) => expression) {
    const observations = [];
    for (const usage of callableInventoryUsages(node)) {
        const inventory = resolveBoundExpression(usage.inventory);
        const boundary = `${callableDisplayName(usage.context)} callable inventory`;
        if (hasRuntimeMembershipMutation(inventory)) {
            observations.push({
                node: usage.invocation,
                boundary,
                boundaryKind: 'dynamic',
                disposition: 'legitimate'
            });
            continue;
        }

        const staticKind = staticInventoryKind(inventory);
        if (staticKind === 'named') {
            observations.push({
                node: usage.invocation,
                boundary,
                boundaryKind: 'declarative',
                disposition: 'legitimate'
            });
            continue;
        }
        if (!isOperationInventory(usage.context, inventory)) {
            continue;
        }
        observations.push({
            node: usage.invocation,
            boundary,
            disposition: staticKind === 'anonymous' ? 'fixed-anonymous' : 'unknown'
        });
    }
    return observations;
}

function callableInventoryUsages(node) {
    return [
        ...descendantsOfKind(node, 'ForOfStatement').map(readForOfUsage),
        ...descendantsOfKind(node, 'CallExpression').map(readForEachUsage)
    ].filter((usage) => usage !== undefined);
}

function readForOfUsage(loop) {
    const declaration = loop.getInitializer().getDeclarations?.()[0];
    if (declaration === undefined) {
        return undefined;
    }
    const invocation = findEntryInvocation(
        loop.getStatement(),
        declaration,
        nearestFunctionLike(loop)
    );
    return invocation === undefined
        ? undefined
        : { context: loop, inventory: loop.getExpression(), invocation };
}

function readForEachUsage(call) {
    const expression = call.getExpression();
    if (expression.getKindName() !== 'PropertyAccessExpression' || expression.getName() !== 'forEach') {
        return undefined;
    }
    const callback = call.getArguments()[0];
    const declaration = callback?.getParameters?.()[0];
    if (!isFunctionLike(callback) || declaration === undefined) {
        return undefined;
    }
    const invocation = findEntryInvocation(callback, declaration, callback);
    return invocation === undefined
        ? undefined
        : { context: call, inventory: expression.getExpression(), invocation };
}

function findEntryInvocation(scope, declaration, containingCallable) {
    for (const call of descendantsOfKind(scope, 'CallExpression')) {
        if (nearestFunctionLike(call) !== containingCallable) {
            continue;
        }
        const calledExpression = call.getExpression();
        const receiver = invocationReceiver(calledExpression);
        if (
            receiver !== undefined &&
            referencesDeclaration(receiver, declaration) &&
            isCallableEntryInvocation(calledExpression, declaration)
        ) {
            return call;
        }
    }
    return undefined;
}

function isCallableEntryInvocation(calledExpression, declaration) {
    if (calledExpression.getKindName() === 'Identifier') {
        return true;
    }
    const typeText = declaration.getType?.().getText?.() ?? '';
    return callableObjectTypePattern.test(typeText);
}

function invocationReceiver(expression) {
    if (expression.getKindName() === 'Identifier') {
        return expression;
    }
    if (expression.getKindName() === 'PropertyAccessExpression') {
        return expression.getExpression();
    }
    return undefined;
}

function referencesDeclaration(expression, declaration) {
    return expression.getKindName() === 'Identifier' &&
        expression.getText() === declaration.getName?.();
}

function hasRuntimeMembershipMutation(expression, seen = new Set()) {
    const inventory = inventoryBaseExpression(expression);
    const key = nodeKey(inventory);
    if (seen.has(key)) {
        return false;
    }
    seen.add(key);
    for (const declaration of resolveExpressionDeclarations(inventory)) {
        const nameNode = declarationNameNode(declaration);
        if (nameNode !== undefined && nameNode.findReferencesAsNodes().some(isRuntimeMembershipMutationReference)) {
            return true;
        }
        for (const candidate of declarationInventoryExpressions(declaration)) {
            if (hasRuntimeMembershipMutation(candidate, seen)) {
                return true;
            }
        }
    }
    return false;
}

function inventoryBaseExpression(expression) {
    if (expression.getKindName() !== 'CallExpression') {
        return expression;
    }
    const called = expression.getExpression();
    return called.getKindName() === 'PropertyAccessExpression' &&
            inventoryProjectionNames.has(called.getName())
        ? called.getExpression()
        : expression;
}

function isRuntimeMembershipMutationReference(reference) {
    const call = membershipMutationCall(reference);
    if (call === undefined) {
        return false;
    }
    const mutationName = call.getExpression().getName();
    const callable = nearestFunctionLike(call);
    if (callable === undefined) {
        return false;
    }
    if (!membershipInsertionNames.has(mutationName)) {
        return true;
    }
    return membershipEntryArguments(call).some((argument) => referencesRuntimeCallableParameter(argument, callable));
}

function membershipMutationCall(reference) {
    const access = reference.getParent();
    if (
        access?.getKindName() !== 'PropertyAccessExpression' ||
        access.getExpression() !== reference ||
        !membershipMutationNames.has(access.getName())
    ) {
        return undefined;
    }
    const call = access.getParent();
    return call?.getKindName() === 'CallExpression' ? call : undefined;
}

function referencesRuntimeCallableParameter(expression, callable) {
    const parametersByKey = new Map(callable.getParameters().map((parameter) => [nodeKey(parameter), parameter]));
    const identifiers = [expression, ...descendantsOfKind(expression, 'Identifier')]
        .filter((candidate) => candidate.getKindName() === 'Identifier');
    return identifiers.some((identifier) =>
        definitionNodes(identifier).some((definition) => {
            const parameter = parametersByKey.get(nodeKey(definition));
            if (parameter === undefined) {
                return false;
            }
            const knownArguments = callArgumentsForParameter(parameter);
            return knownArguments.length === 0 ||
                knownArguments.some((argument) => inventoryElementKinds(argument).includes('unknown'));
        })
    );
}

function membershipEntryArguments(call) {
    const mutationName = call.getExpression().getName();
    const arguments_ = call.getArguments();
    if (mutationName === 'add') {
        return arguments_.slice(0, 1);
    }
    if (mutationName === 'set') {
        return arguments_.slice(1, 2);
    }
    if (mutationName === 'splice') {
        return arguments_.slice(2);
    }
    return mutationName === 'push' || mutationName === 'unshift' ? arguments_ : [];
}

function staticInventoryKind(expression) {
    const inventories = resolveStaticInventories(expression, new Set());
    if (inventories.length !== 1) {
        return 'unknown';
    }
    const elementKinds = [
        ...inventories.flatMap((inventory) => arrayElementKinds(inventory)),
        ...staticMembershipEntries(expression, new Set()).flatMap((entry) => inventoryElementKinds(entry))
    ];
    if (elementKinds.length === 0 || elementKinds.includes('unknown')) {
        return 'unknown';
    }
    return elementKinds.includes('anonymous') ? 'anonymous' : 'named';
}

function staticMembershipEntries(expression, seen) {
    const inventory = unwrapExpression(inventoryBaseExpression(expression));
    const key = nodeKey(inventory);
    if (seen.has(key)) {
        return [];
    }
    seen.add(key);
    if (inventory.getKindName() === 'CallExpression') {
        return callableReturnExpressions(inventory.getExpression())
            .flatMap((returned) => staticMembershipEntries(returned, seen));
    }
    const entries = [];
    for (const declaration of resolveExpressionDeclarations(inventory)) {
        const nameNode = declarationNameNode(declaration);
        if (nameNode !== undefined) {
            entries.push(
                ...nameNode.findReferencesAsNodes().flatMap((reference) => {
                    const call = membershipMutationCall(reference);
                    return call === undefined || isRuntimeMembershipMutationReference(reference)
                        ? []
                        : membershipEntryArguments(call);
                })
            );
        }
        for (const candidate of declarationInventoryExpressions(declaration)) {
            entries.push(...staticMembershipEntries(candidate, seen));
        }
    }
    return entries;
}

function resolveStaticInventories(expression, seen) {
    const current = unwrapExpression(expression);
    const key = nodeKey(current);
    if (seen.has(key)) {
        return [];
    }
    seen.add(key);
    if (current.getKindName() === 'ArrayLiteralExpression') {
        return [current];
    }
    if (current.getKindName() === 'CallExpression') {
        return callableReturnExpressions(current.getExpression())
            .flatMap((returned) => resolveStaticInventories(returned, seen));
    }
    return resolveExpressionDeclarations(current)
        .flatMap(declarationInventoryExpressions)
        .flatMap((candidate) => resolveStaticInventories(candidate, seen));
}

function arrayElementKinds(arrayLiteral) {
    return arrayLiteral.getElements().flatMap((element) => inventoryElementKinds(element));
}

function inventoryElementKinds(element, seen = new Set()) {
    const current = unwrapExpression(element);
    const key = nodeKey(current);
    if (seen.has(key)) {
        return ['unknown'];
    }
    seen.add(key);
    if (current.getKindName() === 'SpreadElement') {
        const inventories = resolveStaticInventories(current.getExpression(), new Set());
        return inventories.length === 0
            ? ['unknown']
            : inventories.flatMap((inventory) => arrayElementKinds(inventory));
    }
    if (isFunctionLike(current)) {
        return ['anonymous'];
    }
    if (
        isNamedDeclarativeFactoryCall(current) ||
        isNamedCallableReference(current) ||
        isNamedDeclarativeEntry(current)
    ) {
        return ['named'];
    }
    const parameterArguments = resolveExpressionDeclarations(current)
        .filter((declaration) => declaration.getKindName() === 'Parameter')
        .flatMap(callArgumentsForParameter);
    if (parameterArguments.length > 0) {
        return parameterArguments.flatMap((argument) => inventoryElementKinds(argument, seen));
    }
    return current.getKindName() === 'CallExpression' ? ['anonymous'] : ['unknown'];
}

function isNamedDeclarativeFactoryCall(expression) {
    if (expression.getKindName() !== 'CallExpression') {
        return false;
    }
    const called = expression.getExpression();
    const named = called.getKindName() === 'Identifier' || called.getKindName() === 'PropertyAccessExpression';
    return named && declarativeFactoryResultPattern.test(expression.getType().getText());
}

function isNamedCallableReference(expression) {
    if (expression.getKindName() !== 'Identifier' && expression.getKindName() !== 'PropertyAccessExpression') {
        return false;
    }
    return resolveExpressionDeclarations(expression).some((declaration) => {
        if (declaration.getKindName() === 'FunctionDeclaration' || declaration.getKindName() === 'MethodDeclaration') {
            return true;
        }
        return isFunctionLike(declaration.getInitializer?.());
    });
}

function isNamedDeclarativeEntry(expression) {
    if (expression.getKindName() !== 'ObjectLiteralExpression') {
        return false;
    }
    return ['id', 'kind', 'name', 'type'].some((property) => expression.getProperty(property) !== undefined);
}

function declarationInventoryExpressions(declaration) {
    const initializer = declaration.getInitializer?.();
    if (initializer !== undefined) {
        return [initializer];
    }
    if (declaration.getKindName() === 'Parameter') {
        return callArgumentsForParameter(declaration);
    }
    if (declaration.getKindName() === 'PropertySignature') {
        return propertyImplementationInitializers(declaration);
    }
    return [];
}

function callArgumentsForParameter(parameter) {
    const callable = nearestFunctionLike(parameter);
    const nameNode = callable?.getNameNode?.();
    const index = callable?.getParameters?.().findIndex((candidate) => candidate === parameter) ?? -1;
    if (nameNode === undefined || index < 0) {
        return [];
    }
    return nameNode.findReferencesAsNodes()
        .map(callForCallableReference)
        .filter((call) => call !== undefined)
        .map((call) => call.getArguments()[index])
        .filter((argument) => argument !== undefined);
}

function callForCallableReference(reference) {
    const parent = reference.getParent();
    if (parent?.getKindName() === 'CallExpression' && parent.getExpression() === reference) {
        return parent;
    }
    if (parent?.getKindName() === 'PropertyAccessExpression' && parent.getNameNode() === reference) {
        const call = parent.getParent();
        return call?.getKindName() === 'CallExpression' ? call : undefined;
    }
    return undefined;
}

function propertyImplementationInitializers(signature) {
    const referenced = signature.findReferencesAsNodes()
        .map((reference) => ({ reference, parent: reference.getParent() }))
        .filter(({ reference, parent }) =>
            parent?.getKindName() === 'PropertyAssignment' &&
            parent.getNameNode?.() === reference
        )
        .map(({ parent }) => parent.getInitializer?.())
        .filter((initializer) => initializer !== undefined);
    if (referenced.length > 0) {
        return referenced;
    }
    return structuralPropertyInitializers(signature);
}

function structuralPropertyInitializers(signature) {
    const propertyName = signature.getName?.();
    if (propertyName === undefined) {
        return [];
    }
    return propertyAssignments(signature.getProject())
        .filter((property) => property.getName?.() === propertyName)
        .map((property) => property.getInitializer?.())
        .filter((initializer) => initializer !== undefined && isCallableCollection(initializer));
}

function propertyAssignments(project) {
    const cached = propertyAssignmentsByProject.get(project);
    if (cached !== undefined) {
        return cached;
    }
    const assignments = project.getSourceFiles()
        .filter((sourceFile) => isProductionFile(sourceFile.getFilePath()))
        .flatMap((sourceFile) => descendantsOfKind(sourceFile, 'PropertyAssignment'));
    propertyAssignmentsByProject.set(project, assignments);
    return assignments;
}

function isCallableCollection(expression) {
    const type = expression.getType();
    const elementType = type.getArrayElementType?.() ?? type.getTypeArguments?.()[0];
    return elementType?.getCallSignatures?.().length > 0;
}

function isProductionFile(file) {
    return !file.replaceAll('\\', '/').split('/').some((part) => ignoredPathParts.has(part));
}

function callableReturnExpressions(expression) {
    return resolveExpressionDeclarations(expression)
        .map(normalizeCallableDeclaration)
        .filter((callable) => callable !== undefined)
        .flatMap(returnExpressions);
}

function returnExpressions(callable) {
    const body = callable.getBody?.();
    if (body === undefined) {
        return [];
    }
    if (body.getKindName() !== 'Block') {
        return [body];
    }
    return descendantsOfKind(body, 'ReturnStatement')
        .filter((statement) => nearestFunctionLike(statement) === callable)
        .map((statement) => statement.getExpression?.())
        .filter((expression) => expression !== undefined);
}

function normalizeCallableDeclaration(declaration) {
    if (isFunctionLike(declaration)) {
        return declaration;
    }
    const initializer = declaration.getInitializer?.();
    return isFunctionLike(initializer) ? initializer : undefined;
}

function resolveExpressionDeclarations(expression) {
    if (expression.getKindName() === 'PropertyAccessExpression') {
        return definitionNodes(expression.getNameNode());
    }
    if (expression.getKindName() === 'Identifier') {
        return definitionNodes(expression);
    }
    return [];
}

function definitionNodes(node) {
    const definitions = node.getDefinitionNodes?.() ?? [];
    const symbol = node.getSymbol?.();
    const aliases = symbol?.getAliasedSymbol?.()?.getDeclarations?.() ?? [];
    return uniqueNodes([...definitions, ...aliases]);
}

function declarationNameNode(declaration) {
    return declaration.getNameNode?.() ?? declaration.getFirstChildByKindName?.('Identifier');
}

function isOperationInventory(loop, inventory) {
    const evidence = [
        callableDisplayName(loop),
        inventory.getText?.() ?? '',
        inventory.getType?.().getText?.() ?? ''
    ].join(' ');
    return operationInventoryPattern.test(evidence);
}

function callableDisplayName(node) {
    const callable = nearestFunctionLike(node);
    const callableName = callable?.getName?.() ?? 'anonymous';
    const owner = callable?.getFirstAncestor((ancestor) => ancestor.getKindName() === 'ClassDeclaration');
    const ownerName = owner?.getName?.();
    return ownerName === undefined ? callableName : `${ownerName}.${callableName}`;
}

function nearestFunctionLike(node) {
    let current = node.getParent?.();
    while (current !== undefined) {
        if (isFunctionLike(current)) {
            return current;
        }
        current = current.getParent?.();
    }
    return undefined;
}

function isFunctionLike(node) {
    const kind = node?.getKindName?.();
    return kind === 'ArrowFunction' ||
        kind === 'FunctionDeclaration' ||
        kind === 'FunctionExpression' ||
        kind === 'MethodDeclaration';
}

function unwrapExpression(expression) {
    const kind = expression.getKindName();
    return kind === 'AsExpression' || kind === 'ParenthesizedExpression' || kind === 'SatisfiesExpression'
        ? unwrapExpression(expression.getExpression())
        : expression;
}

function descendantsOfKind(node, kind) {
    return node.getDescendants().filter((candidate) => candidate.getKindName() === kind);
}

function uniqueNodes(nodes) {
    return [...new Map(nodes.map((node) => [nodeKey(node), node])).values()];
}

function nodeKey(node) {
    return `${node.getSourceFile?.().getFilePath?.() ?? 'unknown'}:${node.getStart?.() ?? 0}:` +
        `${node.getEnd?.() ?? 0}:${node.getKindName?.() ?? 'unknown'}`;
}
