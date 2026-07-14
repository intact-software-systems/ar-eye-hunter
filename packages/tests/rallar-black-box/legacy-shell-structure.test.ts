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
        consumerPath: appPath,
        consumerModuleImport: './legacy/shell/LoginScreen.tsx',
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
        consumerPath:
            'apps/rallar-black-box/src/legacy/shell/LegacyAppShell.tsx',
        consumerModuleImport: './LegacyRunHeader.tsx',
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
        consumerPath:
            'apps/rallar-black-box/src/legacy/shell/LegacyAppShell.tsx',
        consumerModuleImport: './AppTabs.tsx',
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
        consumerPath:
            'apps/rallar-black-box/src/legacy/shell/LegacyAppShell.tsx',
        consumerModuleImport: './GlobalContextBar.tsx',
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
        consumerPath:
            'apps/rallar-black-box/src/legacy/shell/LegacyAppShell.tsx',
        consumerModuleImport: './AppModeSwitch.tsx',
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
        consumerPath:
            'apps/rallar-black-box/src/legacy/shell/LegacyDiagnosticDrawer.tsx',
        consumerModuleImport: './DirectRallarBoundaryPanel.tsx',
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
        consumerPath:
            'apps/rallar-black-box/src/legacy/shell/LegacyDiagnosticDrawer.tsx',
        consumerModuleImport: './RunnerModeBoundaryPanel.tsx',
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

const shellModelOwners = [
    {
        path: 'apps/rallar-black-box/src/legacy/runner/shell/runner-shell-model.ts',
        moduleImport: './legacy/runner/shell/runner-shell-model.ts',
        consumerPath:
            'apps/rallar-black-box/src/legacy/runner/shell/use-runner-shell-state.ts',
        consumerModuleImport: './runner-shell-model.ts',
        declarations: [
            {
                name: 'deriveQueue',
                fingerprint:
                    '2e2bf9e998f7b03da207aa95a205db27fcbbb15674e8e6f11bc459bb83b764a8',
            },
            {
                name: 'findSelectedResult',
                fingerprint:
                    'b05ea1f6e80ee9ec7be455039afc360b93de2bc2ad74558498212d5a92a80e60',
            },
        ],
        imports: [
            '../../shared/command-presentation.ts|value:commandId',
            '../runner-contracts.ts|type:CommandQueueRow',
            '@shared-test/rallar-bb-test/selectors.ts|value:selectRallarBlackBoxActiveCommand',
            '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestResult',
            '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestState',
        ],
        inventory: [
            'export-function:deriveQueue',
            'export-function:findSelectedResult',
        ],
        lineCap: 65,
    },
    {
        path: 'apps/rallar-black-box/src/legacy/shell/global-context-model.ts',
        moduleImport: './legacy/shell/global-context-model.ts',
        consumerPath:
            'apps/rallar-black-box/src/legacy/shell/use-command-center-global-context.ts',
        consumerModuleImport: './global-context-model.ts',
        declarations: [
            {
                name: 'commandCenterGlobalValuesFromState',
                fingerprint:
                    '5a50b6315dbbae744805183f03d970c5b59de016a694938c6e108d05973d988e',
            },
            {
                name: 'sameCommandCenterGlobalValues',
                fingerprint:
                    '1be5249c05b049d9f3cfe7140064749306337e4b83cfc649ea182ddd6b63f968',
            },
            {
                name: 'reconcileDiagnosticGlobalScope',
                fingerprint:
                    '36ab8a477b1b935cd8f0881e0f1a753909c453e9ecc63cd1d278c7bd50242ed8',
            },
            {
                name: 'bootstrapPatchFromGlobalValues',
                fingerprint:
                    'f3e32c3fea671e2f18692a91cfaad9400bb01e44c376a4b0cb0817254e95c75c',
            },
        ],
        imports: [
            '../../manual-workbench.ts|value:DEFAULT_MANUAL_WORKBENCH_VALUES',
            '../../runtime-store.ts|type:RallarBlackBoxBootstrapConfig',
            '../diagnostics/context/legacy-diagnostic-context.ts|type:LegacyDiagnosticContext',
            '../shared/record-value.ts|value:recordValue->optionalRecord',
            '../shared/string-value.ts|value:stringValue',
            '@shared-test/rallar-bb-test/selectors.ts|value:selectRallarBlackBoxCurrentConfig',
            '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestState',
            '@shared/api/api-config.ts|type:AuthSession',
        ],
        inventory: [
            'export-type:CommandCenterGlobalValues',
            'export-function:commandCenterGlobalValuesFromState',
            'export-function:sameCommandCenterGlobalValues',
            'export-function:reconcileDiagnosticGlobalScope',
            'export-function:bootstrapPatchFromGlobalValues',
        ],
        lineCap: 100,
    },
    {
        path: 'apps/rallar-black-box/src/legacy/shell/auth/agent-session-ticket.ts',
        moduleImport: './legacy/shell/auth/agent-session-ticket.ts',
        declarations: [
            {
                name: 'scrubAgentSessionTicketFromUrl',
                fingerprint:
                    'b317987437379cfb9d790e831d9aada8dbb04f12888d8be00bd8a4abc5f85479',
            },
            {
                name: 'consumeBootstrapAgentSessionTicket',
                fingerprint:
                    'd260fc54254279ff69f206d3a6b8385a04ce4671d4060a8f89583b68b440cd90',
            },
        ],
        variable: {
            name: 'pendingAgentSessionTicketConsume',
            fingerprint:
                '91e80d14b0cef62b4ae659ca019c847f8db4389f6799fc72c7811c8e5afeb9ad',
        },
        imports: [
            '@shared-web/browser/api-client-config.ts|value:configureApiClient',
            '@shared-web/browser/api-integration.ts|value:consumeAgentSessionTicket',
            '@shared/api/api-config.ts|type:AuthSession',
        ],
        inventory: [
            'export-function:scrubAgentSessionTicketFromUrl',
            'variable:pendingAgentSessionTicketConsume',
            'export-function:consumeBootstrapAgentSessionTicket',
        ],
        lineCap: 65,
    },
] as const;

const shellControllerOwners = [
    {
        path: 'apps/rallar-black-box/src/legacy/shell/use-legacy-navigation.ts',
        moduleImport: './legacy/shell/use-legacy-navigation.ts',
        exports: ['useLegacyNavigation'],
        fingerprints: {
            useLegacyNavigation:
                'a4deed6c27f2835a636b45ebe638a030d26fdc6bc2a9c5da85d6dedcd6110af4',
        },
        imports: [
            '../../app-tabs.ts|type:AppModeId',
            '../../app-tabs.ts|type:AppTabId',
            '../../app-tabs.ts|type:RunnerAdvancedSurfaceId',
            '../../app-tabs.ts|value:appModeForTab',
            '../../app-tabs.ts|value:appTabInMode',
            '../../app-tabs.ts|value:defaultAppTabForMode',
            '../../app-tabs.ts|value:visibleAppTabForTab',
            './navigation.ts|type:AppNavigationState',
            './navigation.ts|value:normalizeAppNavigation',
            './navigation.ts|value:readInitialAppNavigation',
            './navigation.ts|value:writeAppNavigationToUrl',
            'react|value:useEffect',
            'react|value:useState',
        ],
        hooks: { useState: 1, useMemo: 0, useRef: 0, useEffect: 1 },
        inventory: ['export-function:useLegacyNavigation'],
        staleAppPattern:
            /useState<AppNavigationState>|\bhandlePopState\b|const selectNavigation\s*=|const selectTab\s*=|const selectMode\s*=/,
        lineCap: 100,
    },
    {
        path: 'apps/rallar-black-box/src/legacy/shell/use-command-center-global-context.ts',
        moduleImport:
            './legacy/shell/use-command-center-global-context.ts',
        exports: ['useCommandCenterGlobalContext'],
        fingerprints: {
            useCommandCenterGlobalContext:
                '4a1ff099eacf963952b01801fa645647c8c6d5069bc3a1be3c9dca08708c70ac',
        },
        imports: [
            '../../runtime-store.ts|type:RallarBlackBoxBootstrapConfig',
            '../../runtime-store.ts|value:rallarBlackBoxRuntimeStore',
            '../diagnostics/context/legacy-diagnostic-context.ts|type:LegacyDiagnosticContext',
            './global-context-model.ts|type:CommandCenterGlobalValues',
            './global-context-model.ts|value:bootstrapPatchFromGlobalValues',
            './global-context-model.ts|value:commandCenterGlobalValuesFromState',
            './global-context-model.ts|value:reconcileDiagnosticGlobalScope',
            './global-context-model.ts|value:sameCommandCenterGlobalValues',
            './rallar-browser-status.ts|value:deriveRallarBrowserStatus',
            '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestState',
            '@shared/api/api-config.ts|type:AuthSession',
            'react|value:useEffect',
            'react|value:useMemo',
            'react|value:useRef',
            'react|value:useState',
        ],
        hooks: { useState: 2, useMemo: 2, useRef: 2, useEffect: 1 },
        inventory: ['export-function:useCommandCenterGlobalContext'],
        staleAppPattern:
            /useState<CommandCenterGlobalValues>|\blastGlobalAuthKey\b|const updateGlobalValue\s*=|const resetGlobalValues\s*=/,
        lineCap: 160,
    },
    {
        path: 'apps/rallar-black-box/src/legacy/runner/shell/use-runner-shell-state.ts',
        moduleImport:
            './legacy/runner/shell/use-runner-shell-state.ts',
        exports: [
            'useRunnerShellState',
            'useRunnerShellSelectionSync',
        ],
        fingerprints: {
            useRunnerShellState:
                '34a376f163c5c4567859003e102067ce1ae45cd9c6cbac85bcbb4b9e6dd47a42',
            useRunnerShellSelectionSync:
                'e4f656139d862c94d1b9f2a3ce2db6cd02b41780cd293c98328b133b7a15f67e',
            initialRunnerCommandId:
                'e3d15d77756baa23a9eb199d1e7da547dcb43f76bfe9528516281b3538e45ded',
            selectedRunnerResult:
                'aca9713869f9b781d3f10a6be7ed885355be67f4c3515a7f0cffd338fbc791c7',
        },
        imports: [
            '../../../ui-persistence.ts|value:readStoredSelectedCommandId',
            '../../../ui-persistence.ts|value:writeStoredSelectedCommandId',
            '../../diagnostics/context/legacy-diagnostic-context.ts|type:LegacyDiagnosticContext',
            '../../shared/use-now.ts|value:useNow',
            '../../shell/browser-ui-storage.ts|value:browserUiStorage',
            '../runner-contracts.ts|type:RunnerDistributedRunSelection',
            './runner-shell-model.ts|value:deriveQueue',
            './runner-shell-model.ts|value:findSelectedResult',
            '@shared-test/rallar-bb-test/selectors.ts|value:selectRallarBlackBoxActiveCommand',
            '@shared-test/rallar-bb-test/selectors.ts|value:selectRallarBlackBoxCommandHistory',
            '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestResult',
            '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestState',
            'react|type:Dispatch',
            'react|type:SetStateAction',
            'react|value:useEffect',
            'react|value:useMemo',
            'react|value:useRef',
            'react|value:useState',
        ],
        hooks: { useState: 2, useMemo: 1, useRef: 4, useEffect: 3 },
        inventory: [
            'export-function:useRunnerShellState',
            'export-function:useRunnerShellSelectionSync',
            'export-function:initialRunnerCommandId',
            'export-function:selectedRunnerResult',
        ],
        staleAppPattern:
            /useMemo\(\(\) => deriveQueue|\buseNow\(250\)|readStoredSelectedCommandId|writeStoredSelectedCommandId|useState<RunnerDistributedRunSelection/,
        lineCap: 150,
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

function namedVariable(
    file: ts.SourceFile,
    name: string,
): ts.VariableStatement | undefined {
    return file.statements.find(
        (statement): statement is ts.VariableStatement =>
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some(
                (declaration) => declaration.name.getText(file) === name,
            ),
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

function moveOnlyFingerprint(declaration: ts.Statement): string {
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
            const modifiers = ts.canHaveModifiers(statement)
                ? ts.getModifiers(statement)
                : undefined;
            const exported = modifiers?.some(
                (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
            );
            if (ts.isFunctionDeclaration(statement)) {
                return `${exported ? 'export-' : ''}function:${
                    statement.name?.text ?? '<anonymous>'
                }`;
            }
            if (ts.isTypeAliasDeclaration(statement)) {
                return `${exported ? 'export-' : ''}type:${statement.name.text}`;
            }
            if (ts.isVariableStatement(statement)) {
                return `${exported ? 'export-' : ''}variable:${statement.declarationList.declarations
                    .map((declaration) => declaration.name.getText(file))
                    .join(',')}`;
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

function legacyExperienceModuleImport(moduleImport: string): string {
    return moduleImport
        .replace('./legacy/runner/', '../runner/')
        .replace('./legacy/shell/', './');
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
    it('moves all legacy shell orchestration behind LegacyExperience', () => {
        const legacyExperiencePath =
            'apps/rallar-black-box/src/legacy/shell/LegacyExperience.tsx';
        expect(existsSync(resolve(repositoryRoot, legacyExperiencePath))).toBe(true);
        if (!existsSync(resolve(repositoryRoot, legacyExperiencePath))) return;

        const legacyExperience = repositorySource(legacyExperiencePath);
        const app = repositorySource(appPath);
        for (const name of [
            'useRunnerShellState',
            'useLegacyNavigation',
            'useCommandCenterGlobalContext',
            'ensureBootstrapped',
            'useRunnerShellSelectionSync',
        ]) {
            expect.soft(legacyExperience, `${name}: wrapper owner`).toContain(name);
            expect.soft(app, `${name}: absent from App`).not.toContain(name);
        }
    });

    it('moves each legacy shell leaf into one focused exact owner', () => {
        const appSource = repositorySource(appPath);
        const app = sourceFile(appPath, appSource);

        for (const owner of shellOwners) {
            const consumer = sourceFile(
                owner.consumerPath,
                repositorySource(owner.consumerPath),
            );
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
                importedNames(consumer, owner.consumerModuleImport),
                `${owner.consumerPath} imports ${owner.declaration} from its focused owner`,
            ).toContain(owner.declaration);
            expect.soft(
                importedNames(app, owner.moduleImport).includes(
                    owner.declaration,
                ),
                `${owner.declaration}: exact App versus composed-shell ownership`,
            ).toBe(owner.consumerPath === appPath);
            expect.soft(
                Boolean(namedFunction(app, owner.declaration)),
                `App no longer declares ${owner.declaration}`,
            ).toBe(false);
        }

        const appDeclaration = namedFunction(app, 'App');
        expect.soft(appDeclaration, 'App function remains present').toBeDefined();
        expect.soft(
            appDeclaration ? fingerprint([appDeclaration]) : '',
            'lazy experience cutover leaves App bootstrap/routing behavior exact',
        ).toBe('f3528e1553eedcfde71ef5425f0f443647d421af97bdc422d372ff287a481126');
        expect.soft(
            createHash('sha256')
                .update(repositorySource('apps/rallar-black-box/src/styles.css'))
                .digest('hex'),
            'shell extraction leaves the legacy stylesheet exact',
        ).toBe('9778cfa43e7a858b30a9304b36b2939bfbf89df2722ac05a65b97579a37640b4');
    });

    it('moves shell derivation and ticket services into exact focused owners', () => {
        const appSource = repositorySource(appPath);
        const app = sourceFile(appPath, appSource);

        for (const owner of shellModelOwners) {
            const present = existsSync(resolve(repositoryRoot, owner.path));
            expect.soft(present, `${owner.path}: focused model owner exists`).toBe(true);
            const ownerSource = present ? repositorySource(owner.path) : appSource;
            const ownerFile = sourceFile(present ? owner.path : appPath, ownerSource);
            const consumerPath = 'consumerPath' in owner
                ? owner.consumerPath
                : appPath;
            const consumer = sourceFile(
                consumerPath,
                repositorySource(consumerPath),
            );
            const consumerModuleImport = 'consumerModuleImport' in owner
                ? owner.consumerModuleImport
                : owner.moduleImport;

            for (const expectedDeclaration of owner.declarations) {
                const declaration =
                    namedFunction(ownerFile, expectedDeclaration.name) ??
                    namedFunction(app, expectedDeclaration.name);
                expect.soft(
                    declaration,
                    `${owner.path}: ${expectedDeclaration.name} exists`,
                ).toBeDefined();
                if (declaration) {
                    expect.soft(
                        moveOnlyFingerprint(declaration),
                        `${owner.path}: exact ${expectedDeclaration.name}`,
                    ).toBe(expectedDeclaration.fingerprint);
                }
                expect.soft(
                    importedNames(consumer, consumerModuleImport),
                    `${consumerPath} imports ${expectedDeclaration.name} from ${consumerModuleImport}`,
                ).toContain(expectedDeclaration.name);
                expect.soft(
                    Boolean(namedFunction(app, expectedDeclaration.name)),
                    `App no longer declares ${expectedDeclaration.name}`,
                ).toBe(false);
            }

            if ('variable' in owner) {
                const declaration =
                    namedVariable(ownerFile, owner.variable.name) ??
                    namedVariable(app, owner.variable.name);
                expect.soft(
                    declaration,
                    `${owner.path}: ${owner.variable.name} exists`,
                ).toBeDefined();
                if (declaration) {
                    expect.soft(
                        moveOnlyFingerprint(declaration),
                        `${owner.path}: exact private ticket cache`,
                    ).toBe(owner.variable.fingerprint);
                }
                expect.soft(
                    Boolean(namedVariable(app, owner.variable.name)),
                    `App no longer owns ${owner.variable.name}`,
                ).toBe(false);
            }

            if (present) {
                expect.soft(
                    importInventory(ownerFile),
                    `${owner.path}: exact model imports and kinds`,
                ).toEqual([...owner.imports].sort());
                expect.soft(
                    topLevelInventory(ownerFile),
                    `${owner.path}: exact model/export inventory`,
                ).toEqual(owner.inventory);
                expect.soft(
                    localImportCycles(owner.path),
                    `${owner.path}: acyclic model dependency graph`,
                ).toEqual([]);
                expect.soft(
                    ownerSource.trimEnd().split('\n').length,
                    `${owner.path}: focused model line cap`,
                ).toBeLessThanOrEqual(owner.lineCap);
                expect.soft(ownerSource, `${owner.path}: no App back-edge`).not.toMatch(
                    /(?:from\s+['"][^'"]*App(?:\.tsx)?['"]|import\s*\([^)]*App)/,
                );
            }
        }
    });

    it('moves shell orchestration into focused hooks without changing effect topology', () => {
        const appSource = repositorySource(appPath);
        const app = sourceFile(appPath, appSource);
        const legacyExperiencePath =
            'apps/rallar-black-box/src/legacy/shell/LegacyExperience.tsx';
        const legacyExperience = sourceFile(
            legacyExperiencePath,
            repositorySource(legacyExperiencePath),
        );

        for (const owner of shellControllerOwners) {
            const present = existsSync(resolve(repositoryRoot, owner.path));
            expect.soft(present, `${owner.path}: focused hook owner exists`).toBe(true);
            if (!present) continue;

            const ownerSource = repositorySource(owner.path);
            const ownerFile = sourceFile(owner.path, ownerSource);
            for (const exportedHook of owner.exports) {
                const declaration = namedFunction(ownerFile, exportedHook);
                expect.soft(
                    declaration,
                    `${owner.path}: ${exportedHook} exists`,
                ).toBeDefined();
                expect.soft(
                    importedNames(
                        legacyExperience,
                        legacyExperienceModuleImport(owner.moduleImport),
                    ),
                    `LegacyExperience imports ${exportedHook} from ${owner.moduleImport}`,
                ).toContain(exportedHook);
            }
            for (const [hookName, expectedFingerprint] of Object.entries(
                owner.fingerprints,
            )) {
                const declaration = namedFunction(ownerFile, hookName);
                expect.soft(
                    declaration ? moveOnlyFingerprint(declaration) : '',
                    `${owner.path}: exact ${hookName}`,
                ).toBe(expectedFingerprint);
            }
            expect.soft(
                importInventory(ownerFile),
                `${owner.path}: exact hook imports and kinds`,
            ).toEqual([...owner.imports].sort());
            expect.soft(
                topLevelInventory(ownerFile),
                `${owner.path}: exact hook export inventory`,
            ).toEqual(owner.inventory);
            expect.soft(
                localImportCycles(owner.path),
                `${owner.path}: acyclic hook dependency graph`,
            ).toEqual([]);
            expect.soft(
                ownerSource.trimEnd().split('\n').length,
                `${owner.path}: focused hook line cap`,
            ).toBeLessThanOrEqual(owner.lineCap);
            expect.soft(ownerSource, `${owner.path}: no App back-edge`).not.toMatch(
                /(?:from\s+['"][^'"]*App(?:\.tsx)?['"]|import\s*\([^)]*App)/,
            );
            expect.soft(
                ownerSource,
                `${owner.path}: controller stays free of panels, JSX, CSS, and callback memoization`,
            ).not.toMatch(/\b(?:[A-Z][A-Za-z]+Panel|[A-Z][A-Za-z]+Section|useCallback|Suspense|lazy)\b|\.css['"]/);
            for (const [hookName, expectedCount] of Object.entries(owner.hooks)) {
                expect.soft(
                    hookCount(ownerFile, hookName),
                    `${owner.path}: exact ${hookName} topology`,
                ).toBe(expectedCount);
            }
            expect.soft(
                appSource,
                `${owner.path}: App no longer owns moved orchestration`,
            ).not.toMatch(owner.staleAppPattern);
        }

        const appDeclaration = namedFunction(app, 'App');
        expect.soft(appDeclaration, 'App function remains present').toBeDefined();
        if (appDeclaration?.body) {
            expect.soft(
                {
                    useState: hookCount(appDeclaration, 'useState'),
                    useMemo: hookCount(appDeclaration, 'useMemo'),
                    useRef: hookCount(appDeclaration, 'useRef'),
                    useEffect: hookCount(appDeclaration, 'useEffect'),
                },
                'App direct hook topology after controller cutover',
            ).toEqual({
                useState: 3,
                useMemo: 0,
                useRef: 0,
                useEffect: 3,
            });

            const orderedHookNames: string[] = [];
            const trackedHooks = new Set([
                'useRallarBlackBoxRuntimeStore',
                'useExperienceRoute',
                'useRunnerShellState',
                'useLegacyNavigation',
                'useState',
                'useEffect',
                'useCommandCenterGlobalContext',
                'useRunnerShellSelectionSync',
            ]);
            for (const statement of appDeclaration.body.statements) {
                const calls: ts.CallExpression[] = [];
                const visit = (node: ts.Node): void => {
                    if (
                        ts.isCallExpression(node) &&
                        ts.isIdentifier(node.expression) &&
                        trackedHooks.has(node.expression.text)
                    ) {
                        calls.push(node);
                    }
                    ts.forEachChild(node, visit);
                };
                visit(statement);
                orderedHookNames.push(
                    ...calls
                        .sort((left, right) => left.pos - right.pos)
                        .map((call) => (call.expression as ts.Identifier).text),
                );
            }
            expect.soft(
                orderedHookNames,
                'App preserves transitive effect-registration order',
            ).toEqual([
                'useRallarBlackBoxRuntimeStore',
                'useState',
                'useState',
                'useState',
                'useExperienceRoute',
                'useEffect',
                'useEffect',
                'useEffect',
            ]);
        }
        expect.soft(
            {
                useRunnerShellState: hookCount(
                    legacyExperience,
                    'useRunnerShellState',
                ),
                useLegacyNavigation: hookCount(
                    legacyExperience,
                    'useLegacyNavigation',
                ),
                useCommandCenterGlobalContext: hookCount(
                    legacyExperience,
                    'useCommandCenterGlobalContext',
                ),
                useEffect: hookCount(legacyExperience, 'useEffect'),
                useRunnerShellSelectionSync: hookCount(
                    legacyExperience,
                    'useRunnerShellSelectionSync',
                ),
            },
            'LegacyExperience owns the moved controller registration topology',
        ).toEqual({
            useRunnerShellState: 1,
            useLegacyNavigation: 1,
            useCommandCenterGlobalContext: 1,
            useEffect: 1,
            useRunnerShellSelectionSync: 1,
        });
        expect.soft(
            appSource.trimEnd().split('\n').length,
            'App clears the Iteration 1 below-800 checkpoint',
        ).toBeLessThan(800);
    });
});
