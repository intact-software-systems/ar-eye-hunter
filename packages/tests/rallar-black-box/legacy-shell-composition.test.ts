import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const appPath = 'apps/rallar-black-box/src/App.tsx';
const shellRoot = 'apps/rallar-black-box/src/legacy/shell';
const compositionOwners = [
    { path: `${shellRoot}/legacy-shell-contracts.ts`, cap: 70 },
    { path: `${shellRoot}/LegacyAppShell.tsx`, cap: 180 },
    { path: `${shellRoot}/LegacyDiagnosticDrawer.tsx`, cap: 90 },
    { path: `${shellRoot}/tabs/RunnerWorkspaceTabPanels.tsx`, cap: 190 },
    { path: `${shellRoot}/tabs/DirectConnectionTabPanels.tsx`, cap: 210 },
    { path: `${shellRoot}/tabs/DirectResourceTabPanels.tsx`, cap: 100 },
    { path: `${shellRoot}/tabs/RunnerCompatibilityTabPanels.tsx`, cap: 130 },
    { path: `${shellRoot}/tabs/DiagnosticEvidenceTabPanels.tsx`, cap: 140 },
    { path: `${shellRoot}/tabs/LegacyCompatibilityTailTabPanels.tsx`, cap: 80 },
] as const;
const tabGroupPaths = compositionOwners
    .map((owner) => owner.path)
    .filter((path) => path.includes('/tabs/'));
const expectedTabGroupOrder = [
    'RunnerWorkspaceTabPanels',
    'DirectConnectionTabPanels',
    'DirectResourceTabPanels',
    'RunnerCompatibilityTabPanels',
    'DiagnosticEvidenceTabPanels',
    'LegacyCompatibilityTailTabPanels',
] as const;
const expectedSectionIds = [
    'panel-recipes',
    'panel-runs',
    'panel-fleet',
    'panel-builder',
    'panel-advanced',
    'panel-quick-test',
    'panel-auth',
    'legacy-panel-manual-rallar',
    'panel-rooms-clients',
    'panel-websocket',
    'panel-rtc-realtime',
    'panel-topology',
    'panel-rtc-diagnostics',
    'panel-rallar-data',
    'panel-crdt-health',
    'panel-media',
    'legacy-panel-local-workbench',
    'legacy-panel-run-manager',
    'legacy-panel-distributed-recipes',
    'panel-rallar-trace',
    'panel-event-stream',
    'panel-rallar-server',
    'legacy-panel-flow-builder',
    'legacy-panel-shared-test',
] as const;
const expectedSectionsByGroup = new Map<string, readonly string[]>([
    [tabGroupPaths[0], expectedSectionIds.slice(0, 5)],
    [tabGroupPaths[1], expectedSectionIds.slice(5, 13)],
    [tabGroupPaths[2], expectedSectionIds.slice(13, 16)],
    [tabGroupPaths[3], expectedSectionIds.slice(16, 19)],
    [tabGroupPaths[4], expectedSectionIds.slice(19, 22)],
    [tabGroupPaths[5], expectedSectionIds.slice(22, 24)],
]);
const expectedHiddenExpressions = new Map<string, string>(
    expectedSectionIds.map((id) => {
        const tab = id
            .replace(/^legacy-panel-/, '')
            .replace(/^panel-/, '');
        const owner = ['legacy-panel-flow-builder', 'legacy-panel-shared-test']
            .includes(id)
            ? 'navigation.activeTab'
            : 'activeTab';
        return [id, `${owner} !== '${tab}'`];
    }),
);
const expectedGuardFingerprints = new Map<string, string>([
    ['panel-recipes', '3449b7cff641f2c3c92e3899fd5e6220483eb04c5758518de53ef84378f0de72'],
    ['panel-runs', 'd12a6530dfbfe237bf382b608471e891ea73f61108d0095758ee25ae824b005f'],
    ['panel-fleet', '8f767a77fc68bfb3ee341199fb273f4f047610ed58212f80a558819e46c5055d'],
    ['panel-builder', '24e4faef22986ca263a73d0d54d18c7ed634addc4caaad549a6b128099478fde'],
    ['legacy-panel-run-manager', 'f0cb9b1f77a5efbc3a61ea829d94d16fb09df50cbf9d704b89956eda3c184240'],
    ['legacy-panel-distributed-recipes', '63ff9b090b9fa076027cb180e8a3a06645b6fbbd7c413dc56d7105fb5a48bc38'],
]);

const expectedImportInventory = new Map<string, readonly string[]>([
    [appPath, [
        './app/use-experience-route.ts|value:useExperienceRoute',
        './auth-flow.ts|value:authErrorMessage',
        './auth-flow.ts|value:bootstrapPatchFromAuthSession',
        './auth-lifecycle.ts|value:readAuthSessionFromRallarAuthState',
        './legacy/rallar/load-browser-rallar-facade.ts|value:loadBrowserRallarFacade',
        './legacy/shell/LoginScreen.tsx|value:LoginScreen',
        './legacy/shell/auth/agent-session-ticket.ts|value:consumeBootstrapAgentSessionTicket',
        './legacy/shell/auth/agent-session-ticket.ts|value:scrubAgentSessionTicketFromUrl',
        './legacy/shell/read-current-auth-session.ts|value:readCurrentAuthSession',
        './runtime-store.ts|value:rallarBlackBoxRuntimeStore',
        './runtime-store.ts|value:useRallarBlackBoxRuntimeStore',
        '@shared/api/api-config.ts|type:AuthSession',
        '@shared/api/auth.ts|value:clearSession',
        '@shared/api/auth.ts|value:writeSession',
        'react|value:Suspense',
        'react|value:lazy',
        'react|value:useEffect',
        'react|value:useState',
    ]],
    [`${shellRoot}/legacy-shell-contracts.ts`, [
        '../../runtime-store.ts|type:useRallarBlackBoxRuntimeStore',
        '../runner/shell/use-runner-shell-state.ts|type:useRunnerShellState',
        './use-command-center-global-context.ts|type:useCommandCenterGlobalContext',
        './use-legacy-navigation.ts|type:useLegacyNavigation',
        '@shared/api/api-config.ts|type:AuthSession',
        'react|type:Dispatch',
        'react|type:SetStateAction',
    ]],
    [`${shellRoot}/LegacyAppShell.tsx`, [
        './AppModeSwitch.tsx|value:AppModeSwitch',
        './AppTabs.tsx|value:AppTabs',
        './GlobalContextBar.tsx|value:GlobalContextBar',
        './LegacyDiagnosticDrawer.tsx|value:LegacyDiagnosticDrawer',
        './LegacyRunHeader.tsx|value:Header',
        './legacy-shell-contracts.ts|type:LegacyShellAuth',
        './legacy-shell-contracts.ts|type:LegacyShellGlobalContext',
        './legacy-shell-contracts.ts|type:LegacyShellNavigation',
        './legacy-shell-contracts.ts|type:LegacyShellRunnerSelection',
        './legacy-shell-contracts.ts|type:LegacyShellRuntime',
        './tabs/DiagnosticEvidenceTabPanels.tsx|value:DiagnosticEvidenceTabPanels',
        './tabs/DirectConnectionTabPanels.tsx|value:DirectConnectionTabPanels',
        './tabs/DirectResourceTabPanels.tsx|value:DirectResourceTabPanels',
        './tabs/LegacyCompatibilityTailTabPanels.tsx|value:LegacyCompatibilityTailTabPanels',
        './tabs/RunnerCompatibilityTabPanels.tsx|value:RunnerCompatibilityTabPanels',
        './tabs/RunnerWorkspaceTabPanels.tsx|value:RunnerWorkspaceTabPanels',
    ]],
    [`${shellRoot}/LegacyDiagnosticDrawer.tsx`, [
        './DirectRallarBoundaryPanel.tsx|value:DirectRallarBoundaryPanel',
        './RallarBrowserTraceBar.tsx|value:RallarBrowserTraceBar',
        './RunnerModeBoundaryPanel.tsx|value:RunnerModeBoundaryPanel',
        './legacy-shell-contracts.ts|type:LegacyShellAuth',
        './legacy-shell-contracts.ts|type:LegacyShellGlobalContext',
        './legacy-shell-contracts.ts|type:LegacyShellNavigation',
        './legacy-shell-contracts.ts|type:LegacyShellRuntime',
    ]],
    [tabGroupPaths[0], [
        '../../runner/advanced/RunnerAdvancedPanel.tsx|value:RunnerAdvancedPanel',
        '../../runner/builder/FlowBuilderPanel.tsx|value:FlowBuilderPanel',
        '../../runner/fleet/RunnerFleetPanel.tsx|value:RunnerFleetPanel',
        '../../runner/recipes/RunnerRecipesPanel.tsx|value:RunnerRecipesPanel',
        '../../runner/runs/RunnerRunsPanel.tsx|value:RunnerRunsPanel',
        '../legacy-shell-contracts.ts|type:LegacyShellAuth',
        '../legacy-shell-contracts.ts|type:LegacyShellGlobalContext',
        '../legacy-shell-contracts.ts|type:LegacyShellNavigation',
        '../legacy-shell-contracts.ts|type:LegacyShellRunnerSelection',
        '../legacy-shell-contracts.ts|type:LegacyShellRuntime',
    ]],
    [tabGroupPaths[1], [
        '../../diagnostics/auth/AuthCommandCenterPanel.tsx|value:AuthCommandCenterPanel',
        '../../diagnostics/events/StatsPanel.tsx|value:StatsPanel',
        '../../diagnostics/quick-test/QuickRallarTestPanel.tsx|value:QuickRallarTestPanel',
        '../../diagnostics/rooms-clients/RoomsClientsPanel.tsx|value:RoomsClientsPanel',
        '../../diagnostics/rtc-realtime/RtcRealtimePanel.tsx|value:RtcRealtimePanel',
        '../../diagnostics/rtc/RtcDiagnosticsPanel.tsx|value:RtcDiagnosticsPanel',
        '../../diagnostics/topology/TopologyGraphPanel.tsx|value:TopologyGraphPanel',
        '../../diagnostics/websocket/WebSocketCommandCenterPanel.tsx|value:WebSocketCommandCenterPanel',
        '../../runner/manual/ManualRallarSection.tsx|value:ManualRallarSection',
        '../../runner/runs/RunnerRunsPanel.tsx|value:FailurePanel',
        '../legacy-shell-contracts.ts|type:LegacyShellAuth',
        '../legacy-shell-contracts.ts|type:LegacyShellGlobalContext',
        '../legacy-shell-contracts.ts|type:LegacyShellNavigation',
        '../legacy-shell-contracts.ts|type:LegacyShellRunnerSelection',
        '../legacy-shell-contracts.ts|type:LegacyShellRuntime',
    ]],
    [tabGroupPaths[2], [
        '../../diagnostics/crdt/CrdtHealthPanel.tsx|value:CrdtHealthPanel',
        '../../diagnostics/media/MediaConsolePanel.tsx|value:MediaConsolePanel',
        '../../diagnostics/rallar-data/RallarDataPanel.tsx|value:RallarDataPanel',
        '../legacy-shell-contracts.ts|type:LegacyShellAuth',
        '../legacy-shell-contracts.ts|type:LegacyShellGlobalContext',
        '../legacy-shell-contracts.ts|type:LegacyShellNavigation',
        '../legacy-shell-contracts.ts|type:LegacyShellRuntime',
    ]],
    [tabGroupPaths[3], [
        '../../runner/distributed-recipes/DistributedRecipesPanel.tsx|value:DistributedRecipesPanel',
        '../../runner/run-manager/RunManagerPanel.tsx|value:RunManagerPanel',
        '../../runner/workbench/LocalWorkbenchSection.tsx|value:LocalWorkbenchSection',
        '../legacy-shell-contracts.ts|type:LegacyShellAuth',
        '../legacy-shell-contracts.ts|type:LegacyShellGlobalContext',
        '../legacy-shell-contracts.ts|type:LegacyShellNavigation',
        '../legacy-shell-contracts.ts|type:LegacyShellRunnerSelection',
        '../legacy-shell-contracts.ts|type:LegacyShellRuntime',
    ]],
    [tabGroupPaths[4], [
        '../../diagnostics/events/EventStreamPanel.tsx|value:EventStreamPanel',
        '../../diagnostics/events/ExecutionFocusPanel.tsx|value:ExecutionFocusPanel',
        '../../diagnostics/events/RallarTracePanel.tsx|value:RallarTracePanel',
        '../../diagnostics/events/StatsPanel.tsx|value:StatsPanel',
        '../../diagnostics/rallar-server/RallarServerPanel.tsx|value:RallarServerPanel',
        '../../runner/advanced/CommandHistoryPanel.tsx|value:CommandHistoryPanel',
        '../../runner/runs/RunnerRunsPanel.tsx|value:FailurePanel',
        '../../shared/redaction-presentation.ts|value:uiRedactionOptions',
        '../legacy-shell-contracts.ts|type:LegacyShellAuth',
        '../legacy-shell-contracts.ts|type:LegacyShellGlobalContext',
        '../legacy-shell-contracts.ts|type:LegacyShellNavigation',
        '../legacy-shell-contracts.ts|type:LegacyShellRunnerSelection',
        '../legacy-shell-contracts.ts|type:LegacyShellRuntime',
    ]],
    [tabGroupPaths[5], [
        '../../runner/builder/FlowBuilderPanel.tsx|value:FlowBuilderPanel',
        '../../runner/shared-test/SharedTestPanel.tsx|value:SharedTestPanel',
        '../legacy-shell-contracts.ts|type:LegacyShellAuth',
        '../legacy-shell-contracts.ts|type:LegacyShellGlobalContext',
        '../legacy-shell-contracts.ts|type:LegacyShellNavigation',
        '../legacy-shell-contracts.ts|type:LegacyShellRunnerSelection',
        '../legacy-shell-contracts.ts|type:LegacyShellRuntime',
    ]],
]);

const expectedTopLevelInventory = new Map<string, readonly string[]>([
    [appPath, [
        'variable:RecipeConsoleApp',
        'variable:LegacyExperience',
        'export-default-function:App',
    ]],
    [`${shellRoot}/legacy-shell-contracts.ts`, [
        'export-type:LegacyShellRuntime',
        'export-type:LegacyShellAuth',
        'export-type:LegacyShellNavigation',
        'export-type:LegacyShellGlobalContext',
        'export-type:LegacyShellRunnerSelection',
    ]],
    [`${shellRoot}/LegacyAppShell.tsx`, ['export-function:LegacyAppShell']],
    [`${shellRoot}/LegacyDiagnosticDrawer.tsx`, ['export-function:LegacyDiagnosticDrawer']],
    [tabGroupPaths[0], ['export-function:RunnerWorkspaceTabPanels']],
    [tabGroupPaths[1], ['export-function:DirectConnectionTabPanels']],
    [tabGroupPaths[2], ['export-function:DirectResourceTabPanels']],
    [tabGroupPaths[3], ['export-function:RunnerCompatibilityTabPanels']],
    [tabGroupPaths[4], ['export-function:DiagnosticEvidenceTabPanels']],
    [tabGroupPaths[5], ['export-function:LegacyCompatibilityTailTabPanels']],
]);

const expectedLocalEdges = new Map<string, readonly string[]>([
    [appPath, []],
    [`${shellRoot}/legacy-shell-contracts.ts`, []],
    [`${shellRoot}/LegacyAppShell.tsx`, [
        `${shellRoot}/LegacyDiagnosticDrawer.tsx`,
        `${shellRoot}/legacy-shell-contracts.ts`,
        ...tabGroupPaths,
    ].sort()],
    [`${shellRoot}/LegacyDiagnosticDrawer.tsx`, [
        `${shellRoot}/legacy-shell-contracts.ts`,
    ]],
    ...tabGroupPaths.map((path) => [
        path,
        [`${shellRoot}/legacy-shell-contracts.ts`],
    ] as const),
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

function importModules(file: ts.SourceFile): readonly string[] {
    return file.statements
        .filter(ts.isImportDeclaration)
        .flatMap((statement) =>
            ts.isStringLiteral(statement.moduleSpecifier)
                ? [statement.moduleSpecifier.text]
                : [],
        );
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
                const importedName = element.propertyName?.text ?? element.name.text;
                const alias = importedName === element.name.text
                    ? ''
                    : `->${element.name.text}`;
                imports.push(
                    `${moduleImport}|${clause.isTypeOnly || element.isTypeOnly ? 'type' : 'value'}:${importedName}${alias}`,
                );
            }
        }
    }
    return imports.sort();
}

function topLevelInventory(file: ts.SourceFile): readonly string[] {
    const hasModifier = (
        statement: ts.Statement,
        kind: ts.SyntaxKind,
    ): boolean => ts.canHaveModifiers(statement) &&
        Boolean(ts.getModifiers(statement)?.some((modifier) => modifier.kind === kind));
    return file.statements.flatMap((statement): readonly string[] => {
        if (ts.isImportDeclaration(statement)) return [];
        const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
        const defaultExport = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
        if (ts.isTypeAliasDeclaration(statement)) {
            return [`${exported ? 'export-' : ''}type:${statement.name.text}`];
        }
        if (ts.isFunctionDeclaration(statement)) {
            const prefix = exported
                ? defaultExport
                    ? 'export-default-'
                    : 'export-'
                : '';
            return [`${prefix}function:${statement.name?.text ?? '<anonymous>'}`];
        }
        if (ts.isVariableStatement(statement)) {
            return statement.declarationList.declarations.map((declaration) =>
                `${exported ? 'export-' : ''}variable:${declaration.name.getText(file)}`,
            );
        }
        return [`unexpected:${ts.SyntaxKind[statement.kind]}`];
    });
}

function dynamicImportCount(file: ts.SourceFile): number {
    let count = 0;
    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword
        ) {
            count += 1;
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return count;
}

function functionDeclarations(file: ts.SourceFile): readonly ts.FunctionDeclaration[] {
    return file.statements.filter(ts.isFunctionDeclaration);
}

function namedFunction(
    file: ts.SourceFile,
    name: string,
): ts.FunctionDeclaration {
    const declaration = functionDeclarations(file).find(
        (candidate) => candidate.name?.text === name,
    );
    if (!declaration?.body) throw new Error(`Missing function ${name} in ${file.fileName}`);
    return declaration;
}

function returnExpression(declaration: ts.FunctionDeclaration): ts.Expression {
    const statement = declaration.body!.statements.find(ts.isReturnStatement);
    if (!statement?.expression) {
        throw new Error(`Missing return in ${declaration.name?.text ?? '<anonymous>'}`);
    }
    let expression = statement.expression;
    while (ts.isParenthesizedExpression(expression)) {
        expression = expression.expression;
    }
    return expression;
}

function semanticJsxChildren(
    children: ts.NodeArray<ts.JsxChild>,
): readonly ts.JsxChild[] {
    return children.filter(
        (child) => !ts.isJsxText(child) || child.getText().trim().length > 0,
    );
}

function jsxAttribute(
    element: ts.JsxOpeningLikeElement,
    name: string,
): ts.JsxAttribute | undefined {
    return element.attributes.properties.find(
        (property): property is ts.JsxAttribute =>
            ts.isJsxAttribute(property) && property.name.getText() === name,
    );
}

function sectionId(section: ts.JsxElement): string {
    const attribute = jsxAttribute(section.openingElement, 'id');
    return attribute?.initializer && ts.isStringLiteral(attribute.initializer)
        ? attribute.initializer.text
        : '';
}

const astTextKinds = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.Identifier,
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NumericLiteral,
    ts.SyntaxKind.JsxText,
]);

function astShape(node: ts.Node): string {
    const text = astTextKinds.has(node.kind)
        ? String((node as ts.Node & { text: string }).text)
        : '';
    return `(${node.kind}:${JSON.stringify(text)}${node
        .getChildren(node.getSourceFile())
        .map(astShape)
        .join('')})`;
}

function astFingerprint(node: ts.Node): string {
    return createHash('sha256').update(astShape(node)).digest('hex');
}

function resolveCompositionEdge(
    importerPath: string,
    moduleImport: string,
): string {
    return relative(
        repositoryRoot,
        resolve(dirname(resolve(repositoryRoot, importerPath)), moduleImport),
    );
}

function graphCycles(
    graph: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
    const active = new Set<string>();
    const complete = new Set<string>();
    const cycles: string[] = [];
    const visit = (path: string, stack: readonly string[]): void => {
        if (active.has(path)) {
            cycles.push([...stack, path].join(' -> '));
            return;
        }
        if (complete.has(path)) return;
        active.add(path);
        for (const dependency of graph.get(path) ?? []) {
            visit(dependency, [...stack, path]);
        }
        active.delete(path);
        complete.add(path);
    };
    for (const path of graph.keys()) visit(path, []);
    return cycles;
}

function hookCount(root: ts.Node): number {
    let count = 0;
    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            /^use[A-Z]/.test(node.expression.text)
        ) {
            count += 1;
        }
        ts.forEachChild(node, visit);
    };
    visit(root);
    return count;
}

describe('legacy shell composition boundary', () => {
    it('routes legacy composition through a lazy experience wrapper', () => {
        const appSource = repositorySource(appPath);
        const wrapperPath = `${shellRoot}/LegacyExperience.tsx`;
        expect(existsSync(resolve(repositoryRoot, wrapperPath))).toBe(true);
        if (!existsSync(resolve(repositoryRoot, wrapperPath))) return;

        expect(appSource).toContain(
            "import('./legacy/shell/LegacyExperience.tsx')",
        );
        expect(appSource).not.toContain(
            "from './legacy/shell/LegacyAppShell.tsx';",
        );
        expect(repositorySource(wrapperPath)).toContain('<LegacyAppShell');
    });

    it('owns shell composition in focused bounded modules', () => {
        for (const owner of compositionOwners) {
            const present = existsSync(resolve(repositoryRoot, owner.path));
            expect.soft(present, `${owner.path}: owner exists`).toBe(true);
            if (!present) continue;
            const source = repositorySource(owner.path);
            expect.soft(
                source.trimEnd().split('\n').length,
                `${owner.path}: line cap`,
            ).toBeLessThanOrEqual(owner.cap);
            expect.soft(source, `${owner.path}: no App/CSS/lazy back-edge`)
                .not.toMatch(/App\.tsx['"]|\.css['"]|\blazy\s*\(|\bSuspense\b/);
        }
    });

    it('locks exact composition imports, inventories, and the acyclic local DAG', () => {
        const paths = [appPath, ...compositionOwners.map((owner) => owner.path)];
        const compositionPathSet = new Set(paths);
        const graph = new Map<string, readonly string[]>();

        for (const path of paths) {
            const file = sourceFile(path, repositorySource(path));
            expect.soft(
                importInventory(file),
                `${path}: exact import symbols and type/value kinds`,
            ).toEqual(expectedImportInventory.get(path));
            expect.soft(
                topLevelInventory(file),
                `${path}: exact top-level ownership inventory`,
            ).toEqual(expectedTopLevelInventory.get(path));
            expect.soft(
                dynamicImportCount(file),
                `${path}: only App owns the two experience edges`,
            ).toBe(path === appPath ? 2 : 0);

            graph.set(
                path,
                importModules(file)
                    .filter((moduleImport) => moduleImport.startsWith('.'))
                    .map((moduleImport) =>
                        resolveCompositionEdge(path, moduleImport),
                    )
                    .filter((dependency) => compositionPathSet.has(dependency))
                    .sort(),
            );
        }

        expect.soft(
            [...graph],
            'exact App -> shell -> groups/drawer -> contracts edge map',
        ).toEqual([...expectedLocalEdges]);
        expect.soft(graphCycles(graph), 'composition graph remains acyclic')
            .toEqual([]);
    });

    it('keeps App and LegacyAppShell free of feature-panel ownership', () => {
        const appSource = repositorySource(appPath);
        expect.soft(
            appSource.trimEnd().split('\n').length,
            'App provider/bootstrap/routing line cap',
        ).toBeLessThanOrEqual(280);
        expect.soft(appSource, 'App lazy-loads the thin legacy experience').toContain(
            "import('./legacy/shell/LegacyExperience.tsx')",
        );
        expect.soft(appSource, 'App has no feature imports').not.toMatch(
            /from ['"]\.\/legacy\/(?:diagnostics\/|runner\/(?!shell\/))[^'"]+['"]/,
        );

        const shellPath = `${shellRoot}/LegacyAppShell.tsx`;
        if (!existsSync(resolve(repositoryRoot, shellPath))) return;
        const shellSource = repositorySource(shellPath);
        const shellImports = importModules(sourceFile(shellPath, shellSource));
        expect.soft(
            shellImports.some((moduleImport) =>
                moduleImport.includes('/diagnostics/') ||
                moduleImport.includes('/runner/') ||
                /(?:Panel|Section)\.tsx$/.test(moduleImport),
            ),
            'LegacyAppShell imports composition roots and shell chrome only',
        ).toBe(false);
        expect.soft(hookCount(sourceFile(shellPath, shellSource)), 'shell has no hooks')
            .toBe(0);
    });

    it('preserves exact section order and fragment-only group boundaries', () => {
        const shellPath = `${shellRoot}/LegacyAppShell.tsx`;
        const shellSource = repositorySource(shellPath);
        const shellFile = sourceFile(shellPath, shellSource);
        const renderedTabGroupOrder = [
            ...shellSource.matchAll(/<([A-Z][A-Za-z]+TabPanels)\b/g),
        ].map((match) => match[1]);
        expect.soft(
            renderedTabGroupOrder,
            'LegacyAppShell renders tab groups in exact section order',
        ).toEqual(expectedTabGroupOrder);

        let tabShell: ts.JsxElement | undefined;
        const findTabShell = (node: ts.Node): void => {
            if (tabShell) return;
            if (
                ts.isJsxElement(node) &&
                jsxAttribute(node.openingElement, 'className')?.initializer &&
                ts.isStringLiteral(
                    jsxAttribute(node.openingElement, 'className')!.initializer,
                ) &&
                (jsxAttribute(node.openingElement, 'className')!.initializer as ts.StringLiteral)
                    .text === 'tab-shell'
            ) {
                tabShell = node;
                return;
            }
            ts.forEachChild(node, findTabShell);
        };
        findTabShell(namedFunction(shellFile, 'LegacyAppShell'));
        expect.soft(tabShell, 'LegacyAppShell has one tab composition root')
            .toBeDefined();
        const directGroupChildren = tabShell
            ? semanticJsxChildren(tabShell.children)
            : [];
        expect.soft(
            directGroupChildren.map((child) =>
                ts.isJsxSelfClosingElement(child)
                    ? child.tagName.getText(shellFile)
                    : ts.SyntaxKind[child.kind],
            ),
            'tab composition root has the six direct group children only',
        ).toEqual(expectedTabGroupOrder);

        const presentGroups = tabGroupPaths.filter((path) =>
            existsSync(resolve(repositoryRoot, path)),
        );
        expect.soft(presentGroups, 'all six tab groups exist').toHaveLength(6);
        const groupSources = presentGroups.map(repositorySource);
        const sectionIds = groupSources.flatMap((source) =>
            [...source.matchAll(/<section\s+[\s\S]*?id="([^"]+)"/g)]
                .map((match) => match[1]),
        );
        expect.soft(sectionIds, 'exact top-level tab section order')
            .toEqual(expectedSectionIds);

        const sectionsById = new Map<string, ts.JsxElement>();
        let guardedCount = 0;
        let unconditionalCount = 0;

        for (const [index, path] of presentGroups.entries()) {
            const source = groupSources[index];
            const file = sourceFile(path, source);
            expect.soft(functionDeclarations(file), `${path}: one focused component`)
                .toHaveLength(1);
            expect.soft(hookCount(file), `${path}: no hooks`).toBe(0);
            expect.soft(source, `${path}: fragment root`).toMatch(
                /return\s*\(\s*<>[\s\S]*<\/\>\s*\);/,
            );
            const component = namedFunction(file, expectedTabGroupOrder[index]);
            const returned = returnExpression(component);
            expect.soft(ts.isJsxFragment(returned), `${path}: AST fragment root`)
                .toBe(true);
            const directChildren = ts.isJsxFragment(returned)
                ? semanticJsxChildren(returned.children)
                : [];
            expect.soft(
                directChildren.every(
                    (child) =>
                        ts.isJsxElement(child) &&
                        child.openingElement.tagName.getText(file) === 'section',
                ),
                `${path}: fragment children are direct sections without wrappers`,
            ).toBe(true);
            const directSections = directChildren.filter(ts.isJsxElement);
            expect.soft(
                directSections.map(sectionId),
                `${path}: exact owned section IDs`,
            ).toEqual(expectedSectionsByGroup.get(path));

            for (const section of directSections) {
                const id = sectionId(section);
                sectionsById.set(id, section);
                const hidden = jsxAttribute(section.openingElement, 'hidden');
                const hiddenExpression = hidden?.initializer &&
                        ts.isJsxExpression(hidden.initializer)
                    ? hidden.initializer.expression
                    : undefined;
                expect.soft(
                    hiddenExpression?.getText(file),
                    `${id}: exact hidden expression`,
                ).toBe(expectedHiddenExpressions.get(id));

                const children = semanticJsxChildren(section.children);
                const expectedGuard = expectedGuardFingerprints.get(id);
                if (expectedGuard) {
                    guardedCount += 1;
                    expect.soft(children, `${id}: one exact guarded child`)
                        .toHaveLength(1);
                    const guard = children[0];
                    const expression = guard && ts.isJsxExpression(guard)
                        ? guard.expression
                        : undefined;
                    expect.soft(
                        expression ? astFingerprint(expression) : '',
                        `${id}: exact active mode/tab guard AST and mounted subtree`,
                    ).toBe(expectedGuard);
                } else {
                    unconditionalCount += 1;
                    expect.soft(
                        children.every(
                            (child) =>
                                ts.isJsxElement(child) ||
                                ts.isJsxSelfClosingElement(child),
                        ),
                        `${id}: hidden surface remains unconditionally mounted`,
                    ).toBe(true);
                }
            }
            expect.soft(
                importModules(file).some((moduleImport) =>
                    moduleImport.startsWith('./') &&
                    moduleImport.endsWith('TabPanels.tsx'),
                ),
                `${path}: no cross-group imports`,
            ).toBe(false);
        }
        expect.soft(guardedCount, 'exact guarded surface count').toBe(6);
        expect.soft(unconditionalCount, 'exact hidden-mounted surface count')
            .toBe(18);

        const combined = groupSources.join('\n');
        for (const tab of ['recipes', 'runs', 'fleet', 'builder']) {
            expect.soft(combined, `${tab}: exact runner active guard`).toMatch(
                new RegExp(
                    `activeMode === 'black-box-runner'[\\s\\S]{0,120}activeTab === '${tab}'`,
                ),
            );
        }
        for (const tab of ['run-manager', 'distributed-recipes']) {
            expect.soft(combined, `${tab}: exact compatibility guard`).toMatch(
                new RegExp(
                    `activeMode === 'black-box-runner'[\\s\\S]{0,120}activeTab === '${tab}'`,
                ),
            );
        }
        expect.soft(combined, 'Topology active flag remains exact').toContain(
            "active={activeTab === 'topology'}",
        );
        const topologySection = sectionsById.get('panel-topology');
        const topologyCalls = topologySection
            ? semanticJsxChildren(topologySection.children).filter(
                  (child): child is ts.JsxSelfClosingElement =>
                      ts.isJsxSelfClosingElement(child) &&
                      child.tagName.getText() === 'TopologyGraphPanel',
              )
            : [];
        expect.soft(topologyCalls, 'one direct Topology graph mount')
            .toHaveLength(1);
        const active = topologyCalls[0]
            ? jsxAttribute(topologyCalls[0], 'active')
            : undefined;
        const activeExpression = active?.initializer &&
                ts.isJsxExpression(active.initializer)
            ? active.initializer.expression
            : undefined;
        expect.soft(
            activeExpression?.getText(),
            'Topology active prop is the exact active-tab expression',
        ).toBe("activeTab === 'topology'");
    });

    it('keeps the legacy stylesheet byte-identical', () => {
        expect(
            createHash('sha256')
                .update(repositorySource('apps/rallar-black-box/src/styles.css'))
                .digest('hex'),
        ).toBe('9778cfa43e7a858b30a9304b36b2939bfbf89df2722ac05a65b97579a37640b4');
    });
});
