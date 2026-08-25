import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { appTabsForMode } from '../../../apps/rallar-black-box/src/app-tabs.ts';

const appSourcePath = new URL('../../../apps/rallar-black-box/src/App.tsx', import.meta.url);
const styleSourcePath = new URL('../../../apps/rallar-black-box/src/styles.css', import.meta.url);
const canonicalWebSocketPanelSourcePath = new URL(
    '../../../apps/rallar-black-box/src/diagnostics/websocket/websocket-command-center-panel.tsx',
    import.meta.url
);
const legacyWebSocketPanelSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/diagnostics/websocket/WebSocketCommandCenterPanel.tsx',
    import.meta.url
);
const workbenchExperienceSourcePath = new URL(
    '../../../apps/rallar-black-box/src/workbench/workbench-experience.tsx',
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
const flowBuilderPanelSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/runner/builder/FlowBuilderPanel.tsx',
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
    '../../../apps/rallar-black-box/src/diagnostics/quick-test/use-quick-rallar-test-controller.ts',
    import.meta.url
);
const quickPanelSourcePath = new URL(
    '../../../apps/rallar-black-box/src/diagnostics/quick-test/quick-rallar-test-panel.tsx',
    import.meta.url
);
const quickViewSourcePath = new URL(
    '../../../apps/rallar-black-box/src/diagnostics/quick-test/quick-rallar-test-view.tsx',
    import.meta.url
);
const rtcRealtimeViewSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/diagnostics/rtc-realtime/RtcRealtimeView.tsx',
    import.meta.url
);
const rtcRealtimeControllerSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/diagnostics/rtc-realtime/use-rtc-realtime-controller.ts',
    import.meta.url
);
const rtcRealtimePanelSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/diagnostics/rtc-realtime/RtcRealtimePanel.tsx',
    import.meta.url
);
const webSocketSupportSourcePaths = [
    '../../../apps/rallar-black-box/src/legacy/diagnostics/shared/auth-command-center-ticket.ts',
    '../../../apps/rallar-black-box/src/diagnostics/websocket/websocket-contracts.ts',
    '../../../apps/rallar-black-box/src/diagnostics/websocket/websocket-presets.ts',
    '../../../apps/rallar-black-box/src/diagnostics/websocket/websocket-routing.ts',
    '../../../apps/rallar-black-box/src/diagnostics/websocket/websocket-url-routing.ts',
    '../../../apps/rallar-black-box/src/diagnostics/websocket/evidence/websocket-recipes.ts',
    '../../../apps/rallar-black-box/src/diagnostics/websocket/state/derive-web-socket-diagnostics.ts',
    '../../../apps/rallar-black-box/src/diagnostics/websocket/use-rallar-websocket-actions.ts',
    '../../../apps/rallar-black-box/src/diagnostics/websocket/raw/use-raw-websocket-actions.ts',
    '../../../apps/rallar-black-box/src/diagnostics/websocket/ticket/use-websocket-ticket-wait-actions.ts',
    '../../../apps/rallar-black-box/src/diagnostics/websocket/evidence/use-websocket-evidence-actions.ts',
    '../../../apps/rallar-black-box/src/diagnostics/websocket/view/websocket-status-section.tsx'
].map((path) => new URL(path, import.meta.url));
const webSocketViewSourcePath = new URL(
    '../../../apps/rallar-black-box/src/diagnostics/websocket/view/websocket-command-center-view.tsx',
    import.meta.url
);
const webSocketControllerSourcePath = new URL(
    '../../../apps/rallar-black-box/src/diagnostics/websocket/use-websocket-command-center-controller.ts',
    import.meta.url
);
const webSocketPanelSourcePath = new URL(
    '../../../apps/rallar-black-box/src/diagnostics/websocket/websocket-command-center-panel.tsx',
    import.meta.url
);
const mediaConsolePanelSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/diagnostics/media/MediaConsolePanel.tsx',
    import.meta.url
);
const rallarDataPanelSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/diagnostics/rallar-data/RallarDataPanel.tsx',
    import.meta.url
);
const authPanelSourcePath = new URL(
    '../../../apps/rallar-black-box/src/legacy/diagnostics/auth/AuthCommandCenterPanel.tsx',
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
const rallarServerOwnerSourcePaths = [
    '../../../apps/rallar-black-box/src/legacy/diagnostics/rallar-server/rallar-server-contracts.ts',
    '../../../apps/rallar-black-box/src/legacy/diagnostics/rallar-server/rallar-server-parsing.ts',
    '../../../apps/rallar-black-box/src/legacy/diagnostics/rallar-server/RallarServerRequestFeedbackPanel.tsx',
    '../../../apps/rallar-black-box/src/legacy/diagnostics/rallar-server/use-rallar-server-controller.ts',
    '../../../apps/rallar-black-box/src/legacy/diagnostics/rallar-server/RallarServerView.tsx',
    '../../../apps/rallar-black-box/src/legacy/diagnostics/rallar-server/RallarServerPanel.tsx'
].map((path) => new URL(path, import.meta.url));
const crdtOwnerSourcePaths = [
    '../../../apps/rallar-black-box/src/legacy/diagnostics/crdt/crdt-contracts.ts',
    '../../../apps/rallar-black-box/src/legacy/diagnostics/crdt/use-crdt-editor-controller.ts',
    '../../../apps/rallar-black-box/src/legacy/diagnostics/crdt/CrdtEditorBoardView.tsx',
    '../../../apps/rallar-black-box/src/legacy/diagnostics/crdt/CrdtEditorEntitiesView.tsx',
    '../../../apps/rallar-black-box/src/legacy/diagnostics/crdt/CrdtEditorView.tsx',
    '../../../apps/rallar-black-box/src/legacy/diagnostics/crdt/use-crdt-health-controller.ts',
    '../../../apps/rallar-black-box/src/legacy/diagnostics/crdt/CrdtHealthPanel.tsx'
].map((path) => new URL(path, import.meta.url));
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

interface DiagnosticOwnerSources {
    readonly rtcController: string;
    readonly rtcPanel: string;
    readonly topologyPanel: string;
    readonly quickPanel: string;
}

function diagnosticOwnerSources(source: string): DiagnosticOwnerSources {
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

function rtcRealtimeOwnerSource(source: string): string {
    const controllerFallback = existsSync(rtcRealtimeControllerSourcePath) &&
            existsSync(rtcRealtimePanelSourcePath)
        ? ''
        : sourceBetween(
            source,
            'function RtcRealtimePanel',
            'function RallarDataPanel'
        );
    return [
        sourceOrFallback(rtcRealtimeControllerSourcePath, controllerFallback),
        sourceOrFallback(rtcRealtimePanelSourcePath, ''),
        sourceOrFallback(rtcRealtimeViewSourcePath, '')
    ].join('\n');
}

function webSocketCommandCenterOwnerSource(source: string): string {
    const controllerFallback = existsSync(webSocketControllerSourcePath) &&
            existsSync(webSocketPanelSourcePath)
        ? ''
        : sourceBetween(
            source,
            'function WebSocketCommandCenterPanel',
            existsSync(rtcRealtimeControllerSourcePath) &&
                existsSync(rtcRealtimePanelSourcePath)
                ? 'function RallarDataPanel'
                : 'function RtcRealtimePanel'
        );
    return [
        sourceOrFallback(
            webSocketControllerSourcePath,
            controllerFallback
        ),
        sourceOrFallback(webSocketPanelSourcePath, ''),
        ...webSocketSupportSourcePaths.map((path) => sourceOrFallback(path, '')),
        sourceOrFallback(webSocketViewSourcePath, '')
    ].join('\n');
}

function mediaConsoleOwnerSource(source: string): string {
    const fallback = existsSync(mediaConsolePanelSourcePath)
        ? ''
        : sourceBetween(
            source,
            'function MediaConsolePanel',
            'function AuthCommandCenterPanel'
        );
    return sourceOrFallback(mediaConsolePanelSourcePath, fallback);
}

function rallarDataOwnerSource(source: string): string {
    const fallback = existsSync(rallarDataPanelSourcePath)
        ? ''
        : sourceBetween(
            source,
            'function RallarDataPanel',
            existsSync(mediaConsolePanelSourcePath)
                ? 'function AuthCommandCenterPanel'
                : 'function MediaConsolePanel'
        );
    return sourceOrFallback(rallarDataPanelSourcePath, fallback);
}

function authCommandCenterOwnerSource(source: string): string {
    const fallback = existsSync(authPanelSourcePath)
        ? ''
        : sourceBetween(
            source,
            'function AuthCommandCenterPanel',
            existsSync(roomsClientsPanelSourcePath)
                ? 'function RallarServerRequestFeedbackPanel'
                : 'function RoomsClientsPanel'
        );
    return sourceOrFallback(authPanelSourcePath, fallback);
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

function rallarServerOwnerSource(source: string): string {
    const extracted = rallarServerOwnerSourcePaths.every((path) => existsSync(path));
    const fallback = extracted
        ? ''
        : sourceBetween(
            source,
            'function RallarServerRequestFeedbackPanel',
            existsSync(flowBuilderPanelSourcePath)
                ? 'export default function App'
                : 'function parseVariablesText'
        );
    return [
        ...rallarServerOwnerSourcePaths.map((path) => sourceOrFallback(path, '')),
        fallback
    ].join('\n');
}

function crdtOwnerSource(source: string): string {
    const extracted = crdtOwnerSourcePaths.every((path) => existsSync(path));
    const fallback = extracted || !source.includes('type CrdtAdminDocumentStatus')
        ? ''
        : sourceBetween(
            source,
            'type CrdtAdminDocumentStatus',
            existsSync(flowBuilderPanelSourcePath)
                ? 'export default function App'
                : 'function parseVariablesText'
        );
    return [
        ...crdtOwnerSourcePaths.map((path) => sourceOrFallback(path, '')),
        fallback
    ].join('\n');
}

it('owns active WebSocket diagnostics outside the legacy tree', () => {
    expect(existsSync(canonicalWebSocketPanelSourcePath)).toBe(true);
    expect(existsSync(legacyWebSocketPanelSourcePath)).toBe(false);
});

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
    const workbenchExperience = readFileSync(workbenchExperienceSourcePath, 'utf8');
    const header = existsSync(legacyRunHeaderSourcePath)
        ? readFileSync(legacyRunHeaderSourcePath, 'utf8')
        : sourceBetween(source, 'function Header', 'function AppTabs');

    expect(header).toContain('mode === \'black-box-runner\'');
    expect(header).toContain('rallarBlackBoxRuntimeStore.runSample()');
    expect(workbenchExperience).toContain(
        'if (canBootstrap && navigation.activeMode === \'black-box-runner\')'
    );
    expect(workbenchExperience).toContain(
        '}, [canBootstrap, navigation.activeMode]);'
    );
    expect(workbenchExperience).toContain('bootstrapMatchesAuthSession');
});

it('does not reset the browser-rallar runtime when runner mode is first opened', () => {
    const workbenchExperience = readFileSync(workbenchExperienceSourcePath, 'utf8');
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
    expect(workbenchExperience).toContain(
        'if (canBootstrap && navigation.activeMode === \'black-box-runner\')'
    );
    expect(workbenchExperience).toContain(
        '}, [canBootstrap, navigation.activeMode]);'
    );
});

it('does not execute black-box runtime commands from direct Rallar panels', () => {
    const source = appSource();
    const diagnostics = diagnosticOwnerSources(source);
    const directPanels = [
        diagnostics.quickPanel,
        diagnostics.rtcController,
        diagnostics.rtcPanel,
        diagnostics.topologyPanel,
        webSocketCommandCenterOwnerSource(source),
        rtcRealtimeOwnerSource(source),
        rallarDataOwnerSource(source),
        mediaConsoleOwnerSource(source),
        authCommandCenterOwnerSource(source),
        roomsClientsOwnerSource(source),
        rallarServerOwnerSource(source),
        crdtOwnerSource(source)
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
    const diagnostics = diagnosticOwnerSources(source);
    const websocketPanel = webSocketCommandCenterOwnerSource(source);

    expect(websocketPanel).toContain('runDirectRallarWsSend');
    expect(websocketPanel).toContain('runDirectRallarWsSubscribe');
    expect(websocketPanel).toContain('loadBrowserRallarFacade');
    expect(diagnostics.rtcController).toContain('loadBrowserRallarFacade');
    expect(diagnostics.rtcController).toContain('facade.start');
});

it('keeps RTC sends on the direct facade fast path after the room is joined', () => {
    const source = appSource();
    const rtcRealtimePanel = rtcRealtimeOwnerSource(source);

    expect(rtcRealtimePanel).toContain('\'rallar.direct.rtc_realtime.phase\'');
    expect(rtcRealtimePanel).toContain('isFacadeJoinedToActiveGroup');
    expect(rtcRealtimePanel).toContain('status: \'skipped\'');
    expect(rtcRealtimePanel).toMatch(
        /useState<\s*'best-effort' \| 'at-least-once'\s*>\('best-effort'\)/
    );
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
    const websocketPanel = webSocketCommandCenterOwnerSource(source);
    const rtcRealtimePanel = rtcRealtimeOwnerSource(source);

    expect(actionFeedbackPanel).toContain('feedback.state');
    expect(actionFeedbackPanel).toContain('aria-live="polite"');
    expect(roomsClientsPanel).toContain('CommandCenterActionFeedbackPanel');
    expect(websocketPanel).toContain('CommandCenterActionFeedbackPanel');
    expect(websocketPanel).toContain('WS subscribed');
    expect(rtcRealtimePanel).toContain('CommandCenterActionFeedbackPanel');
    expect(rtcRealtimePanel).toContain('Realtime sub');
    expect(rtcRealtimePanel).toContain('RTC message sub');
    expect(diagnostics.rtcPanel).toContain('RtcDiagnosticsTimeseriesPanel');
});

interface RecipeEvidenceSources {
    readonly panel: string;
}

interface RunEvidenceSources {
    readonly controller: string;
    readonly panel: string;
    readonly distributedView: string;
}

interface FleetEvidenceSources {
    readonly controller: string;
    readonly views: string;
}

it('keeps runner analysis evidence before setup controls and adds RTC performance surfaces', () => {
    const source = appSource();
    assertRunEvidence(readRunEvidenceSources(source));
    assertRecipeEvidence(readRecipeEvidenceSources(source));
    assertFleetEvidence(readFleetEvidenceSources(source));
    assertRtcAndStyleEvidence(diagnosticOwnerSources(source).rtcPanel, styleSource());
});

function readRecipeEvidenceSources(source: string): RecipeEvidenceSources {
    const fallback = existsSync(runnerRecipesControllerSourcePath)
        ? ''
        : sourceBetween(source, 'function RunnerRecipesPanel', 'function RunnerRunsPanel');
    const controller = sourceOrFallback(runnerRecipesControllerSourcePath, fallback);
    return {
        panel: [
            sourceOrFallback(runnerAgentActionsSourcePath, fallback),
            controller,
            sourceOrFallback(runnerRecipesPanelSourcePath, fallback),
            ...runnerRecipeViewSourcePaths.map((path) => sourceOrFallback(path, fallback))
        ].join('\n')
    };
}

function readRunEvidenceSources(source: string): RunEvidenceSources {
    const fallback = existsSync(runnerRunsControllerSourcePath)
        ? ''
        : sourceBetween(source, 'function RunnerRunsPanel', 'function RunnerFleetPanel');
    const controller = sourceOrFallback(runnerRunsControllerSourcePath, fallback);
    const panel = sourceOrFallback(runnerRunsPanelSourcePath, fallback);
    return {
        controller,
        panel,
        distributedView: sourceOrFallback(runnerDistributedAnalysisSourcePath, panel)
    };
}

function readFleetEvidenceSources(source: string): FleetEvidenceSources {
    const fallback = existsSync(runnerFleetControllerSourcePath)
        ? ''
        : sourceBetween(source, 'function RunnerFleetPanel', 'function RtcDiagnosticsPanel');
    return {
        controller: sourceOrFallback(runnerFleetControllerSourcePath, fallback),
        views: [
            sourceOrFallback(runnerFleetControlsSourcePath, fallback),
            sourceOrFallback(runnerFleetOverviewSourcePath, fallback),
            sourceOrFallback(runnerFleetAnalysisSourcePath, fallback),
            sourceOrFallback(runnerFleetDetailsSourcePath, fallback),
            sourceOrFallback(runnerFleetTimingSourcePath, fallback)
        ].join('\n')
    };
}

function assertRunEvidence(sources: RunEvidenceSources): void {
    expect(sources.panel).toContain('RunVerdictPanel');
    expect(sources.panel).toContain('CausalTrailPanel');
    expect(sources.panel).toContain('RtcPerformancePanel');
    expect(sources.distributedView).toContain('title="Run Participants"');
    expect(sources.controller).toContain('monitorAgentProgress: selectedMonitor?.agentProgress');
    expect(sources.controller).toContain('distributedRunSeed');
    expect(sources.distributedView).toContain('DISTRIBUTED_RUN_SEEDS');
    expect(sources.distributedView).toContain('Synthetic seed');
    expect(sources.distributedView).toContain('Synthetic evidence');
    expect(sources.distributedView).toContain('Clear seed');
    expect(sources.panel.indexOf('RunVerdictPanel')).toBeLessThan(
        sources.panel.indexOf(
            existsSync(runnerDistributedAnalysisSourcePath)
                ? '<RunnerDistributedAnalysisSection'
                : 'runner-distributed-analysis'
        )
    );
    expect(sources.distributedView.indexOf('Synthetic seed')).toBeLessThan(
        sources.distributedView.indexOf('title="Run Participants"')
    );
    expect(sources.controller).toContain('selectedMonitor');
    expect(sources.controller).toContain('distributedMonitor: selectedMonitor');
}

function assertRecipeEvidence(sources: RecipeEvidenceSources): void {
    expect(sources.panel).toContain('resolveBlackBoxControlToken');
    expect(sources.panel).toContain('brokeredControlToken');
    expect(sources.panel).toContain('Session control token valid until');
    expect(sources.panel).toContain('Session control token will be requested when needed.');
    expect(sources.panel).toContain('title="Targetable Agents"');
    expect(sources.panel).toContain('showConnectedAgents={false}');
    expect(sources.panel).toContain('const distributedControlToken');
    expect(sources.panel).toContain('token: distributedControlToken');
    expect(sources.panel).toContain('controlToken,');
    expect(sources.panel).not.toContain('const agentLaunchUrls =');
    expect(sources.panel).not.toContain('createRunnerAgentLaunchUrl({');
    expect(sources.panel).toContain('createBrowserAgentLaunchService');
    expect(sources.panel).toContain('reserveBrowserAgentPopups(agentIds)');
    expect(sources.panel.indexOf('runner-quick-launch-strip')).toBeLessThan(
        sources.panel.indexOf('<RunnerReadinessPanel')
    );
    expect(sources.panel.indexOf('<RunnerReadinessPanel')).toBeLessThan(
        sources.panel.indexOf('title="Targetable Agents"')
    );
    expect(sources.panel.indexOf('title="Targetable Agents"')).toBeLessThan(
        sources.panel.indexOf('<RunnerAgentSetupPanel')
    );
}

function assertFleetEvidence(sources: FleetEvidenceSources): void {
    expect(sources.views).toContain('Live Fleet');
    expect(sources.views).toContain('title="Live Fleet Agents"');
    expect(sources.controller).toContain('fetchControlServerSnapshot');
}

function assertRtcAndStyleEvidence(rtcDiagnosticsPanel: string, styles: string): void {
    expect(rtcDiagnosticsPanel).toContain('RtcPerformancePanel');
    expect(rtcDiagnosticsPanel.indexOf('<RtcPerformancePanel')).toBeLessThan(
        rtcDiagnosticsPanel.indexOf('<RtcDiagnosticsTimeseriesPanel')
    );
    expect(rtcDiagnosticsPanel.indexOf('<RtcPerformancePanel')).toBeLessThan(
        rtcDiagnosticsPanel.indexOf('rtc-stage-list')
    );
    for (
        const sentinel of [
            '.run-verdict-band',
            '.causal-trail-panel',
            '.rtc-performance-panel',
            '.runner-evidence-first',
            '.control-agent-board-panel',
            '.control-agent-board-row',
            '.fleet-live-panel',
            '.app-shell.mode-black-box-runner .app-mode-switch',
            '.app-shell.mode-black-box-runner .app-mode-copy p',
            '.causal-trail-actions',
            '.rtc-performance-legend',
            '.synthetic-seed-control',
            '.synthetic-seed-notice'
        ]
    ) {
        expect(styles).toContain(sentinel);
    }
}
