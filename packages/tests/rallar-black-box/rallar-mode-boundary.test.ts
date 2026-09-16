import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appTabsForMode } from '../../../apps/rallar-black-box/src/app-tabs.ts';
import { analyzeSourceFile, resolveRelativeTypeScriptDependency } from '../helpers/source-analysis';

const appSourcePath = new URL('../../../apps/rallar-black-box/src/app.tsx', import.meta.url);
const styleSourcePath = new URL('../../../apps/rallar-black-box/src/styles.css', import.meta.url);
const legacyExperienceSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/shell/legacy-experience.tsx',
    import.meta.url
);
const legacyRunHeaderSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/shell/LegacyRunHeader.tsx',
    import.meta.url
);
const runnerRecipesPanelSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/runner/recipes/RunnerRecipesPanel.tsx',
    import.meta.url
);
const runnerRecipesControllerSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/runner/recipes/use-runner-recipes-controller.ts',
    import.meta.url
);
const runnerAgentActionsSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/runner/recipes/runner-agent-launch-actions.ts',
    import.meta.url
);
const runnerDistributedAnalysisSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/runner/runs/RunnerDistributedAnalysisSection.tsx',
    import.meta.url
);
const runnerRunsControllerSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/runner/runs/use-runner-runs-controller.ts',
    import.meta.url
);
const runnerRunsPanelSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/runner/runs/RunnerRunsPanel.tsx',
    import.meta.url
);
const runnerFleetControlsSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/runner/fleet/views/RunnerFleetControls.tsx',
    import.meta.url
);
const runnerFleetControllerSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/runner/fleet/use-runner-fleet-controller.ts',
    import.meta.url
);
const runnerFleetOverviewSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/runner/fleet/views/RunnerFleetOverview.tsx',
    import.meta.url
);
const runnerFleetAnalysisSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/runner/fleet/views/RunnerFleetReportAnalysis.tsx',
    import.meta.url
);
const runnerFleetDetailsSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/runner/fleet/views/RunnerFleetSelectedDetails.tsx',
    import.meta.url
);
const runnerFleetTimingSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/runner/fleet/views/FleetTimingGroupList.tsx',
    import.meta.url
);
const actionFeedbackPanelSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/diagnostics/shared/CommandCenterActionFeedbackPanel.tsx',
    import.meta.url
);
const rtcDiagnosticsControllerSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/diagnostics/rtc/use-rtc-diagnostics-controller.ts',
    import.meta.url
);
const rtcDiagnosticsPanelSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/diagnostics/rtc/RtcDiagnosticsPanel.tsx',
    import.meta.url
);
const topologyGraphPanelSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/diagnostics/topology/TopologyGraphPanel.tsx',
    import.meta.url
);
const quickControllerSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/diagnostics/quick-test/use-quick-rallar-test-controller.ts',
    import.meta.url
);
const quickPanelSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/diagnostics/quick-test/quick-rallar-test-panel.tsx',
    import.meta.url
);
const quickViewSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/diagnostics/quick-test/QuickRallarTestView.tsx',
    import.meta.url
);
const roomsClientsRequestSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/diagnostics/rooms-clients/rooms-clients-request.ts',
    import.meta.url
);
const roomsClientsControllerSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/diagnostics/rooms-clients/use-rooms-clients-controller.ts',
    import.meta.url
);
const roomsClientsViewSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/diagnostics/rooms-clients/RoomsClientsView.tsx',
    import.meta.url
);
const roomsClientsPanelSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/diagnostics/rooms-clients/RoomsClientsPanel.tsx',
    import.meta.url
);
const runnerRecipeViewSourcePaths = [
    new URL(
        '../../../apps/rallar-black-box/src/legacy/runner/recipes/views/RunnerRecipesOverview.tsx',
        import.meta.url
    ),
    new URL(
        '../../../apps/rallar-black-box/src/legacy/runner/recipes/views/RunnerRecipeCatalogList.tsx',
        import.meta.url
    ),
    new URL(
        '../../../apps/rallar-black-box/src/legacy/runner/recipes/views/RunnerRecipeDetail.tsx',
        import.meta.url
    )
] as const;

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const DIRECT_RALLAR_TAB_GROUPS = [
    'apps/rallar-black-box/src/legacy/shell/tabs/direct-connection-tab-panels.tsx',
    'apps/rallar-black-box/src/legacy/shell/tabs/DirectResourceTabPanels.tsx',
    'apps/rallar-black-box/src/legacy/shell/tabs/diagnostic-evidence-tab-panels.tsx'
].map((relativePath) => path.resolve(repositoryRoot, relativePath));
const BLACK_BOX_RUNTIME_STORE = path.resolve(repositoryRoot, 'apps/rallar-black-box/src/runtime-store.ts');
const DIAGNOSTICS_SOURCE_ROOT = path.resolve(repositoryRoot, 'apps/rallar-black-box/src/legacy/diagnostics');
const BLACK_BOX_RUNTIME_COMMAND_NAMES: ReadonlySet<string> = new Set([
    'executeManualCommand',
    'executeManualCommands',
    'executeCommandFromJson',
    'loadRecipeFromJson',
    'runLoadedRecipe',
    'runSample',
    '__blackBoxRallar',
    '__blackBoxRallarEmit',
    'createSpaBrowserRallarRuntime'
]);

/** The runtime store is the black-box boundary: panels may record events through it, so the walk stops there. */
function directPanelDependencyClosure(): readonly string[] {
    const visited = new Set<string>();
    const pending = [...DIRECT_RALLAR_TAB_GROUPS];
    while (pending.length > 0) {
        const filePath = pending.pop();
        if (filePath === undefined || visited.has(filePath) || filePath === BLACK_BOX_RUNTIME_STORE) {
            continue;
        }
        visited.add(filePath);
        const analysis = analyzeSourceFile(filePath);
        const specifiers = [
            ...analysis.imports.map((entry) => entry.specifier),
            ...analysis.exports.flatMap((entry) => entry.specifier ? [entry.specifier] : []),
            ...analysis.dynamicImports.flatMap((entry) => entry.literal && entry.specifier ? [entry.specifier] : [])
        ];
        pending.push(
            ...specifiers.flatMap((specifier) => resolveRelativeTypeScriptDependency(filePath, specifier) ?? [])
        );
    }
    return [...visited].sort();
}

function diagnosticActionOwners(): readonly string[] {
    return readdirSync(DIAGNOSTICS_SOURCE_ROOT, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('-actions.ts'))
        .map((entry) => path.join(entry.parentPath, entry.name))
        .sort();
}

function appSource(): string {
    return readFileSync(appSourcePath, 'utf8');
}

function styleSource(): string {
    return readFileSync(styleSourcePath, 'utf8');
}

function sourceOrFallback(path: URL, fallback: string): string {
    return existsSync(path) ? readFileSync(path, 'utf8') : fallback;
}

function sourceBetween(source: string, startMarker: string, endMarker: string): string {
    const startIndex = source.indexOf(startMarker);
    const endIndex = source.indexOf(endMarker, startIndex + startMarker.length);

    expect(startIndex, `Missing start marker ${startMarker}`).toBeGreaterThanOrEqual(0);
    expect(endIndex, `Missing end marker ${endMarker}`).toBeGreaterThan(startIndex);

    return source.slice(startIndex, endIndex);
}

function diagnosticOwnerSources(source: string): Readonly<{
    rtcController: string;
    rtcPanel: string;
    topologyPanel: string;
    quickPanel: string;
}> {
    const rtcFallback = existsSync(rtcDiagnosticsControllerSourcePath) &&
            existsSync(rtcDiagnosticsPanelSourcePath)
        ? ''
        : sourceBetween(
            source,
            'function RtcDiagnosticsPanel',
            'function TopologyGraphPanel'
        );
    const topologyFallback = existsSync(topologyGraphPanelSourcePath)
        ? ''
        : sourceBetween(
            source,
            'function TopologyGraphPanel',
            'function WebSocketCommandCenterPanel'
        );
    const extracted = existsSync(rtcDiagnosticsControllerSourcePath) &&
        existsSync(rtcDiagnosticsPanelSourcePath) &&
        existsSync(topologyGraphPanelSourcePath);
    const quickFallback = existsSync(quickControllerSourcePath) && existsSync(quickPanelSourcePath)
        ? ''
        : sourceBetween(
            source,
            'function QuickRallarTestPanel',
            extracted
                ? 'function WebSocketCommandCenterPanel'
                : 'function RtcDiagnosticsPanel'
        );
    return {
        rtcController: sourceOrFallback(
            rtcDiagnosticsControllerSourcePath,
            rtcFallback
        ),
        rtcPanel: sourceOrFallback(rtcDiagnosticsPanelSourcePath, rtcFallback),
        topologyPanel: sourceOrFallback(
            topologyGraphPanelSourcePath,
            topologyFallback
        ),
        quickPanel: [
            sourceOrFallback(quickControllerSourcePath, quickFallback),
            sourceOrFallback(quickPanelSourcePath, ''),
            sourceOrFallback(quickViewSourcePath, '')
        ].join('\n')
    };
}

function roomsClientsOwnerSource(source: string): string {
    const extracted = [
        roomsClientsRequestSourcePath,
        roomsClientsControllerSourcePath,
        roomsClientsViewSourcePath,
        roomsClientsPanelSourcePath
    ].every((path) => existsSync(path));
    const fallback = extracted
        ? ''
        : sourceBetween(
            source,
            'function RoomsClientsPanel',
            'function RallarServerRequestFeedbackPanel'
        );
    return [
        sourceOrFallback(roomsClientsRequestSourcePath, fallback),
        sourceOrFallback(roomsClientsControllerSourcePath, ''),
        sourceOrFallback(roomsClientsViewSourcePath, ''),
        sourceOrFallback(roomsClientsPanelSourcePath, '')
    ].join('\n');
}

describe('rallar-black-box Rallar mode boundary', () => {
    it('does not expose black-box-runner command tabs in Rallar mode', () => {
        expect(appTabsForMode('rallar').map((tab) => tab.id)).not.toEqual(
            expect.arrayContaining([
                'manual-rallar',
                'local-workbench',
                'flow-builder',
                'run-manager',
                'shared-test'
            ])
        );
    });

    it('keeps runner sample controls and bootstrap behind black-box-runner mode', () => {
        const source = appSource();
        const legacyExperience = readFileSync(legacyExperienceSourcePath, 'utf8');
        const header = existsSync(legacyRunHeaderSourcePath)
            ? readFileSync(legacyRunHeaderSourcePath, 'utf8')
            : sourceBetween(source, 'function Header', 'function AppTabs');

        expect(header).toContain('mode === \'black-box-runner\'');
        expect(header).toContain('rallarBlackBoxRuntimeStore.runSample()');
        expect(legacyExperience).toContain(
            'if (canBootstrap && navigation.activeMode === \'black-box-runner\')'
        );
        expect(legacyExperience).toContain(
            '}, [canBootstrap, navigation.activeMode]);'
        );
        expect(legacyExperience).toContain('bootstrapMatchesAuthSession');
    });

    it('does not reset the browser-rallar runtime when runner mode is first opened', () => {
        const legacyExperience = readFileSync(legacyExperienceSourcePath, 'utf8');
        const runtimeBootstrap = readFileSync(
            new URL('../../../apps/rallar-black-box/src/runtime-store.ts', import.meta.url),
            'utf8'
        );
        const configureLocalWorkbenchOnly = sourceBetween(
            runtimeBootstrap,
            'async configureLocalWorkbenchOnly(): Promise<void>',
            'async bootstrapControlAgent(): Promise<void>'
        );

        expect(configureLocalWorkbenchOnly).toContain('await this.configureRuntime(runNumber)');
        expect(configureLocalWorkbenchOnly).not.toContain('resetForRun');
        expect(legacyExperience).toContain(
            'if (canBootstrap && navigation.activeMode === \'black-box-runner\')'
        );
        expect(legacyExperience).toContain(
            '}, [canBootstrap, navigation.activeMode]);'
        );
    });

    it('keeps black-box runtime commands out of every module the direct Rallar tab groups load', () => {
        const closure = directPanelDependencyClosure();
        const violations = closure.flatMap((filePath) => {
            const analysis = analyzeSourceFile(filePath);
            const commandNames = analysis.identifierNames.filter((name) => BLACK_BOX_RUNTIME_COMMAND_NAMES.has(name));
            const runtimeImports = [
                ...analysis.imports.map((entry) => entry.specifier),
                ...analysis.dynamicImports.flatMap((entry) => entry.specifier ? [entry.specifier] : [])
            ].filter((specifier) => specifier.includes('browser-rallar-runtime'));
            return [...new Set([...commandNames, ...runtimeImports])].map((name) => `${path.relative(repositoryRoot, filePath)}: ${name}`);
        });

        expect(diagnosticActionOwners().filter((filePath) => !closure.includes(filePath))).toEqual([]);
        expect(violations).toEqual([]);
    });

    it('surfaces action feedback and live subscription state in direct command panels', () => {
        const source = appSource();
        const diagnostics = diagnosticOwnerSources(source);
        const actionFeedbackPanelFallback = existsSync(
                actionFeedbackPanelSourcePath
            )
            ? ''
            : sourceBetween(
                source,
                'function CommandCenterActionFeedbackPanel',
                'function RallarServerRequestFeedbackPanel'
            );
        const actionFeedbackPanel = sourceOrFallback(
            actionFeedbackPanelSourcePath,
            actionFeedbackPanelFallback
        );
        const roomsClientsPanel = roomsClientsOwnerSource(source);

        expect(actionFeedbackPanel).toContain('feedback.state');
        expect(actionFeedbackPanel).toContain('aria-live="polite"');
        expect(roomsClientsPanel).toContain('CommandCenterActionFeedbackPanel');
        expect(diagnostics.rtcPanel).toContain('RtcDiagnosticsTimeseriesPanel');
    });

    it('keeps runner analysis evidence before setup controls and adds RTC performance surfaces', () => {
        const source = appSource();
        const diagnostics = diagnosticOwnerSources(source);
        const styles = styleSource();
        const recipesControllerFallback = existsSync(
                runnerRecipesControllerSourcePath
            )
            ? ''
            : sourceBetween(
                source,
                'function RunnerRecipesPanel',
                'function RunnerRunsPanel'
            );
        const recipesController = sourceOrFallback(
            runnerRecipesControllerSourcePath,
            recipesControllerFallback
        );
        const recipesPanel = [
            sourceOrFallback(runnerAgentActionsSourcePath, recipesControllerFallback),
            recipesController,
            sourceOrFallback(runnerRecipesPanelSourcePath, recipesControllerFallback),
            ...runnerRecipeViewSourcePaths.map((path) => sourceOrFallback(path, recipesControllerFallback))
        ].join('\n');
        const runsControllerFallback = existsSync(runnerRunsControllerSourcePath)
            ? ''
            : sourceBetween(
                source,
                'function RunnerRunsPanel',
                'function RunnerFleetPanel'
            );
        const runsController = sourceOrFallback(
            runnerRunsControllerSourcePath,
            runsControllerFallback
        );
        const runsPanel = sourceOrFallback(
            runnerRunsPanelSourcePath,
            runsControllerFallback
        );
        const runsDistributedView = sourceOrFallback(
            runnerDistributedAnalysisSourcePath,
            runsPanel
        );
        const fleetControllerFallback = existsSync(runnerFleetControllerSourcePath)
            ? ''
            : sourceBetween(
                source,
                'function RunnerFleetPanel',
                'function RtcDiagnosticsPanel'
            );
        const fleetController = sourceOrFallback(
            runnerFleetControllerSourcePath,
            fleetControllerFallback
        );
        const fleetViewsFallback = fleetControllerFallback;
        const fleetViews = [
            sourceOrFallback(runnerFleetControlsSourcePath, fleetViewsFallback),
            sourceOrFallback(runnerFleetOverviewSourcePath, fleetViewsFallback),
            sourceOrFallback(runnerFleetAnalysisSourcePath, fleetViewsFallback),
            sourceOrFallback(runnerFleetDetailsSourcePath, fleetViewsFallback),
            sourceOrFallback(runnerFleetTimingSourcePath, fleetViewsFallback)
        ].join('\n');
        const rtcDiagnosticsPanel = diagnostics.rtcPanel;

        expect(runsPanel).toContain('RunVerdictPanel');
        expect(runsPanel).toContain('CausalTrailPanel');
        expect(runsPanel).toContain('RtcPerformancePanel');
        expect(runsDistributedView).toContain('title="Run Participants"');
        expect(runsController).toContain(
            'monitorAgentProgress: selectedMonitor?.agentProgress'
        );
        expect(runsController).toContain('distributedRunSeed');
        expect(runsDistributedView).toContain('DISTRIBUTED_RUN_SEEDS');
        expect(runsDistributedView).toContain('Synthetic seed');
        expect(runsDistributedView).toContain('Synthetic evidence');
        expect(runsDistributedView).toContain('Clear seed');
        expect(fleetViews).toContain('Live Fleet');
        expect(fleetViews).toContain('title="Live Fleet Agents"');
        expect(fleetController).toContain('fetchControlServerSnapshot');
        expect(recipesPanel).toContain('resolveBlackBoxControlToken');
        expect(recipesPanel).toContain('brokeredControlToken');
        expect(recipesPanel).toContain('Session control token valid until');
        expect(recipesPanel).toContain('Session control token will be requested when needed.');
        expect(recipesPanel).toContain('title="Targetable Agents"');
        expect(recipesPanel).toContain('showConnectedAgents={false}');
        expect(recipesPanel).toContain('const distributedControlToken');
        expect(recipesPanel).toContain('token: distributedControlToken');
        expect(recipesPanel).toContain('controlToken,');
        expect(recipesPanel).not.toContain('const agentLaunchUrls =');
        expect(recipesPanel).not.toContain('createRunnerAgentLaunchUrl({');
        expect(recipesPanel).toContain('createBrowserAgentLaunchService');
        expect(recipesPanel).toContain('reserveBrowserAgentPopups(agentIds)');
        expect(runsPanel.indexOf('RunVerdictPanel')).toBeLessThan(
            runsPanel.indexOf(
                existsSync(runnerDistributedAnalysisSourcePath)
                    ? '<RunnerDistributedAnalysisSection'
                    : 'runner-distributed-analysis'
            )
        );
        expect(runsDistributedView.indexOf('Synthetic seed')).toBeLessThan(
            runsDistributedView.indexOf('title="Run Participants"')
        );
        expect(runsController).toContain('selectedMonitor');
        expect(runsController).toContain(
            'distributedMonitor: selectedMonitor'
        );
        expect(recipesPanel.indexOf('runner-quick-launch-strip')).toBeLessThan(
            recipesPanel.indexOf('<RunnerReadinessPanel')
        );
        expect(recipesPanel.indexOf('<RunnerReadinessPanel')).toBeLessThan(
            recipesPanel.indexOf('title="Targetable Agents"')
        );
        expect(recipesPanel.indexOf('title="Targetable Agents"')).toBeLessThan(
            recipesPanel.indexOf('<RunnerAgentSetupPanel')
        );
        expect(rtcDiagnosticsPanel).toContain('RtcPerformancePanel');
        expect(rtcDiagnosticsPanel.indexOf('<RtcPerformancePanel')).toBeLessThan(
            rtcDiagnosticsPanel.indexOf('<RtcDiagnosticsTimeseriesPanel')
        );
        expect(rtcDiagnosticsPanel.indexOf('<RtcPerformancePanel')).toBeLessThan(
            rtcDiagnosticsPanel.indexOf('rtc-stage-list')
        );
        expect(styles).toContain('.run-verdict-band');
        expect(styles).toContain('.causal-trail-panel');
        expect(styles).toContain('.rtc-performance-panel');
        expect(styles).toContain('.runner-evidence-first');
        expect(styles).toContain('.control-agent-board-panel');
        expect(styles).toContain('.control-agent-board-row');
        expect(styles).toContain('.fleet-live-panel');
        expect(styles).toContain('.app-shell.mode-black-box-runner .app-mode-switch');
        expect(styles).toContain('.app-shell.mode-black-box-runner .app-mode-copy p');
        expect(styles).toContain('.causal-trail-actions');
        expect(styles).toContain('.rtc-performance-legend');
        expect(styles).toContain('.synthetic-seed-control');
        expect(styles).toContain('.synthetic-seed-notice');
    });
});
