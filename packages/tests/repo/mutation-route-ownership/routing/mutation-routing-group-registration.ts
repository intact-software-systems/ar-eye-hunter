import path from 'node:path';

import { resolveModuleString, type MutationRoutingAstNode } from './mutation-routing-call-graph.ts';

interface FindGroupRouteHandlerInput {
    readonly program: MutationRoutingAstNode;
    readonly method: string;
    readonly routePath: string;
    readonly privateOwnerName: string;
    readonly familyOwnerName: string;
    readonly familyPrivateOwnerNames?: readonly string[];
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

const ROOT_FAMILY_CALLS = [
    [
        'registerGroupStateReadRoutes',
        './register-group-state-read-routes.ts',
        'app',
        'dependencies',
        'authorization'
    ],
    [
        'registerGroupStateMutationRoutes',
        './register-group-state-mutation-routes.ts',
        'app',
        'dependencies',
        'authorization'
    ],
    ['registerGroupLifecycleRoutes', './register-group-lifecycle-routes.ts', 'app', 'dependencies'],
    ['registerGroupAdmissionRoutes', './register-group-admission-routes.ts', 'app', 'dependencies'],
    [
        'registerGroupMembershipRoutes',
        './register-group-membership-routes.ts',
        'app',
        'dependencies',
        'authorization'
    ],
    [
        'registerGroupPresenceRoutes',
        './register-group-presence-routes.ts',
        'app',
        'dependencies',
        'authorization'
    ]
] as const;

export function hasExactGroupRegistrationRoot({
    familyOwnerName,
    familySourcePath,
    program,
    rootOwnerName,
    rootSourcePath
}: GroupRegistrationRootContract): boolean {
    const familyContract = ROOT_FAMILY_CALLS.find(([name]) => name === familyOwnerName);
    if (
        !familyContract ||
        familyContract[1] !== relativeImportPath(rootSourcePath, familySourcePath)
    ) {
        return false;
    }
    if (!hasExactRootFamilyImports(program)) {
        return false;
    }
    const roots = findExportedFunctions(program, rootOwnerName);
    if (roots.length !== 1) {
        return false;
    }
    const root = roots[0]!;
    if (!sameNames(readParameterNames(root), ['app', 'dependencies'])) {
        return false;
    }
    const statements = readBlockStatements(asNode(root.body));
    if (statements.length !== 1 + ROOT_FAMILY_CALLS.length) {
        return false;
    }
    if (
        !hasExactConstCall({
            statement: statements[0],
            bindingName: 'authorization',
            callName: 'createGroupStateRouteAuthorization',
            argumentNames: ['dependencies']
        })
    ) {
        return false;
    }
    return ROOT_FAMILY_CALLS.every(([name, , ...argumentNames], index) => isExactDirectCall(statements[index + 1], name, argumentNames));
}

export function findDirectGroupRouteHandler({
    program,
    method,
    routePath,
    privateOwnerName,
    familyOwnerName,
    familyPrivateOwnerNames
}: FindGroupRouteHandlerInput): MutationRoutingAstNode | undefined {
    const familyOwners = findExportedFunctions(program, familyOwnerName);
    if (familyOwners.length !== 1) {
        return undefined;
    }
    const familyOwner = familyOwners[0]!;
    const familyParameters = readParameterNames(familyOwner);
    if (!sameNames(familyParameters, expectedFamilyParameters(familyOwnerName))) {
        return undefined;
    }
    const calledOwners = readDirectFamilyOwnerCalls(familyOwner);
    if (!calledOwners || countOwnerCalls(calledOwners, privateOwnerName) !== 1) {
        return undefined;
    }
    if (
        familyPrivateOwnerNames &&
        !sameNames(
            calledOwners.map((call) => call.ownerName),
            familyPrivateOwnerNames
        )
    ) {
        return undefined;
    }
    if (!hasOnlyDirectRouteOwners(program, calledOwners, familyParameters)) {
        return undefined;
    }
    const exact = readAllDirectRegistrations(program).filter(
        (registration) => registration.method === method && registration.routePath === routePath
    );
    return exact.length === 1 && exact[0]?.ownerName === privateOwnerName
        ? exact[0].handler
        : undefined;
}

function hasExactRootFamilyImports(program: MutationRoutingAstNode): boolean {
    return ROOT_FAMILY_CALLS.every(([name, sourcePath]) => hasExactNamedImport(program, name, sourcePath));
}

function hasExactNamedImport(
    program: MutationRoutingAstNode,
    expectedName: string,
    expectedSourcePath: string
): boolean {
    const bindings = asNodes(program.body).flatMap((statement) => {
        if (statement.type !== 'ImportDeclaration') {
            return [];
        }
        const sourcePath = readString(asNode(statement.source));
        return asNodes(statement.specifiers)
            .filter((specifier) => readName(asNode(specifier.local)) === expectedName)
            .map((specifier) => ({ sourcePath, specifier }));
    });
    if (bindings.length !== 1) {
        return false;
    }
    const binding = bindings[0]!;
    return (
        binding.sourcePath === expectedSourcePath &&
        binding.specifier.type === 'ImportSpecifier' &&
        readName(asNode(binding.specifier.imported)) === expectedName
    );
}

function relativeImportPath(rootSourcePath: string, familySourcePath: string): string {
    const relative = path.posix.relative(path.posix.dirname(rootSourcePath), familySourcePath);
    return relative.startsWith('.') ? relative : `./${relative}`;
}

function readDirectFamilyOwnerCalls(owner: MutationRoutingAstNode): readonly DirectOwnerCall[] | undefined {
    const calledOwners: DirectOwnerCall[] = [];
    for (const statement of readBlockStatements(asNode(owner.body))) {
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
        const argumentNames = asNodes(call.arguments).map(readName);
        if (argumentNames.some((name) => !name)) {
            return undefined;
        }
        calledOwners.push({ argumentNames, ownerName: readName(callee) });
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
        const parameters = readParameterNames(owners[0]!);
        return (
            parameters.every((name) => familyParameters.includes(name)) &&
            sameNames(call.argumentNames, parameters) &&
            readDirectRegistration(program, owners[0]!) !== undefined
        );
    });
}

interface ExactConstCallInput {
    readonly statement: MutationRoutingAstNode | undefined;
    readonly bindingName: string;
    readonly callName: string;
    readonly argumentNames: readonly string[];
}

function hasExactConstCall({ statement, bindingName, callName, argumentNames }: ExactConstCallInput): boolean {
    if (statement?.type !== 'VariableDeclaration' || statement.kind !== 'const') {
        return false;
    }
    const declarations = asNodes(statement.declarations);
    if (declarations.length !== 1 || readName(asNode(declarations[0]?.id)) !== bindingName) {
        return false;
    }
    const call = asNode(declarations[0]?.init);
    return call?.type === 'CallExpression' && isExactCall(call, callName, argumentNames);
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
        readName(asNode(call.callee)) === callName &&
        sameNames(asNodes(call.arguments).map(readName), argumentNames)
    );
}

function expectedFamilyParameters(familyOwnerName: string): readonly string[] {
    return (familyOwnerName === 'registerGroupAdmissionRoutes' || familyOwnerName === 'registerGroupLifecycleRoutes')
        ? ['app', 'dependencies']
        : ['app', 'dependencies', 'authorization'];
}

function readParameterNames(owner: MutationRoutingAstNode): readonly string[] {
    return asNodes(owner.params).map((parameter) => {
        const binding = parameter.type === 'AssignmentPattern' ? asNode(parameter.left) : parameter;
        return readName(binding);
    });
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
    return (
        actual.length === expected.length && actual.every((name, index) => name === expected[index])
    );
}

function readAllDirectRegistrations(program: MutationRoutingAstNode): readonly DirectRouteRegistration[] {
    return asNodes(program.body)
        .map(readTopLevelDeclaration)
        .filter((node): node is MutationRoutingAstNode => node?.type === 'FunctionDeclaration')
        .map((owner) => readDirectRegistration(program, owner))
        .filter((registration): registration is DirectRouteRegistration => registration !== undefined);
}

function readDirectRegistration(
    program: MutationRoutingAstNode,
    owner: MutationRoutingAstNode
): DirectRouteRegistration | undefined {
    const statements = readBlockStatements(asNode(owner.body));
    if (statements.length !== 1 || statements[0]?.type !== 'ExpressionStatement') {
        return undefined;
    }
    const call = asNode(statements[0].expression);
    const callee = asNode(call?.callee);
    if (call?.type !== 'CallExpression' || callee?.type !== 'MemberExpression') {
        return undefined;
    }
    if (readName(asNode(callee.object)) !== 'app') {
        return undefined;
    }
    const handler = resolveDirectHandler(program, asNodes(call.arguments)[1]);
    const routePath = resolveModuleString(program, asNodes(call.arguments)[0]);
    const method = readName(asNode(callee.property));
    const ownerName = readName(asNode(owner.id));
    return handler && routePath && method && ownerName
        ? { handler, method, ownerName, routePath }
        : undefined;
}

function resolveDirectHandler(program: MutationRoutingAstNode, handler: MutationRoutingAstNode | undefined): MutationRoutingAstNode | undefined {
    if (!handler) {
        return undefined;
    }
    if (handler.type === 'Identifier') {
        const targets = findTopLevelFunctions(program, readName(handler));
        return targets.length === 1 ? targets[0] : undefined;
    }
    if (handler.type !== 'ArrowFunctionExpression' && handler.type !== 'FunctionExpression') {
        return handler;
    }
    const call = readDirectWrapperCall(handler);
    if (!call) {
        return handler;
    }
    const callee = asNode(call.callee);
    if (callee?.type !== 'Identifier') {
        return undefined;
    }
    const targets = findTopLevelFunctions(program, readName(callee));
    if (targets.length !== 1) {
        return undefined;
    }
    const target = targets[0]!;
    return sameNames(asNodes(call.arguments).map(readName), readParameterNames(target))
        ? target
        : undefined;
}

function readDirectWrapperCall(handler: MutationRoutingAstNode): MutationRoutingAstNode | undefined {
    const body = asNode(handler.body);
    if (body?.type === 'CallExpression') {
        return body;
    }
    const statements = readBlockStatements(body);
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
            (node): node is MutationRoutingAstNode => node?.type === 'FunctionDeclaration' && readName(asNode(node.id)) === name
        );
}

function findTopLevelFunctions(program: MutationRoutingAstNode, name: string): readonly MutationRoutingAstNode[] {
    return asNodes(program.body)
        .map(readTopLevelDeclaration)
        .filter(
            (node): node is MutationRoutingAstNode => node?.type === 'FunctionDeclaration' && readName(asNode(node.id)) === name
        );
}

function readTopLevelDeclaration(statement: MutationRoutingAstNode): MutationRoutingAstNode | undefined {
    return statement.type === 'ExportNamedDeclaration' ? asNode(statement.declaration) : statement;
}

function readBlockStatements(block: MutationRoutingAstNode | undefined): readonly MutationRoutingAstNode[] {
    return block?.type === 'BlockStatement' ? asNodes(block.body) : [];
}

function readName(node: MutationRoutingAstNode | undefined): string {
    return node && typeof node.name === 'string' ? node.name : '';
}

function readString(node: MutationRoutingAstNode | undefined): string | undefined {
    return node && typeof node.value === 'string' ? node.value : undefined;
}

function countOwnerCalls(calls: readonly DirectOwnerCall[], expected: string): number {
    return calls.filter((call) => call.ownerName === expected).length;
}

function asNode(value: unknown): MutationRoutingAstNode | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as MutationRoutingAstNode)
        : undefined;
}

function asNodes(value: unknown): readonly MutationRoutingAstNode[] {
    return Array.isArray(value)
        ? value.map(asNode).filter((node): node is MutationRoutingAstNode => node !== undefined)
        : [];
}
