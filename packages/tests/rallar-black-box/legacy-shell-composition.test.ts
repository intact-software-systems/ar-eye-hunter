import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const appPath = 'apps/rallar-black-box/src/App.tsx';
const shellRoot = 'apps/rallar-black-box/src/legacy/shell';
const legacyExperiencePath = `${shellRoot}/LegacyExperience.tsx`;
const legacyAccessibilityPath =
    'apps/rallar-black-box/src/legacy/accessibility/legacy-accessibility.css';
const cssIsolationFixturePaths = [
    'apps/rallar-black-box/test/fixtures/recipe-console-css-isolation-main.tsx',
    'apps/rallar-black-box/test/fixtures/recipe-console-css-isolation-recipe-first-main.tsx',
] as const;
const compositionOwners = [
    { path: `${shellRoot}/legacy-shell-contracts.ts`, cap: 70 },
    { path: `${shellRoot}/LegacyAppShell.tsx`, cap: 180 },
    { path: `${shellRoot}/LegacyDiagnosticDrawer.tsx`, cap: 90 },
    { path: `${shellRoot}/tabs/RunnerWorkspaceTabPanels.tsx`, cap: 210 },
    { path: `${shellRoot}/tabs/DirectConnectionTabPanels.tsx`, cap: 210 },
    { path: `${shellRoot}/tabs/DirectResourceTabPanels.tsx`, cap: 100 },
    { path: `${shellRoot}/tabs/DiagnosticEvidenceTabPanels.tsx`, cap: 140 },
] as const;
const tabGroupPaths = compositionOwners
    .map((owner) => owner.path)
    .filter((path) => path.includes('/tabs/'));
const expectedTabGroupOrder = [
    'RunnerWorkspaceTabPanels',
    'DirectConnectionTabPanels',
    'DirectResourceTabPanels',
    'DiagnosticEvidenceTabPanels',
] as const;
const expectedSectionIds = [
    'panel-recipes',
    'panel-runs',
    'panel-fleet',
    'panel-builder',
    'panel-advanced',
    'panel-quick-test',
    'panel-auth',
    'panel-rooms-clients',
    'panel-websocket',
    'panel-rtc-realtime',
    'panel-topology',
    'panel-rtc-diagnostics',
    'panel-rallar-data',
    'panel-crdt-health',
    'panel-media',
    'panel-rallar-trace',
    'panel-event-stream',
    'panel-rallar-server',
] as const;
const expectedSectionsByGroup = new Map<string, readonly string[]>([
    [tabGroupPaths[0], expectedSectionIds.slice(0, 5)],
    [tabGroupPaths[1], expectedSectionIds.slice(5, 12)],
    [tabGroupPaths[2], expectedSectionIds.slice(12, 15)],
    [tabGroupPaths[3], expectedSectionIds.slice(15, 18)],
]);
const activeOnlySectionIds = new Set([
    'panel-recipes',
    'panel-runs',
    'panel-fleet',
    'panel-builder',
    'panel-rooms-clients',
    'panel-topology',
    'panel-rtc-diagnostics',
]);
const expectedHiddenExpressions = new Map<string, string>(
    expectedSectionIds.filter(id => !activeOnlySectionIds.has(id)).map((id) => {
        const tab = id
            .replace(/^legacy-panel-/, '')
            .replace(/^panel-/, '');
        return [id, `activeTab !== '${tab}'`];
    }),
);
const expectedGuardExpressions = new Map<string, string>([
    ['panel-recipes', "activeMode === 'black-box-runner' && activeTab === 'recipes'"],
    ['panel-runs', "activeMode === 'black-box-runner' && activeTab === 'runs'"],
    ['panel-fleet', "activeMode === 'black-box-runner' && activeTab === 'fleet'"],
    ['panel-builder', "activeMode === 'black-box-runner' && activeTab === 'builder'"],
    ['panel-rooms-clients', "activeTab === 'rooms-clients'"],
    ['panel-topology', "activeTab === 'topology'"],
    ['panel-rtc-diagnostics', "activeTab === 'rtc-diagnostics'"],
]);

const expectedImportInventory = new Map<string, readonly string[]>([
    [appPath, [
        './app/recipe-console-url-guard.ts|value:captureInitialRecipeConsoleControlCredentialPolicy',
        './app/recipe-console-url-guard.ts|value:scrubCurrentRecipeConsoleUrlBeforeLoad',
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
        '../diagnostics/context/legacy-diagnostic-context.ts|type:ParsedLegacyDiagnosticContext',
        '../runner/shell/use-runner-shell-state.ts|type:useRunnerShellState',
        './use-command-center-global-context.ts|type:useCommandCenterGlobalContext',
        './use-legacy-navigation.ts|type:useLegacyNavigation',
        '@shared/api/api-config.ts|type:AuthSession',
        'react|type:Dispatch',
        'react|type:SetStateAction',
    ]],
    [`${shellRoot}/LegacyAppShell.tsx`, [
        '../diagnostics/context/LegacyDiagnosticContextBar.tsx|value:LegacyDiagnosticContextBar',
        './AppModeSwitch.tsx|value:AppModeSwitch',
        './AppTabs.tsx|value:AppTabs',
        './GlobalContextBar.tsx|value:GlobalContextBar',
        './LegacyDiagnosticDrawer.tsx|value:LegacyDiagnosticDrawer',
        './LegacyRunHeader.tsx|value:Header',
        './legacy-shell-contracts.ts|type:LegacyShellAuth',
        './legacy-shell-contracts.ts|type:LegacyShellDiagnosticContext',
        './legacy-shell-contracts.ts|type:LegacyShellGlobalContext',
        './legacy-shell-contracts.ts|type:LegacyShellNavigation',
        './legacy-shell-contracts.ts|type:LegacyShellRunnerSelection',
        './legacy-shell-contracts.ts|type:LegacyShellRuntime',
        './tabs/DiagnosticEvidenceTabPanels.tsx|value:DiagnosticEvidenceTabPanels',
        './tabs/DirectConnectionTabPanels.tsx|value:DirectConnectionTabPanels',
        './tabs/DirectResourceTabPanels.tsx|value:DirectResourceTabPanels',
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
        '../legacy-shell-contracts.ts|type:LegacyShellAuth',
        '../legacy-shell-contracts.ts|type:LegacyShellGlobalContext',
        '../legacy-shell-contracts.ts|type:LegacyShellNavigation',
        '../legacy-shell-contracts.ts|type:LegacyShellRunnerSelection',
        '../legacy-shell-contracts.ts|type:LegacyShellRuntime',
        'react|value:Suspense',
        'react|value:lazy',
    ]],
    [tabGroupPaths[1], [
        '../../diagnostics/auth/AuthCommandCenterPanel.tsx|value:AuthCommandCenterPanel',
        '../../diagnostics/events/StatsPanel.tsx|value:StatsPanel',
        '../../diagnostics/quick-test/QuickRallarTestPanel.tsx|value:QuickRallarTestPanel',
        '../../diagnostics/rtc-realtime/RtcRealtimePanel.tsx|value:RtcRealtimePanel',
        '../../diagnostics/websocket/WebSocketCommandCenterPanel.tsx|value:WebSocketCommandCenterPanel',
        '../../runner/runs/FailurePanel.tsx|value:FailurePanel',
        '../legacy-shell-contracts.ts|type:LegacyShellAuth',
        '../legacy-shell-contracts.ts|type:LegacyShellGlobalContext',
        '../legacy-shell-contracts.ts|type:LegacyShellNavigation',
        '../legacy-shell-contracts.ts|type:LegacyShellRunnerSelection',
        '../legacy-shell-contracts.ts|type:LegacyShellRuntime',
        'react|value:Suspense',
        'react|value:lazy',
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
        '../../diagnostics/events/EventStreamPanel.tsx|value:EventStreamPanel',
        '../../diagnostics/events/ExecutionFocusPanel.tsx|value:ExecutionFocusPanel',
        '../../diagnostics/events/RallarTracePanel.tsx|value:RallarTracePanel',
        '../../diagnostics/events/StatsPanel.tsx|value:StatsPanel',
        '../../diagnostics/rallar-server/RallarServerPanel.tsx|value:RallarServerPanel',
        '../../runner/advanced/CommandHistoryPanel.tsx|value:CommandHistoryPanel',
        '../../runner/runs/FailurePanel.tsx|value:FailurePanel',
        '../../shared/redaction-presentation.ts|value:uiRedactionOptions',
        '../legacy-shell-contracts.ts|type:LegacyShellAuth',
        '../legacy-shell-contracts.ts|type:LegacyShellGlobalContext',
        '../legacy-shell-contracts.ts|type:LegacyShellNavigation',
        '../legacy-shell-contracts.ts|type:LegacyShellRunnerSelection',
        '../legacy-shell-contracts.ts|type:LegacyShellRuntime',
    ]],
]);

const expectedTopLevelInventory = new Map<string, readonly string[]>([
    [appPath, [
        'variable:initialRecipeConsoleControlCredentialPolicy',
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
        'export-type:LegacyShellDiagnosticContext',
    ]],
    [`${shellRoot}/LegacyAppShell.tsx`, ['export-function:LegacyAppShell']],
    [`${shellRoot}/LegacyDiagnosticDrawer.tsx`, ['export-function:LegacyDiagnosticDrawer']],
    [tabGroupPaths[0], [
        'variable:RunnerRecipesPanel',
        'variable:RunnerRunsPanel',
        'variable:RunnerFleetPanel',
        'variable:FlowBuilderPanel',
        'export-function:RunnerWorkspaceTabPanels',
    ]],
    [tabGroupPaths[1], [
        'variable:RoomsClientsPanel',
        'variable:TopologyGraphPanel',
        'variable:RtcDiagnosticsPanel',
        'export-function:DirectConnectionTabPanels',
    ]],
    [tabGroupPaths[2], ['export-function:DirectResourceTabPanels']],
    [tabGroupPaths[3], ['export-function:DiagnosticEvidenceTabPanels']],
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

function directOwnedSection(
    child: ts.JsxChild,
): Readonly<{ section: ts.JsxElement; guard?: ts.Expression }> | undefined {
    if (
        ts.isJsxElement(child) &&
        child.openingElement.tagName.getText() === 'section'
    ) {
        return { section: child };
    }
    if (!ts.isJsxExpression(child) || !child.expression) return undefined;
    let section: ts.JsxElement | undefined;
    const visit = (node: ts.Node): void => {
        if (section) return;
        if (
            ts.isJsxElement(node) &&
            node.openingElement.tagName.getText() === 'section'
        ) {
            section = node;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(child.expression);
    return section ? { section, guard: child.expression } : undefined;
}

function jsxCalls(root: ts.Node, name: string): readonly ts.JsxSelfClosingElement[] {
    const calls: ts.JsxSelfClosingElement[] = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isJsxSelfClosingElement(node) &&
            node.tagName.getText() === name
        ) calls.push(node);
        ts.forEachChild(node, visit);
    };
    visit(root);
    return calls;
}

function activeGuardText(guard: ts.Expression | undefined): string | undefined {
    return guard && ts.isBinaryExpression(guard) &&
            guard.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        ? guard.left.getText(guard.getSourceFile())
        : undefined;
}

describe('legacy shell composition boundary', () => {
    it('locks the exact lazy legacy experience controller and shell wiring', () => {
        const legacyExperienceSource = repositorySource(legacyExperiencePath);
        const legacyExperience = sourceFile(
            legacyExperiencePath,
            legacyExperienceSource,
        );

        expect(importInventory(legacyExperience)).toEqual([
            '../../auth-flow.ts|value:bootstrapMatchesAuthSession',
            '../../runtime-store.ts|value:rallarBlackBoxRuntimeStore',
            '../../styles.css|side-effect',
            '../accessibility/legacy-accessibility.css|side-effect',
            '../diagnostics/context/LegacyDiagnosticContextBar.tsx|value:LegacyDiagnosticContextProvider',
            '../diagnostics/context/legacy-diagnostic-context.ts|value:parseLegacyDiagnosticContext',
            '../runner/shell/use-runner-shell-state.ts|value:useRunnerShellSelectionSync',
            '../runner/shell/use-runner-shell-state.ts|value:useRunnerShellState',
            './LegacyAppShell.tsx|value:LegacyAppShell',
            './legacy-shell-contracts.ts|type:LegacyShellAuth',
            './legacy-shell-contracts.ts|type:LegacyShellRuntime',
            './use-command-center-global-context.ts|value:useCommandCenterGlobalContext',
            './use-legacy-navigation.ts|value:useLegacyNavigation',
            'react|value:useEffect',
        ]);
        expect(topLevelInventory(legacyExperience)).toEqual([
            'export-type:LegacyExperienceProps',
            'export-default-function:LegacyExperience',
        ]);
        expect(dynamicImportCount(legacyExperience)).toBe(0);

        const controller = namedFunction(legacyExperience, 'LegacyExperience');
        expect(astFingerprint(controller)).toBe(
            '69700d11d0036599ea0acc2dc1ad75a322c63077ca3c3f8edda481749a783c66',
        );
        expect(legacyExperienceSource).not.toMatch(
            /(?:from\s+['"][^'"]*App(?:\.tsx)?['"]|import\s*\([^)]*App)/,
        );
    });

    it('loads a narrow legacy accessibility repair after the frozen base styles', () => {
        const legacyExperienceSource = repositorySource(legacyExperiencePath);
        expect(legacyExperienceSource).toContain(
            "import '../../styles.css';\n" +
            "import '../accessibility/legacy-accessibility.css';",
        );

        for (const fixturePath of cssIsolationFixturePaths) {
            expect.soft(
                repositorySource(fixturePath),
                `${fixturePath}: legacy accessibility CSS follows base legacy CSS`,
            ).toMatch(
                /await import\('\.\.\/\.\.\/src\/styles\.css'\);\n\s+await import\('\.\.\/\.\.\/src\/legacy\/accessibility\/legacy-accessibility\.css'\);/u,
            );
        }

        const stylesheetExists = existsSync(
            resolve(repositoryRoot, legacyAccessibilityPath),
        );
        expect.soft(
            stylesheetExists,
            'the legacy-only accessibility stylesheet exists',
        ).toBe(true);
        if (!stylesheetExists) return;

        const stylesheet = repositorySource(legacyAccessibilityPath);
        expect.soft(
            stylesheet.trimEnd().split('\n').length,
            'the focused accessibility repair stays small',
        ).toBeLessThanOrEqual(50);
        for (const panelClass of [
            'media-console-panel',
            'rallar-data-panel',
            'crdt-health-panel',
            'auth-command-center-panel',
            'rooms-clients-panel',
            'rallar-server-panel',
        ]) {
            expect.soft(
                stylesheet,
                `repair is scoped to ${panelClass}`,
            ).toContain(`.${panelClass}`);
        }
        const unscopedSelectorGroups = [
            ...stylesheet.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{/gu),
        ]
            .map((match) => match[1].trim())
            .filter((selector) => !selector.startsWith('@'))
            .filter((selector) => !selector.includes('.app-shell'));
        expect.soft(
            unscopedSelectorGroups,
            'every selector group is rooted at the legacy shell',
        ).toEqual([]);
        expect.soft(
            stylesheet,
            'repair covers form controls without selecting checkbox/radio glyphs',
        ).toContain(
            'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])',
        );
        expect.soft(
            stylesheet,
            'repair expands checkbox/radio label hit areas',
        ).toContain(
            'label:has(input:is([type="checkbox"], [type="radio"]))',
        );
        expect.soft(
            stylesheet,
            'repair does not retain hidden legacy surfaces',
        ).not.toMatch(/\[hidden\]|display\s*:\s*none|visibility\s*:\s*hidden/iu);
    });

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
            expect.soft(source, `${owner.path}: no App/CSS back-edge`)
                .not.toMatch(/App\.tsx['"]|\.css['"]/);
            const expectedDynamicImports = owner.path === tabGroupPaths[0]
                ? 4
                : owner.path === tabGroupPaths[1]
                    ? 3
                    : 0;
            expect.soft(
                dynamicImportCount(sourceFile(owner.path, source)),
                `${owner.path}: exact local safe-route splits`,
            ).toBe(expectedDynamicImports);
            expect.soft(
                [...source.matchAll(/<Suspense\b/g)],
                `${owner.path}: one local boundary per split`,
            ).toHaveLength(expectedDynamicImports);
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
            const expectedDynamicImports = path === appPath
                ? 2
                : path === tabGroupPaths[0]
                    ? 4
                    : path === tabGroupPaths[1]
                        ? 3
                        : 0;
            expect.soft(
                dynamicImportCount(file),
                `${path}: exact dynamic composition edges`,
            ).toBe(expectedDynamicImports);

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
                (
                    moduleImport.includes('/diagnostics/') &&
                    moduleImport !==
                        '../diagnostics/context/LegacyDiagnosticContextBar.tsx'
                ) ||
                moduleImport.includes('/runner/') ||
                /(?:Panel|Section)\.tsx$/.test(moduleImport),
            ),
            'LegacyAppShell imports composition roots, shell chrome, and the context bar only',
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
            'tab composition root has the four direct group children only',
        ).toEqual(expectedTabGroupOrder);

        const presentGroups = tabGroupPaths.filter((path) =>
            existsSync(resolve(repositoryRoot, path)),
        );
        expect.soft(presentGroups, 'all four tab groups exist').toHaveLength(4);
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
            const ownedSections = directChildren.flatMap(child => {
                const owned = directOwnedSection(child);
                return owned ? [owned] : [];
            });
            expect.soft(
                ownedSections,
                `${path}: every fragment child owns one direct or active-only section`,
            ).toHaveLength(directChildren.length);
            const directSections = ownedSections.map(owned => owned.section);
            expect.soft(
                directSections.map(sectionId),
                `${path}: exact owned section IDs`,
            ).toEqual(expectedSectionsByGroup.get(path));

            for (const [sectionIndex, section] of directSections.entries()) {
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
                const expectedGuard = expectedGuardExpressions.get(id);
                if (expectedGuard) {
                    guardedCount += 1;
                    expect.soft(
                        activeGuardText(ownedSections[sectionIndex]?.guard),
                        `${id}: exact active-only guard`,
                    ).toBe(expectedGuard);
                    expect.soft(
                        section.getText(file),
                        `${id}: local status fallback`,
                    ).toMatch(/<Suspense\b[\s\S]*role="status"/);
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
        expect.soft(guardedCount, 'exact guarded surface count').toBe(7);
        expect.soft(unconditionalCount, 'exact hidden-mounted surface count')
            .toBe(11);

        const combined = groupSources.join('\n');
        for (const tab of ['recipes', 'runs', 'fleet', 'builder']) {
            expect.soft(combined, `${tab}: exact runner active guard`).toMatch(
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
            ? jsxCalls(topologySection, 'TopologyGraphPanel')
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
