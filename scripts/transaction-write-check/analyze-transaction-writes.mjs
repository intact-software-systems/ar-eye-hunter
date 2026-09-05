import { Node, SyntaxKind } from 'ts-morph';

import {
    appInboxWriteBoundary,
    indexedDbRequestCallbacks,
    indexedDbRequestListenerCallbacks,
    indexedDbTransactionAnalysisEnd,
    indexedDbUpgradeListener,
    isCallbackReference,
    isDirectDatabaseResultCall,
    isDirectTransactionOperation,
    isPersistedWriteOperation,
    isReviewedCallableParameterInvocation,
    isReviewedTransactionForwardingReference,
    isSpecializedTransactionBoundary,
    isSpecializedTransactionImplementation,
    isTransactionParameter,
    isTransactionWriteDeclaration,
    isUnresolvedCallableParameterInvocation,
    isUpgradeCallbackAssignment,
    transactionBoundary,
    transactionExecutedCallbackArguments
} from './transaction-boundaries.mjs';
import {
    assignedOutputDeclarations,
    declarationInitializer,
    expressionIdentifiers,
    functionBody,
    identifierDependsOnDeclarations,
    isAnalyzedSource,
    isFunctionDeclaration,
    isKnownTransactionType,
    resolveCallableBodies,
    resolveCallTargets,
    resolvedDeclarations,
    sourcePath,
    unwrapValueExpression
} from './typescript-provenance.mjs';

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
                roots.push(analysisRoot({ node: declaration }));
            }
        }
        for (const assignment of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
            if (isUpgradeCallbackAssignment(assignment)) {
                const callback = assignment.getRight();
                const callbacks = resolveCallableBodies(callback, project);
                if (callbacks.length === 0 && isCallbackReference(callback)) {
                    addFinding({
                        findings,
                        node: callback,
                        rule: 'transaction.unresolved-provenance',
                        operation: nodeOperation(callback),
                        boundary: assignment
                    });
                }
                for (const resolvedCallback of callbacks) {
                    roots.push(analysisRoot({
                        node: resolvedCallback,
                        start: resolvedCallback.getStart(),
                        boundary: assignment
                    }));
                }
            }
        }
        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const upgradeCallback = indexedDbUpgradeListener(call);
            if (upgradeCallback) {
                addCallbackRoots({ callback: upgradeCallback, call, roots, findings, project });
            }
            const appInboxCallback = appInboxWriteBoundary(call);
            if (appInboxCallback) {
                addCallbackRoots({ callback: appInboxCallback, call, roots, findings, project });
            }
            const boundary = transactionBoundary(call);
            if (!boundary) {
                continue;
            }
            reportTransactionLoop(call, findings, project);
            if (boundary.kind === 'readonly' || isSpecializedTransactionBoundary(call)) {
                continue;
            }
            if (boundary.kind === 'indexed-db') {
                const owner = call.getFirstAncestor(isFunctionDeclaration);
                if (owner) {
                    roots.push(analysisRoot({
                        node: owner,
                        start: call.getEnd(),
                        boundary: call,
                        end: indexedDbTransactionAnalysisEnd(owner, call, project)
                    }));
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
            end: root.end,
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
        roots.push(analysisRoot({
            node: resolvedCallback,
            start: resolvedCallback.getStart(),
            boundary: call
        }));
    }
}

function analyzeBody(input) {
    const { root, start, end, findings, visited, boundary, project } = input;
    const callables = [analysisRoot({ node: root, start, boundary, end })];
    for (let index = 0; index < callables.length; index += 1) {
        const callable = callables[index];
        if (isSpecializedTransactionImplementation(callable.node)) {
            continue;
        }
        const body = functionBody(callable.node);
        if (!body) {
            continue;
        }
        const identity = [
            body.getSourceFile().getFilePath(),
            body.getStart(),
            callable.start,
            callable.end,
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
            end: callable.end,
            findings,
            boundary,
            project,
            callables
        });
    }
}

function analyzeCallableBody(input) {
    const { root, body, start, end, findings, boundary, project, callables } = input;
    analyzeExecutionNode({ root, node: body, start, end, findings, boundary, project, callables });
    body.forEachDescendant((node, traversal) => {
        if (isFunctionDeclaration(node)) {
            traversal.skip();
            return;
        }
        analyzeExecutionNode({ root, node, start, end, findings, boundary, project, callables });
    });
}

function analyzeExecutionNode(input) {
    const { root, node, start, end, findings, boundary, project, callables } = input;
    if (node.getStart() < start || node.getStart() >= end) {
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
    if (Node.isTaggedTemplateExpression(node)) {
        reportSqlInterpolationMaterialization({ node, root, findings, boundary, project });
        return;
    }
    if (Node.isBinaryExpression(node)) {
        for (const callback of indexedDbRequestCallbacks(node, project)) {
            callables.push(analysisRoot({ node: callback }));
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
    followTransactionCallbacks({ call, findings, boundary, project, callables });
    for (const callback of indexedDbRequestListenerCallbacks(call, project)) {
        callables.push(analysisRoot({ node: callback }));
    }
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
    else if (hasParameterOnlyPersistedValueTransformation(call, root, project)) {
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

function reportSqlInterpolationMaterialization(input) {
    const { node, root, findings, boundary, project } = input;
    if (!isKnownTransactionType(node.getTag())) {
        return;
    }
    const template = node.getTemplate();
    if (!Node.isTemplateExpression(template)) {
        return;
    }
    for (const span of template.getTemplateSpans()) {
        const expression = span.getExpression();
        const persistedValue = resolveConstructedPersistedValue(expression);
        if (
            persistedValue &&
            referencesPreTransactionInput(persistedValue, root) &&
            !referencesDatabaseResult(persistedValue, project) &&
            !isAllowedSqlParameterNormalization(persistedValue, root)
        ) {
            addFinding({
                findings,
                node: expression,
                rule: 'transaction.precomputable-work',
                operation: `${nodeOperation(node.getTag())} interpolation`,
                boundary
            });
        }
    }
}

function isAllowedSqlParameterNormalization(expression, root) {
    if (isDirectPreparedProjection(expression, root)) {
        return true;
    }
    if (
        Node.isBinaryExpression(expression) &&
        expression.getOperatorToken().getKind() === SyntaxKind.QuestionQuestionToken
    ) {
        const left = expression.getLeft();
        const right = expression.getRight();
        return (isDirectPreparedProjection(left, root) && right.getKind() === SyntaxKind.NullKeyword) ||
            (left.getKind() === SyntaxKind.NullKeyword && isDirectPreparedProjection(right, root));
    }
    return false;
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
        callables.push(analysisRoot({ node: callable }));
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
    const { call, findings, boundary, project, callables } = input;
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
            callables.push(analysisRoot({ node: callbackBody }));
        }
    }
}

function hasParameterOnlyPersistedValueTransformation(call, root, project) {
    if (!isPersistedWriteOperation(call)) {
        return false;
    }
    return call.getArguments().some((argument) => {
        const persistedValue = resolveConstructedPersistedValue(argument);
        if (!persistedValue || !referencesPreTransactionInput(persistedValue, root)) {
            return false;
        }
        if (!referencesDatabaseResult(persistedValue, project)) {
            return true;
        }
        return hasCandidateTransformationBesideDatabaseResult(persistedValue, root, project);
    });
}

function hasCandidateTransformationBesideDatabaseResult(expression, root, project) {
    if (isDirectPreparedProjection(expression, root)) {
        return false;
    }
    if (
        referencesPreTransactionInput(expression, root) &&
        !referencesDatabaseResult(expression, project)
    ) {
        return true;
    }
    return directValueExpressions(expression).some((child) =>
        hasCandidateTransformationBesideDatabaseResult(child, root, project)
    );
}

function isDirectPreparedProjection(expression, root, visited = new Set()) {
    let current = unwrapValueExpression(expression);
    while (Node.isPropertyAccessExpression(current) || Node.isElementAccessExpression(current)) {
        current = current.getExpression();
    }
    if (!Node.isIdentifier(current)) {
        return false;
    }
    return resolvedDeclarations(current).some((declaration) => {
        if (
            Node.isParameterDeclaration(declaration) &&
            declaration.getFirstAncestor(isFunctionDeclaration) === root
        ) {
            return !isTransactionParameter(declaration);
        }
        if (visited.has(declaration)) {
            return false;
        }
        visited.add(declaration);
        const initializer = declarationInitializer(declaration);
        return initializer !== undefined && isDirectPreparedProjection(initializer, root, visited);
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

function referencesDatabaseResult(expression, project) {
    return isDatabaseDerivedExpression({
        expression,
        project,
        visited: new Set(),
        visitedCallables: new Set(),
        parameterValues: new Map()
    });
}

function isDatabaseDerivedExpression(input) {
    const { expression, project, visited, visitedCallables, parameterValues } = input;
    const value = unwrapValueExpression(expression);
    if (Node.isTaggedTemplateExpression(value)) {
        return isKnownTransactionType(value.getTag());
    }
    if (Node.isIdentifier(value)) {
        return resolvedDeclarations(value).some((declaration) => {
            const parameterValue = parameterValues.get(declaration);
            if (parameterValue) {
                return isDatabaseDerivedExpression({
                    expression: parameterValue,
                    project,
                    visited,
                    visitedCallables,
                    parameterValues
                });
            }
            if (visited.has(declaration)) {
                return false;
            }
            const initializer = declarationInitializer(declaration);
            if (!initializer) {
                return false;
            }
            visited.add(declaration);
            return isDatabaseDerivedExpression({
                expression: initializer,
                project,
                visited,
                visitedCallables,
                parameterValues
            });
        });
    }
    if (Node.isPropertyAccessExpression(value) || Node.isElementAccessExpression(value)) {
        return isDatabaseDerivedExpression({
            expression: value.getExpression(),
            project,
            visited,
            visitedCallables,
            parameterValues
        });
    }
    if (Node.isCallExpression(value)) {
        if (isDirectDatabaseResultCall(value)) {
            return true;
        }
        const targets = resolveCallTargets(value, project);
        if (targets.bodies.length > 0) {
            return callReturnsDatabaseResult({
                call: value,
                targets: targets.bodies,
                project,
                visited,
                visitedCallables,
                parameterValues
            });
        }
        if (targets.unresolved) {
            return false;
        }
        return value.getArguments().some((argument) =>
            !isCallbackReference(argument) &&
            isDatabaseDerivedExpression({
                expression: argument,
                project,
                visited,
                visitedCallables,
                parameterValues
            })
        );
    }
    return directValueExpressions(value).some((child) =>
        isDatabaseDerivedExpression({
            expression: child,
            project,
            visited,
            visitedCallables,
            parameterValues
        })
    );
}

function callReturnsDatabaseResult(input) {
    const { call, targets, project, visited, visitedCallables, parameterValues } = input;
    for (const target of targets) {
        const identity = `${target.getSourceFile().getFilePath()}:${target.getStart()}`;
        if (visitedCallables.has(identity)) {
            continue;
        }
        const targetCallables = new Set(visitedCallables).add(identity);
        const targetValues = new Map(parameterValues);
        const arguments_ = call.getArguments();
        target.getParameters().forEach((parameter, index) => {
            const argument = arguments_[index];
            if (argument) {
                targetValues.set(parameter, argument);
            }
        });
        if (
            returnExpressions(target).some((returned) =>
                isDatabaseDerivedExpression({
                    expression: returned,
                    project,
                    visited: new Set(visited),
                    visitedCallables: targetCallables,
                    parameterValues: targetValues
                })
            )
        ) {
            return true;
        }
    }
    return false;
}

function directValueExpressions(value) {
    if (Node.isCallExpression(value)) {
        const expression = value.getExpression();
        const receiver = Node.isPropertyAccessExpression(expression) ? [expression.getExpression()] : [];
        return [...receiver, ...value.getArguments().filter((argument) => !isCallbackReference(argument))];
    }
    if (Node.isObjectLiteralExpression(value)) {
        return value.getProperties().flatMap((property) => {
            if (Node.isPropertyAssignment(property)) {
                return property.getInitializer() ?? [];
            }
            if (Node.isShorthandPropertyAssignment(property)) {
                return property.getNameNode();
            }
            if (Node.isSpreadAssignment(property)) {
                return property.getExpression();
            }
            return [];
        });
    }
    if (Node.isArrayLiteralExpression(value)) {
        return value.getElements();
    }
    if (Node.isBinaryExpression(value)) {
        return [value.getLeft(), value.getRight()];
    }
    if (Node.isConditionalExpression(value)) {
        return [value.getCondition(), value.getWhenTrue(), value.getWhenFalse()];
    }
    if (Node.isTemplateExpression(value)) {
        return value.getTemplateSpans().map((span) => span.getExpression());
    }
    if (Node.isPrefixUnaryExpression(value) || Node.isPostfixUnaryExpression(value)) {
        return [value.getOperand()];
    }
    return [];
}

function returnExpressions(callable) {
    const body = functionBody(callable);
    if (!body) {
        return [];
    }
    if (!Node.isBlock(body)) {
        return [body];
    }
    return body.getDescendantsOfKind(SyntaxKind.ReturnStatement)
        .filter((statement) => statement.getFirstAncestor(isFunctionDeclaration) === callable)
        .map((statement) => statement.getExpression())
        .filter((expression) => expression !== undefined);
}

function isPersistedAuthoredHelperResult(call, root, project) {
    const targets = resolveCallTargets(call, project);
    if (
        isPersistedWriteOperation(call) ||
        targets.bodies.length === 0 ||
        callableClosureContainsExplicitPrecomputableWork(targets.bodies, project)
    ) {
        return false;
    }
    if (
        referencesDatabaseResult(call, project) &&
        !authoredHelperContainsCandidateTransformation({
            call,
            targets: targets.bodies,
            root,
            project
        })
    ) {
        return false;
    }
    if (isWithinPersistedValuePosition(call)) {
        return true;
    }
    return assignedOutputDeclarations(call).some((declaration) =>
        root.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) =>
            identifier.getStart() > declaration.getStart() &&
            resolvedDeclarations(identifier).includes(declaration) &&
            isWithinPersistedValuePosition(identifier)
        )
    );
}

function authoredHelperContainsCandidateTransformation(input) {
    const { call, targets, root, project } = input;
    for (const target of targets) {
        const parameterValues = new Map();
        target.getParameters().forEach((parameter, index) => {
            const argument = call.getArguments()[index];
            if (argument) {
                parameterValues.set(parameter, argument);
            }
        });
        if (
            returnExpressions(target).some((expression) =>
                hasMappedCandidateTransformation({ expression, root, project, parameterValues })
            )
        ) {
            return true;
        }
    }
    return false;
}

function hasMappedCandidateTransformation(input) {
    const { expression, root, project, parameterValues } = input;
    if (isMappedDirectPreparedProjection(expression, root, parameterValues)) {
        return false;
    }
    const referencesCandidate = referencesPreTransactionInputMapped({
        expression,
        root,
        parameterValues,
        visited: new Set()
    });
    const referencesDatabase = isDatabaseDerivedExpression({
        expression,
        project,
        visited: new Set(),
        visitedCallables: new Set(),
        parameterValues
    });
    if (referencesCandidate && !referencesDatabase) {
        return true;
    }
    return directValueExpressions(expression).some((child) =>
        hasMappedCandidateTransformation({ expression: child, root, project, parameterValues })
    );
}

function referencesPreTransactionInputMapped(input) {
    const { expression, root, parameterValues, visited } = input;
    const value = unwrapValueExpression(expression);
    if (Node.isIdentifier(value)) {
        return resolvedDeclarations(value).some((declaration) => {
            const parameterValue = parameterValues.get(declaration);
            if (parameterValue) {
                return referencesPreTransactionInput(parameterValue, root);
            }
            if (visited.has(declaration)) {
                return false;
            }
            visited.add(declaration);
            const initializer = declarationInitializer(declaration);
            return initializer !== undefined &&
                referencesPreTransactionInputMapped({
                    expression: initializer,
                    root,
                    parameterValues,
                    visited
                });
        });
    }
    if (Node.isPropertyAccessExpression(value) || Node.isElementAccessExpression(value)) {
        return referencesPreTransactionInputMapped({
            expression: value.getExpression(),
            root,
            parameterValues,
            visited
        });
    }
    return directValueExpressions(value).some((child) =>
        referencesPreTransactionInputMapped({
            expression: child,
            root,
            parameterValues,
            visited
        })
    );
}

function isMappedDirectPreparedProjection(expression, root, parameterValues) {
    let current = unwrapValueExpression(expression);
    while (Node.isPropertyAccessExpression(current) || Node.isElementAccessExpression(current)) {
        current = current.getExpression();
    }
    if (!Node.isIdentifier(current)) {
        return false;
    }
    return resolvedDeclarations(current).some((declaration) => {
        const parameterValue = parameterValues.get(declaration);
        return parameterValue !== undefined && isDirectPreparedProjection(parameterValue, root);
    });
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
        const calls = [
            ...(Node.isCallExpression(body) ? [body] : []),
            ...body.getDescendantsOfKind(SyntaxKind.CallExpression)
        ];
        for (const call of calls) {
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

function isWithinPersistedValuePosition(node) {
    return node.getAncestors().some((ancestor) => {
        if (Node.isCallExpression(ancestor) && isPersistedWriteOperation(ancestor)) {
            return ancestor.getArguments().some((argument) =>
                argument.getStart() <= node.getStart() && argument.getEnd() >= node.getEnd()
            );
        }
        return Node.isTaggedTemplateExpression(ancestor) &&
            isKnownTransactionType(ancestor.getTag()) &&
            ancestor.getTag().getEnd() <= node.getStart();
    });
}

function analysisRoot(input) {
    const { node, start = node.getStart(), boundary = node, end = node.getEnd() } = input;
    return { node, start, end, boundary };
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

function reportTransactionLoop(call, findings, project) {
    const loops = call.getAncestors().filter((ancestor) =>
        Node.isForStatement(ancestor) ||
        Node.isForOfStatement(ancestor) ||
        Node.isWhileStatement(ancestor) ||
        Node.isDoStatement(ancestor)
    );
    if (loops.some((loop) => !Node.isForOfStatement(loop) || isRetryShapedForOfTransaction(call, loop, project))) {
        addFinding({
            findings,
            node: call,
            rule: 'transaction.inner-retry',
            operation: callOperation(call),
            boundary: call
        });
    }
}

function isRetryShapedForOfTransaction(call, loop, project) {
    const initializer = loop.getInitializer();
    if (!Node.isVariableDeclarationList(initializer)) {
        return true;
    }
    const declarations = initializer.getDeclarations().flatMap((declaration) => {
        const name = declaration.getNameNode();
        return Node.isIdentifier(name)
            ? [declaration]
            : name.getDescendantsOfKind(SyntaxKind.BindingElement);
    });
    return !call.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) =>
        identifierDependsOnDeclarations(identifier, declarations, new Set()) &&
        flowsIntoTransactionWork(identifier, call, project)
    );
}

function flowsIntoTransactionWork(identifier, transactionCall, project) {
    return identifier.getAncestors().some((ancestor) => {
        if (ancestor === transactionCall) {
            return false;
        }
        if (Node.isTaggedTemplateExpression(ancestor)) {
            return isKnownTransactionType(ancestor.getTag()) && ancestor.getTag().getEnd() <= identifier.getStart();
        }
        if (!Node.isCallExpression(ancestor)) {
            return false;
        }
        if (isPersistedWriteOperation(ancestor)) {
            return ancestor.getArguments().some((argument) => containsNode(argument, identifier));
        }
        const argumentIndexes = ancestor.getArguments().flatMap((argument, index) =>
            containsNode(argument, identifier) ? [index] : []
        );
        return argumentIndexes.length > 0 &&
            authoredHelperPersistsArguments({
                call: ancestor,
                argumentIndexes,
                project,
                visited: new Set()
            });
    });
}

function containsNode(container, node) {
    return container.getStart() <= node.getStart() && container.getEnd() >= node.getEnd();
}

function authoredHelperPersistsArguments(input) {
    const { call, argumentIndexes, project, visited } = input;
    for (const callable of resolveCallTargets(call, project).bodies) {
        const identity = `${callable.getSourceFile().getFilePath()}:${callable.getStart()}`;
        if (visited.has(identity)) {
            continue;
        }
        visited.add(identity);
        const parameters = argumentIndexes
            .map((index) => callable.getParameters()[index])
            .filter((parameter) => parameter !== undefined);
        const body = functionBody(callable);
        if (!body || parameters.length === 0) {
            continue;
        }
        for (const identifier of body.getDescendantsOfKind(SyntaxKind.Identifier)) {
            if (
                identifier.getFirstAncestor(isFunctionDeclaration) !== callable ||
                !identifierDependsOnDeclarations(identifier, parameters, new Set())
            ) {
                continue;
            }
            if (isWithinPersistedValuePosition(identifier)) {
                return true;
            }
            for (const nested of identifier.getAncestors().filter(Node.isCallExpression)) {
                const nestedIndexes = nested.getArguments().flatMap((argument, index) =>
                    containsNode(argument, identifier) ? [index] : []
                );
                if (
                    nestedIndexes.length > 0 &&
                    authoredHelperPersistsArguments({
                        call: nested,
                        argumentIndexes: nestedIndexes,
                        project,
                        visited: new Set(visited)
                    })
                ) {
                    return true;
                }
            }
        }
    }
    return false;
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

function compareFindings(left, right) {
    return left.path.localeCompare(right.path) ||
        left.line - right.line ||
        left.column - right.column ||
        left.operation.localeCompare(right.operation);
}

export function isBlockingTransactionWriteFinding(finding) {
    return finding.rule !== 'transaction.unresolved-provenance';
}
