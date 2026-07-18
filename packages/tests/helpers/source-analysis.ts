import { parse } from '@babel/parser';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export type SourceNamedImport = Readonly<{
    imported: string;
    local: string;
    typeOnly: boolean;
}>;

export type SourceImport = Readonly<{
    specifier: string;
    typeOnly: boolean;
    sideEffectOnly: boolean;
    defaultImport?: string;
    namespaceImport?: string;
    namedImports: readonly SourceNamedImport[];
}>;

export type SourceExport = Readonly<{
    kind: 'named' | 'star' | 'namespace' | 'declaration' | 'default';
    exportedName?: string;
    localName?: string;
    specifier?: string;
    typeOnly: boolean;
}>;

export type SourceDeclaration = Readonly<{
    name: string;
    kind: 'value' | 'type' | 'class';
    exported: boolean;
    defaultExport: boolean;
}>;

export type SourceAnalysis = Readonly<{
    imports: readonly SourceImport[];
    exports: readonly SourceExport[];
    dynamicImports: readonly Readonly<{
        specifier?: string;
        literal: boolean;
    }>[];
    topLevelDeclarations: readonly SourceDeclaration[];
    identifierNames: readonly string[];
}>;

type AstNode = Readonly<{
    type: string;
    [key: string]: unknown;
}>;

const TYPESCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;
const WALK_IGNORED_KEYS = new Set([
    'type',
    'start',
    'end',
    'loc',
    'extra',
    'errors',
    'comments',
    'tokens',
]);

export function analyzeSource(source: string, filePath: string): SourceAnalysis {
    let body: readonly AstNode[];

    try {
        const extension = path.extname(filePath).toLowerCase();
        const plugins: string[] = ['typescript', 'importAttributes'];
        if (extension === '.tsx' || extension === '.jsx') {
            plugins.unshift('jsx');
        }

        const parsed = parse(source, {
            sourceType: 'module',
            sourceFilename: filePath,
            createImportExpressions: true,
            plugins,
        });
        body = parsed.program.body as unknown as readonly AstNode[];
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to parse ${displayPath(filePath)}: ${message}`, {
            cause: error,
        });
    }

    const imports: SourceImport[] = [];
    const exports: SourceExport[] = [];
    const topLevelDeclarations: SourceDeclaration[] = [];

    for (const statement of body) {
        if (statement.type === 'ImportDeclaration') {
            imports.push(normalizeImport(statement));
            continue;
        }

        if (statement.type === 'ExportNamedDeclaration') {
            normalizeNamedExport(statement, exports, topLevelDeclarations);
            continue;
        }

        if (statement.type === 'ExportAllDeclaration') {
            normalizeAllExport(statement, exports);
            continue;
        }

        if (statement.type === 'ExportDefaultDeclaration') {
            normalizeDefaultExport(statement, exports, topLevelDeclarations);
            continue;
        }

        topLevelDeclarations.push(
            ...normalizeDeclarations(statement, false, false),
        );
    }

    const dynamicImports: Array<{
        specifier?: string;
        literal: boolean;
    }> = [];
    const identifierNames: string[] = [];

    for (const statement of body) {
        walkAst(statement, (node) => {
            if (node.type === 'Identifier' && typeof node.name === 'string') {
                identifierNames.push(node.name);
            }

            if (node.type === 'ImportExpression') {
                dynamicImports.push(normalizeDynamicImport(node.source));
                return;
            }

            if (
                node.type === 'CallExpression' &&
                isAstNode(node.callee) &&
                node.callee.type === 'Import'
            ) {
                const [argument] = Array.isArray(node.arguments)
                    ? node.arguments
                    : [];
                dynamicImports.push(normalizeDynamicImport(argument));
            }
        });
    }

    return {
        imports,
        exports,
        dynamicImports,
        topLevelDeclarations,
        identifierNames,
    };
}

export function analyzeSourceFile(filePath: string): SourceAnalysis {
    return analyzeSource(readFileSync(filePath, 'utf8'), filePath);
}

export function resolveRelativeTypeScriptDependency(
    importerPath: string,
    specifier: string,
): string | undefined {
    if (!specifier.startsWith('.')) {
        return undefined;
    }

    const unresolvedPath = path.resolve(path.dirname(importerPath), specifier);
    const explicitExtension = path.extname(unresolvedPath);
    if (explicitExtension) {
        return isTypeScriptExtension(explicitExtension) && isFile(unresolvedPath)
            ? unresolvedPath
            : undefined;
    }

    const candidates = [
        ...TYPESCRIPT_EXTENSIONS.map(
            (extension) => `${unresolvedPath}${extension}`,
        ),
        ...TYPESCRIPT_EXTENSIONS.map((extension) =>
            path.join(unresolvedPath, `index${extension}`),
        ),
    ];

    return candidates.find(isFile);
}

export function buildRelativeTypeScriptGraph(
    entryPaths: readonly string[],
): ReadonlyMap<string, readonly string[]> {
    const graph = new Map<string, readonly string[]>();
    const pending = [...new Set(entryPaths.map((entryPath) => path.resolve(entryPath)))]
        .sort()
        .reverse();

    while (pending.length > 0) {
        const filePath = pending.pop();
        if (!filePath || graph.has(filePath)) {
            continue;
        }

        const analysis = analyzeSourceFile(filePath);
        const moduleSpecifiers = [
            ...analysis.imports.map((entry) => entry.specifier),
            ...analysis.exports.flatMap((entry) =>
                entry.specifier ? [entry.specifier] : [],
            ),
        ];
        const dependencies = [
            ...new Set(
                moduleSpecifiers.flatMap((specifier) => {
                    const dependency = resolveRelativeTypeScriptDependency(
                        filePath,
                        specifier,
                    );
                    return dependency ? [dependency] : [];
                }),
            ),
        ].sort();

        graph.set(filePath, dependencies);
        for (const dependency of [...dependencies].reverse()) {
            if (!graph.has(dependency)) {
                pending.push(dependency);
            }
        }
    }

    return graph;
}

export function findDependencyCycles(
    graph: ReadonlyMap<string, readonly string[]>,
): readonly (readonly string[])[] {
    const state = new Map<string, 'visiting' | 'visited'>();
    const stack: string[] = [];
    const stackIndexes = new Map<string, number>();
    const cycles = new Map<string, readonly string[]>();

    function visit(filePath: string): void {
        state.set(filePath, 'visiting');
        stackIndexes.set(filePath, stack.length);
        stack.push(filePath);

        for (const dependency of [...(graph.get(filePath) ?? [])].sort()) {
            if (!graph.has(dependency)) {
                continue;
            }

            const dependencyState = state.get(dependency);
            if (!dependencyState) {
                visit(dependency);
                continue;
            }

            if (dependencyState === 'visiting') {
                const cycleStart = stackIndexes.get(dependency);
                if (cycleStart !== undefined) {
                    const cycle = canonicalizeCycle([
                        ...stack.slice(cycleStart),
                        dependency,
                    ]);
                    cycles.set(cycle.join('\u0000'), cycle);
                }
            }
        }

        stack.pop();
        stackIndexes.delete(filePath);
        state.set(filePath, 'visited');
    }

    for (const filePath of [...graph.keys()].sort()) {
        if (!state.has(filePath)) {
            visit(filePath);
        }
    }

    return [...cycles.values()].sort((left, right) =>
        left.join('\u0000').localeCompare(right.join('\u0000')),
    );
}

function normalizeImport(statement: AstNode): SourceImport {
    const importTypeOnly = statement.importKind === 'type';
    const specifiers = Array.isArray(statement.specifiers)
        ? statement.specifiers.filter(isAstNode)
        : [];
    let defaultImport: string | undefined;
    let namespaceImport: string | undefined;
    const namedImports: SourceNamedImport[] = [];

    for (const specifier of specifiers) {
        const localName = readNodeName(specifier.local);
        if (specifier.type === 'ImportDefaultSpecifier') {
            defaultImport = localName;
            continue;
        }
        if (specifier.type === 'ImportNamespaceSpecifier') {
            namespaceImport = localName;
            continue;
        }
        if (specifier.type === 'ImportSpecifier' && localName) {
            namedImports.push({
                imported: readNodeName(specifier.imported) ?? localName,
                local: localName,
                typeOnly: importTypeOnly || specifier.importKind === 'type',
            });
        }
    }

    return {
        specifier: readStringValue(statement.source) ?? '',
        typeOnly: importTypeOnly,
        sideEffectOnly: specifiers.length === 0,
        defaultImport,
        namespaceImport,
        namedImports,
    };
}

function normalizeNamedExport(
    statement: AstNode,
    exports: SourceExport[],
    declarations: SourceDeclaration[],
): void {
    const declaration = isAstNode(statement.declaration)
        ? statement.declaration
        : undefined;
    if (declaration) {
        const normalizedDeclarations = normalizeDeclarations(
            declaration,
            true,
            false,
        );
        declarations.push(...normalizedDeclarations);
        for (const normalized of normalizedDeclarations) {
            exports.push({
                kind: 'declaration',
                exportedName: normalized.name,
                localName: normalized.name,
                typeOnly: normalized.kind === 'type',
            });
        }
    }

    const statementTypeOnly = statement.exportKind === 'type';
    const source = readStringValue(statement.source);
    const specifiers = Array.isArray(statement.specifiers)
        ? statement.specifiers.filter(isAstNode)
        : [];

    for (const specifier of specifiers) {
        if (specifier.type === 'ExportNamespaceSpecifier') {
            exports.push({
                kind: 'namespace',
                exportedName: readNodeName(specifier.exported),
                specifier: source,
                typeOnly: statementTypeOnly || specifier.exportKind === 'type',
            });
            continue;
        }

        if (specifier.type === 'ExportSpecifier') {
            exports.push({
                kind: 'named',
                exportedName: readNodeName(specifier.exported),
                localName: readNodeName(specifier.local),
                specifier: source,
                typeOnly: statementTypeOnly || specifier.exportKind === 'type',
            });
        }
    }
}

function normalizeAllExport(
    statement: AstNode,
    exports: SourceExport[],
): void {
    const exportedName = readNodeName(statement.exported);
    exports.push({
        kind: exportedName ? 'namespace' : 'star',
        exportedName,
        specifier: readStringValue(statement.source),
        typeOnly: statement.exportKind === 'type',
    });
}

function normalizeDefaultExport(
    statement: AstNode,
    exports: SourceExport[],
    declarations: SourceDeclaration[],
): void {
    const declaration = isAstNode(statement.declaration)
        ? statement.declaration
        : undefined;
    const normalizedDeclarations = declaration
        ? normalizeDeclarations(declaration, true, true)
        : [];
    declarations.push(...normalizedDeclarations);

    exports.push({
        kind: 'default',
        exportedName: 'default',
        localName:
            normalizedDeclarations[0]?.name ?? readNodeName(statement.declaration),
        typeOnly: false,
    });
}

function normalizeDeclarations(
    node: AstNode,
    exported: boolean,
    defaultExport: boolean,
): readonly SourceDeclaration[] {
    if (node.type === 'VariableDeclaration') {
        const declarators = Array.isArray(node.declarations)
            ? node.declarations.filter(isAstNode)
            : [];
        return declarators.flatMap((declarator) =>
            readBindingNames(declarator.id).map((name) => ({
                name,
                kind: 'value' as const,
                exported,
                defaultExport,
            })),
        );
    }

    const name = readNodeName(node.id);
    if (!name) {
        return [];
    }

    if (
        node.type === 'TSInterfaceDeclaration' ||
        node.type === 'TSTypeAliasDeclaration'
    ) {
        return [{ name, kind: 'type', exported, defaultExport }];
    }

    if (node.type === 'ClassDeclaration') {
        return [{ name, kind: 'class', exported, defaultExport }];
    }

    if (
        node.type === 'FunctionDeclaration' ||
        node.type === 'TSEnumDeclaration' ||
        node.type === 'TSModuleDeclaration' ||
        node.type === 'TSDeclareFunction'
    ) {
        return [{ name, kind: 'value', exported, defaultExport }];
    }

    return [];
}

function readBindingNames(value: unknown): readonly string[] {
    if (!isAstNode(value)) {
        return [];
    }
    if (value.type === 'Identifier') {
        return typeof value.name === 'string' ? [value.name] : [];
    }
    if (value.type === 'RestElement') {
        return readBindingNames(value.argument);
    }
    if (value.type === 'AssignmentPattern') {
        return readBindingNames(value.left);
    }
    if (value.type === 'ObjectPattern') {
        return (Array.isArray(value.properties) ? value.properties : []).flatMap(
            (property) => {
                if (!isAstNode(property)) {
                    return [];
                }
                return property.type === 'RestElement'
                    ? readBindingNames(property.argument)
                    : readBindingNames(property.value);
            },
        );
    }
    if (value.type === 'ArrayPattern') {
        return (Array.isArray(value.elements) ? value.elements : []).flatMap(
            readBindingNames,
        );
    }
    return [];
}

function normalizeDynamicImport(
    source: unknown,
): Readonly<{ specifier?: string; literal: boolean }> {
    const specifier = readStringValue(source);
    return specifier === undefined
        ? { specifier: undefined, literal: false }
        : { specifier, literal: true };
}

function walkAst(node: AstNode, visit: (node: AstNode) => void): void {
    visit(node);
    for (const [key, value] of Object.entries(node)) {
        if (WALK_IGNORED_KEYS.has(key)) {
            continue;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                if (isAstNode(item)) {
                    walkAst(item, visit);
                }
            }
            continue;
        }
        if (isAstNode(value)) {
            walkAst(value, visit);
        }
    }
}

function readNodeName(value: unknown): string | undefined {
    if (!isAstNode(value)) {
        return undefined;
    }
    if (value.type === 'Identifier' && typeof value.name === 'string') {
        return value.name;
    }
    return readStringValue(value);
}

function readStringValue(value: unknown): string | undefined {
    return isAstNode(value) &&
        (value.type === 'StringLiteral' || value.type === 'Literal') &&
        typeof value.value === 'string'
        ? value.value
        : undefined;
}

function isAstNode(value: unknown): value is AstNode {
    return (
        typeof value === 'object' &&
        value !== null &&
        'type' in value &&
        typeof value.type === 'string'
    );
}

function isTypeScriptExtension(extension: string): boolean {
    return TYPESCRIPT_EXTENSIONS.includes(
        extension as (typeof TYPESCRIPT_EXTENSIONS)[number],
    );
}

function isFile(filePath: string): boolean {
    if (!existsSync(filePath)) {
        return false;
    }
    try {
        return statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function canonicalizeCycle(cycle: readonly string[]): readonly string[] {
    const members = cycle.slice(0, -1);
    if (members.length === 0) {
        return cycle;
    }

    const rotations = members.map((_, index) => [
        ...members.slice(index),
        ...members.slice(0, index),
    ]);
    rotations.sort((left, right) =>
        left.join('\u0000').localeCompare(right.join('\u0000')),
    );
    const canonicalMembers = rotations[0];
    return [...canonicalMembers, canonicalMembers[0]];
}

function displayPath(filePath: string): string {
    const absolutePath = path.resolve(filePath);
    const relativePath = path.relative(process.cwd(), absolutePath);
    return relativePath.startsWith('..') ? filePath : relativePath;
}
