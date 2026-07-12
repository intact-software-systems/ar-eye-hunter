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
const recipeConsoleRoot = 'apps/rallar-black-box/src/recipe-console';
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
            /lazy\(\(\)\s*=>\s*import\(['"]([^'"]+)['"]\)\s*\)/g,
        )].map(match => match[1]);

        expect(dynamicExperienceImports).toEqual([
            './recipe-console/app/RecipeConsoleApp.tsx',
            './legacy/shell/LegacyExperience.tsx',
        ]);
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
        expect(app).toMatch(/authSession,?/);
        expect(app).toMatch(
            /bootstrapGroup:\s*\{[\s\S]*applicationId:\s*bootstrap\.applicationId,[\s\S]*workspaceId:\s*bootstrap\.workspaceId,[\s\S]*groupId:\s*bootstrap\.roomId,[\s\S]*\}/,
        );
        expect(app).not.toMatch(/<RecipeConsoleApp\b[^>]*\bruntime=/);
        expect(app).not.toMatch(/<RecipeConsoleApp\b[^>]*\bbootstrap=\{bootstrap\}/);
    });

    test('owns one control query above keyed preview workspace remounts', () => {
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
            /<ControlConnectionProvider\b[\s\S]*<RecipeConsoleWorkspace\b[\s\S]*key=\{revision\}[\s\S]*<\/ControlConnectionProvider>/,
        );
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

    test('composes a focused repository-derived control overview and agent board', () => {
        for (const path of [controlOverviewPath, controlAgentBoardPath]) {
            expect(existsSync(resolve(repositoryRoot, path)), path).toBe(true);
        }
        if (
            !existsSync(resolve(repositoryRoot, controlOverviewPath)) ||
            !existsSync(resolve(repositoryRoot, controlAgentBoardPath))
        ) {
            return;
        }

        const overview = source(controlOverviewPath);
        const board = source(controlAgentBoardPath);
        const selection = source(controlSelectionPath);
        const compositionOwners = filesBelow(recipeConsoleRoot)
            .filter(path => path.endsWith('.tsx'))
            .filter(path => path !== controlOverviewPath)
            .filter(path => source(path).includes('<ControlOverview'));

        expect(compositionOwners).toHaveLength(1);
        expect(compositionOwners[0]).toMatch(
            /apps\/rallar-black-box\/src\/recipe-console\/(?:app|execute)\//,
        );
        expect(overview).toContain(
            "import { ControlAgentBoard } from './ControlAgentBoard.tsx';",
        );
        expect(overview).toContain('<ControlAgentBoard');
        expect(selection).toMatch(
            /import\s*\{[^}]*deriveControlAgentBoardRows[^}]*summarizeControlAgentBoardRows[^}]*\}\s*from ['"]\.\.\/\.\.\/control-agent-board\.ts['"]/s,
        );
        expect(`${overview}\n${board}`).not.toMatch(
            /createRecipeConsoleSeedState|seeded-console-state|seed-agent-/,
        );
        expect(`${overview}\n${board}`).not.toMatch(
            /distributedRecipeTargetRows|\.filter\([^)]*targetable[^)]*\)\.length/,
        );

        for (const [path, file] of [
            [controlOverviewPath, overview],
            [controlAgentBoardPath, board],
        ] as const) {
            expect(file.trimEnd().split(/\r?\n/).length, path)
                .toBeLessThanOrEqual(300);
            expect(file, path).not.toMatch(
                /(?:from\s+|import\()['"][^'"]*legacy\/[^'"]*['"]|(?:registry|Registry|index\.ts)/,
            );
            expect(file, path).not.toMatch(/^\s{4,}function\s+[A-Z]\w*/m);
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
        expect(workspace).toMatch(/switch\s*\(view\)/);
        expect(workspace).toMatch(
            /activeWork\(\s*urlState\.state\.view,\s*seedState,\s*monitorWork,/,
        );
        expect(workspace).not.toMatch(/display\s*:\s*['"]none|(?:^|\s)hidden(?:=|\s|>)/m);
        expect(workspace).not.toMatch(/(?:registry|Registry|index\.ts)/);
        expect(workspace).toContain('createRecipeConsoleSeedState');

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

    test('keeps Execute preview UI state and repository projections explicit', () => {
        const hook = source(
            `${recipeConsoleRoot}/execute/use-execute-preview.ts`,
        );
        const view = source(
            `${recipeConsoleRoot}/execute/ExecutePreview.tsx`,
        );
        expect(hook).toContain('preflightExpanded');
        expect(view).toContain('open={preview.preflightExpanded}');
        expect(view).toContain('model.group.applicationId');
        expect(view).not.toContain("'rallar-server/default/seed-room'");
        expect(view).not.toMatch(/\bfetch\s*\(/);
    });

    test('keeps failure-first Monitor and modal focus behavior bounded', () => {
        const monitorPath = `${recipeConsoleRoot}/monitor/MonitorPreview.tsx`;
        const inspectorPath = `${recipeConsoleRoot}/monitor/FailureInspector.tsx`;
        const monitorCssPath = `${recipeConsoleRoot}/monitor/MonitorPreview.module.css`;
        for (const path of [monitorPath, inspectorPath, monitorCssPath]) {
            expect(existsSync(resolve(repositoryRoot, path)), path).toBe(true);
        }
        expect(source(monitorPath).trimEnd().split(/\r?\n/).length).toBeLessThan(300);
        expect(source(inspectorPath).trimEnd().split(/\r?\n/).length).toBeLessThan(300);
        expect(source(monitorCssPath).trimEnd().split(/\r?\n/).length).toBeLessThan(400);
        expect(source(monitorPath)).not.toMatch(/\bfetch\s*\(|legacy\//);
        expect(source(inspectorPath)).toContain(
            '/?provider=simulated&experience=legacy&tab=rtc-diagnostics',
        );
        expect(source(inspectorPath)).not.toMatch(/from ['"][^'"]*legacy\//);

        const overlay = source(`${recipeConsoleRoot}/ui/OverlaySheet.tsx`);
        expect(overlay).toContain("event.key === 'Escape'");
        expect(overlay).toContain("event.key !== 'Tab'");
        expect(overlay).toContain('restoreFocusTo.focus()');
        expect(overlay).toContain('querySelectorAll<HTMLElement>(FOCUSABLE)');
    });

    test('routes focused Tune Analyze Fleet and Advanced modules through one switch', () => {
        const focusedModules = [
            ['tune/TunePreview.tsx', "import { TunePreview } from '../tune/TunePreview.tsx';", '<TunePreview'],
            ['analyze/AnalyzePreview.tsx', "import { AnalyzePreview } from '../analyze/AnalyzePreview.tsx';", '<AnalyzePreview'],
            ['fleet/FleetPreview.tsx', "import { FleetPreview } from '../fleet/FleetPreview.tsx';", '<FleetPreview'],
            ['advanced/AdvancedPreview.tsx', "import { AdvancedPreview } from '../advanced/AdvancedPreview.tsx';", '<AdvancedPreview'],
        ] as const;
        const app = source(recipeConsoleWorkspacePath);

        for (const [path, directImport, render] of focusedModules) {
            const absolutePath = resolve(repositoryRoot, recipeConsoleRoot, path);
            expect(existsSync(absolutePath), path).toBe(true);
            expect(app).toContain(directImport);
            expect(app).toContain(render);
            expect(source(`${recipeConsoleRoot}/${path}`)).not.toMatch(
                /(?:from\s+|import\()['"][^'"]*legacy\/[^'"]*['"]/,
            );
        }
        for (const path of [
            'tune/TimingDistribution.tsx',
            'tune/TunePreview.module.css',
            'views/PreviewState.module.css',
        ]) {
            expect(existsSync(resolve(repositoryRoot, recipeConsoleRoot, path)), path).toBe(true);
        }
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
