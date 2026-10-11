export interface MutationRoutingAstNode {
    readonly type: string;
    readonly [key: string]: unknown;
}

interface ExecutedNodeScan {
    readonly matched: boolean;
    readonly callNames: ReadonlySet<string>;
    readonly callbacks: readonly MutationRoutingAstNode[];
}

export function findRouteRegistration(
    program: MutationRoutingAstNode,
    method: string,
    routePath: string
): MutationRoutingAstNode | undefined {
    return findAstNode(program, (node) => {
        if (node.type !== 'CallExpression') {
            return false;
        }
        const callee = asNode(node.callee);
        const arguments_ = asNodes(node.arguments);
        return (
            readMemberName(callee) === method && resolveModuleString(program, arguments_[0]) === routePath
        );
    });
}

export function resolveModuleString(
    program: MutationRoutingAstNode,
    value: MutationRoutingAstNode | undefined,
    resolving = new Set<string>()
): string | undefined {
    if (!value) {
        return undefined;
    }
    const direct = readString(value);
    if (direct !== undefined) {
        return direct;
    }
    if (value.type === 'Identifier') {
        const name = readIdentifier(value);
        if (!name || resolving.has(name)) {
            return undefined;
        }
        const binding = findModuleConst(program, name);
        return binding
            ? resolveModuleString(program, asNode(binding.init), new Set(resolving).add(name))
            : undefined;
    }
    if (value.type === 'TemplateLiteral') {
        return resolveTemplate(program, value, resolving);
    }
    if (value.type !== 'BinaryExpression' || value.operator !== '+') {
        return undefined;
    }
    const left = resolveModuleString(program, asNode(value.left), resolving);
    const right = resolveModuleString(program, asNode(value.right), resolving);
    return left === undefined || right === undefined ? undefined : `${left}${right}`;
}

export function hasReachableAstNode(
    program: MutationRoutingAstNode,
    handler: MutationRoutingAstNode,
    predicate: (node: MutationRoutingAstNode) => boolean
): boolean {
    const functions = collectLocalFunctions(program);
    const pending = [handler];
    const visited = new Set<MutationRoutingAstNode>();
    for (let current = pending.shift(); current !== undefined; current = pending.shift()) {
        if (visited.has(current)) {
            continue;
        }
        visited.add(current);
        const scan = scanExecutedNodes(current, predicate);
        if (scan.matched) {
            return true;
        }
        pending.push(...scan.callbacks.filter((callback) => !visited.has(callback)));
        for (const callName of scan.callNames) {
            const target = functions.get(callName);
            if (target && !visited.has(target)) {
                pending.push(target);
            }
        }
    }
    return false;
}

function scanExecutedNodes(
    root: MutationRoutingAstNode,
    predicate: (node: MutationRoutingAstNode) => boolean
): ExecutedNodeScan {
    const callNames = new Set<string>();
    const callbacks: MutationRoutingAstNode[] = [];
    const pending = [root];
    for (let node = pending.shift(); node !== undefined; node = pending.shift()) {
        if (node !== root && isFunctionNode(node)) {
            continue;
        }
        if (typeof node.type === 'string' && predicate(node)) {
            return { matched: true, callNames, callbacks };
        }
        if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
            const callee = asNode(node.callee);
            const name = readCallName(callee);
            if (name) {
                callNames.add(name);
            }
            if (callee && isFunctionNode(callee)) {
                callbacks.push(callee);
            }
            callbacks.push(...asNodes(node.arguments).filter(isFunctionNode));
        }
        else if (node.type === 'ReturnStatement') {
            const returned = asNode(node.argument);
            if (returned && isFunctionNode(returned)) {
                callbacks.push(returned);
            }
        }
        pending.push(...readAstChildren(node));
    }
    return { matched: false, callNames, callbacks };
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

export function findAstNode(
    value: unknown,
    predicate: (node: MutationRoutingAstNode) => boolean
): MutationRoutingAstNode | undefined {
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findAstNode(item, predicate);
            if (found) {
                return found;
            }
        }
        return undefined;
    }
    const node = asNode(value);
    if (node === undefined) {
        return undefined;
    }
    if (predicate(node)) {
        return node;
    }
    for (const child of readAstChildren(node)) {
        const found = findAstNode(child, predicate);
        if (found) {
            return found;
        }
    }
    return undefined;
}

function collectLocalFunctions(
    program: MutationRoutingAstNode
): ReadonlyMap<string, MutationRoutingAstNode> {
    const functions = new Map<string, MutationRoutingAstNode>();
    visitAll(program, (node) => {
        if (node.type === 'FunctionDeclaration') {
            const name = readIdentifier(asNode(node.id));
            if (name) {
                functions.set(name, node);
            }
        }
        else if (node.type === 'VariableDeclarator') {
            const name = readIdentifier(asNode(node.id));
            const init = asNode(node.init);
            if (
                name &&
                init &&
                (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')
            ) {
                functions.set(name, init);
            }
        }
        else if (
            node.type === 'ClassMethod' ||
            node.type === 'ClassPrivateMethod' ||
            node.type === 'ObjectMethod'
        ) {
            const name = readIdentifier(asNode(node.key));
            if (name) {
                functions.set(name, node);
            }
        }
        else if (node.type === 'ObjectProperty') {
            const name = readIdentifier(asNode(node.key));
            const value = asNode(node.value);
            if (
                name &&
                value &&
                (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression')
            ) {
                functions.set(name, value);
            }
        }
    });
    return functions;
}

function resolveTemplate(
    program: MutationRoutingAstNode,
    template: MutationRoutingAstNode,
    resolving: ReadonlySet<string>
): string | undefined {
    const expressions = asNodes(template.expressions);
    const quasis = asNodes(template.quasis);
    if (quasis.length !== expressions.length + 1) {
        return undefined;
    }
    let resolved = readTemplateElement(quasis[0]);
    if (resolved === undefined) {
        return undefined;
    }
    for (const [index, expression] of expressions.entries()) {
        const expressionValue = resolveModuleString(program, expression, new Set(resolving));
        const following = readTemplateElement(quasis[index + 1]);
        if (expressionValue === undefined || following === undefined) {
            return undefined;
        }
        resolved += expressionValue + following;
    }
    return resolved;
}

function findModuleConst(
    program: MutationRoutingAstNode,
    name: string
): MutationRoutingAstNode | undefined {
    for (const statement of asNodes(program.body)) {
        if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') {
            continue;
        }
        const binding = asNodes(statement.declarations).find(
            (declaration) => readIdentifier(asNode(declaration.id)) === name
        );
        if (binding) {
            return binding;
        }
    }
    return undefined;
}

function visitAll(value: unknown, visit: (node: MutationRoutingAstNode) => void): void {
    if (Array.isArray(value)) {
        for (const item of value) {
            visitAll(item, visit);
        }
        return;
    }
    const node = asNode(value);
    if (node === undefined) {
        return;
    }
    visit(node);
    for (const child of readAstChildren(node)) {
        visitAll(child, visit);
    }
}

/** Parser metadata is never executable; normalize child records and arrays at this one boundary. */
function readAstChildren(node: MutationRoutingAstNode): readonly MutationRoutingAstNode[] {
    const children: MutationRoutingAstNode[] = [];
    for (const [name, value] of Object.entries(node)) {
        if (['loc', 'start', 'end', 'comments', 'tokens'].includes(name)) {
            continue;
        }
        const child = asNode(value);
        children.push(...(child === undefined ? asNodes(value) : [child]));
    }
    return children;
}

function readCallName(node: MutationRoutingAstNode | undefined): string {
    return readIdentifier(node) || readMemberName(node);
}

function readMemberName(node: MutationRoutingAstNode | undefined): string {
    return node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression'
        ? readIdentifier(asNode(node.property))
        : '';
}

function readIdentifier(node: MutationRoutingAstNode | undefined): string {
    return node && typeof node.name === 'string' ? node.name : '';
}

function readString(node: MutationRoutingAstNode | undefined): string | undefined {
    return node && typeof node.value === 'string' ? node.value : undefined;
}

function readTemplateElement(node: MutationRoutingAstNode | undefined): string | undefined {
    if (node?.type !== 'TemplateElement') {
        return undefined;
    }
    const value = node.value;
    return value !== null && typeof value === 'object' && 'cooked' in value && typeof value.cooked === 'string'
        ? value.cooked
        : undefined;
}

function asNode(value: unknown): MutationRoutingAstNode | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !('type' in value) || typeof value.type !== 'string') {
        return undefined;
    }
    return value as MutationRoutingAstNode;
}

function asNodes(value: unknown): readonly MutationRoutingAstNode[] {
    return Array.isArray(value)
        ? value.map(asNode).filter((node): node is MutationRoutingAstNode => node !== undefined)
        : [];
}
