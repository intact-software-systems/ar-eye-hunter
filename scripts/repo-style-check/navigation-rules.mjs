import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { extractRouteHandlerRanges } from './factory-route-rules.mjs';
import { readCallableInventoryObservations } from './navigation-callable-inventories.mjs';

const require = createRequire(import.meta.url);
const maximumTraversalDepth = 24;
const deferredBoundaryNames = new Set([
    'afterCommit',
    'chain',
    'enqueue',
    'flatMap',
    'map',
    'runInTransaction',
    'then',
    'transaction',
    'withTransaction'
]);
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
const effectPortOwnerPattern = /(?:Repository|TransactionWriter|Queue|Clock|Gateway|Sink|EventStore|Enqueue)/u;
const clockMethodNames = new Set(['now', 'nowEpochMs']);
const deferredBoundaryOwnerPattern = /Callbacks?$/u;
const deferredCallableTypePattern = /(?:Callback|Handler|Observer|Predicate)$/u;
const translationBoundaryOwnerPattern = /(?:Codec|Decoder)$/u;
const appInboxHandlerRegistryPattern = /\bAppInboxHandlerRegistry\b/u;

let memoizedTsMorph;

export const navigationRuleIds = Object.freeze({
    registrationIndirection: 'navigation.registration-indirection',
    unnamedDeferredEdge: 'navigation.unnamed-deferred-edge',
    interfacePivot: 'navigation.interface-pivot'
});

export const navigationClassifications = Object.freeze({
    highConfidenceFinding: 'high-confidence-finding',
    legitimateBoundary: 'legitimate-boundary',
    manualReview: 'unknown/manual-review'
});

export function scanNavigationProject(input) {
    validateInput(input);
    const project = createProject(input);
    const sourceFilesByPath = addSources(project, input.sources);
    project.resolveSourceFileDependencies();

    const scanRoots = (input.scanRoots ?? input.sources.map(({ file }) => file)).map(normalizePath);
    const sourceFiles = [...sourceFilesByPath.values()]
        .filter((sourceFile) => isWithinRoots(sourceFile.getFilePath(), scanRoots))
        .filter((sourceFile) => isNavigationProductionFile(sourceFile.getFilePath()))
        .toSorted((left, right) => left.getFilePath().localeCompare(right.getFilePath()));
    const state = createScanState({
        maximumEdgeDepth: input.maximumEdgeDepth ?? maximumTraversalDepth,
        repoRoot: input.repoRoot
    });

    for (const sourceFile of sourceFiles) {
        scanSourceFile(state, sourceFile);
    }

    return toResult(state);
}

export function formatNavigationReport(result, options) {
    const maximumDetails = options.maximumDetails ?? 200;
    const lines = [];
    let displayedDetails = 0;
    if (result.findings.length === 0) {
        lines.push('repo-style-check: NAVIGATION PASS (no navigation findings in this run)');
    }
    else {
        lines.push('repo-style-check: NAVIGATION WARN');
        const displayedFindings = result.findings.slice(0, maximumDetails);
        for (const finding of displayedFindings) {
            lines.push(`NAVIGATION WARN: ${finding.file}:${finding.line}`);
            lines.push(`  - [${findingClassification(finding)}] [${finding.ruleId}] ${finding.message}`);
        }
        displayedDetails += displayedFindings.length;
    }

    let remainingDetailCapacity = Math.max(0, maximumDetails - displayedDetails);
    const displayedFacts = result.boundaryFacts.slice(0, remainingDetailCapacity);
    for (const fact of displayedFacts) {
        lines.push(`NAVIGATION BOUNDARY: ${fact.file}:${fact.line}`);
        lines.push(
            `  - [${fact.classification ?? navigationClassifications.legitimateBoundary}] ` +
                `${fact.boundary} is a named ${boundaryKindLabel(fact.boundaryKind)}.`
        );
    }
    displayedDetails += displayedFacts.length;
    remainingDetailCapacity = Math.max(0, maximumDetails - displayedDetails);
    const displayedDiagnostics = result.diagnostics.slice(0, remainingDetailCapacity);
    for (const diagnostic of displayedDiagnostics) {
        lines.push(`NAVIGATION DIAGNOSTIC: ${diagnostic.file}:${diagnostic.line}`);
        lines.push(
            `  - [${diagnostic.classification ?? navigationClassifications.manualReview}] ${diagnostic.message}`
        );
    }
    displayedDetails += displayedDiagnostics.length;
    const totalDetails = result.findings.length +
        result.boundaryFacts.length +
        result.diagnostics.length;
    if (totalDetails > displayedDetails) {
        lines.push(
            `${totalDetails - displayedDetails} additional navigation details not displayed. ` +
                'Use --root with a narrower path for a reviewable result.'
        );
    }
    lines.push(
        'Navigation summary: ' +
            Object.values(navigationRuleIds)
                .map((ruleId) => `${ruleId}=${result.counts[ruleId]}`)
                .join(', ')
    );
    lines.push(`Navigation boundaries: ${result.boundaryFacts.length} named boundaries.`);
    lines.push(
        'Navigation classifications: ' +
            Object.values(navigationClassifications)
                .map((classification) => `${classification}=${classificationCount(result, classification)}`)
                .join(', ')
    );
    lines.push(`Navigation roots: ${options.scanRoots.join(', ')}.`);
    return lines.join('\n');
}

function validateInput(input) {
    if (input === undefined || typeof input.repoRoot !== 'string' || !Array.isArray(input.sources)) {
        throw new TypeError('Navigation analysis requires repoRoot and sources.');
    }
    if (
        input.maximumEdgeDepth !== undefined &&
        (!Number.isInteger(input.maximumEdgeDepth) || input.maximumEdgeDepth < 1)
    ) {
        throw new TypeError('maximumEdgeDepth must be a positive integer.');
    }
}

function createProject(input) {
    const { Project } = readTsMorph();
    const requestedTsConfig = input.tsConfigFilePath;
    const defaultTsConfig = path.join(input.repoRoot, 'tsconfig.json');
    const tsConfigFilePath = requestedTsConfig ?? (existsSync(defaultTsConfig) ? defaultTsConfig : undefined);
    const projectOptions = {
        skipAddingFilesFromTsConfig: true,
        skipFileDependencyResolution: false
    };
    if (tsConfigFilePath !== undefined) {
        projectOptions.tsConfigFilePath = tsConfigFilePath;
    }
    return new Project(projectOptions);
}

function addSources(project, sources) {
    const sourceFiles = new Map();
    for (const source of sources) {
        const file = normalizePath(source.file);
        const sourceFile = project.createSourceFile(file, source.raw, { overwrite: true });
        sourceFiles.set(file, sourceFile);
    }
    return sourceFiles;
}

function createScanState({ maximumEdgeDepth, repoRoot }) {
    return {
        maximumEdgeDepth,
        repoRoot: normalizePath(repoRoot),
        findings: new Map(),
        boundaryFacts: new Map(),
        diagnostics: new Map(),
        minimumDepthByTraversal: new Map(),
        callableCarrierByParameter: new Map()
    };
}

function scanSourceFile(state, sourceFile) {
    const { SyntaxKind } = readTsMorph();
    const routeHandlerBodyStarts = new Set(
        extractRouteHandlerRanges(sourceFile.getFullText()).map(({ start }) => start)
    );
    scanCallableInventories(state, sourceFile, new Map());
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (isRegisterHandlerCall(call)) {
            scanRegistration(state, call);
            continue;
        }
        if (isDiscoveredRouteRegistration(call, routeHandlerBodyStarts)) {
            scanRouteRegistration(state, call);
            continue;
        }
        if (isRouteMountCall(call)) {
            scanRouteMount(state, call);
        }
    }
}

function scanRouteMount(state, call) {
    for (const target of resolveCallTargets(state, call, new Map())) {
        walkCallable(state, {
            callable: target.callable,
            depth: 0,
            bindings: target.bindings
        });
    }
}

function scanRegistration(state, call) {
    const [registration] = call.getArguments();
    if (!isObjectLiteral(registration)) {
        addFinding(state, {
            node: call,
            ruleId: navigationRuleIds.registrationIndirection,
            message:
                'AppInbox registration is indirect; Go to Definition cannot reveal a concrete type and adjacent handler edge.'
        });
        addFinding(state, {
            node: call,
            ruleId: navigationRuleIds.unnamedDeferredEdge,
            message:
                'AppInbox registration does not expose visible work or a transparent edge to a concrete named handler.'
        });
        return;
    }

    const typeInitializer = readPropertyInitializer(registration, 'type');
    if (!isConcreteRegistrationType(typeInitializer)) {
        addFinding(state, {
            node: typeInitializer ?? registration,
            ruleId: navigationRuleIds.registrationIndirection,
            message:
                'AppInbox type is registered through an indirect value instead of a concrete type at the registration site.'
        });
    }

    const handleInitializer = readPropertyInitializer(registration, 'handle');
    const entryNodes = resolveVisibleCallableEdges(handleInitializer);
    if (entryNodes.length === 0) {
        addFinding(state, {
            node: handleInitializer ?? registration,
            ruleId: navigationRuleIds.unnamedDeferredEdge,
            message:
                'Deferred handler exposes neither visible work nor a transparent edge to a concrete named callable.'
        });
        return;
    }
    walkEntryNodes(state, entryNodes);
}

function scanRouteRegistration(state, call) {
    const [, ...handlerArguments] = call.getArguments();
    for (const handler of handlerArguments) {
        const entryNodes = resolveVisibleCallableEdges(handler);
        if (entryNodes.length === 0 && isPotentialCallback(handler)) {
            addFinding(state, {
                node: handler,
                ruleId: navigationRuleIds.unnamedDeferredEdge,
                message:
                    'Route callback exposes neither visible work nor a transparent edge to a concrete named callable.'
            });
            continue;
        }
        walkEntryNodes(state, entryNodes);
    }
}

function walkEntryNodes(state, entryNodes) {
    for (const entryNode of entryNodes) {
        walkCallable(state, { callable: entryNode, depth: 0, bindings: new Map() });
    }
}

function walkCallable(state, { callable, depth, bindings }) {
    if (depth > state.maximumEdgeDepth) {
        addDiagnostic(
            state,
            callable,
            `analysis truncated after the ${state.maximumEdgeDepth}-edge safety ceiling.`
        );
        return;
    }
    const key = traversalKey(callable, bindings);
    const previousDepth = state.minimumDepthByTraversal.get(key);
    if (previousDepth !== undefined && previousDepth <= depth) {
        return;
    }
    state.minimumDepthByTraversal.set(key, depth);
    scanCallableInventories(state, callable, bindings);

    for (const call of directCallsIn(callable)) {
        analyzeCallBoundary(state, call, bindings);
        if (isDynamicCall(call)) {
            addFinding(state, {
                node: call,
                ruleId: navigationRuleIds.unnamedDeferredEdge,
                message: 'Dynamic call dispatch does not expose a transparent edge to a concrete named callable.'
            });
        }
        for (const next of resolveCallTargets(state, call, bindings)) {
            walkCallable(state, {
                callable: next.callable,
                depth: depth + 1,
                bindings: next.bindings
            });
        }
        scanDeferredArguments(state, { call, depth, bindings });
    }
}

function scanCallableInventories(state, node, bindings) {
    const observations = readCallableInventoryObservations(
        node,
        (expression) => resolveBoundExpression(expression, bindings)
    );
    for (const observation of observations) {
        if (observation.disposition === 'fixed-anonymous') {
            addFinding(state, {
                node: observation.node,
                ruleId: navigationRuleIds.unnamedDeferredEdge,
                message:
                    'A fixed operation inventory is erased behind a transparent generic invocation; expose direct named operations or one named aggregate.'
            });
            continue;
        }
        if (observation.disposition === 'legitimate') {
            addBoundaryFact(state, observation);
            continue;
        }
        addDiagnostic(
            state,
            observation.node,
            'Callable operation inventory could not be classified as fixed or runtime-owned; manual review is required.'
        );
    }
}

function analyzeCallBoundary(state, call, bindings) {
    if (resolveBoundCallableDeclarations(call.getExpression(), bindings).length > 0) {
        return;
    }
    const declarations = resolveExpressionDeclarations(call.getExpression()).filter((declaration) =>
        isWithinRoots(declaration.getSourceFile().getFilePath(), [state.repoRoot])
    );
    const signatures = declarations.filter(isTypeOnlyCallableDeclaration);
    if (signatures.length === 0 || signatures.length !== declarations.length) {
        return;
    }

    for (const signature of signatures) {
        const boundary = declarationDisplayName(signature);
        const kind = boundaryKind(signature);
        if (kind !== undefined) {
            addBoundaryFact(state, { node: call, boundary, boundaryKind: kind });
            continue;
        }
        if (implementationCandidates(state, signature).length > 1) {
            addFinding(state, {
                node: call,
                ruleId: navigationRuleIds.interfacePivot,
                message:
                    `${boundary} resolves only to a type signature while Find Usages exposes multiple production candidates.`
            });
        }
    }
}

function scanDeferredArguments(state, { call, depth, bindings }) {
    const callName = expressionName(call.getExpression());
    for (const argument of call.getArguments()) {
        if (isFunctionLike(argument)) {
            walkCallable(state, { callable: argument, depth: depth + 1, bindings });
            continue;
        }
        const callableEdges = resolveCallableDeclarations(argument);
        if (callableEdges.length > 0) {
            for (const callable of callableEdges.filter((candidate) => isInternalNode(state, candidate))) {
                walkCallable(state, { callable, depth: depth + 1, bindings });
            }
            continue;
        }
        if (
            deferredBoundaryNames.has(callName) &&
            isPotentialCallback(argument) &&
            !isExternalNamedCallable(state, argument)
        ) {
            addFinding(state, {
                node: argument,
                ruleId: navigationRuleIds.unnamedDeferredEdge,
                message: `${callName} defers work through a callback without visible work or a concrete named callable.`
            });
        }
    }
}

function isExternalNamedCallable(state, expression) {
    const kind = expression.getKindName?.();
    if (kind !== 'Identifier' && kind !== 'PropertyAccessExpression') {
        return false;
    }
    const declarations = resolveExpressionDeclarations(expression);
    return declarations.length > 0 &&
        declarations.every((declaration) => !isInternalNode(state, declaration));
}

function resolveVisibleCallableEdges(expression) {
    if (expression === undefined) {
        return [];
    }
    if (isFunctionLike(expression)) {
        if (hasVisibleWork(expression)) {
            return [expression];
        }
        return [];
    }
    return resolveCallableDeclarations(expression);
}

function hasVisibleWork(functionNode) {
    const body = functionNode.getBody?.();
    if (body === undefined) {
        return false;
    }
    if (body.getKindName() === 'Block') {
        return body.getStatements().length > 0;
    }
    const { SyntaxKind } = readTsMorph();
    if (body.getKind() !== SyntaxKind.CallExpression) {
        return true;
    }
    return !isDynamicExpression(body.getExpression());
}

function resolveCallTargets(state, call, bindings) {
    if (isDynamicCall(call)) {
        return [];
    }
    const boundTargets = resolveBoundCallableDeclarations(call.getExpression(), bindings);
    const directCallables = boundTargets.length > 0
        ? boundTargets
        : resolveCallableDeclarations(call.getExpression());
    const callables = directCallables.length > 0
        ? directCallables
        : resolveUniqueInterfaceCallable(state, call.getExpression());
    return callables
        .filter((callable) => isInternalNode(state, callable))
        .map((callable) => ({
            callable,
            bindings: bindCallArguments(state, {
                callable,
                arguments_: call.getArguments(),
                inheritedBindings: bindings
            })
        }));
}

function resolveUniqueInterfaceCallable(state, expression) {
    const declarations = resolveExpressionDeclarations(expression).filter((declaration) =>
        isInternalNode(state, declaration)
    );
    const signatures = declarations.filter(isTypeOnlyCallableDeclaration);
    if (signatures.length === 0 || signatures.length !== declarations.length) {
        return [];
    }
    const candidates = uniqueNodes(
        signatures.flatMap((signature) => implementationCandidates(state, signature))
    );
    if (candidates.length !== 1) {
        return [];
    }
    return callableDeclarationsForImplementation(candidates[0]);
}

function callableDeclarationsForImplementation(implementation) {
    if (isFunctionLike(implementation)) {
        return [implementation];
    }
    if (implementation.getKindName() === 'ShorthandPropertyAssignment') {
        return resolveCallableDeclarations(implementation.getNameNode?.());
    }
    return resolveCallableDeclarations(implementation.getInitializer?.());
}

function bindCallArguments(state, { callable, arguments_, inheritedBindings }) {
    const bindings = new Map();
    const parameters = callable.getParameters?.() ?? [];
    for (let index = 0; index < parameters.length; index += 1) {
        const parameter = parameters[index];
        const argument = arguments_[index];
        if (argument !== undefined && isCallableCarrier(state, parameter)) {
            bindings.set(
                nodeKey(parameter),
                resolveBoundExpression(argument, inheritedBindings)
            );
        }
    }
    return bindings;
}

function isCallableCarrier(state, parameter) {
    const key = nodeKey(parameter);
    const known = state.callableCarrierByParameter.get(key);
    if (known !== undefined) {
        return known;
    }
    const type = parameter.getType();
    const callable = type.getCallSignatures().length > 0 ||
        type.getProperties().some((property) => property.getTypeAtLocation(parameter).getCallSignatures().length > 0);
    state.callableCarrierByParameter.set(key, callable);
    return callable;
}

function resolveBoundCallableDeclarations(expression, bindings) {
    const boundExpression = resolveBoundExpression(expression, bindings);
    if (boundExpression === expression) {
        return [];
    }
    return resolveCallableDeclarations(boundExpression);
}

function resolveBoundExpression(expression, bindings, seen = new Set()) {
    if (expression === undefined) {
        return expression;
    }
    const key = nodeKey(expression);
    if (seen.has(key)) {
        return expression;
    }
    seen.add(key);

    if (expression.getKindName() === 'Identifier') {
        const parameter = parameterDeclarationFor(expression);
        const bound = parameter === undefined ? undefined : bindings.get(nodeKey(parameter));
        return bound === undefined ? expression : resolveBoundExpression(bound, bindings, seen);
    }
    if (expression.getKindName() !== 'PropertyAccessExpression') {
        return expression;
    }

    const receiver = resolveBoundExpression(expression.getExpression(), bindings, seen);
    if (!isObjectLiteral(receiver)) {
        return expression;
    }
    const initializer = readPropertyInitializer(receiver, expression.getName());
    return initializer === undefined
        ? expression
        : resolveBoundExpression(initializer, bindings, seen);
}

function parameterDeclarationFor(identifier) {
    const { SyntaxKind } = readTsMorph();
    for (const definition of definitionNodes(identifier)) {
        if (definition.getKind() === SyntaxKind.Parameter) {
            return definition;
        }
        const parameter = definition.getFirstAncestorByKind?.(SyntaxKind.Parameter);
        if (parameter !== undefined) {
            return parameter;
        }
    }
    return undefined;
}

function resolveCallableDeclarations(expression, seen = new Set()) {
    if (expression === undefined || isDynamicExpression(expression)) {
        return [];
    }
    if (isFunctionLike(expression)) {
        return [expression];
    }
    const expressionKey = nodeKey(expression);
    if (seen.has(expressionKey)) {
        return [];
    }
    seen.add(expressionKey);

    const callableDeclarations = [];
    for (const declaration of resolveExpressionDeclarations(expression)) {
        const normalized = normalizeDeclaration(declaration);
        if (normalized === undefined) {
            continue;
        }
        if (isFunctionLike(normalized)) {
            callableDeclarations.push(normalized);
            continue;
        }
        const initializer = normalized.getInitializer?.();
        if (initializer !== undefined) {
            callableDeclarations.push(...resolveCallableDeclarations(initializer, seen));
        }
    }
    return uniqueNodes(callableDeclarations);
}

function resolveExpressionDeclarations(expression) {
    const { SyntaxKind } = readTsMorph();
    if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
        return definitionNodes(expression.getNameNode());
    }
    if (expression.getKind() === SyntaxKind.Identifier) {
        return definitionNodes(expression);
    }
    return [];
}

function definitionNodes(node) {
    const definitions = node.getDefinitionNodes?.() ?? [];
    const symbol = node.getSymbol?.();
    const aliasedDeclarations = symbol?.getAliasedSymbol?.()?.getDeclarations?.() ?? [];
    return uniqueNodes([...definitions, ...aliasedDeclarations]);
}

function normalizeDeclaration(node) {
    const { SyntaxKind } = readTsMorph();
    const declarationKinds = new Set([
        SyntaxKind.ArrowFunction,
        SyntaxKind.FunctionDeclaration,
        SyntaxKind.FunctionExpression,
        SyntaxKind.MethodDeclaration,
        SyntaxKind.PropertyAssignment,
        SyntaxKind.VariableDeclaration
    ]);
    if (declarationKinds.has(node.getKind())) {
        return node;
    }
    return node.getFirstAncestor((ancestor) => declarationKinds.has(ancestor.getKind()));
}

function directCallsIn(callable) {
    const { SyntaxKind } = readTsMorph();
    return callable
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .filter((call) => nearestFunctionLike(call) === callable);
}

function nearestFunctionLike(node) {
    let current = node.getParent();
    while (current !== undefined) {
        if (isFunctionLike(current)) {
            return current;
        }
        current = current.getParent();
    }
    return undefined;
}

function isTypeOnlyCallableDeclaration(node) {
    const { SyntaxKind } = readTsMorph();
    return node.getKind() === SyntaxKind.MethodSignature ||
        node.getKind() === SyntaxKind.PropertySignature;
}

function implementationCandidates(state, signature) {
    const references = signature.findReferencesAsNodes?.() ?? [];
    return uniqueNodes(
        references
            .map(normalizeImplementationDeclaration)
            .filter((candidate) =>
                candidate !== undefined &&
                isImplementationDeclaration(candidate) &&
                isInternalNode(state, candidate) &&
                isNavigationProductionFile(candidate.getSourceFile().getFilePath())
            )
    );
}

function normalizeImplementationDeclaration(reference) {
    const parent = reference.getParent();
    if (parent === undefined) {
        return undefined;
    }
    const kind = parent.getKindName();
    if (
        (kind === 'MethodDeclaration' ||
            kind === 'PropertyAssignment' ||
            kind === 'PropertyDeclaration' ||
            kind === 'ShorthandPropertyAssignment') &&
        parent.getNameNode?.() === reference
    ) {
        return parent;
    }
    return undefined;
}

function isImplementationDeclaration(node) {
    const { SyntaxKind } = readTsMorph();
    if (node.getKind() === SyntaxKind.MethodDeclaration) {
        return node.getBody?.() !== undefined;
    }
    if (node.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
        return resolveCallableDeclarations(node.getNameNode?.()).length > 0;
    }
    if (node.getKind() === SyntaxKind.PropertyAssignment || node.getKind() === SyntaxKind.PropertyDeclaration) {
        return resolveCallableDeclarations(node.getInitializer?.()).length > 0;
    }
    return false;
}

function isEffectPort(signature) {
    return effectPortOwnerPattern.test(declarationOwnerName(signature)) ||
        clockMethodNames.has(signature.getName?.() ?? '');
}

function boundaryKind(signature) {
    const ownerName = declarationOwnerName(signature);
    if (isEffectPort(signature)) {
        return 'effect';
    }
    if (
        deferredBoundaryOwnerPattern.test(ownerName) ||
        isNamedDeferredCallableType(signature)
    ) {
        return 'deferred';
    }
    if (translationBoundaryOwnerPattern.test(ownerName)) {
        return 'translation';
    }
    return undefined;
}

function isNamedDeferredCallableType(signature) {
    const callableType = signature.getType();
    const typeNames = [
        callableType.getAliasSymbol?.()?.getName?.(),
        callableType.getSymbol?.()?.getName?.()
    ];
    return typeNames.some((name) => name !== undefined && deferredCallableTypePattern.test(name));
}

function boundaryKindLabel(kind) {
    if (kind === 'dynamic') {
        return 'runtime-owned callable boundary';
    }
    if (kind === 'declarative') {
        return 'declarative callable boundary';
    }
    if (kind === 'deferred') {
        return 'deferred boundary';
    }
    if (kind === 'translation') {
        return 'translation boundary';
    }
    return 'effect port';
}

function declarationDisplayName(declaration) {
    const ownerName = declarationOwnerName(declaration);
    const memberName = declaration.getName?.() ?? 'call';
    return ownerName === '' ? memberName : `${ownerName}.${memberName}`;
}

function declarationOwnerName(declaration) {
    const owner = declaration.getFirstAncestor((ancestor) => {
        const kind = ancestor.getKindName();
        return kind === 'InterfaceDeclaration' || kind === 'ClassDeclaration' || kind === 'TypeAliasDeclaration';
    });
    return owner?.getName?.() ?? '';
}

function isConcreteRegistrationType(expression) {
    if (expression === undefined) {
        return false;
    }
    const { SyntaxKind } = readTsMorph();
    return expression.getKind() === SyntaxKind.StringLiteral ||
        expression.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral ||
        expression.getKind() === SyntaxKind.PropertyAccessExpression;
}

function readPropertyInitializer(objectLiteral, propertyName) {
    const property = objectLiteral.getProperty(propertyName);
    return property?.getInitializer?.();
}

function isRegisterHandlerCall(call) {
    const expression = call.getExpression();
    if (expressionName(expression) !== 'registerHandler') {
        return false;
    }
    const receiverType = expression.getExpression?.().getType?.().getText?.() ?? '';
    return appInboxHandlerRegistryPattern.test(receiverType) ||
        resolveExpressionDeclarations(expression).some((declaration) =>
            appInboxHandlerRegistryPattern.test(declarationOwnerName(declaration))
        );
}

function isRouteMountCall(call) {
    return /^mount(?:Http|Rest|Routes?)$/u.test(expressionName(call.getExpression()));
}

function isDiscoveredRouteRegistration(call, routeHandlerBodyStarts) {
    return call.getArguments().some((argument) => {
        if (!isFunctionLike(argument)) {
            return false;
        }
        const body = argument.getBody?.();
        return body !== undefined && routeHandlerBodyStarts.has(body.getStart());
    });
}

function expressionName(expression) {
    return expression.getName?.() ?? expression.getText?.() ?? '';
}

function isDynamicCall(call) {
    return isDynamicExpression(call.getExpression());
}

function isDynamicExpression(expression) {
    return expression?.getKindName?.() === 'ElementAccessExpression';
}

function isPotentialCallback(expression) {
    return expression.getType?.().getCallSignatures?.().length > 0 ||
        isDynamicExpression(expression) ||
        expression.getKindName?.() === 'Identifier' ||
        expression.getKindName?.() === 'PropertyAccessExpression';
}

function isObjectLiteral(node) {
    return node?.getKindName?.() === 'ObjectLiteralExpression';
}

function isFunctionLike(node) {
    if (node === undefined) {
        return false;
    }
    const kind = node.getKindName?.();
    return kind === 'ArrowFunction' ||
        kind === 'FunctionDeclaration' ||
        kind === 'FunctionExpression' ||
        kind === 'MethodDeclaration';
}

function uniqueNodes(nodes) {
    return [...new Map(nodes.map((node) => [nodeKey(node), node])).values()];
}

function traversalKey(callable, bindings) {
    const bindingKey = [...bindings.entries()]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([parameter, argument]) => `${parameter}=${nodeKey(argument)}`)
        .join(';');
    return `${nodeKey(callable)}|${bindingKey}`;
}

function nodeKey(node) {
    const sourceFile = node.getSourceFile?.();
    return `${sourceFile?.getFilePath?.() ?? 'unknown'}:${node.getStart?.() ?? 0}:` +
        `${node.getEnd?.() ?? 0}:${node.getKindName?.() ?? 'unknown'}`;
}

function addFinding(state, { node, ruleId, message }) {
    const location = nodeLocation(node);
    state.findings.set(`${ruleId}:${location.file}:${location.line}:${message}`, {
        ...location,
        ruleId,
        message,
        classification: ruleId === navigationRuleIds.interfacePivot
            ? navigationClassifications.manualReview
            : navigationClassifications.highConfidenceFinding,
        kind: 'warn'
    });
}

function addBoundaryFact(state, { node, boundary, boundaryKind }) {
    const location = nodeLocation(node);
    state.boundaryFacts.set(`${boundary}:${location.file}:${location.line}`, {
        ...location,
        boundary,
        boundaryKind,
        classification: navigationClassifications.legitimateBoundary
    });
}

function addDiagnostic(state, node, message) {
    const location = nodeLocation(node);
    state.diagnostics.set(`${location.file}:${location.line}:${message}`, {
        ...location,
        message,
        classification: navigationClassifications.manualReview
    });
}

function classificationCount(result, classification) {
    const findingCount = result.findings.filter((finding) => findingClassification(finding) === classification).length;
    const boundaryCount = classification === navigationClassifications.legitimateBoundary
        ? result.boundaryFacts.length
        : 0;
    const diagnosticCount = classification === navigationClassifications.manualReview
        ? result.diagnostics.length
        : 0;
    return findingCount + boundaryCount + diagnosticCount;
}

function findingClassification(finding) {
    return finding.classification ??
        (finding.ruleId === navigationRuleIds.interfacePivot
            ? navigationClassifications.manualReview
            : navigationClassifications.highConfidenceFinding);
}

function nodeLocation(node) {
    return {
        file: normalizePath(node.getSourceFile().getFilePath()),
        line: node.getStartLineNumber()
    };
}

function toResult(state) {
    const findings = [...state.findings.values()].toSorted(compareDetails);
    const boundaryFacts = [...state.boundaryFacts.values()].toSorted(compareDetails);
    const diagnostics = [...state.diagnostics.values()].toSorted(compareDetails);
    const counts = Object.fromEntries(Object.values(navigationRuleIds).map((ruleId) => [ruleId, 0]));
    for (const finding of findings) {
        counts[finding.ruleId] += 1;
    }
    return { findings, boundaryFacts, diagnostics, counts };
}

function compareDetails(left, right) {
    return left.file.localeCompare(right.file) ||
        left.line - right.line ||
        (left.ruleId ?? left.boundary ?? left.message).localeCompare(
            right.ruleId ?? right.boundary ?? right.message
        );
}

function isWithinRoots(file, roots) {
    const normalizedFile = normalizePath(file);
    return roots.some((root) => normalizedFile === root || normalizedFile.startsWith(`${root}/`));
}

function isInternalNode(state, node) {
    return isWithinRoots(node.getSourceFile().getFilePath(), [state.repoRoot]);
}

function isNavigationProductionFile(file) {
    const parts = normalizePath(file).split('/');
    return !parts.some((part) => ignoredPathParts.has(part));
}

function normalizePath(file) {
    return path.resolve(file).replaceAll('\\', '/').replace(/\/$/u, '');
}

function readTsMorph() {
    memoizedTsMorph ??= require('ts-morph');
    return memoizedTsMorph;
}
