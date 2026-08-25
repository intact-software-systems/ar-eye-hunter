import { readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { analyzeSourceFile, buildRelativeTypeScriptGraph, findDependencyCycles, type SourceAnalysis, type SourceImport } from '../helpers/source-analysis';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const appSourcePath = 'apps/rallar-black-box/src/App.tsx';
const workbenchExperienceSourcePath = 'apps/rallar-black-box/src/workbench/workbench-experience.tsx';
const recipeConsoleSourcePath = 'apps/rallar-black-box/src/recipe-console';
const runnerWorkspaceTabsSourcePath = 'apps/rallar-black-box/src/legacy/shell/tabs/RunnerWorkspaceTabPanels.tsx';
const runnerAdvancedSourcePath = 'apps/rallar-black-box/src/legacy/runner/advanced/RunnerAdvancedPanel.tsx';
const directConnectionTabsSourcePath = 'apps/rallar-black-box/src/workbench/shell/workbench-direct-connection-tab-panels.tsx';

const WORKBENCH_DYNAMIC_ROUTES = [
    [
        runnerWorkspaceTabsSourcePath,
        '../../runner/recipes/RunnerRecipesPanel.tsx',
        'RunnerRecipesPanel'
    ],
    [
        runnerWorkspaceTabsSourcePath,
        '../../runner/runs/RunnerRunsPanel.tsx',
        'RunnerRunsPanel'
    ],
    [
        runnerWorkspaceTabsSourcePath,
        '../../runner/fleet/RunnerFleetPanel.tsx',
        'RunnerFleetPanel'
    ],
    [
        runnerWorkspaceTabsSourcePath,
        '../../runner/builder/FlowBuilderPanel.tsx',
        'FlowBuilderPanel'
    ],
    [
        runnerAdvancedSourcePath,
        '../distributed-recipes/DistributedRecipesPanel.tsx',
        'DistributedRecipesPanel'
    ],
    [
        runnerAdvancedSourcePath,
        '../run-manager/RunManagerPanel.tsx',
        'RunManagerPanel'
    ],
    [
        runnerAdvancedSourcePath,
        '../shared-test/SharedTestPanel.tsx',
        'SharedTestPanel'
    ],
    [
        directConnectionTabsSourcePath,
        '../../legacy/diagnostics/rooms-clients/RoomsClientsPanel.tsx',
        'RoomsClientsPanel'
    ],
    [
        directConnectionTabsSourcePath,
        '../../legacy/diagnostics/topology/TopologyGraphPanel.tsx',
        'TopologyGraphPanel'
    ],
    [
        directConnectionTabsSourcePath,
        '../../legacy/diagnostics/rtc/RtcDiagnosticsPanel.tsx',
        'RtcDiagnosticsPanel'
    ]
] as const;

it('keeps Recipe Console free of static legacy implementation imports', () => {
    const forbiddenImports = sourceFilesUnder(recipeConsoleSourcePath)
        .flatMap((filePath) => {
            const analysis = analyzeSourceFile(filePath);
            return [
                ...analysis.imports.map((entry) => entry.specifier),
                ...analysis.exports.flatMap((entry) => entry.specifier ? [entry.specifier] : [])
            ]
                .filter(isLegacyImplementationSpecifier)
                .map(
                    (specifier) => `${repositoryRelative(filePath)}: ${specifier}`
                );
        });

    expect(forbiddenImports).toEqual([]);
});

it('loads every registered workbench route dynamically', () => {
    const analyses = new Map<string, SourceAnalysis>();

    for (const [ownerPath, moduleSpecifier, seamName] of WORKBENCH_DYNAMIC_ROUTES) {
        const analysis = analyses.get(ownerPath) ??
            analyzeSourceFile(repositoryAbsolute(ownerPath));
        analyses.set(ownerPath, analysis);

        const literalDynamicImports = analysis.dynamicImports.flatMap(
            (entry) => entry.literal && entry.specifier ? [entry.specifier] : []
        );
        const eagerValueImports = analysis.imports
            .filter(isRuntimeImport)
            .map((entry) => entry.specifier);

        expect(
            literalDynamicImports,
            `${ownerPath}: ${seamName}`
        ).toContain(moduleSpecifier);
        expect(
            eagerValueImports,
            `${ownerPath}: ${seamName} remains lazy`
        ).not.toContain(moduleSpecifier);
    }
});

it('keeps the reachable workbench TypeScript dependency graph acyclic', () => {
    const graph = buildRelativeTypeScriptGraph([
        repositoryAbsolute(workbenchExperienceSourcePath)
    ]);

    expect(findDependencyCycles(graph)).toEqual([]);
});

it('keeps application and workbench roots as composition boundaries', () => {
    const featurePanelNames: ReadonlySet<string> = new Set(
        WORKBENCH_DYNAMIC_ROUTES.map(([, , seamName]) => seamName)
    );

    for (const sourcePath of [appSourcePath, workbenchExperienceSourcePath]) {
        const analysis = analyzeSourceFile(repositoryAbsolute(sourcePath));
        const directFeatureDeclarations = analysis.topLevelDeclarations
            .map((declaration) => declaration.name)
            .filter((name) => featurePanelNames.has(name) || /(?:Panel|Section)$/.test(name));
        const directFeatureImports = analysis.imports
            .flatMap(importedLocalNames)
            .filter((name) => featurePanelNames.has(name) || /(?:Panel|Section)$/.test(name));

        expect(
            directFeatureDeclarations,
            `${sourcePath}: feature declarations`
        ).toEqual([]);
        expect(
            directFeatureImports,
            `${sourcePath}: feature imports`
        ).toEqual([]);
    }
});

function sourceFilesUnder(relativeDirectory: string): readonly string[] {
    const pending = [repositoryAbsolute(relativeDirectory)];
    const sourceFiles: string[] = [];

    while (pending.length > 0) {
        const directory = pending.pop();
        if (!directory) {
            continue;
        }

        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                pending.push(entryPath);
            }
            else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
                sourceFiles.push(entryPath);
            }
        }
    }

    return sourceFiles.sort();
}

function isLegacyImplementationSpecifier(specifier: string): boolean {
    return /(?:^|\/)legacy\//.test(specifier);
}

function isRuntimeImport(entry: SourceImport): boolean {
    return !entry.typeOnly && (
        entry.sideEffectOnly ||
        entry.defaultImport !== undefined ||
        entry.namespaceImport !== undefined ||
        entry.namedImports.some((namedImport) => !namedImport.typeOnly)
    );
}

function importedLocalNames(entry: SourceImport): readonly string[] {
    return [
        ...(entry.defaultImport ? [entry.defaultImport] : []),
        ...(entry.namespaceImport ? [entry.namespaceImport] : []),
        ...entry.namedImports.map((namedImport) => namedImport.local)
    ];
}

function repositoryAbsolute(relativePath: string): string {
    return path.resolve(repositoryRoot, relativePath);
}

function repositoryRelative(absolutePath: string): string {
    return path.relative(repositoryRoot, absolutePath);
}
