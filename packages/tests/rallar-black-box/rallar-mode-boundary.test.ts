import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appTabsForMode } from '../../../apps/rallar-black-box/src/app-tabs.ts';

const appSourcePath = new URL('../../../apps/rallar-black-box/src/App.tsx', import.meta.url);
const styleSourcePath = new URL('../../../apps/rallar-black-box/src/styles.css', import.meta.url);
const runnerRecipeViewSourcePaths = [
    new URL(
        '../../../apps/rallar-black-box/src/legacy/runner/recipes/views/RunnerRecipesOverview.tsx',
        import.meta.url,
    ),
    new URL(
        '../../../apps/rallar-black-box/src/legacy/runner/recipes/views/RunnerRecipeCatalogList.tsx',
        import.meta.url,
    ),
    new URL(
        '../../../apps/rallar-black-box/src/legacy/runner/recipes/views/RunnerRecipeDetail.tsx',
        import.meta.url,
    ),
] as const;

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

describe('rallar-black-box Rallar mode boundary', () => {
    it('does not expose black-box-runner command tabs in Rallar mode', () => {
        expect(appTabsForMode('rallar').map(tab => tab.id)).not.toEqual(
            expect.arrayContaining([
                'manual-rallar',
                'local-workbench',
                'flow-builder',
                'run-manager',
                'shared-test',
            ]),
        );
    });

    it('keeps runner sample controls and bootstrap behind black-box-runner mode', () => {
        const source = appSource();
        const header = sourceBetween(source, 'function Header', 'function AppTabs');

        expect(header).toContain("mode === 'black-box-runner'");
        expect(header).toContain('rallarBlackBoxRuntimeStore.runSample()');
        expect(source).toContain("if (canEnterApp && activeMode === 'black-box-runner')");
    });

    it('does not reset the browser-rallar runtime when runner mode is first opened', () => {
        const source = appSource();
        const runtimeBootstrap = readFileSync(
            new URL('../../../apps/rallar-black-box/src/runtime-store.ts', import.meta.url),
            'utf8',
        );
        const configureLocalWorkbenchOnly = sourceBetween(
            runtimeBootstrap,
            'async configureLocalWorkbenchOnly(): Promise<void>',
            'async bootstrapControlAgent(): Promise<void>',
        );

        expect(configureLocalWorkbenchOnly).toContain('await this.configureRuntime(runNumber)');
        expect(configureLocalWorkbenchOnly).not.toContain('resetForRun');
        expect(source).toContain("if (canEnterApp && activeMode === 'black-box-runner')");
    });

    it('does not execute black-box runtime commands from direct Rallar panels', () => {
        const source = appSource();
        const directPanels = [
            sourceBetween(source, 'function QuickRallarTestPanel', 'function RunnerRecipesPanel'),
            sourceBetween(source, 'function RtcDiagnosticsPanel', 'function TopologyGraphPanel'),
            sourceBetween(source, 'function WebSocketCommandCenterPanel', 'function RtcRealtimePanel'),
            sourceBetween(source, 'function RtcRealtimePanel', 'function RallarDataPanel'),
            sourceBetween(source, 'function RallarDataPanel', 'function MediaConsolePanel'),
            sourceBetween(source, 'function MediaConsolePanel', 'function AuthCommandCenterPanel'),
            sourceBetween(source, 'function AuthCommandCenterPanel', 'function RoomsClientsPanel'),
            sourceBetween(source, 'function RoomsClientsPanel', 'function CommandCenterActionFeedbackPanel'),
            sourceBetween(source, 'function RallarServerPanel', 'function parseVariablesText'),
        ].join('\n');

        expect(directPanels).not.toMatch(/executeManualCommand|executeManualCommands|executeCommandFromJson/);
        expect(directPanels).not.toMatch(/loadRecipeFromJson|runLoadedRecipe|runSample/);
        expect(directPanels).not.toContain('__blackBoxRallar');
        expect(directPanels).not.toContain('__blackBoxRallarEmit');
        expect(directPanels).not.toContain('browser-rallar-runtime');
        expect(directPanels).not.toContain('createSpaBrowserRallarRuntime');
    });

    it('uses the shared browser Rallar facade for direct WebSocket and RTC actions', () => {
        const source = appSource();
        const websocketPanel = sourceBetween(
            source,
            'function WebSocketCommandCenterPanel',
            'function RtcRealtimePanel',
        );
        const rtcDiagnosticsPanel = sourceBetween(
            source,
            'function RtcDiagnosticsPanel',
            'function TopologyGraphPanel',
        );

        expect(websocketPanel).toContain('runDirectRallarWsSend');
        expect(websocketPanel).toContain('runDirectRallarWsSubscribe');
        expect(websocketPanel).toContain('loadBrowserRallarFacade');
        expect(rtcDiagnosticsPanel).toContain('loadBrowserRallarFacade');
        expect(rtcDiagnosticsPanel).toContain('facade.start');
    });

    it('keeps RTC sends on the direct facade fast path after the room is joined', () => {
        const source = appSource();
        const rtcRealtimePanel = sourceBetween(
            source,
            'function RtcRealtimePanel',
            'function RallarDataPanel',
        );

        expect(rtcRealtimePanel).toContain("'rallar.direct.rtc_realtime.phase'");
        expect(rtcRealtimePanel).toContain('isFacadeJoinedToActiveGroup');
        expect(rtcRealtimePanel).toContain("status: 'skipped'");
        expect(rtcRealtimePanel).toMatch(
            /useState<\s*'best-effort' \| 'at-least-once'\s*>\('best-effort'\)/,
        );
    });

    it('surfaces action feedback and live subscription state in direct command panels', () => {
        const source = appSource();
        const roomsClientsPanel = sourceBetween(source, 'function RoomsClientsPanel', 'function CommandCenterActionFeedbackPanel');
        const websocketPanel = sourceBetween(source, 'function WebSocketCommandCenterPanel', 'function RtcRealtimePanel');
        const rtcRealtimePanel = sourceBetween(source, 'function RtcRealtimePanel', 'function RallarDataPanel');
        const rtcDiagnosticsPanel = sourceBetween(source, 'function RtcDiagnosticsPanel', 'function TopologyGraphPanel');

        expect(roomsClientsPanel).toContain('CommandCenterActionFeedbackPanel');
        expect(websocketPanel).toContain('CommandCenterActionFeedbackPanel');
        expect(websocketPanel).toContain('WS subscribed');
        expect(rtcRealtimePanel).toContain('CommandCenterActionFeedbackPanel');
        expect(rtcRealtimePanel).toContain('Realtime sub');
        expect(rtcRealtimePanel).toContain('RTC message sub');
        expect(rtcDiagnosticsPanel).toContain('RtcDiagnosticsTimeseriesPanel');
    });

    it('keeps runner analysis evidence before setup controls and adds RTC performance surfaces', () => {
        const source = appSource();
        const styles = styleSource();
        const recipesController = sourceBetween(
            source,
            'function RunnerRecipesPanel',
            'function RunnerRunsPanel',
        );
        const recipesPanel = [
            recipesController,
            ...runnerRecipeViewSourcePaths.map((path) =>
                sourceOrFallback(path, recipesController),
            ),
        ].join('\n');
        const runsPanel = sourceBetween(source, 'function RunnerRunsPanel', 'function RunnerFleetPanel');
        const fleetPanel = sourceBetween(source, 'function RunnerFleetPanel', 'function FleetTimingGroupList');
        const rtcDiagnosticsPanel = sourceBetween(source, 'function RtcDiagnosticsPanel', 'function TopologyGraphPanel');

        expect(runsPanel).toContain('RunVerdictPanel');
        expect(runsPanel).toContain('CausalTrailPanel');
        expect(runsPanel).toContain('RtcPerformancePanel');
        expect(runsPanel).toContain('title="Run Participants"');
        expect(runsPanel).toContain('monitorAgentProgress: selectedMonitor?.agentProgress');
        expect(runsPanel).toContain('distributedRunSeed');
        expect(runsPanel).toContain('DISTRIBUTED_RUN_SEEDS');
        expect(runsPanel).toContain('Synthetic seed');
        expect(runsPanel).toContain('Synthetic evidence');
        expect(runsPanel).toContain('Clear seed');
        expect(fleetPanel).toContain('Live Fleet');
        expect(fleetPanel).toContain('title="Live Fleet Agents"');
        expect(fleetPanel).toContain('fetchControlServerSnapshot');
        expect(recipesPanel).toContain('resolveBlackBoxControlToken');
        expect(recipesPanel).toContain('brokeredControlToken');
        expect(recipesPanel).toContain('Session control token valid until');
        expect(recipesPanel).toContain('Session control token will be requested when needed.');
        expect(recipesPanel).toContain('title="Targetable Agents"');
        expect(recipesPanel).toContain('showConnectedAgents={false}');
        expect(recipesPanel).toContain('const distributedControlToken');
        expect(recipesPanel).toContain('token: distributedControlToken');
        expect(recipesPanel).toContain('controlToken,');
        const launchUrlPosition = recipesController.indexOf(
            'createRunnerAgentLaunchUrl({',
        );
        const distributedControlTokenPosition = recipesController.indexOf(
            'const distributedControlToken',
        );
        expect(launchUrlPosition).toBeGreaterThanOrEqual(0);
        expect(distributedControlTokenPosition).toBeGreaterThanOrEqual(0);
        expect(launchUrlPosition).toBeLessThan(distributedControlTokenPosition);
        expect(runsPanel.indexOf('RunVerdictPanel')).toBeLessThan(runsPanel.indexOf('runner-distributed-analysis'));
        expect(runsPanel).toContain('selectedMonitor');
        expect(runsPanel).toContain('distributedMonitor: selectedMonitor');
        expect(recipesPanel.indexOf('runner-quick-launch-strip')).toBeLessThan(
            recipesPanel.indexOf('<RunnerReadinessPanel'),
        );
        expect(recipesPanel.indexOf('<RunnerReadinessPanel')).toBeLessThan(
            recipesPanel.indexOf('title="Targetable Agents"'),
        );
        expect(recipesPanel.indexOf('title="Targetable Agents"')).toBeLessThan(
            recipesPanel.indexOf('<RunnerAgentSetupPanel'),
        );
        expect(rtcDiagnosticsPanel).toContain('RtcPerformancePanel');
        expect(rtcDiagnosticsPanel.indexOf('RtcPerformancePanel')).toBeLessThan(
            rtcDiagnosticsPanel.indexOf('RtcDiagnosticsTimeseriesPanel'),
        );
        expect(rtcDiagnosticsPanel.indexOf('RtcPerformancePanel')).toBeLessThan(
            rtcDiagnosticsPanel.indexOf('rtc-stage-list'),
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
