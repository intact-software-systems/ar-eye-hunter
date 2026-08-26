type AstNode = { readonly type: string; readonly [key: string]: unknown; };

interface Scope {
    readonly id: number;
    readonly parent?: Scope;
    readonly kind: 'program' | 'function' | 'block' | 'catch' | 'class';
    readonly classId?: number;
    readonly bindings: Map<string, string>;
}

export interface MutationBoundaryLexicalBindings {
    identifierKey(value: unknown): string;
    identifierFunctionKey(value: unknown): string;
    functionKey(value: unknown): string;
    thisKey(value: unknown): string;
}

export function createMutationBoundaryLexicalBindings(
    program: AstNode
): MutationBoundaryLexicalBindings {
    const nodeScopes = new WeakMap<object, Scope>();
    const declarations = new WeakMap<object, string>();
    const bindingScopes = new Map<string, Scope>();
    let nextScopeId = 1;
    let nextClassId = 1;

    const createScope = (
        kind: Scope['kind'],
        parent?: Scope,
        classId?: number,
        inheritClassId = true
    ): Scope => ({
        id: nextScopeId++,
        parent,
        kind,
        classId: classId ?? (inheritClassId ? parent?.classId : undefined),
        bindings: new Map()
    });

    const declareName = (scope: Scope, name: string, node?: AstNode): string => {
        let key = scope.bindings.get(name);
        if (!key) {
            key = `binding:${scope.id}:${name}`;
            scope.bindings.set(name, key);
            bindingScopes.set(key, scope);
        }
        if (node) {
            declarations.set(node, key);
        }
        return key;
    };

    const declarePattern = (value: unknown, scope: Scope): void => {
        const node = asNode(value);
        if (!node) {
            return;
        }
        nodeScopes.set(node, scope);
        if (node.type === 'Identifier') {
            declareName(scope, readName(node), node);
            return;
        }
        if (node.type === 'TSParameterProperty') {
            declarePattern(node.parameter, scope);
            return;
        }
        if (node.type === 'AssignmentPattern') {
            declarePattern(node.left, scope);
            return;
        }
        if (node.type === 'RestElement') {
            declarePattern(node.argument, scope);
            return;
        }
        if (node.type === 'ObjectPattern') {
            for (const property of asNodes(node.properties)) {
                if (property.type === 'RestElement') {
                    declarePattern(property.argument, scope);
                }
                else {
                    declarePattern(property.value, scope);
                }
            }
            return;
        }
        if (node.type === 'ArrayPattern') {
            for (const element of asNodes(node.elements)) {
                declarePattern(element, scope);
            }
        }
    };

    const nearestVariableScope = (scope: Scope): Scope => {
        let current: Scope | undefined = scope;
        while (current && current.kind !== 'function' && current.kind !== 'program') {
            current = current.parent;
        }
        return current ?? scope;
    };

    const scanChildren = (node: AstNode, scope: Scope, skip: ReadonlySet<string>): void => {
        for (const [key, child] of Object.entries(node)) {
            if (
                skip.has(key) ||
                ['loc', 'start', 'end', 'comments', 'tokens'].includes(key)
            ) {
                continue;
            }
            scan(child, scope);
        }
    };

    const scanFunction = (node: AstNode, parent: Scope): void => {
        if (node.type === 'FunctionDeclaration') {
            const id = asNode(node.id);
            if (id) {
                declareName(parent, readName(id), id);
            }
        }
        const inheritsClassThis = [
            'ArrowFunctionExpression',
            'ClassMethod',
            'ClassPrivateMethod'
        ].includes(node.type);
        const scope = createScope('function', parent, undefined, inheritsClassThis);
        nodeScopes.set(node, scope);
        const id = asNode(node.id);
        if (id && node.type === 'FunctionExpression') {
            declareName(scope, readName(id), id);
        }
        for (const parameter of asNodes(node.params)) {
            declarePattern(parameter, scope);
        }
        scanChildren(node, scope, new Set(['id']));
    };

    const scanClass = (node: AstNode, parent: Scope): void => {
        const id = asNode(node.id);
        if (id && node.type === 'ClassDeclaration') {
            declareName(parent, readName(id), id);
        }
        const scope = createScope('class', parent, nextClassId++);
        nodeScopes.set(node, scope);
        if (id && node.type === 'ClassExpression') {
            declareName(scope, readName(id), id);
        }
        scanChildren(node, scope, new Set(['id']));
    };

    const scan = (value: unknown, scope: Scope): void => {
        if (!value || typeof value !== 'object') {
            return;
        }
        if (Array.isArray(value)) {
            for (const child of value) {
                scan(child, scope);
            }
            return;
        }
        const node = value as AstNode;
        nodeScopes.set(node, scope);
        if (isFunction(node)) {
            scanFunction(node, scope);
            return;
        }
        if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
            scanClass(node, scope);
            return;
        }
        if (node.type === 'BlockStatement' || node.type === 'StaticBlock') {
            const block = createScope('block', scope);
            nodeScopes.set(node, block);
            scanChildren(node, block, new Set());
            return;
        }
        if (node.type === 'CatchClause') {
            const catchScope = createScope('catch', scope);
            nodeScopes.set(node, catchScope);
            declarePattern(node.param, catchScope);
            scanChildren(node, catchScope, new Set(['param']));
            return;
        }
        if (node.type === 'VariableDeclaration') {
            const target = node.kind === 'var' ? nearestVariableScope(scope) : scope;
            for (const declaration of asNodes(node.declarations)) {
                declarePattern(declaration.id, target);
            }
        }
        else if (node.type === 'ImportDeclaration') {
            for (const specifier of asNodes(node.specifiers)) {
                const local = asNode(specifier.local);
                if (local) {
                    declareName(scope, readName(local), local);
                }
            }
        }
        scanChildren(node, scope, new Set());
    };

    const root = createScope('program');
    scan(program, root);

    const resolve = (node: AstNode): string => {
        const declared = declarations.get(node);
        if (declared) {
            return declared;
        }
        const name = readName(node);
        let scope = nodeScopes.get(node);
        while (scope) {
            const key = scope.bindings.get(name);
            if (key) {
                return key;
            }
            scope = scope.parent;
        }
        return name ? `unbound:${name}` : '';
    };

    const functionKey = (scope: Scope | undefined): string => {
        let current = scope;
        while (current && current.kind !== 'function' && current.kind !== 'program') {
            current = current.parent;
        }
        return current ? `function:${current.id}` : '';
    };

    return {
        identifierKey: (value) => {
            const node = asNode(value);
            return node?.type === 'Identifier' ? resolve(node) : '';
        },
        identifierFunctionKey: (value) => {
            const node = asNode(value);
            if (node?.type !== 'Identifier') {
                return '';
            }
            return functionKey(bindingScopes.get(resolve(node)));
        },
        functionKey: (value) => {
            const node = asNode(value);
            return functionKey(node && nodeScopes.get(node));
        },
        thisKey: (value) => {
            const node = asNode(value);
            let scope = node && nodeScopes.get(node);
            while (scope) {
                if (scope.classId !== undefined) {
                    return `class:${scope.classId}:this`;
                }
                if (scope.kind === 'function') {
                    return '';
                }
                scope = scope.parent;
            }
            return '';
        }
    };
}

function isFunction(node: AstNode): boolean {
    return [
        'FunctionDeclaration',
        'FunctionExpression',
        'ArrowFunctionExpression',
        'ObjectMethod',
        'ClassMethod',
        'ClassPrivateMethod'
    ].includes(node.type);
}

function readName(value: unknown): string {
    const node = asNode(value);
    return node && typeof node.name === 'string' ? node.name : '';
}

function asNode(value: unknown): AstNode | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as AstNode : undefined;
}

function asNodes(value: unknown): readonly AstNode[] {
    return Array.isArray(value)
        ? value.map(asNode).filter((node): node is AstNode => node !== undefined)
        : [];
}
