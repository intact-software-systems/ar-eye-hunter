import { findRouteRegistration, type MutationRoutingAstNode } from './mutation-routing-call-graph.ts';
import { findDirectGroupRouteHandler } from './mutation-routing-group-registration.ts';

interface FindHttpRouteHandlerInput {
    readonly program: MutationRoutingAstNode;
    readonly method: string;
    readonly routePath: string;
    readonly registrationMarker: string;
    readonly familyRegistrationMarker?: string;
    readonly expectedFamilyRouteCount?: number;
}

interface GroupStateRouteOperation {
    readonly operationDiscriminant?: string;
    readonly type: string;
}

type AstTraversalValue = MutationRoutingAstNode | readonly AstTraversalValue[] | string | number | boolean | null | undefined;

export function findExactHttpRouteHandler({
    program,
    method,
    routePath,
    familyRegistrationMarker,
    expectedFamilyRouteCount
}: FindHttpRouteHandlerInput): MutationRoutingAstNode | undefined {
    if (!familyRegistrationMarker) {
        const direct = findRouteRegistration(program, method, routePath);
        if (direct) {
            return asNodes(direct.arguments)[1];
        }
        return findCollectionRouteHandler(program, method, routePath);
    }
    return findDirectGroupRouteHandler({
        program,
        method,
        routePath,
        familyOwnerName: familyRegistrationMarker,
        expectedFamilyRouteCount
    });
}

export function hasExactCrdtAdminRouteDefinition(
    program: MutationRoutingAstNode,
    routePath: string,
    operation: string
): boolean {
    const basePath = stripMutationRequestPath(routePath);
    const definitions = findCrdtAdminMutationRouteDefinitions(program);
    if (!basePath || definitions.length !== 1) {
        return false;
    }
    const entries = asNodes(asNode(definitions[0]?.init)?.elements);
    return (
        entries.filter(
            (entry) =>
                readObjectString(entry, 'path') === basePath &&
                readObjectString(entry, 'operation') === operation
        ).length === 1
    );
}

function findCollectionRouteHandler(
    program: MutationRoutingAstNode,
    method: string,
    routePath: string
): MutationRoutingAstNode | undefined {
    const basePath = stripMutationRequestPath(routePath);
    const definitions = findCrdtAdminMutationRouteDefinitions(program);
    if (!basePath || definitions.length !== 1) {
        return undefined;
    }
    const entries = asNodes(asNode(definitions[0]?.init)?.elements);
    if (entries.filter((entry) => readObjectString(entry, 'path') === basePath).length !== 1) {
        return undefined;
    }
    const registrations = findAll(program, (node) => {
        if (node.type !== 'CallExpression') {
            return false;
        }
        const arguments_ = asNodes(node.arguments);
        return (
            readMemberName(asNode(node.callee)) === method &&
            isCrdtAdminMutationRouteTemplate(arguments_[0])
        );
    });
    return registrations.length === 1 ? asNodes(registrations[0]?.arguments)[1] : undefined;
}

function findCrdtAdminMutationRouteDefinitions(program: MutationRoutingAstNode): readonly MutationRoutingAstNode[] {
    return findAll(
        program,
        (node) =>
            node.type === 'VariableDeclarator' &&
            readName(asNode(node.id)) === 'CRDT_ADMIN_MUTATION_ROUTES'
    );
}

function stripMutationRequestPath(routePath: string): string | undefined {
    const suffix = '/requests/:requestId';
    return routePath.endsWith(suffix) ? routePath.slice(0, -suffix.length) : undefined;
}

function isCrdtAdminMutationRouteTemplate(node: MutationRoutingAstNode | undefined): boolean {
    if (node?.type !== 'TemplateLiteral') {
        return false;
    }
    const expressions = asNodes(node.expressions);
    const quasis = asNodes(node.quasis);
    return (
        expressions.length === 1 &&
        readMemberPath(expressions[0]) === 'route.path' &&
        readTemplateElement(quasis[0]) === '' &&
        readTemplateElement(quasis[1]) === '/requests/:requestId'
    );
}

function readObjectString(node: MutationRoutingAstNode, propertyName: string): string | undefined {
    if (node.type !== 'ObjectExpression') {
        return undefined;
    }
    const values = asNodes(node.properties)
        .filter(
            (property) =>
                property.type === 'ObjectProperty' &&
                !property.computed &&
                readName(asNode(property.key)) === propertyName
        )
        .map((property) => readString(asNode(property.value)))
        .filter((value): value is string => value !== undefined);
    return values.length === 1 ? values[0] : undefined;
}

function readTemplateElement(node: MutationRoutingAstNode | undefined): string | undefined {
    const value = asNode(node?.value);
    return typeof value?.raw === 'string' ? value.raw : undefined;
}

function findAll(value: MutationRoutingAstNode, predicate: (node: MutationRoutingAstNode) => boolean): MutationRoutingAstNode[] {
    const matches: MutationRoutingAstNode[] = [];
    const visit = (current: AstTraversalValue): void => {
        if (!current || typeof current !== 'object') {
            return;
        }
        if (Array.isArray(current)) {
            for (const child of current) {
                visit(child);
            }
            return;
        }
        const node = current as MutationRoutingAstNode;
        if (typeof node.type === 'string' && predicate(node)) {
            matches.push(node);
        }
        for (const [key, child] of Object.entries(node)) {
            if (!['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) {
                visit(child as AstTraversalValue);
            }
        }
    };
    visit(value);
    return matches;
}

export function isExactGroupStateRouteOperation(
    handler: MutationRoutingAstNode,
    translator: MutationRoutingAstNode,
    route: GroupStateRouteOperation
): boolean {
    const operation = route.operationDiscriminant;
    return Boolean(
        operation &&
            hasExactGroupRouteSubmission(handler, operation) &&
            hasExactGroupTranslatorOperation(translator, operation, route.type)
    );
}

function hasExactGroupRouteSubmission(handler: MutationRoutingAstNode, operation: string): boolean {
    const handlerStatements = readBlockStatements(asNode(handler.body));
    if (handlerStatements.length !== 1 || handlerStatements[0]?.type !== 'TryStatement') {
        return false;
    }
    const tryStatements = readBlockStatements(asNode(handlerStatements[0].block));
    const calls = readLiveSequentialCalls(tryStatements);
    if (!calls) {
        return false;
    }
    const submissions = calls.filter(
        (call) => readMemberName(asNode(call.callee)) === 'processGroupAppInbox'
    );
    if (submissions.length !== 1) {
        return false;
    }
    const commands = calls.filter(
        (call) => readCallName(asNode(call.callee)) === 'toGroupStateCommand'
    );
    return (
        commands.length === 1 &&
        readOperationLiteral(commands[0]) === operation &&
        isSubmittedCommand(submissions[0]!, commands[0]!, tryStatements)
    );
}

function isSubmittedCommand(
    submission: MutationRoutingAstNode,
    command: MutationRoutingAstNode,
    statements: readonly MutationRoutingAstNode[]
): boolean {
    if (findCallsOutsideFunctions(submission.arguments).includes(command)) {
        return true;
    }
    const binding = findCommandBindingBeforeSubmission(statements, command, submission);
    return Boolean(binding && hasIdentifierOutsideFunctions(submission.arguments, binding));
}

function findCommandBindingBeforeSubmission(
    statements: readonly MutationRoutingAstNode[],
    command: MutationRoutingAstNode,
    submission: MutationRoutingAstNode
): string | undefined {
    let bindingName: string | undefined;
    for (const statement of statements) {
        if (statement.type === 'ReturnStatement' || statement.type === 'ThrowStatement') {
            return undefined;
        }
        if (findCallsOutsideFunctions(statement).includes(submission)) {
            return bindingName;
        }
        if (statement.type === 'VariableDeclaration') {
            const binding = asNodes(statement.declarations).find(
                (declaration) => asNode(declaration.init) === command
            );
            if (binding) {
                bindingName = readName(asNode(binding.id)) || undefined;
            }
        }
    }
    return undefined;
}

function hasIdentifierOutsideFunctions(value: unknown, expectedName: string): boolean {
    let found = false;
    visitOutsideFunctions(value, (node) => {
        if (node.type === 'Identifier' && readName(node) === expectedName) {
            found = true;
        }
    });
    return found;
}

function hasExactGroupTranslatorOperation(
    program: MutationRoutingAstNode,
    operation: string,
    expectedType: string
): boolean {
    const translators = findNamedTopLevelFunctions(program, 'toGroupStateCommand');
    if (translators.length !== 1) {
        return false;
    }
    const statements = readBlockStatements(asNode(translators[0]?.body));
    if (statements.length !== 1 || statements[0]?.type !== 'SwitchStatement') {
        return false;
    }
    const cases = asNodes(statements[0].cases).filter(
        (switchCase) => readString(asNode(switchCase.test)) === operation
    );
    if (cases.length !== 1) {
        return false;
    }
    const helperName = readSwitchHelperName(cases[0]!);
    if (!helperName) {
        return false;
    }
    const helpers = findNamedTopLevelFunctions(program, helperName);
    if (helpers.length !== 1) {
        return false;
    }
    const result = readLiveReturnObject(helpers[0]!);
    return readObjectMemberPath(result, 'type') === `AppInboxType.${expectedType}`;
}

function readSwitchHelperName(switchCase: MutationRoutingAstNode): string | undefined {
    const consequent = asNodes(switchCase.consequent);
    if (consequent.length !== 1 || consequent[0]?.type !== 'ReturnStatement') {
        return undefined;
    }
    const returned = asNode(consequent[0].argument);
    return returned?.type === 'CallExpression' ? readName(asNode(returned.callee)) : undefined;
}

function readLiveReturnObject(owner: MutationRoutingAstNode): MutationRoutingAstNode | undefined {
    for (const statement of readBlockStatements(asNode(owner.body))) {
        if (statement.type === 'ReturnStatement') {
            const returned = asNode(statement.argument);
            return returned?.type === 'ObjectExpression' ? returned : undefined;
        }
        if (statement.type === 'ThrowStatement') {
            return undefined;
        }
        if (statement.type !== 'VariableDeclaration' && statement.type !== 'ExpressionStatement' && !isThrowOnlyGuard(statement)) {
            return undefined;
        }
    }
    return undefined;
}

function isThrowOnlyGuard(statement: MutationRoutingAstNode): boolean {
    if (statement.type !== 'IfStatement' || statement.alternate) {
        return false;
    }
    const consequent = asNode(statement.consequent);
    const statements = consequent?.type === 'BlockStatement' ? readBlockStatements(consequent) : consequent ? [consequent] : [];
    return statements.length === 1 && statements[0]?.type === 'ThrowStatement';
}

function readLiveSequentialCalls(statements: readonly MutationRoutingAstNode[]): readonly MutationRoutingAstNode[] | undefined {
    const calls: MutationRoutingAstNode[] = [];
    for (const statement of statements) {
        if (statement.type === 'ReturnStatement') {
            calls.push(...findCallsOutsideFunctions(statement.argument));
            return calls;
        }
        if (statement.type === 'ThrowStatement') {
            return calls;
        }
        if (statement.type !== 'VariableDeclaration' && statement.type !== 'ExpressionStatement') {
            return undefined;
        }
        calls.push(...findCallsOutsideFunctions(statement));
    }
    return calls;
}

function findCallsOutsideFunctions(value: unknown): readonly MutationRoutingAstNode[] {
    const calls: MutationRoutingAstNode[] = [];
    visitOutsideFunctions(value, (node) => {
        if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
            calls.push(node);
        }
    });
    return calls;
}

function visitOutsideFunctions(value: unknown, visitor: (node: MutationRoutingAstNode) => void): void {
    const visit = (current: unknown, isRoot = false): void => {
        if (!current || typeof current !== 'object') {
            return;
        }
        if (Array.isArray(current)) {
            for (const child of current) {
                visit(child);
            }
            return;
        }
        const node = current as MutationRoutingAstNode;
        if (!isRoot && isFunctionNode(node)) {
            return;
        }
        visitor(node);
        for (const [name, child] of Object.entries(node)) {
            if (!['loc', 'start', 'end', 'comments', 'tokens'].includes(name)) {
                visit(child);
            }
        }
    };
    visit(value, true);
}

function readOperationLiteral(command: MutationRoutingAstNode | undefined): string | undefined {
    const input = asNodes(command?.arguments)[0];
    if (input?.type !== 'ObjectExpression') {
        return undefined;
    }
    const properties = asNodes(input.properties);
    if (properties.some((property) => property.type === 'SpreadElement' || property.computed)) {
        return undefined;
    }
    const values = properties
        .filter(
            (property) => property.type === 'ObjectProperty' && readName(asNode(property.key)) === 'operation'
        )
        .map((property) => readString(asNode(property.value)))
        .filter((value): value is string => value !== undefined);
    return values.length === 1 ? values[0] : undefined;
}

function readObjectMemberPath(object: MutationRoutingAstNode | undefined, propertyName: string): string {
    if (object?.type !== 'ObjectExpression') {
        return '';
    }
    const objectProperties = asNodes(object.properties);
    if (objectProperties.some((property) => property.type === 'SpreadElement' || property.computed)) {
        return '';
    }
    const properties = objectProperties.filter(
        (property) => property.type === 'ObjectProperty' && readName(asNode(property.key)) === propertyName
    );
    return properties.length === 1 ? readMemberPath(asNode(properties[0]?.value)) : '';
}

function findNamedTopLevelFunctions(program: MutationRoutingAstNode, name: string): readonly MutationRoutingAstNode[] {
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

function readMemberPath(node: MutationRoutingAstNode | undefined): string {
    if (!node) {
        return '';
    }
    if (node.type === 'Identifier') {
        return readName(node);
    }
    if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') {
        return '';
    }
    const object = readMemberPath(asNode(node.object));
    const property = readName(asNode(node.property));
    return object && property ? `${object}.${property}` : '';
}

function readCallName(node: MutationRoutingAstNode | undefined): string {
    return readName(node) || readMemberName(node);
}

function readMemberName(node: MutationRoutingAstNode | undefined): string {
    return node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression'
        ? readName(asNode(node.property))
        : '';
}

function readName(node: MutationRoutingAstNode | undefined): string {
    return node && typeof node.name === 'string' ? node.name : '';
}

function readString(node: MutationRoutingAstNode | undefined): string | undefined {
    return node && typeof node.value === 'string' ? node.value : undefined;
}

function isFunctionNode(node: MutationRoutingAstNode): boolean {
    return [
        'FunctionDeclaration',
        'FunctionExpression',
        'ArrowFunctionExpression',
        'ObjectMethod',
        'ClassMethod',
        'ClassPrivateMethod'
    ].includes(node.type);
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
