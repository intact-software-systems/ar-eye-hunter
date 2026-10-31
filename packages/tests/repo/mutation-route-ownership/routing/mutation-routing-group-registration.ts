import path from 'node:path';

import { resolveModuleString, type MutationRoutingAstNode } from './mutation-routing-call-graph.ts';

interface FindGroupRouteHandlerInput {
    readonly program: MutationRoutingAstNode;
    readonly method: string;
    readonly routePath: string;
    readonly familyOwnerName: string;
    readonly expectedFamilyRouteCount?: number;
}

interface GroupRegistrationRootContract {
    readonly familyOwnerName: string;
    readonly familySourcePath: string;
    readonly program: MutationRoutingAstNode;
    readonly rootOwnerName: string;
    readonly rootSourcePath: string;
}

interface DirectRouteRegistration {
    readonly handler: MutationRoutingAstNode;
    readonly method: string;
    readonly ownerName: string;
    readonly routePath: string;
}

interface DirectOwnerCall {
    readonly argumentNames: readonly string[];
    readonly ownerName: string;
}

interface RootFamilyRegistration {
    readonly name: string;
    readonly sourcePath: string;
    readonly requiresAuthorization: boolean;
    readonly readRoutePaths?: readonly string[];
}

const ROOT_FAMILY_CALLS: readonly RootFamilyRegistration[] = [
    { name: 'registerGroupStateReadRoutes', sourcePath: './register-group-state-read-routes.ts', requiresAuthorization: true },
    { name: 'registerGroupQuickJoinRoute', sourcePath: './register-group-quick-join-route.ts', requiresAuthorization: false },
    {
        name: 'registerGroupMoveRoutes',
        sourcePath: './register-group-move-routes.ts',
        requiresAuthorization: false,
        readRoutePaths: ['/api/state/apps/:applicationId/workspaces/:workspaceId/group-moves']
    },
    {
        name: 'registerGroupSessionRoutes',
        sourcePath: './register-group-session-routes.ts',
        requiresAuthorization: false,
        readRoutePaths: [
            '/api/state/apps/:applicationId/workspaces/:workspaceId/group-sessions',
            '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/session'
        ]
    },
    { name: 'registerGroupStateMutationRoutes', sourcePath: './register-group-state-mutation-routes.ts', requiresAuthorization: true },
    { name: 'registerGroupLifecycleRoutes', sourcePath: './register-group-lifecycle-routes.ts', requiresAuthorization: false },
    { name: 'registerGroupAdmissionRoutes', sourcePath: './register-group-admission-routes.ts', requiresAuthorization: false },
    { name: 'registerGroupMembershipRoutes', sourcePath: './register-group-membership-routes.ts', requiresAuthorization: true },
    { name: 'registerGroupPresenceRoutes', sourcePath: './register-group-presence-routes.ts', requiresAuthorization: true },
    { name: 'registerGroupPublicationRoutes', sourcePath: './register-group-publication-routes.ts', requiresAuthorization: false }
];

export function hasExactGroupRegistrationRoot({
    familyOwnerName,
    familySourcePath,
    program,
    rootOwnerName,
    rootSourcePath
}: GroupRegistrationRootContract): boolean {
    const familyContract = ROOT_FAMILY_CALLS.find(({ name }) => name === familyOwnerName);
    if (
        !familyContract ||
        familyContract.sourcePath !== relativeImportPath(rootSourcePath, familySourcePath)
    ) {
        return false;
    }
    const roots = findExportedFunctions(program, rootOwnerName);
    if (roots.length !== 1) {
        return false;
    }
    const root = roots[0]!;
    const parameters = toParameterNames(root);
    if (parameters.length !== 2 || parameters.some((name) => !name)) {
        return false;
    }
    const statements = getBlockStatements(asNode(root.body)).filter((statement) => !isInertStatement(statement));
    const authorization = findAuthorizationBinding(program, statements[0], parameters[1]!);
    if (!authorization) {
        return false;
    }
    const calls = statements.slice(1);
    return calls.length === ROOT_FAMILY_CALLS.length && ROOT_FAMILY_CALLS.every(({ name, sourcePath, requiresAuthorization }) => {
        const binding = findNamedImportBinding(program, name, sourcePath);
        const arguments_ = requiresAuthorization ? [...parameters, authorization] : parameters;
        return binding !== undefined && calls.filter((statement) => isExactDirectCall(statement, binding, arguments_)).length === 1;
    });
}

export function findDirectGroupRouteHandler({
    program,
    method,
    routePath,
    familyOwnerName,
    expectedFamilyRouteCount
}: FindGroupRouteHandlerInput): MutationRoutingAstNode | undefined {
    const familyOwners = findExportedFunctions(program, familyOwnerName);
    if (familyOwners.length !== 1) {
        return undefined;
    }
    const familyOwner = familyOwners[0]!;
    const familyParameters = toParameterNames(familyOwner);
    if (familyParameters.length !== expectedFamilyParameterCount(familyOwnerName) || familyParameters.some((name) => !name)) {
        return undefined;
    }
    const readRoutePaths = ROOT_FAMILY_CALLS.find(({ name }) => name === familyOwnerName)?.readRoutePaths;
    if (readRoutePaths) {
        return findInlineFamilyHandler({ program, owner: familyOwner, method, routePath, expectedFamilyRouteCount, readRoutePaths });
    }
    const direct = findDirectRegistration(program, familyOwner);
    if (direct) {
        return (expectedFamilyRouteCount === undefined || expectedFamilyRouteCount === 1) &&
                direct.method === method && direct.routePath === routePath
            ? direct.handler
            : undefined;
    }
    const calledOwners = collectDirectFamilyOwnerCalls(familyOwner);
    if (!calledOwners || new Set(calledOwners.map((call) => call.ownerName)).size !== calledOwners.length) {
        return undefined;
    }
    if (
        expectedFamilyRouteCount &&
        calledOwners.length !== expectedFamilyRouteCount
    ) {
        return undefined;
    }
    if (!hasOnlyDirectRouteOwners(program, calledOwners, familyParameters)) {
        return undefined;
    }
    const exact = collectDirectRegistrations(program).filter(
        (registration) => registration.method === method && registration.routePath === routePath
    );
    return exact.length === 1 && calledOwners.some((call) => call.ownerName === exact[0]?.ownerName)
        ? exact[0].handler
        : undefined;
}

interface InlineFamilyHandlerInput {
    readonly program: MutationRoutingAstNode;
    readonly owner: MutationRoutingAstNode;
    readonly method: string;
    readonly routePath: string;
    readonly expectedFamilyRouteCount: number | undefined;
    readonly readRoutePaths: readonly string[];
}

function findInlineFamilyHandler(input: InlineFamilyHandlerInput): MutationRoutingAstNode | undefined {
    const registrations = collectInlineRegistrations(input.program, input.owner);
    if (!registrations) {
        return undefined;
    }
    const reads = registrations.filter((entry) => entry.method === 'get');
    const mutations = registrations.filter((entry) => entry.method !== 'get');
    if (
        reads.length !== input.readRoutePaths.length ||
        !input.readRoutePaths.every((routePath) => reads.filter((entry) => entry.routePath === routePath).length === 1) ||
        (input.expectedFamilyRouteCount !== undefined && mutations.length !== input.expectedFamilyRouteCount)
    ) {
        return undefined;
    }
    const matched = registrations.filter((entry) => entry.method === input.method && entry.routePath === input.routePath);
    return matched.length === 1 ? matched[0]?.handler : undefined;
}

function collectInlineRegistrations(program: MutationRoutingAstNode, owner: MutationRoutingAstNode): readonly DirectRouteRegistration[] | undefined {
    const registrations: DirectRouteRegistration[] = [];
    const bindings: MutationRoutingAstNode[] = [];
    for (const statement of getBlockStatements(asNode(owner.body))) {
        const scopedProgram = { ...program, body: [...bindings, ...asNodes(program.body)] };
        if (isInertStatement(statement) || isStaticStringBinding(scopedProgram, statement)) {
            bindings.unshift(statement);
            continue;
        }
        const registration = toInlineRegistration(scopedProgram, owner, statement);
        if (!registration) {
            return undefined;
        }
        registrations.push(registration);
    }
    return registrations.length > 0 ? registrations : undefined;
}

function isStaticStringBinding(program: MutationRoutingAstNode, statement: MutationRoutingAstNode): boolean {
    return statement.type === 'VariableDeclaration' && statement.kind === 'const' &&
        asNodes(statement.declarations).every((declaration) =>
            asNode(declaration.id)?.type === 'Identifier' && resolveModuleString(program, asNode(declaration.init)) !== undefined
        );
}

function toInlineRegistration(
    program: MutationRoutingAstNode,
    owner: MutationRoutingAstNode,
    statement: MutationRoutingAstNode
): DirectRouteRegistration | undefined {
    if (statement.type !== 'ExpressionStatement') {
        return undefined;
    }
    const call = asNode(statement.expression);
    const callee = asNode(call?.callee);
    if (
        call?.type !== 'CallExpression' || callee?.type !== 'MemberExpression' || callee.computed ||
        getName(asNode(callee.object)) !== toParameterNames(owner)[0] || asNodes(call.arguments).length !== 2
    ) {
        return undefined;
    }
    const handler = resolveDirectHandler(program, asNodes(call.arguments)[1], toParameterNames(owner).slice(1));
    const routePath = resolveModuleString(program, asNodes(call.arguments)[0]);
    const method = getName(asNode(callee.property));
    const ownerName = getName(asNode(owner.id));
    return handler && routePath && method && ownerName ? { handler, method, ownerName, routePath } : undefined;
}

function findNamedImportBinding(
    program: MutationRoutingAstNode,
    expectedName: string,
    expectedSourcePath: string
): string | undefined {
    const bindings = asNodes(program.body).flatMap((statement) => {
        if (statement.type !== 'ImportDeclaration') {
            return [];
        }
        const sourcePath = getString(asNode(statement.source));
        return asNodes(statement.specifiers)
            .filter((specifier) => getName(asNode(specifier.imported)) === expectedName && sourcePath === expectedSourcePath)
            .map((specifier) => ({ sourcePath, specifier }));
    });
    if (bindings.length !== 1) {
        return undefined;
    }
    const binding = bindings[0]!;
    return binding.specifier.type === 'ImportSpecifier' ? getName(asNode(binding.specifier.local)) : undefined;
}

function relativeImportPath(rootSourcePath: string, familySourcePath: string): string {
    const relative = path.posix.relative(path.posix.dirname(rootSourcePath), familySourcePath);
    return relative.startsWith('.') ? relative : `./${relative}`;
}

function collectDirectFamilyOwnerCalls(owner: MutationRoutingAstNode): readonly DirectOwnerCall[] | undefined {
    const calledOwners: DirectOwnerCall[] = [];
    for (const statement of getBlockStatements(asNode(owner.body))) {
        if (isInertStatement(statement)) {
            continue;
        }
        if (statement.type !== 'ExpressionStatement') {
            return undefined;
        }
        const call = asNode(statement.expression);
        if (call?.type !== 'CallExpression') {
            return undefined;
        }
        const callee = asNode(call.callee);
        if (callee?.type !== 'Identifier') {
            return undefined;
        }
        const argumentNames = asNodes(call.arguments).map(getName);
        if (argumentNames.some((name) => !name)) {
            return undefined;
        }
        calledOwners.push({ argumentNames, ownerName: getName(callee) });
    }
    return calledOwners.length > 0 ? calledOwners : undefined;
}

function hasOnlyDirectRouteOwners(
    program: MutationRoutingAstNode,
    calls: readonly DirectOwnerCall[],
    familyParameters: readonly string[]
): boolean {
    return calls.every((call) => {
        const owners = findTopLevelFunctions(program, call.ownerName);
        if (owners.length !== 1) {
            return false;
        }
        const parameters = toParameterNames(owners[0]!);
        return (
            parameters.length === call.argumentNames.length &&
            sameNames(call.argumentNames, familyParameters.slice(0, parameters.length)) &&
            findDirectRegistration(program, owners[0]!) !== undefined
        );
    });
}

function findAuthorizationBinding(program: MutationRoutingAstNode, statement: MutationRoutingAstNode | undefined, dependencyName: string): string | undefined {
    if (statement?.type !== 'VariableDeclaration' || statement.kind !== 'const') {
        return undefined;
    }
    const declarations = asNodes(statement.declarations);
    if (declarations.length !== 1) {
        return undefined;
    }
    const factory = findNamedImportBinding(program, 'createGroupStateRouteAuthorization', './group-state-route-authorization.ts');
    const call = asNode(declarations[0]?.init);
    return factory && isExactCall(call, factory, [dependencyName]) ? getName(asNode(declarations[0]?.id)) : undefined;
}

function isInertStatement(statement: MutationRoutingAstNode): boolean {
    if (statement.type === 'EmptyStatement') {
        return true;
    }
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') {
        return false;
    }
    return asNodes(statement.declarations).every((declaration) => {
        const value = asNode(declaration.init);
        return asNode(declaration.id)?.type === 'Identifier' && value !== undefined &&
            ['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral'].includes(value.type);
    });
}

function isExactDirectCall(
    statement: MutationRoutingAstNode | undefined,
    callName: string,
    argumentNames: readonly string[]
): boolean {
    return (
        statement?.type === 'ExpressionStatement' &&
        isExactCall(asNode(statement.expression), callName, argumentNames)
    );
}

function isExactCall(
    call: MutationRoutingAstNode | undefined,
    callName: string,
    argumentNames: readonly string[]
): boolean {
    return (
        call?.type === 'CallExpression' &&
        asNode(call.callee)?.type === 'Identifier' &&
        getName(asNode(call.callee)) === callName &&
        sameNames(asNodes(call.arguments).map(getName), argumentNames)
    );
}

function expectedFamilyParameterCount(familyOwnerName: string): number | undefined {
    const family = ROOT_FAMILY_CALLS.find(({ name }) => name === familyOwnerName);
    return family ? (family.requiresAuthorization ? 3 : 2) : undefined;
}

function toParameterNames(owner: MutationRoutingAstNode): readonly string[] {
    return asNodes(owner.params).map((parameter) => {
        const binding = parameter.type === 'AssignmentPattern' ? asNode(parameter.left) : parameter;
        return getName(binding);
    });
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
    return (
        actual.length === expected.length && actual.every((name, index) => name === expected[index])
    );
}

function collectDirectRegistrations(program: MutationRoutingAstNode): readonly DirectRouteRegistration[] {
    return asNodes(program.body)
        .map(toTopLevelDeclaration)
        .filter((node): node is MutationRoutingAstNode => node?.type === 'FunctionDeclaration')
        .map((owner) => findDirectRegistration(program, owner))
        .filter((registration): registration is DirectRouteRegistration => registration !== undefined);
}

function findDirectRegistration(
    program: MutationRoutingAstNode,
    owner: MutationRoutingAstNode
): DirectRouteRegistration | undefined {
    const statements = getBlockStatements(asNode(owner.body)).filter((statement) => !isInertStatement(statement));
    if (statements.length !== 1 || statements[0]?.type !== 'ExpressionStatement') {
        return undefined;
    }
    return toInlineRegistration(program, owner, statements[0]);
}

function resolveDirectHandler(
    program: MutationRoutingAstNode,
    handler: MutationRoutingAstNode | undefined,
    capturedParameters: readonly string[]
): MutationRoutingAstNode | undefined {
    if (!handler) {
        return undefined;
    }
    if (handler.type === 'Identifier') {
        const targets = findTopLevelFunctions(program, getName(handler));
        return targets.length === 1 ? targets[0] : undefined;
    }
    if (handler.type !== 'ArrowFunctionExpression' && handler.type !== 'FunctionExpression') {
        return handler;
    }
    const call = findDirectWrapperCall(handler);
    if (!call) {
        return handler;
    }
    const callee = asNode(call.callee);
    if (callee?.type !== 'Identifier') {
        return undefined;
    }
    const targets = findTopLevelFunctions(program, getName(callee));
    if (targets.length !== 1) {
        return undefined;
    }
    const target = targets[0]!;
    return sameNames(asNodes(call.arguments).map(getName), [...toParameterNames(handler), ...capturedParameters]) &&
            asNodes(call.arguments).length === toParameterNames(target).length
        ? target
        : undefined;
}

function findDirectWrapperCall(handler: MutationRoutingAstNode): MutationRoutingAstNode | undefined {
    const body = asNode(handler.body);
    if (body?.type === 'CallExpression') {
        return body;
    }
    const statements = getBlockStatements(body);
    if (statements.length !== 1 || statements[0]?.type !== 'ReturnStatement') {
        return undefined;
    }
    const returned = asNode(statements[0].argument);
    return returned?.type === 'CallExpression' ? returned : undefined;
}

function findExportedFunctions(program: MutationRoutingAstNode, name: string): readonly MutationRoutingAstNode[] {
    return asNodes(program.body)
        .filter((statement) => statement.type === 'ExportNamedDeclaration')
        .map((statement) => asNode(statement.declaration))
        .filter(
            (node): node is MutationRoutingAstNode => node?.type === 'FunctionDeclaration' && getName(asNode(node.id)) === name
        );
}

function findTopLevelFunctions(program: MutationRoutingAstNode, name: string): readonly MutationRoutingAstNode[] {
    return asNodes(program.body)
        .map(toTopLevelDeclaration)
        .filter(
            (node): node is MutationRoutingAstNode => node?.type === 'FunctionDeclaration' && getName(asNode(node.id)) === name
        );
}

function toTopLevelDeclaration(statement: MutationRoutingAstNode): MutationRoutingAstNode | undefined {
    return statement.type === 'ExportNamedDeclaration' ? asNode(statement.declaration) : statement;
}

function getBlockStatements(block: MutationRoutingAstNode | undefined): readonly MutationRoutingAstNode[] {
    return block?.type === 'BlockStatement' ? asNodes(block.body) : [];
}

function getName(node: MutationRoutingAstNode | undefined): string {
    return node && typeof node.name === 'string' ? node.name : '';
}

function getString(node: MutationRoutingAstNode | undefined): string | undefined {
    return node && typeof node.value === 'string' ? node.value : undefined;
}

function asNode(value: unknown): MutationRoutingAstNode | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) &&
            'type' in value && typeof value.type === 'string'
        ? (value as MutationRoutingAstNode)
        : undefined;
}

function asNodes(value: unknown): readonly MutationRoutingAstNode[] {
    return Array.isArray(value)
        ? value.map(asNode).filter((node): node is MutationRoutingAstNode => node !== undefined)
        : [];
}
