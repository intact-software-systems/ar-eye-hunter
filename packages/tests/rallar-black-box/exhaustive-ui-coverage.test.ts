import { describe, expect, it } from 'vitest';
import { APP_TABS, appModeForTab } from '../../../apps/rallar-black-box/src/app-tabs.ts';
import {
    EXHAUSTIVE_UI_COVERAGE_MATRIX,
    exhaustiveUiCoverageRowsForTab,
    exhaustiveUiCoverageSpecFiles
} from '../../../apps/rallar-black-box/src/exhaustive-ui-coverage.ts';

const EXPECTED_EXHAUSTIVE_SPEC_FILES = [
    'exhaustive-auth-groups.spec.ts',
    'exhaustive-control-distributed.spec.ts',
    'exhaustive-event-topology-trace.spec.ts',
    'exhaustive-quick-websocket.spec.ts',
    'exhaustive-rallar-data-crdt-media.spec.ts',
    'exhaustive-rallar-server.spec.ts',
    'exhaustive-rtc-realtime.spec.ts',
    'exhaustive-runner-workbench.spec.ts',
    'exhaustive-shell-navigation.spec.ts'
];

describe('rallar-black-box exhaustive UI coverage matrix', () => {
    it('maps every app tab to at least one exhaustive Playwright row', () => {
        const missingTabs = APP_TABS
            .map((tab) => tab.id)
            .filter((tabId) => exhaustiveUiCoverageRowsForTab(tabId).length === 0);

        expect(missingTabs).toEqual([]);
    });

    it('keeps rows decision-complete for live/control/media requirements', () => {
        for (const row of EXHAUSTIVE_UI_COVERAGE_MATRIX) {
            expect(row.id).toMatch(/^[a-z0-9-]+$/);
            expect(row.workspace).toBe(appModeForTab(row.tab));
            expect(row.intent.length).toBeGreaterThan(20);
            expect(row.specFile).toMatch(/^exhaustive-.*\.spec\.ts$/);
            expect(row.evidence.length).toBeGreaterThanOrEqual(2);
        }

        expect(EXHAUSTIVE_UI_COVERAGE_MATRIX.some((row) => row.requiresControl)).toBe(true);
        expect(EXHAUSTIVE_UI_COVERAGE_MATRIX.some((row) => row.requiresMedia)).toBe(true);
        expect(EXHAUSTIVE_UI_COVERAGE_MATRIX.some((row) => row.liveBackend)).toBe(true);
    });

    it('tracks the exhaustive spec file inventory', () => {
        expect(exhaustiveUiCoverageSpecFiles()).toEqual(EXPECTED_EXHAUSTIVE_SPEC_FILES);
    });
});
