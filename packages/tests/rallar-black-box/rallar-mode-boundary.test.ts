import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appTabsForMode } from '../../../apps/rallar-black-box/src/app-tabs.ts';

const appSourcePath = new URL('../../../apps/rallar-black-box/src/App.tsx', import.meta.url);

function appSource(): string {
    return readFileSync(appSourcePath, 'utf8');
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
            sourceBetween(source, 'function QuickRallarTestPanel', 'function RunnerReadinessPanel'),
            sourceBetween(source, 'function RtcDiagnosticsPanel', 'function TopologyGraphPanel'),
            sourceBetween(source, 'function WebSocketCommandCenterPanel', 'function RtcRealtimePanel'),
            sourceBetween(source, 'function RtcRealtimePanel', 'function RallarDataPanel'),
            sourceBetween(source, 'function RallarDataPanel', 'function MediaConsolePanel'),
            sourceBetween(source, 'function MediaConsolePanel', 'function AuthCommandCenterPanel'),
            sourceBetween(source, 'function AuthCommandCenterPanel', 'function RoomsClientsPanel'),
            sourceBetween(source, 'function RoomsClientsPanel', 'function SharedTestCatalogPanel'),
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
        const roomsClientsPanel = sourceBetween(source, 'function RoomsClientsPanel', 'function SharedTestCatalogPanel');
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
});
