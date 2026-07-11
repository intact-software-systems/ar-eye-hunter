import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const appPath = 'apps/rallar-black-box/src/App.tsx';

const shellOwners = [
    {
        path: 'apps/rallar-black-box/src/legacy/shell/LoginScreen.tsx',
        moduleImport: './legacy/shell/LoginScreen.tsx',
        declaration: 'LoginScreen',
        fingerprint:
            '00541599fa2ef974423764969ca9efc874c48b8a9fbaf7e65d0e4d6faec84818',
        useState: 6,
        lineCap: 150,
        imports: [
            '../../auth-flow.ts|value:authErrorMessage',
            '../../auth-flow.ts|value:authenticateRallarBlackBox',
            '../../auth-flow.ts|value:bootstrapPatchFromAuthSession',
            '../../runtime-store.ts|type:RallarBlackBoxBootstrapConfig',
            '../../runtime-store.ts|value:rallarBlackBoxRuntimeStore',
            '../rallar/load-browser-rallar-facade.ts|value:loadBrowserRallarFacade',
            '@shared/api/api-config.ts|type:AuthSession',
            'react|type:FormEvent',
            'react|value:useState',
        ],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/shell/LegacyRunHeader.tsx',
        moduleImport: './legacy/shell/LegacyRunHeader.tsx',
        declaration: 'Header',
        fingerprint:
            '09cf171725109c1aa6dd0ac2897e4db0c89066360c1c24d3b53b6cf52df8039d',
        useState: 1,
        lineCap: 205,
        imports: [
            '../../app-tabs.ts|type:AppModeId',
            '../../control-client.ts|type:RallarBlackBoxControlSnapshot',
            '../../runtime-store.ts|type:RallarBlackBoxBootstrapConfig',
            '../../runtime-store.ts|value:rallarBlackBoxProviderModeFromConfig',
            '../../runtime-store.ts|value:rallarBlackBoxRuntimeStore',
            '../shared/Metric.tsx|value:Metric',
            '../shared/command-presentation.ts|value:statusTone',
            './global-context-model.ts|type:CommandCenterGlobalValues',
            './rallar-browser-status.ts|type:RallarBrowserStatusSummary',
            '@shared-test/rallar-bb-test/selectors.ts|value:selectRallarBlackBoxActiveCommand',
            '@shared-test/rallar-bb-test/selectors.ts|value:selectRallarBlackBoxCurrentConfig',
            '@shared-test/rallar-bb-test/selectors.ts|value:selectRallarBlackBoxFirstFailure',
            '@shared-test/rallar-bb-test/selectors.ts|value:selectRallarBlackBoxLatestStats',
            '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestState',
            '@shared/api/api-config.ts|type:AuthSession',
            'react|value:useState',
        ],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/shell/AppTabs.tsx',
        moduleImport: './legacy/shell/AppTabs.tsx',
        declaration: 'AppTabs',
        fingerprint:
            '262e375113bf1e7a6407eb8c23b78e0f2276199cb5640fd805ea6de67585fe25',
        useState: 0,
        lineCap: 65,
        imports: [
            '../../app-tabs.ts|type:AppModeId',
            '../../app-tabs.ts|type:AppTabId',
            '../../app-tabs.ts|value:APP_MODES',
            '../../app-tabs.ts|value:appTabsForMode',
            '../../app-tabs.ts|value:nextAppTab',
            'react|type:KeyboardEvent',
        ],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/shell/GlobalContextBar.tsx',
        moduleImport: './legacy/shell/GlobalContextBar.tsx',
        declaration: 'GlobalContextBar',
        fingerprint:
            '10f27f7991906445cbc85c6815b41378a54563ca3b3ae1e6302f85585fcb93be',
        useState: 1,
        lineCap: 125,
        imports: [
            './global-context-model.ts|type:CommandCenterGlobalValues',
            '@shared/api/api-config.ts|type:AuthSession',
            'react|value:useState',
        ],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/shell/AppModeSwitch.tsx',
        moduleImport: './legacy/shell/AppModeSwitch.tsx',
        declaration: 'AppModeSwitch',
        fingerprint:
            '53b5572be9f7bb77d08e85dbc568cc142c1b9895228b06e4cf573d0f4bb8e3ea',
        useState: 0,
        lineCap: 50,
        imports: [
            '../../app-tabs.ts|type:AppModeId',
            '../../app-tabs.ts|value:APP_MODES',
        ],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/shell/DirectRallarBoundaryPanel.tsx',
        moduleImport: './legacy/shell/DirectRallarBoundaryPanel.tsx',
        declaration: 'DirectRallarBoundaryPanel',
        fingerprint:
            'ec3334cb986182cd339aed46eacbe2c22e14859cad400f9f64e14f9eee83308a',
        useState: 3,
        lineCap: 215,
        imports: [
            '../../client-defaults.ts|value:RALLAR_BLACK_BOX_CLIENT_DEFAULTS',
            '../../direct-rallar-operations.ts|type:DirectRallarOperationResult',
            '../../direct-rallar-operations.ts|value:runDirectRallarStatusCheck',
            '../../runtime-store.ts|type:RallarBlackBoxBootstrapConfig',
            '../../runtime-store.ts|value:rallarBlackBoxRuntimeStore',
            '../rallar/load-browser-rallar-facade.ts|value:loadBrowserRallarFacade',
            '../shared/Metric.tsx|value:Metric',
            '../shared/record-value.ts|value:recordValue->optionalRecord',
            '../shared/redaction-presentation.ts|value:redactedJson',
            '../shared/time-format.ts|value:formatDuration',
            './global-context-model.ts|type:CommandCenterGlobalValues',
            '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestState',
            '@shared/api/api-config.ts|type:AuthSession',
            'react|value:useState',
        ],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/shell/RunnerModeBoundaryPanel.tsx',
        moduleImport: './legacy/shell/RunnerModeBoundaryPanel.tsx',
        declaration: 'RunnerModeBoundaryPanel',
        fingerprint:
            'f20f244a20a5cbb7bd406ba8c431bd1a4a8c4ef26146a36f756f29e56e5651b4',
        useState: 0,
        lineCap: 45,
        imports: [
            '../../control-client.ts|type:RallarBlackBoxControlSnapshot',
            '../shared/Metric.tsx|value:Metric',
        ],
    },
] as const;

const astTextKinds = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.Identifier,
    ts.SyntaxKind.PrivateIdentifier,
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NumericLiteral,
    ts.SyntaxKind.BigIntLiteral,
    ts.SyntaxKind.RegularExpressionLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.JsxText,
]);

function repositorySource(path: string): string {
    return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

function sourceFile(path: string, source: string): ts.SourceFile {
    return ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
    );
}

function namedFunction(
    file: ts.SourceFile,
    name: string,
): ts.FunctionDeclaration | undefined {
    return file.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    );
}

function astShape(node: ts.Node): string {
    const text = astTextKinds.has(node.kind)
        ? String((node as ts.Node & { text: string }).text)
        : '';
    const children = node
        .getChildren(node.getSourceFile())
        .map((child) => astShape(child));
    return `(${node.kind}:${JSON.stringify(text)}${children.join('')})`;
}

function fingerprint(nodes: readonly ts.Node[]): string {
    return createHash('sha256')
        .update(nodes.map((node) => astShape(node)).join('\n'))
        .digest('hex');
}

function moveOnlyFingerprint(declaration: ts.FunctionDeclaration): string {
    const declarationSource = declaration
        .getText(declaration.getSourceFile())
        .replace(/^export\s+/, '');
    const reparsed = sourceFile(declaration.getSourceFile().fileName, declarationSource);
    return reparsed.statements[0] ? fingerprint([reparsed.statements[0]]) : '';
}

function importInventory(file: ts.SourceFile): readonly string[] {
    const imports: string[] = [];
    for (const declaration of file.statements.filter(ts.isImportDeclaration)) {
        if (!ts.isStringLiteral(declaration.moduleSpecifier)) continue;
        const moduleImport = declaration.moduleSpecifier.text;
        const clause = declaration.importClause;
        if (!clause) {
            imports.push(`${moduleImport}|side-effect`);
            continue;
        }
        if (clause.name) {
            imports.push(
                `${moduleImport}|${clause.isTypeOnly ? 'type' : 'value'}:default->${clause.name.text}`,
            );
        }
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
            imports.push(
                `${moduleImport}|${clause.isTypeOnly ? 'type' : 'value'}:*->${bindings.name.text}`,
            );
        }
        if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
                const kind = clause.isTypeOnly || element.isTypeOnly
                    ? 'type'
                    : 'value';
                const importedName = element.propertyName?.text ?? element.name.text;
                const localName = element.name.text;
                imports.push(
                    `${moduleImport}|${kind}:${importedName}${
                        importedName === localName ? '' : `->${localName}`
                    }`,
                );
            }
        }
    }
    return imports.sort();
}

function topLevelInventory(file: ts.SourceFile): readonly string[] {
    return file.statements
        .filter((statement) => !ts.isImportDeclaration(statement))
        .map((statement) => {
            const exported = statement.modifiers?.some(
                (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
            );
            if (ts.isFunctionDeclaration(statement)) {
                return `${exported ? 'export-' : ''}function:${
                    statement.name?.text ?? '<anonymous>'
                }`;
            }
            return `${exported ? 'export-' : ''}${ts.SyntaxKind[statement.kind]}`;
        });
}

function localImportPaths(path: string): readonly string[] {
    const file = sourceFile(path, repositorySource(path));
    return file.statements
        .filter(ts.isImportDeclaration)
        .flatMap((declaration) => {
            if (
                !ts.isStringLiteral(declaration.moduleSpecifier) ||
                !declaration.moduleSpecifier.text.startsWith('.')
            ) {
                return [];
            }
            const absolutePath = resolve(
                repositoryRoot,
                dirname(path),
                declaration.moduleSpecifier.text,
            );
            return existsSync(absolutePath)
                ? [relative(repositoryRoot, absolutePath)]
                : [];
        });
}

function localImportCycles(rootPath: string): readonly string[] {
    const visited = new Set<string>();
    const active: string[] = [];
    const cycles = new Set<string>();
    const visit = (path: string): void => {
        const activeIndex = active.indexOf(path);
        if (activeIndex >= 0) {
            cycles.add([...active.slice(activeIndex), path].join(' -> '));
            return;
        }
        if (visited.has(path)) return;
        active.push(path);
        for (const dependency of localImportPaths(path)) visit(dependency);
        active.pop();
        visited.add(path);
    };
    visit(rootPath);
    return [...cycles].sort();
}

function importedNames(file: ts.SourceFile, moduleImport: string): readonly string[] {
    const declaration = file.statements.find(
        (statement): statement is ts.ImportDeclaration =>
            ts.isImportDeclaration(statement) &&
            ts.isStringLiteral(statement.moduleSpecifier) &&
            statement.moduleSpecifier.text === moduleImport,
    );
    const bindings = declaration?.importClause?.namedBindings;
    return bindings && ts.isNamedImports(bindings)
        ? bindings.elements.map((element) => element.name.text)
        : [];
}

function hookCount(root: ts.Node, hookName: string): number {
    let count = 0;
    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === hookName
        ) {
            count += 1;
        }
        ts.forEachChild(node, visit);
    };
    visit(root);
    return count;
}

describe('rallar-black-box legacy shell ownership', () => {
    it('moves each legacy shell leaf into one focused exact owner', () => {
        const appSource = repositorySource(appPath);
        const app = sourceFile(appPath, appSource);

        for (const owner of shellOwners) {
            const present = existsSync(resolve(repositoryRoot, owner.path));
            expect.soft(present, `${owner.path}: focused owner exists`).toBe(true);

            const ownerSource = present ? repositorySource(owner.path) : appSource;
            const ownerFile = sourceFile(present ? owner.path : appPath, ownerSource);
            const declaration = namedFunction(ownerFile, owner.declaration);
            expect.soft(declaration, `${owner.declaration}: declaration exists`).toBeDefined();
            if (declaration) {
                expect.soft(
                    moveOnlyFingerprint(declaration),
                    `${owner.declaration}: exact move-only component`,
                ).toBe(owner.fingerprint);
                expect.soft(
                    hookCount(declaration, 'useState'),
                    `${owner.declaration}: exact local state topology`,
                ).toBe(owner.useState);
                expect.soft(
                    hookCount(declaration, 'useEffect'),
                    `${owner.declaration}: no hidden lifecycle was introduced`,
                ).toBe(0);
            }

            if (present) {
                expect.soft(
                    importInventory(ownerFile),
                    `${owner.path}: exact import edges and kinds`,
                ).toEqual([...owner.imports].sort());
                expect.soft(
                    topLevelInventory(ownerFile),
                    `${owner.path}: exact non-import/export inventory`,
                ).toEqual([`export-function:${owner.declaration}`]);
                expect.soft(
                    localImportCycles(owner.path),
                    `${owner.path}: acyclic transitive local DAG`,
                ).toEqual([]);
                expect.soft(
                    ownerSource.trimEnd().split('\n').length,
                    `${owner.path}: focused line cap`,
                ).toBeLessThanOrEqual(owner.lineCap);
                expect.soft(ownerSource, `${owner.path}: no App back-edge`).not.toMatch(
                    /(?:from\s+['"][^'"]*App(?:\.tsx)?['"]|import\s*\([^)]*App)/,
                );
                expect.soft(
                    declaration?.modifiers?.some(
                        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
                    ),
                    `${owner.declaration}: named public owner export`,
                ).toBe(true);
            }

            expect.soft(
                importedNames(app, owner.moduleImport),
                `App imports ${owner.declaration} from its focused owner`,
            ).toContain(owner.declaration);
            expect.soft(
                Boolean(namedFunction(app, owner.declaration)),
                `App no longer declares ${owner.declaration}`,
            ).toBe(false);
        }

        const appDeclaration = namedFunction(app, 'App');
        expect.soft(appDeclaration, 'App function remains present').toBeDefined();
        expect.soft(
            appDeclaration ? fingerprint([appDeclaration]) : '',
            'shell extraction leaves App bootstrap/routing behavior exact',
        ).toBe('9359ca185437ff49b62e1f643f86119ef5a8419a9fe887e4f183e3d82ef96f33');
        expect.soft(
            createHash('sha256')
                .update(repositorySource('apps/rallar-black-box/src/styles.css'))
                .digest('hex'),
            'shell extraction leaves the legacy stylesheet exact',
        ).toBe('9778cfa43e7a858b30a9304b36b2939bfbf89df2722ac05a65b97579a37640b4');
    });
});
