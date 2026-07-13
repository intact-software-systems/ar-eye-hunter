import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const appPath = 'apps/rallar-black-box/src/App.tsx';
const legacyExperiencePath =
    'apps/rallar-black-box/src/legacy/shell/LegacyExperience.tsx';
const recipeConsolePath =
    'apps/rallar-black-box/src/recipe-console/app/RecipeConsoleApp.tsx';
const recipeConsoleWorkspacePath =
    'apps/rallar-black-box/src/recipe-console/app/RecipeConsoleWorkspace.tsx';
const recipeConsoleActiveWorkPath =
    'apps/rallar-black-box/src/recipe-console/app/RecipeConsoleActiveWork.tsx';
const recipeConsoleRoot = 'apps/rallar-black-box/src/recipe-console';
const rallarBlackBoxSourceRoot = 'apps/rallar-black-box/src';
const controlConnectionProviderPath =
    `${recipeConsoleRoot}/control/ControlConnectionProvider.tsx`;
const controlCommandContextPath =
    `${recipeConsoleRoot}/control/ControlCommandContext.tsx`;
const controlOverviewPath =
    `${recipeConsoleRoot}/control/ControlOverview.tsx`;
const controlAgentBoardPath =
    `${recipeConsoleRoot}/control/ControlAgentBoard.tsx`;
const controlSelectionPath =
    `${recipeConsoleRoot}/control/control-selection.ts`;

const controlAuthorizedTransportPath =
    `${recipeConsoleRoot}/control/control-authorized-transport.ts`;
const controlSnapshotReaderPath =
    `${recipeConsoleRoot}/control/control-snapshot-reader.ts`;
const controlExecutionApiPath = `${recipeConsoleRoot}/control/control-execution-api.ts`;
const controlExecutionValidationPath =
    `${recipeConsoleRoot}/control/control-execution-validation.ts`;

function source(path: string): string {
    return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

function filesBelow(path: string): string[] {
    return readdirSync(resolve(repositoryRoot, path), {
        recursive: true,
        encoding: 'utf8',
    }).map(entry => `${path}/${entry}`);
}

describe('Recipe Console experience boundary', () => {
    test('keeps App as a two-way lazy experience router after auth gates', () => {
        const app = source(appPath);
        const dynamicExperienceImports = [...app.matchAll(
            /\bimport\(['"]([^'"]+)['"]\)/g,
        )].map(match => match[1]);

        expect(dynamicExperienceImports).toEqual([
            './recipe-console/app/RecipeConsoleApp.tsx',
            './legacy/shell/LegacyExperience.tsx',
        ]);
        expect(app).toMatch(
            /const RecipeConsoleApp = lazy\(\(\) => \{[\s\S]*scrubCurrentRecipeConsoleUrlBeforeLoad\(\);[\s\S]*return import\('\.\/recipe-console\/app\/RecipeConsoleApp\.tsx'\);[\s\S]*\}\);/,
        );
        expect(app).toContain(
            "import { useExperienceRoute } from './app/use-experience-route.ts';",
        );
        expect(app).not.toMatch(/\btype\s+AppExperience\b/);
        expect(app).not.toMatch(/\bfunction\s+experienceFromSearch\b/);
        expect(app).not.toContain("addEventListener('popstate'");
        expect(app).not.toMatch(/from ['"].*LegacyAppShell\.tsx['"]/);
        expect(app).not.toMatch(
            /\b(?:useRunnerShellState|useLegacyNavigation|useCommandCenterGlobalContext|useRunnerShellSelectionSync|ensureBootstrapped)\b/,
        );
        expect(app).not.toMatch(/\b(?:RecipeConsole|Legacy)\w*(?:Panel|Section)\b/);
        expect(app.match(/<Suspense\b/g)).toHaveLength(1);
        expect(app.match(/\?\s*<RecipeConsoleApp\b[\s\S]*:\s*<LegacyExperience\b/g))
            .toHaveLength(1);
        expect(app.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(260);
    });

    test('makes LegacyExperience the sole legacy controller owner', () => {
        expect(existsSync(resolve(repositoryRoot, legacyExperiencePath))).toBe(true);
        const legacyExperience = source(legacyExperiencePath);
        const app = source(appPath);
        expect(legacyExperience.trimEnd().split(/\r?\n/).length)
            .toBeLessThanOrEqual(100);

        for (const controller of [
            'useRunnerShellState',
            'useLegacyNavigation',
            'useCommandCenterGlobalContext',
            'ensureBootstrapped',
            'useRunnerShellSelectionSync',
        ]) {
            expect(legacyExperience, `${controller} owned by lazy legacy wrapper`)
                .toContain(controller);
            expect(app, `${controller} absent from App`).not.toContain(controller);
        }
        expect(legacyExperience).toContain("import '../../styles.css';");
        expect(legacyExperience).toContain('<LegacyAppShell');
    });

    test('keeps Recipe Console independent of legacy modules and bounded', () => {
        expect(existsSync(resolve(repositoryRoot, recipeConsolePath))).toBe(true);
        expect(existsSync(resolve(repositoryRoot, recipeConsoleWorkspacePath))).toBe(true);
        const recipeConsole = source(recipeConsolePath);
        const workspace = source(recipeConsoleWorkspacePath);
        expect(recipeConsole).toContain('<RecipeConsoleWorkspace');
        expect(workspace).toContain('className="recipe-console"');
        expect(workspace).toContain('data-view={urlState.state.view}');
        expect(recipeConsole).not.toMatch(/(?:from\s+|import\()['"][^'"]*legacy\/[^'"]*['"]/);
        expect(workspace).not.toMatch(/(?:from\s+|import\()['"][^'"]*legacy\/[^'"]*['"]/);
        expect(recipeConsole.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(180);
        expect(workspace.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(220);
    });

    test('keeps root domain and legacy modules independent of Recipe Console internals', () => {
        const rootDomainModules = readdirSync(
            resolve(repositoryRoot, rallarBlackBoxSourceRoot),
            { encoding: 'utf8' },
        )
            .filter(entry => /\.[cm]?[jt]sx?$/.test(entry))
            .filter(entry => entry !== 'App.tsx')
            .map(entry => `${rallarBlackBoxSourceRoot}/${entry}`);
        const legacyModules = filesBelow(`${rallarBlackBoxSourceRoot}/legacy`)
            .filter(path => /\.[cm]?[jt]sx?$/.test(path));
        const recipeConsoleImport =
            /(?:from\s+|import\()\s*['"][^'"]*recipe-console\/[^'"]*['"]/;

        for (const path of [...rootDomainModules, ...legacyModules]) {
            expect(source(path), path).not.toMatch(recipeConsoleImport);
        }
    });

    test('passes only the narrow control bootstrap into the lazy Recipe Console', () => {
        const app = source(appPath);
        const recipeConsole = source(recipeConsolePath);

        expect(recipeConsole).toContain('RecipeConsoleControlBootstrap');
        expect(recipeConsole).toMatch(
            /controlBootstrap:\s*RecipeConsoleControlBootstrap/,
        );
        expect(recipeConsole).not.toContain('RallarBlackBoxBootstrapConfig');
        expect(recipeConsole).not.toContain('RuntimeStoreSnapshot');

        expect(app).toContain('controlBootstrap={{');
        expect(app).toMatch(/controlUrl:\s*bootstrap\.controlUrl/);
        expect(app).toMatch(/bootstrapRunId:\s*bootstrap\.runId/);
        expect(app).toMatch(/apiBaseUrl:\s*bootstrap\.apiBaseUrl/);
        expect(app).toMatch(/manualToken:\s*bootstrap\.controlToken/);
        expect(app).toMatch(
            /credentialPolicy:\s*initialRecipeConsoleControlCredentialPolicy/,
        );
        expect(app).toMatch(/authSession,?/);
        expect(app).toMatch(
            /bootstrapGroup:\s*\{[\s\S]*applicationId:\s*bootstrap\.applicationId,[\s\S]*workspaceId:\s*bootstrap\.workspaceId,[\s\S]*groupId:\s*bootstrap\.roomId,[\s\S]*\}/,
        );
        expect(app).not.toMatch(/<RecipeConsoleApp\b[^>]*\bruntime=/);
        expect(app).not.toMatch(/<RecipeConsoleApp\b[^>]*\bbootstrap=\{bootstrap\}/);
    });

    test('owns one control query above the unkeyed live workspace', () => {
        expect(existsSync(resolve(repositoryRoot, controlConnectionProviderPath)))
            .toBe(true);
        if (!existsSync(resolve(repositoryRoot, controlConnectionProviderPath))) {
            return;
        }

        const provider = source(controlConnectionProviderPath);
        const recipeConsole = source(recipeConsolePath);
        const workspace = source(recipeConsoleWorkspacePath);

        expect(recipeConsole).toContain(
            "import { ControlConnectionProvider } from '../control/ControlConnectionProvider.tsx';",
        );
        expect(recipeConsole).toMatch(
            /<ControlConnectionProvider\b[\s\S]*<RecipeConsoleWorkspace\s*\/>[\s\S]*<\/ControlConnectionProvider>/,
        );
        expect(recipeConsole).not.toMatch(/key=\{|\brevision\b|\buseState\b/);
        expect(recipeConsole).not.toMatch(
            /<ControlConnectionProvider\b[^>]*\bkey=/,
        );
        expect(provider).toMatch(
            /import\s*\{[^}]*createRecipeConsoleControlApi[^}]*\}\s*from ['"]\.\/control-api\.ts['"]/,
        );
        expect(provider).toMatch(
            /import\s*\{[^}]*createControlQueryService[^}]*\}\s*from ['"]\.\/control-query\.ts['"]/,
        );
        expect(provider.match(/\bcreateRecipeConsoleControlApi\(/g)).toHaveLength(1);
        expect(provider.match(/\bcreateControlQueryService\(/g)).toHaveLength(1);
        expect(provider).toContain('useEffect');
        expect(provider).toContain('useSyncExternalStore');
        expect(provider).toMatch(/\.start\(\)/);
        expect(provider).toMatch(
            /return\s*\(\)\s*=>\s*\{?[\s\S]{0,120}?\.stop\(\)/,
        );
        expect(provider).not.toMatch(/(?:from\s+|import\()['"][^'"]*legacy\/[^'"]*['"]/);
        expect(provider).not.toMatch(/control-client|control-run-manager|runtime-store/);
        expect(workspace).not.toMatch(
            /createRecipeConsoleControlApi|createControlQueryService|\.start\(\)|\.stop\(\)/,
        );
    });

    test('keeps control authorization and execution behind bounded root-owned seams', () => {
        for (
            const path of [
                controlAuthorizedTransportPath,
                controlSnapshotReaderPath,
                controlExecutionApiPath,
                controlExecutionValidationPath,
            ]
        ) {
            expect(existsSync(resolve(repositoryRoot, path)), path).toBe(true);
        }
        if (
            ![
                controlAuthorizedTransportPath,
                controlSnapshotReaderPath,
                controlExecutionApiPath,
                controlExecutionValidationPath,
            ].every((path) => existsSync(resolve(repositoryRoot, path)))
        ) {
            return;
        }

        const controlApi = source(`${recipeConsoleRoot}/control/control-api.ts`);
        const transport = source(controlAuthorizedTransportPath);
        const snapshotReader = source(controlSnapshotReaderPath);
        const execution = source(controlExecutionApiPath);
        const validation = source(controlExecutionValidationPath);
        const provider = source(controlConnectionProviderPath);

        expect(controlApi).toContain(
            "import { createControlAuthorizedTransport } from './control-authorized-transport.ts';",
        );
        expect(controlApi).toContain(
            "import { createControlSnapshotReader } from './control-snapshot-reader.ts';",
        );
        expect(controlApi).toContain(
            "import { createRecipeConsoleControlExecutionApi } from './control-execution-api.ts';",
        );
        expect(provider).toContain('execution: apiSetup.api?.execution');
        expect(transport).toContain('resolveBlackBoxControlToken');
        expect(snapshotReader).toContain('fetchControlServerSnapshot');
        expect(snapshotReader).toContain('fetchDistributedRuns');
        expect(snapshotReader).toContain('createControlSnapshotRevisionSession');
        expect(execution).toContain('createDistributedRun');
        expect(execution).toContain('resolveDistributedTargets');
        expect(execution).toContain('fetchDistributedRunArtifactBundle');
        expect(validation).toContain('validateControlExecutionArtifactBundle');

        expect(controlApi.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(300);
        expect(transport.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(320);
        expect(snapshotReader.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(240);
        expect(execution.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(220);
        expect(validation.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(220);
        expect(`${transport}\n${snapshotReader}\n${execution}\n${validation}`).not.toMatch(
            /(?:from\s+|import\()['"][^'"]*legacy\/[^'"]*['"]|(?:registry|Registry|index\.ts)/,
        );
    });

    test('keeps pure Execute workflow truth bounded and independent of React or legacy UI', () => {
        const paths = [
            `${recipeConsoleRoot}/execute/execute-workflow-state.ts`,
            `${recipeConsoleRoot}/execute/execute-manifest.ts`,
            `${recipeConsoleRoot}/execute/execute-action-policy.ts`,
        ];
        for (const path of paths) {
            expect(existsSync(resolve(repositoryRoot, path)), path).toBe(true);
        }
        if (!paths.every(path => existsSync(resolve(repositoryRoot, path)))) {
            return;
        }

        const files = paths.map(path => source(path));
        for (const [index, file] of files.entries()) {
            expect(file.trimEnd().split(/\r?\n/).length, paths[index])
                .toBeLessThanOrEqual(300);
        }
        expect(files.join('\n')).not.toMatch(
            /(?:from\s+|import\()['"][^'"]*(?:legacy\/|seeded-console-state|control-run-manager|registry|index\.ts)['"]|from ['"]react['"]|\bfetch\s*\(/,
        );
        expect(files[0]).toContain(
            "export const DEFAULT_EXECUTE_RECIPE_ID = 'rtc-realtime-stability';",
        );
        expect(files[1]).toContain('validateDistributedRunManifest');
        expect(files[2]).toContain('createExecuteActionArmContext');
    });

    test('replaces Execute preview with one bounded live workflow composition', () => {
        const executeOwners = [
            'use-execute-workflow.ts',
            'ExecuteCatalog.tsx',
            'ExecuteTargets.tsx',
            'ExecutePreflight.tsx',
            'ExecuteManifestDisclosure.tsx',
            'ExecuteRunStatus.tsx',
            'ExecuteActionBand.tsx',
            'ExecuteCancelDialog.tsx',
            'ExecuteRecipeInspector.tsx',
            'ExecuteWorkspace.tsx',
        ].map(file => `${recipeConsoleRoot}/execute/${file}`);
        const executeStyles = [
            'ExecuteWorkspace.module.css',
            'ExecuteCatalog.module.css',
            'ExecuteTargets.module.css',
            'ExecutePreflight.module.css',
            'ExecuteManifestDisclosure.module.css',
            'ExecuteRunStatus.module.css',
            'ExecuteActionBand.module.css',
            'ExecuteCancelDialog.module.css',
            'ExecuteRecipeInspector.module.css',
        ].map(file => `${recipeConsoleRoot}/execute/${file}`);
        const executeSupport = [
            'use-execute-draft.ts',
            'use-execute-operations.ts',
            'execute-workflow-context.ts',
            'execute-operation-error.ts',
            'execute-artifact-export.ts',
        ].map(file => `${recipeConsoleRoot}/execute/${file}`);
        for (const path of [...executeOwners, ...executeStyles, ...executeSupport]) {
            expect(existsSync(resolve(repositoryRoot, path)), path).toBe(true);
        }
        if (!executeOwners.every(path => existsSync(resolve(repositoryRoot, path)))) {
            return;
        }

        const ownerSources = executeOwners.map(path => source(path));
        for (const [index, file] of ownerSources.entries()) {
            if (executeOwners[index].endsWith('.tsx')) {
                expect(file.trimEnd().split(/\r?\n/).length, executeOwners[index])
                    .toBeLessThan(300);
            }
        }
        const workspace = source(`${recipeConsoleRoot}/execute/ExecuteWorkspace.tsx`);
        for (const path of [executeOwners[0], ...executeSupport]) {
            expect(source(path).trimEnd().split(/\r?\n/).length, path)
                .toBeLessThanOrEqual(300);
        }
        expect(executeSupport.map(path => source(path)).join('\n')).not.toMatch(
            /(?:from\s+|import\()['"][^'"]*(?:legacy\/|seeded-console-state|control-run-manager|registry|index\.ts)['"]|\bfetch\s*\(/,
        );
        expect(workspace.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(150);
        expect(workspace.match(/\buseExecuteWorkflow\b/g)).toHaveLength(2);
        for (const owner of [
            'ExecuteCatalog',
            'ExecuteTargets',
            'ExecutePreflight',
            'ExecuteManifestDisclosure',
            'ExecuteRunStatus',
            'ExecuteActionBand',
        ]) {
            expect(workspace, owner).toContain(`import { ${owner} }`);
            expect(workspace.match(new RegExp(`<${owner}\\b`, 'g')), owner)
                .toHaveLength(1);
        }
        expect(ownerSources.join('\n')).not.toMatch(
            /(?:from\s+|import\()['"][^'"]*(?:legacy\/|seeded-console-state|control-run-manager|registry|index\.ts)['"]|\bfetch\s*\(|ExecutePreviewModel|seed-agent|Preview action|Stage Preview|Start Preview/,
        );
        expect(workspace).not.toMatch(/ControlOverview|ControlAgentBoard/);
        expect(source(`${recipeConsoleRoot}/execute/ExecuteManifestDisclosure.tsx`))
            .not.toMatch(/textarea|contentEditable/);

        for (const removed of [
            `${recipeConsoleRoot}/execute/ExecutePreview.tsx`,
            `${recipeConsoleRoot}/execute/ExecutePreview.module.css`,
            `${recipeConsoleRoot}/execute/use-execute-preview.ts`,
            `${recipeConsoleRoot}/execute/execute-preview-export.ts`,
            `${recipeConsoleRoot}/control/ControlOverview.tsx`,
            `${recipeConsoleRoot}/control/ControlAgentBoard.tsx`,
            `${recipeConsoleRoot}/control/ControlOverview.module.css`,
        ]) {
            expect(existsSync(resolve(repositoryRoot, removed)), removed).toBe(false);
        }
        const app = source(recipeConsolePath);
        expect(app).not.toMatch(/key=\{revision\}|useState/);
        for (const removed of [
            `${recipeConsoleRoot}/data/seeded-console-state.ts`,
            `${recipeConsoleRoot}/data/recipe-console-models.ts`,
        ]) {
            expect(existsSync(resolve(repositoryRoot, removed)), removed).toBe(false);
        }
    });

    test('binds Monitor operations to the root credential-aware control boundary', () => {
        const monitorOwners = [
            `${recipeConsoleRoot}/monitor/use-monitor-workspace.ts`,
            `${recipeConsoleRoot}/monitor/use-monitor-operations.ts`,
        ];
        const sharedCancelDialog =
            `${recipeConsoleRoot}/control/ControlRunCancelDialog.tsx`;
        const sharedCancelStyle =
            `${recipeConsoleRoot}/control/ControlRunCancelDialog.module.css`;
        for (const path of [...monitorOwners, sharedCancelDialog, sharedCancelStyle]) {
            expect(existsSync(resolve(repositoryRoot, path)), path).toBe(true);
        }
        if (!monitorOwners.every(path => existsSync(resolve(repositoryRoot, path)))) {
            return;
        }

        for (const path of [...monitorOwners, sharedCancelDialog]) {
            expect(source(path).trimEnd().split(/\r?\n/).length, path)
                .toBeLessThanOrEqual(300);
        }
        const monitorOperations = source(monitorOwners[1]);
        expect(monitorOwners.map(path => source(path)).join('\n')).not.toMatch(
            /(?:from\s+|import\()['"][^'"]*(?:legacy\/|seeded-console-state|control-run-manager|registry|index\.ts)['"]|\bfetch\s*\(|\bsetInterval\s*\(/,
        );
        expect(monitorOperations).toContain('connection.execution');
        expect(monitorOperations).toContain('.cancelRun');
        expect(monitorOperations).toContain('.exportRunArtifact');
        expect(monitorOperations).toContain('refreshAfterCurrent');
        expect(monitorOperations).toMatch(/AbortController|\.abort\(\)/);

        const executeCancel = source(
            `${recipeConsoleRoot}/execute/ExecuteCancelDialog.tsx`,
        );
        expect(executeCancel).toContain(
            "../control/ControlRunCancelDialog.tsx",
        );
        expect(executeCancel).not.toMatch(/role=["']alertdialog["']/);
        expect(source(sharedCancelDialog)).toMatch(/role=["']alertdialog["']/);
    });

    test('keeps control fetch and poll ownership out of shell composition', () => {
        const forbiddenOwnership =
            /\bfetch\s*\(|\bsetInterval\s*\(|\bsetTimeout\s*\(|createRecipeConsoleControlApi|createControlQueryService|from ['"][^'"]*control-(?:api|query)\.ts['"]/;
        for (const path of [
            appPath,
            recipeConsolePath,
            recipeConsoleWorkspacePath,
            `${recipeConsoleRoot}/shell/TopCommandBar.tsx`,
        ]) {
            expect(source(path), path).not.toMatch(forbiddenOwnership);
        }

        const runtimeOwners = filesBelow(recipeConsoleRoot)
            .filter(path => path.endsWith('.tsx'))
            .filter(path => /createRecipeConsoleControlApi|createControlQueryService/
                .test(source(path)));
        expect(runtimeOwners).toEqual([controlConnectionProviderPath]);
    });

    test('wires a focused live command context and explicit status mark', () => {
        expect(existsSync(resolve(repositoryRoot, controlCommandContextPath)))
            .toBe(true);
        if (!existsSync(resolve(repositoryRoot, controlCommandContextPath))) {
            return;
        }

        const context = source(controlCommandContextPath);
        const workspace = source(recipeConsoleWorkspacePath);
        const shell = source(`${recipeConsoleRoot}/shell/RecipeConsoleShell.tsx`);
        const commandBar = source(`${recipeConsoleRoot}/shell/TopCommandBar.tsx`);

        expect(workspace).toContain(
            "import { ControlCommandContext } from '../control/ControlCommandContext.tsx';",
        );
        expect(workspace).toContain('<ControlCommandContext');
        expect(workspace).not.toContain('recipeConsoleCommandContext');
        expect(context).toContain('<CommandBarItem');
        for (const label of [
            'Control server',
            'Control run',
            'Group',
            'Connected',
            'Safe targets',
            'Active run',
            'Last updated',
        ]) {
            expect(context, label).toContain(label);
        }
        expect(context).not.toMatch(
            /\bfetch\s*\(|\bsetInterval\s*\(|\bsetTimeout\s*\(|createControlQueryService|createRecipeConsoleSeedState|Seeded offline preview/,
        );

        expect(commandBar).toMatch(/\bstatus,\s*\n?\s*statusLabel,/);
        expect(commandBar).toMatch(/status:\s*OperationalStatus/);
        expect(commandBar).toMatch(/statusLabel:\s*string/);
        expect(commandBar).toContain(
            '<StatusMark label={statusLabel} status={status} />',
        );
        expect(commandBar).not.toContain(
            '<StatusMark label="Preview" status="partial" />',
        );
        expect(shell).toMatch(/commandBarStatus:\s*OperationalStatus/);
        expect(shell).toMatch(/commandBarStatusLabel:\s*string/);
        expect(shell).toContain('status={commandBarStatus}');
        expect(shell).toContain('statusLabel={commandBarStatusLabel}');
    });

    test('keeps new control TSX modules focused and within import boundaries', () => {
        for (const path of [controlConnectionProviderPath, controlCommandContextPath]) {
            expect(existsSync(resolve(repositoryRoot, path)), path).toBe(true);
            if (!existsSync(resolve(repositoryRoot, path))) {
                continue;
            }
            const file = source(path);
            expect(file.trimEnd().split(/\r?\n/).length, path).toBeLessThan(300);
            expect(file, path).not.toMatch(
                /(?:from\s+|import\()['"][^'"]*legacy\/[^'"]*['"]|control-client|runtime-store|(?:registry|Registry|index\.ts)/,
            );
            expect(file, path).not.toMatch(/^\s{4,}function\s+[A-Z]\w*/m);
        }
    });

    test('removes the generic control board after the recipe-aware target cutover', () => {
        for (const path of [controlOverviewPath, controlAgentBoardPath]) {
            expect(existsSync(resolve(repositoryRoot, path)), path).toBe(false);
        }
        const selection = source(controlSelectionPath);
        const hook = source(`${recipeConsoleRoot}/execute/use-execute-workflow.ts`);
        const draft = source(`${recipeConsoleRoot}/execute/use-execute-draft.ts`);
        const targets = source(`${recipeConsoleRoot}/execute/ExecuteTargets.tsx`);
        expect(selection).toMatch(
            /import\s*\{[^}]*deriveControlAgentBoardRows[^}]*summarizeControlAgentBoardRows[^}]*\}\s*from ['"]\.\.\/\.\.\/control-agent-board\.ts['"]/s,
        );
        expect(draft).toContain('distributedRecipeTargetRows');
        expect(targets).toContain('DistributedRecipeTargetRow');
        expect(`${hook}\n${draft}\n${targets}`).not.toMatch(
            /createRecipeConsoleSeedState|seeded-console-state|seed-agent-|ControlOverview|ControlAgentBoard/,
        );
    });

    test('keeps indexed selection ownership in bounded facades and focused helpers', () => {
        const modules = [
            [controlSelectionPath, 285],
            [`${recipeConsoleRoot}/control/control-selection-contract.ts`, 100],
            [`${recipeConsoleRoot}/control/control-selection-context.ts`, 80],
            [`${recipeConsoleRoot}/control/control-run-selection-patch.ts`, 60],
            [`${recipeConsoleRoot}/control/control-selection-index-projection.ts`, 180],
            [`${rallarBlackBoxSourceRoot}/control-selection-index-binding.ts`, 60],
            [`${recipeConsoleRoot}/monitor/monitor-selection.ts`, 220],
            [`${recipeConsoleRoot}/monitor/monitor-selection-projection.ts`, 260],
            [`${recipeConsoleRoot}/monitor/monitor-selection-legacy.ts`, 140],
            [`${recipeConsoleRoot}/monitor/monitor-workspace-state.ts`, 285],
            [`${recipeConsoleRoot}/monitor/monitor-workspace-index-reconciliation.ts`, 140],
            [`${recipeConsoleRoot}/monitor/monitor-workspace-mutation-truth.ts`, 70],
            ['apps/rallar-black-box/src/control-agent-board-index.ts', 270],
            ['apps/rallar-black-box/src/control-agent-board-run-projection.ts', 90],
        ] as const;

        for (const [path, budget] of modules) {
            expect(existsSync(resolve(repositoryRoot, path)), path).toBe(true);
            if (!existsSync(resolve(repositoryRoot, path))) continue;
            const file = source(path);
            expect(file.trimEnd().split(/\r?\n/).length, path)
                .toBeLessThanOrEqual(budget);
            expect(file, path).not.toMatch(/(?:registry|Registry)/);
            expect(file, path).not.toMatch(
                /(?:from\s+|import\()['"][^'"]*\/index\.ts['"]/,
            );
        }
    });

    test('builds the scoped Signal Ledger shell from bounded modules', () => {
        const requiredFiles = [
            'design/tokens.css',
            'design/reset.css',
            'app/RecipeConsoleWorkspace.tsx',
            'app/recipe-console-navigation.ts',
            'shell/RecipeConsoleShell.tsx',
            'shell/RecipeConsoleShell.module.css',
            'shell/TopCommandBar.tsx',
            'shell/PrimaryNavigation.tsx',
            'shell/InspectorHost.tsx',
            'shell/responsive-presentation.ts',
            'shell/use-responsive-presentation.ts',
            'ui/Icon.tsx',
            'ui/IconButton.tsx',
            'ui/CommandBarItem.tsx',
            'ui/StatusMark.tsx',
            'ui/MetricStrip.tsx',
            'ui/SelectableRow.tsx',
            'ui/MatrixCell.tsx',
            'ui/SegmentedControl.tsx',
            'ui/OverlaySheet.tsx',
            'ui/StatePanel.tsx',
            'ui/primitives.module.css',
        ];
        for (const file of requiredFiles) {
            expect(
                existsSync(resolve(repositoryRoot, recipeConsoleRoot, file)),
                file,
            ).toBe(true);
        }

        const navigation = source(`${recipeConsoleRoot}/app/recipe-console-navigation.ts`);
        expect(navigation).toMatch(
            /Execute[\s\S]*Monitor[\s\S]*Analyze[\s\S]*Tune[\s\S]*Fleet[\s\S]*Advanced/,
        );
        expect(navigation).not.toMatch(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u);

        const tokens = source(`${recipeConsoleRoot}/design/tokens.css`);
        expect(tokens.trimStart()).toMatch(/^\.recipe-console\s*\{/);
        expect(tokens).toContain('--rc-canvas: #F5F7FA;');
        expect(tokens).toContain('--rc-primary: #2446C2;');
        expect(tokens).toContain('--rc-status-failed-bg: #FCEBED;');
        expect(tokens).not.toMatch(/^\.(?:panel|metric|workspace-grid|tabs?)\b/m);

        const shell = source(`${recipeConsoleRoot}/shell/RecipeConsoleShell.tsx`);
        expect(shell).toContain('<InspectorHost');
        expect(shell.match(/\{inspectorContent\}/g)).toHaveLength(1);
        expect(shell.trimEnd().split(/\r?\n/).length).toBeLessThan(300);

        const workspace = source(recipeConsoleWorkspacePath);
        const activeWork = source(recipeConsoleActiveWorkPath);
        expect(activeWork).toMatch(/switch\s*\(view\)/);
        expect(workspace).toContain('<RecipeConsoleActiveWork');
        expect(workspace).toContain('<MonitorWorkspace');
        expect(workspace).not.toMatch(/display\s*:\s*['"]none|(?:^|\s)hidden(?:=|\s|>)/m);
        expect(workspace).not.toMatch(/(?:registry|Registry|index\.ts)/);
        expect(workspace).not.toMatch(
            /createRecipeConsoleSeedState|seeded-console-state|\bseedState\b|\bseededRevision\b/,
        );

        for (const path of filesBelow(recipeConsoleRoot).filter(path => path.endsWith('.tsx'))) {
            const file = source(path);
            expect(file.trimEnd().split(/\r?\n/).length, path).toBeLessThan(300);
            expect(file, path).not.toMatch(/^\s{4,}function\s+[A-Z]\w*/m);
        }
        for (const path of requiredFiles.filter(path => path.endsWith('.module.css'))) {
            expect(source(`${recipeConsoleRoot}/${path}`).trimEnd().split(/\r?\n/).length)
                .toBeLessThan(400);
        }
    });

    test('keeps icon-only controls named and the inspector subtree singular', () => {
        const iconButton = source(`${recipeConsoleRoot}/ui/IconButton.tsx`);
        expect(iconButton).toContain("'aria-label': ariaLabel");
        expect(iconButton).toContain('title={title ?? ariaLabel}');

        const inspector = source(`${recipeConsoleRoot}/shell/InspectorHost.tsx`);
        expect(inspector.match(/\{children\}/g)).toHaveLength(1);
        expect(inspector).not.toMatch(/hidden|display\s*:\s*none/);
    });

    test('owns one bounded searchable listbox foundation without a registry or native select', () => {
        const budgets = [
            ['ui/explicit-window-model.ts', 110],
            ['ui/use-explicit-window.ts', 135],
            ['ui/ExplicitWindowControls.tsx', 100],
            ['ui/searchable-listbox-model.ts', 180],
            ['ui/use-searchable-listbox.ts', 220],
            ['ui/SearchableWindowedListbox.tsx', 220],
            ['ui/SearchableWindowedListbox.module.css', 220],
        ] as const;
        for (const [relative, budget] of budgets) {
            const path = `${recipeConsoleRoot}/${relative}`;
            expect(existsSync(resolve(repositoryRoot, path)), path).toBe(true);
            if (!existsSync(resolve(repositoryRoot, path))) continue;
            const file = source(path);
            expect(file.trimEnd().split(/\r?\n/).length, path)
                .toBeLessThanOrEqual(budget);
            expect(file, path).not.toMatch(/(?:registry|Registry|index\.ts|legacy\/)/);
        }

        const model = source(`${recipeConsoleRoot}/ui/searchable-listbox-model.ts`);
        const hook = source(`${recipeConsoleRoot}/ui/use-searchable-listbox.ts`);
        const component = source(`${recipeConsoleRoot}/ui/SearchableWindowedListbox.tsx`);
        expect(model).toContain('SEARCHABLE_LISTBOX_WINDOW_SIZE = 100');
        expect(hook).toContain('useDeferredValue');
        expect(hook).toContain('revealIndex');
        expect(component).toContain('role="combobox"');
        expect(component).toContain('role="listbox"');
        expect(component).toContain('role="option"');
        expect(component).toContain('<ExactIdentifier');
        expect(component).toContain('<ExplicitWindowControls');
        expect(component).not.toMatch(/<select\b|\.slice\(\s*0\s*,\s*100\s*\)/);
        expect(component).not.toMatch(/(?:\shidden(?:=|\s|>)|display\s*:\s*none)/);
    });

    test('keeps live Execute orchestration and refresh ownership explicit', () => {
        const hook = source(`${recipeConsoleRoot}/execute/use-execute-workflow.ts`);
        const draft = source(`${recipeConsoleRoot}/execute/use-execute-draft.ts`);
        const operations = source(`${recipeConsoleRoot}/execute/use-execute-operations.ts`);
        const workspace = source(recipeConsoleWorkspacePath);
        expect(hook).toContain('projectDistributedRecipeCatalog');
        expect(draft).toContain('distributedRecipeTargetRows');
        expect(hook).toContain('deriveExecuteManifest');
        expect(operations).toContain('requiredExecution(input.connection)');
        expect(`${hook}\n${draft}\n${operations}`).not.toMatch(
            /\bfetch\s*\(|seeded-console-state|seed-agent-/,
        );
        expect(workspace).toContain(
            'onRefresh={() => void control.connection.refresh()}',
        );
        expect(workspace).not.toMatch(/setSeededRevision|createRecipeConsoleSeedState/);
        expect(workspace).toContain('onSafeTargetLabelChange');
    });

    test('replaces seeded Monitor with bounded failure-first live composition', () => {
        const owners = [
            'MonitorWorkspace.tsx',
            'MonitorRunSelector.tsx',
            'MonitorVerdict.tsx',
            'MonitorFailureLedger.tsx',
            'MonitorAgentPhaseMatrix.tsx',
            'MonitorProgressEvidence.tsx',
            'MonitorDiagnostics.tsx',
            'MonitorEvidenceDisclosure.tsx',
            'MonitorWindowTruth.tsx',
            'MonitorActionBand.tsx',
            'MonitorInspector.tsx',
            'MonitorInspectorWindow.tsx',
            'MonitorRecipeEvidence.tsx',
        ].map(file => `${recipeConsoleRoot}/monitor/${file}`);
        const styles = [
            'MonitorWorkspace.module.css',
            'MonitorVerdict.module.css',
            'MonitorLedger.module.css',
            'MonitorProgress.module.css',
            'MonitorEvidence.module.css',
            'MonitorActions.module.css',
            'MonitorInspector.module.css',
            'MonitorWindowTruth.module.css',
        ].map(file => `${recipeConsoleRoot}/monitor/${file}`);
        const support = `${recipeConsoleRoot}/monitor/legacy-monitor-link.ts`;
        const windowSupport = [
            'monitor-window-contract.ts',
            'use-monitor-window.ts',
        ].map(file => `${recipeConsoleRoot}/monitor/${file}`);
        for (const path of [...owners, ...styles, support, ...windowSupport]) {
            expect(existsSync(resolve(repositoryRoot, path)), path).toBe(true);
        }
        if (!owners.every(path => existsSync(resolve(repositoryRoot, path)))) {
            return;
        }

        const sources = owners.map(path => source(path));
        for (const [index, file] of sources.entries()) {
            expect(file.trimEnd().split(/\r?\n/).length, owners[index])
                .toBeLessThan(300);
        }
        for (const path of styles) {
            expect(source(path).trimEnd().split(/\r?\n/).length, path)
                .toBeLessThan(300);
        }
        const windowSupportSource = windowSupport.map(path => source(path));
        for (const [index, file] of windowSupportSource.entries()) {
            expect(file.trimEnd().split(/\r?\n/).length, windowSupport[index])
                .toBeLessThan(180);
        }
        expect([...sources, ...windowSupportSource].join('\n')).not.toMatch(
            /(?:from\s+|import\()['"][^'"]*(?:legacy\/|seeded-console-state|control-run-manager|registry|index\.ts)['"]|\bfetch\s*\(|\bsetInterval\s*\(/,
        );
        const composition = sources[0];
        expect(composition.match(/\buseMonitorWorkspace\b/g)).toHaveLength(2);
        expect(composition).toContain('if (!model) return undefined;');
        expect(composition).toMatch(
            /<MonitorVerdict[\s\S]*<MonitorActionBand[\s\S]*<MonitorFailureLedger/,
        );
        for (const owner of [
            'MonitorRunSelector',
            'MonitorVerdict',
            'MonitorFailureLedger',
            'MonitorAgentPhaseMatrix',
            'MonitorProgressEvidence',
            'MonitorDiagnostics',
            'MonitorEvidenceDisclosure',
            'MonitorActionBand',
        ]) {
            expect(composition, owner).toContain(`<${owner}`);
        }
        expect(composition).toContain('<ControlRunCancelDialog');
        expect(source(`${recipeConsoleRoot}/monitor/MonitorInspector.tsx`))
            .toContain('deriveDistributedRunFailureEvidenceDestinations');
        expect(composition).toContain('MONITOR_ARTIFACT_EVIDENCE_ID');
        expect(composition.match(/contextKey=\{monitor\.model\.source\.contextKey\}/g))
            .toHaveLength(3);
        const ledger = source(`${recipeConsoleRoot}/monitor/MonitorFailureLedger.tsx`);
        expect(ledger).toContain('<ul');
        expect(ledger).toContain('aria-pressed={active}');
        expect(ledger).not.toMatch(/role="(?:listbox|option)"|aria-selected/);
        const boundedOwners = [
            'MonitorFailureLedger.tsx',
            'MonitorAgentPhaseMatrix.tsx',
            'MonitorProgressEvidence.tsx',
            'MonitorDiagnostics.tsx',
            'MonitorEvidenceDisclosure.tsx',
            'MonitorInspectorWindow.tsx',
        ].map(file => source(`${recipeConsoleRoot}/monitor/${file}`));
        expect(boundedOwners.join('\n')).not.toMatch(/\.slice\(\s*0\s*,|\b[A-Z_]+_LIMIT\b/);
        expect(boundedOwners.every(file => file.includes('useMonitorWindow'))).toBe(true);
        const matrix = boundedOwners[1];
        expect(matrix.indexOf('<ExplicitWindowControls'))
            .toBeLessThan(matrix.indexOf('data-monitor-matrix-scroller'));
        const disclosure = boundedOwners[4];
        expect(disclosure).toContain('timelineOpen ?');
        expect(disclosure).toContain('eventsOpen ?');
        expect(disclosure).toContain('compositesOpen ?');
        expect(disclosure).not.toMatch(/\bhidden\b|display\s*:\s*none/);
        const inspectorWindow = boundedOwners[5];
        expect(inspectorWindow.trimEnd().split(/\r?\n/).length)
            .toBeLessThan(220);
        expect(inspectorWindow).toContain('section: MonitorWindowSection;');
        expect(inspectorWindow).toContain('items.slice(');
        expect(inspectorWindow).toContain('window.controlsFocusProps');
        expect(inspectorWindow).toContain('<MonitorWindowTruth');
        const contract = windowSupportSource[0];
        for (const [section, budget] of [
            ['failures', 60], ['agents', 80], ['recipes', 60],
            ['readiness', 60], ['diagnostics', 50], ['timeline', 40],
            ['events', 40], ['composites', 40],
        ] as const) {
            expect(contract).toContain(`${section}: ${budget}`);
        }
        expect(contract).toContain("input.section === 'diagnostics'");
        expect(contract).toContain('JSON.stringify([');
        expect(windowSupportSource[1]).toContain(
            'controlsFocusProps: focus.contentFocusProps',
        );
        const windowTruth = source(
            `${recipeConsoleRoot}/monitor/MonitorWindowTruth.tsx`,
        );
        expect(windowTruth).toContain('data-monitor-window-focus-anchor={label}');
        expect(windowTruth).toContain('ref={window.focusFallbackRef}');
        expect(windowTruth).toContain(
            'window.model.total > window.model.windowSize',
        );
        expect(windowTruth).not.toMatch(/aria-live|role="status"/);
        const monitorHook = source(`${recipeConsoleRoot}/monitor/use-monitor-workspace.ts`);
        expect(monitorHook).toContain('if (nextEvidenceKey === urlEvidenceKey) return;');
        expect(monitorHook).not.toMatch(
            /\[context\?\.key,\s*input\.urlState,\s*urlEvidenceKey\]/,
        );
        expect(source(support)).toContain('tab=runs');

        for (const removed of [
            `${recipeConsoleRoot}/monitor/MonitorPreview.tsx`,
            `${recipeConsoleRoot}/monitor/FailureInspector.tsx`,
            `${recipeConsoleRoot}/monitor/MonitorPreview.module.css`,
        ]) {
            expect(existsSync(resolve(repositoryRoot, removed)), removed).toBe(false);
        }
        const workspace = source(recipeConsoleWorkspacePath);
        expect(workspace).toContain(
            "import { MonitorWorkspace } from '../monitor/MonitorWorkspace.tsx';",
        );
        expect(workspace).not.toMatch(/MonitorPreview|FailureInspector|seedState\.monitor/);
        expect(workspace).toContain(
            'const inspectableSelection = inspectorContent !== undefined &&',
        );
        expect(workspace).toContain('onSelectionLabelChange={setSelectionLabel}');

        const overlay = source(`${recipeConsoleRoot}/ui/OverlaySheet.tsx`);
        expect(overlay).toContain("event.key === 'Escape'");
        expect(overlay).toContain("event.key !== 'Tab'");
        expect(overlay).toContain('restoreFocusTo.focus()');
        expect(overlay).toContain('querySelectorAll<HTMLElement>(FOCUSABLE)');
    });

    test('replaces Analyze preview with one bounded artifact workflow composition', () => {
        const analyzeOwners = [
            'AnalyzeWorkspace.tsx',
            'AnalyzeSourcePanel.tsx',
            'AnalyzeVerdict.tsx',
            'AnalyzeEvidenceQuality.tsx',
            'AnalyzePerformance.tsx',
            'AnalyzeEvidenceSearch.tsx',
            'AnalyzeMarkdown.tsx',
            'AnalyzeInspector.tsx',
        ].map(file => `${recipeConsoleRoot}/analyze/${file}`);
        const analyzeSupport = [
            'use-analyze-workspace.ts',
            'use-analyze-workspace-controller.ts',
            'use-analyze-operations.ts',
            'analyze-local-offer.ts',
            'analyze-worker-workspace-adapter.ts',
            'analyze-worker-error.ts',
            'analyze-artifact-model.ts',
            'analyze-artifact-search.ts',
            'analyze-artifact-projection.ts',
            'analyze-artifact-display-projection.ts',
            'analyze-analysis-projection.ts',
            'analyze-performance-projection.ts',
            'analyze-verdict-projection.ts',
            'analyze-evidence-projection.ts',
            'analyze-projection-bounds.ts',
            'analyze-tune-projection.ts',
            'analyze-tune-projection-rows.ts',
            'analyze-tune-fallback.ts',
            'analyze-file-boundary.ts',
            'analyze-file-contract.ts',
            'analyze-file-intake-policy.ts',
            'analyze-identity-policy.ts',
            'analyze-legacy-links.ts',
            'analyze-selection.ts',
            'analyze-workspace-policy.ts',
            'analyze-workspace-state.ts',
        ].map(file => `${recipeConsoleRoot}/analyze/${file}`);
        const analyzeStyles = [
            'AnalyzeWorkspace.module.css',
            'AnalyzeSource.module.css',
            'AnalyzeSearch.module.css',
            'AnalyzeVerdict.module.css',
            'AnalyzeEvidence.module.css',
            'AnalyzeInspector.module.css',
        ].map(file => `${recipeConsoleRoot}/analyze/${file}`);

        for (const path of [...analyzeOwners, ...analyzeSupport, ...analyzeStyles]) {
            expect(existsSync(resolve(repositoryRoot, path)), path).toBe(true);
        }
        if (!analyzeOwners.every(path => existsSync(resolve(repositoryRoot, path)))) {
            return;
        }

        const composition = source(`${recipeConsoleRoot}/analyze/AnalyzeWorkspace.tsx`);
        expect(composition.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(180);
        for (const path of [...analyzeOwners, ...analyzeSupport]) {
            expect(source(path).trimEnd().split(/\r?\n/).length, path)
                .toBeLessThanOrEqual(300);
        }
        const analyzeModules = filesBelow(`${recipeConsoleRoot}/analyze`)
            .filter(path => /\.(?:ts|tsx)$/u.test(path));
        expect(analyzeModules.length).toBeGreaterThanOrEqual(
            analyzeOwners.length + analyzeSupport.length,
        );
        for (const path of analyzeModules) {
            expect(source(path).trimEnd().split(/\r?\n/).length, path)
                .toBeLessThanOrEqual(300);
        }
        for (const path of analyzeStyles) {
            expect(source(path).trimEnd().split(/\r?\n/).length, path)
                .toBeLessThanOrEqual(300);
        }
        for (const owner of [
            'AnalyzeSourcePanel',
            'AnalyzeVerdict',
            'AnalyzeEvidenceQuality',
            'AnalyzePerformance',
            'AnalyzeEvidenceSearch',
            'AnalyzeMarkdown',
        ]) {
            expect(composition, owner).toContain(`<${owner}`);
        }
        const allSources = [...analyzeOwners, ...analyzeSupport]
            .map(path => source(path))
            .join('\n');
        expect(allSources).not.toMatch(
            /(?:from\s+|import\()['"][^'"]*(?:legacy\/|seeded-console-state|control-run-manager|registry|index\.ts)['"]|\bfetch\s*\(|\bsetInterval\s*\(|\blocalStorage\b|dangerouslySetInnerHTML/,
        );
        const hook = source(`${recipeConsoleRoot}/analyze/use-analyze-workspace.ts`);
        const operations = source(
            `${recipeConsoleRoot}/analyze/use-analyze-operations.ts`,
        );
        const localOffer = source(
            `${recipeConsoleRoot}/analyze/analyze-local-offer.ts`,
        );
        const workerAdapter = source(
            `${recipeConsoleRoot}/analyze/analyze-worker-workspace-adapter.ts`,
        );
        expect(hook).toContain('useAnalyzeOperations');
        expect(hook).not.toMatch(
            /from ['"]\.\/analyze-worker-(?:client|factory)\.ts['"]/,
        );
        expect(hook).not.toContain('state.artifactStatus');
        expect(operations).toContain('connection.execution');
        expect(operations).toContain('.exportRunArtifactBytes');
        expect(`${operations}\n${workerAdapter}`)
            .toContain('analyzeOperationOwnsCurrentBoundary');
        expect(operations).toMatch(/AbortController|\.abort\(\)/);
        expect(localOffer).toContain('readAnalyzeArtifactFiles');
        expect(localOffer).toContain('readAnalyzeArtifactTransferFiles');
        expect(workerAdapter).toContain("import('./analyze-worker-client.ts')");
        expect(workerAdapter).toContain("import('./analyze-worker-factory.ts')");
        expect(workerAdapter).toContain('lifetimeRef.current');
        expect(workerAdapter).toMatch(
            /if \(lifetime !== lifetimeRef\.current\) \{\s*client\.dispose\(\);\s*throw/,
        );
        expect(source(`${recipeConsoleRoot}/analyze/analyze-artifact-model.ts`))
            .toContain('deriveDistributedArtifactWorkspace');
        expect(source(`${recipeConsoleRoot}/analyze/AnalyzeSourcePanel.tsx`))
            .toContain('Open generic export in legacy Shared Test');

        const workspace = source(recipeConsoleWorkspacePath);
        expect(workspace).toContain(
            "import { AnalyzeWorkspace } from '../analyze/AnalyzeWorkspace.tsx';",
        );
        expect(workspace).toContain(
            "import { useAnalyzeWorkspace } from '../analyze/use-analyze-workspace.ts';",
        );
        expect(workspace).not.toMatch(/AnalyzePreview|data-preview-view=["']analyze/);
        expect(existsSync(resolve(
            repositoryRoot,
            `${recipeConsoleRoot}/analyze/AnalyzePreview.tsx`,
        ))).toBe(false);
    });

    test('routes focused Tune Fleet and Advanced modules through one switch', () => {
        const focusedModules = [
            ['fleet/FleetPreview.tsx', "import { FleetPreview } from '../fleet/FleetPreview.tsx';", '<FleetPreview'],
            ['advanced/AdvancedPreview.tsx', "import { AdvancedPreview } from '../advanced/AdvancedPreview.tsx';", '<AdvancedPreview'],
        ] as const;
        const app = source(recipeConsoleActiveWorkPath);

        expect(existsSync(resolve(repositoryRoot, recipeConsoleActiveWorkPath))).toBe(true);
        expect(app.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(100);

        for (const [path, directImport, render] of focusedModules) {
            const absolutePath = resolve(repositoryRoot, recipeConsoleRoot, path);
            expect(existsSync(absolutePath), path).toBe(true);
            expect(app).toContain(directImport);
            expect(app).toContain(render);
            expect(source(`${recipeConsoleRoot}/${path}`)).not.toMatch(
                /(?:from\s+|import\()['"][^'"]*legacy\/[^'"]*['"]/,
            );
        }
        expect(app).toContain(
            "const TuneWorkspace = lazy(() => import('../tune/TuneWorkspace.tsx'));",
        );
        expect(app).toMatch(
            /case 'tune':[\s\S]*<Suspense[\s\S]*<TuneWorkspace[\s\S]*<\/Suspense>/,
        );
        for (const removed of [
            'tune/TunePreview.tsx',
            'tune/TimingDistribution.tsx',
            'tune/TunePreview.module.css',
        ]) {
            expect(existsSync(resolve(repositoryRoot, recipeConsoleRoot, removed)), removed)
                .toBe(false);
        }
        expect(existsSync(resolve(
            repositoryRoot,
            recipeConsoleRoot,
            'views/PreviewState.module.css',
        ))).toBe(true);
        expect(app.match(/switch\s*\(view\)/g)).toHaveLength(1);
        expect(app).not.toMatch(/(?:viewRegistry|VIEW_REGISTRY|Record<RecipeConsoleView)/);
        expect(app).not.toMatch(/from ['"][^'"]*(?:index|views)\.ts['"]/);
    });

    test('loads only auth CSS statically while preserving legacy CSS bytes', () => {
        const authCss = source('apps/rallar-black-box/src/auth.css');
        expect(source('apps/rallar-black-box/src/main.tsx')).toContain("import './auth.css';");
        expect(source('apps/rallar-black-box/src/main.tsx')).not.toContain("import './styles.css';");
        expect(authCss).toMatch(
            /\.auth-panel \.pill\.active\s*\{\s*color:\s*#0c6f7b;\s*\}/,
        );
        expect(authCss).toContain(`.auth-summary dt {
    color: #67766f;
    font-size: 0.72rem;
}`);
        expect(authCss).toContain(`.auth-summary dd {
    min-width: 0;
    margin: 2px 0 0;
    overflow: hidden;
    color: #1d2823;
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
}`);
        expect(authCss).not.toMatch(/^\.active\s*\{/m);
        expect(authCss).not.toMatch(/^dt\s*\{/m);
        expect(authCss).not.toMatch(/^dd\s*\{/m);
        expect(createHash('sha256')
            .update(source('apps/rallar-black-box/src/styles.css'))
            .digest('hex'))
            .toBe('9778cfa43e7a858b30a9304b36b2939bfbf89df2722ac05a65b97579a37640b4');
    });

    test('restricts the Vite-only browser project to Recipe Console specs', () => {
        const config = source(
            'apps/rallar-black-box/playwright.recipe-console.config.ts',
        );
        expect(config).toContain('testMatch: /recipe-console-.*\\.spec\\.ts/');
        expect(config).toContain("baseURL: 'http://127.0.0.1:5176'");
        expect(config.match(/webServer:/g)).toHaveLength(1);
        expect(config).not.toMatch(/control-server|RALLAR_BLACK_BOX_CONTROL/i);
    });

    test('includes emitted CSS in the executable experience closure proof', () => {
        const assertion = source(
            'apps/rallar-black-box/scripts/assert-experience-chunks.ts',
        );
        expect(assertion).toContain('css?: readonly string[];');
        expect(assertion).toContain('...(chunk.css ?? [])');
        expect(assertion).toContain('function cssClosure(');
        expect(assertion).toContain(
            'Legacy experience must emit a nonempty CSS closure.',
        );
        expect(assertion).toContain(
            'Main static closure includes legacy CSS:',
        );
        expect(assertion).toContain(
            'Recipe Console static closure includes legacy CSS:',
        );
    });
});
