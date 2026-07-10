// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    FleetReportAnalysis,
    FleetReportAgentDetail,
    FleetReportHeatmap,
} from '../../../packages/shared-test/rallar-bb-test/fleet-report-analysis.ts';
import type {
    ControlFleetAgentRunOutcome,
    ControlFleetFailureSignature,
    ControlFleetRegionSummary,
    ControlFleetRunReport,
} from '../../../packages/shared-test/rallar-bb-test/fleet-report.ts';
import type { ControlAgentBoardRow } from
    '../../../apps/rallar-black-box/src/control-agent-board.ts';
import { rememberControlResponseDocument } from
    '../../../apps/rallar-black-box/src/control-response-document.ts';
import type { RecipeConsoleControlConnection } from
    '../../../apps/rallar-black-box/src/recipe-console/control/ControlConnectionProvider.tsx';
import {
    controlSnapshotRevisionOf,
    createControlSnapshotRevisionSession,
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-snapshot-revision.ts';
import type { RecipeConsoleControlSelection } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-selection-contract.ts';
import { FleetFailures } from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/FleetFailures.tsx';
import { FleetEvidenceDetail } from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/FleetEvidenceDetail.tsx';
import { FleetHeatmap } from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/FleetHeatmap.tsx';
import { FleetLiveBoard } from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/FleetLiveBoard.tsx';
import { FleetOperationalState } from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/FleetOperationalState.tsx';
import { FleetEvidenceQuality } from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/FleetEvidenceQuality.tsx';
import { FleetRegions } from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/FleetRegions.tsx';
import { FleetSummary } from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/FleetSummary.tsx';
import { FleetSourceBar } from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/FleetSourceBar.tsx';
import { FleetTiming } from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/FleetTiming.tsx';
import { FleetWindowTruth } from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/FleetWindowTruth.tsx';
import { FleetWindowControls } from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/FleetWindowControls.tsx';
import FleetWorkspace from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/FleetWorkspace.tsx';
import {
    FLEET_WINDOW_BUDGETS,
    createFleetWindowFingerprint,
} from '../../../apps/rallar-black-box/src/recipe-console/fleet/fleet-window-contract.ts';
import { useFleetWindow } from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/use-fleet-window.ts';
import {
    useFleetWorkspace,
    type FleetWorkspaceController,
} from '../../../apps/rallar-black-box/src/recipe-console/fleet/use-fleet-workspace.ts';
import type { FleetWorkspaceProps } from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/fleet-workspace-contract.ts';
import { ExplicitWindowControls } from
    '../../../apps/rallar-black-box/src/recipe-console/ui/ExplicitWindowControls.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const BIDI_AGENT = 'agent-\u202e]exact';
const BIDI_GROUP = 'group-\u202e]exact';
const BIDI_RECIPE = 'recipe-\u202e]exact';

function outcome(
    agentId: string,
    state: ControlFleetAgentRunOutcome['state'],
    region = 'eu-north',
): ControlFleetAgentRunOutcome {
    return {
        agentId,
        label: { agentId, region, provider: 'provider-a' },
        state,
        ok: state === 'passed',
        missing: state === 'missing',
        flaky: false,
        stale: false,
        commandCount: 3,
        failedCommandCount: state === 'failed' ? 1 : 0,
        resultCount: 3,
        eventCount: 5,
        diagnosticCount: state === 'failed' ? 2 : 0,
        reconnectCount: 1,
        durationMs: state === 'failed' ? 900 : 300,
        failureSignatureIds: state === 'failed' ? ['sig-runtime'] : [],
    };
}

function report(
    distributedRunId: string,
    generatedAtEpochMs: number,
    agent: ControlFleetAgentRunOutcome,
): ControlFleetRunReport {
    return {
        fleetReportSchemaVersion: 1,
        distributedRunId,
        controlRunId: `control-${distributedRunId}`,
        generatedAtEpochMs,
        state: agent.ok ? 'passed' : 'failed',
        ok: agent.ok,
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'fleet-group',
        },
        recipeIds: ['rtc-smoke'],
        runDurationMs: 1_200,
        summary: {
            agents: 1,
            regions: 1,
            passed: agent.ok ? 1 : 0,
            failed: agent.ok ? 0 : 1,
            missing: 0,
            flaky: 0,
            stale: 0,
            passRate: agent.ok ? 1 : 0,
            failureGroups: agent.ok ? 0 : 1,
        },
        timing: {
            run: { count: 1, p95Ms: 1_200 },
            commands: { count: 3, p95Ms: agent.durationMs },
        },
        agents: [agent],
        regions: [],
        failureSignatures: [],
        artifactRefs: {
            distributedRun: `opaque:${distributedRunId}`,
            controlRun: `opaque:control-${distributedRunId}`,
            fleetReport: `opaque:fleet-${distributedRunId}`,
        },
    };
}

function liveRow(
    agentId: string,
    connected: boolean,
): ControlAgentBoardRow {
    return {
        agentId,
        connected,
        connectionStatus: connected ? 'connected' : 'offline',
        synthetic: false,
        targetStatus: connected ? 'ready' : 'offline',
        targetable: connected,
        targetReason: connected ? 'Ready' : 'Offline',
        region: 'eu-north',
        provider: 'provider-a',
        tags: [],
        crdtTransports: [],
        queuedCommandCount: 0,
        completedCommandCount: 3,
        receivedResultCount: 3,
        receivedEventCount: 5,
        reconnectCount: 0,
        activeRuns: [],
    } as unknown as ControlAgentBoardRow;
}

const FAILED = outcome(BIDI_AGENT, 'failed');
const PASSED = outcome('agent-pass', 'passed');
const RUN_FAILED = report('run-\u2069\u202e]failed', 2_000, FAILED);
const RUN_PASSED = report('run-pass', 1_000, PASSED);

const REGION: ControlFleetRegionSummary = {
    region: 'eu-north',
    provider: 'provider-a',
    agentCount: 2,
    passed: 1,
    failed: 1,
    missing: 0,
    flaky: 0,
    stale: 0,
    passRate: 0.5,
    timing: { count: 2, p50Ms: 300, p95Ms: 900, maxMs: 900 },
    dominantFailureSignatureId: 'sig-runtime',
};

const FAILURE: ControlFleetFailureSignature = {
    signatureId: 'sig-runtime',
    category: 'runtime',
    title: 'Receiver did not observe payload',
    normalizedMessage: 'receiver did not observe payload',
    count: 3,
    affectedAgents: [BIDI_AGENT],
    affectedRegions: ['eu-north'],
    affectedRuns: [RUN_FAILED.distributedRunId],
    likelyCause: 'The receiver lost the expected RTC payload.',
    nextAction: 'Inspect the affected agent and exact run.',
};

const HEATMAP: FleetReportHeatmap = {
    runs: [RUN_FAILED, RUN_PASSED],
    rows: [{
        agent: FAILED,
        region: 'eu-north',
        provider: 'provider-a',
        cells: [FAILED, undefined],
    }],
    totalAgentRows: 1,
    omittedAgentRows: 0,
    totalRunColumns: 2,
    omittedRunColumns: 0,
};

const ANALYSIS = {
    reports: [RUN_FAILED, RUN_PASSED],
    summary: {
        runs: 2,
        agents: 2,
        regions: 1,
        passRate: 0.5,
        failureGroups: 1,
        p95DurationMs: 1_200,
        stale: 0,
    },
    heatmap: HEATMAP,
    regions: { items: [REGION], total: 1, omitted: 0 },
    failures: { items: [FAILURE], total: 1, omitted: 0 },
    regionTiming: {
        items: [{ id: 'region-eu', label: 'eu-north / provider-a', timing: REGION.timing }],
        total: 1,
        omitted: 0,
    },
    recipeTiming: {
        items: [{ id: 'recipe-rtc', label: 'rtc-smoke', timing: { count: 2, p95Ms: 1_200 } }],
        total: 1,
        omitted: 0,
    },
    missingLabelAgentIds: { items: [], total: 0, omitted: 0 },
    work: {
        reportVisits: 2,
        outcomeVisits: 2,
        indexInserts: 2,
        cellLookups: 2,
        failureSignatureVisits: 1,
    },
} as FleetReportAnalysis;

describe('Recipe Console Fleet explicit windows', () => {
    it('publishes collision-safe fingerprints and exact evidence budgets', () => {
        expect(FLEET_WINDOW_BUDGETS).toEqual({
            heatmapAgents: 32,
            heatmapRuns: 8,
            regions: 24,
            failures: 24,
            regionTiming: 24,
            recipeTiming: 24,
            missingLabels: 40,
            agentRuns: 12,
            failureAgents: 40,
            regionProviders: 24,
            reportRecipes: 24,
            mapAgents: 40,
            mapRegions: 24,
            mapFailures: 40,
            mapRoutes: 32,
            unresolvedAgents: 40,
            unresolvedRouteEndpoints: 40,
            liveAgents: 40,
        });
        const fingerprint = createFleetWindowFingerprint({
            contextKey: 'run\u0000,]\u202e["failures',
            section: 'failures',
        });
        expect(JSON.parse(fingerprint)).toEqual([
            'fleet-window-v1',
            'run\u0000,]\u202e["failures',
            'failures',
        ]);
    });

    it('traverses first, middle, and final Fleet ranges without gaps', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);

        function Harness() {
            const window = useFleetWindow({
                contextKey: 'fleet-context',
                section: 'failures',
                total: 61,
            });
            const ordinals = Array.from({
                length: window.model.endIndexExclusive - window.model.startIndex,
            }, (_, offset) => window.model.startIndex + offset);
            return createElement(Fragment, {},
                createElement('div', window.controlsFocusProps,
                    createElement(ExplicitWindowControls, {
                        contentId: 'fleet-window-content',
                        itemLabel: 'failures',
                        label: 'Fleet failures',
                        model: window.model,
                        onNext: window.next,
                        onPrevious: window.previous,
                    }),
                ),
                createElement(FleetWindowTruth, {
                    itemLabel: 'failures',
                    label: 'Fleet failures',
                    window,
                }),
                createElement('ol', {
                    id: 'fleet-window-content',
                    ...window.contentFocusProps,
                }, ordinals.map(ordinal => createElement('li', {
                    'data-window-ordinal': ordinal,
                    key: ordinal,
                }, ordinal))),
            );
        }

        await act(async () => root.render(createElement(Harness)));
        const visited: number[] = [];
        while (true) {
            visited.push(...[...container.querySelectorAll<HTMLElement>(
                '[data-window-ordinal]',
            )].map(row => Number(row.dataset.windowOrdinal)));
            const next = [...container.querySelectorAll<HTMLButtonElement>('button')]
                .find(button => button.textContent === 'Next');
            if (!next || next.disabled) break;
            await act(async () => next.click());
        }

        expect(visited).toEqual(Array.from({ length: 61 }, (_, index) => index));
        expect(new Set(visited).size).toBe(61);
        expect(container.querySelector('[data-fleet-window-focus-anchor]')?.textContent)
            .toBe('Showing 49–61 of 61 failures.');
        await act(async () => root.unmount());
        container.remove();
    });
});

describe('Recipe Console Fleet evidence UI', () => {
    let container: HTMLDivElement;
    let root: Root | undefined;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
    });

    afterEach(async () => {
        if (root) await act(async () => root?.unmount());
        root = undefined;
        container.remove();
    });

    async function render(node: ReturnType<typeof createElement>) {
        root = createRoot(container);
        await act(async () => root?.render(node));
    }

    it.each([
        ['connecting', 'Connecting to Fleet evidence'],
        ['partial', 'Fleet evidence is partial'],
        ['stale', 'Showing last-known Fleet evidence'],
        ['offline', 'Fleet control is offline'],
        ['empty', 'No Fleet reports yet'],
        ['schema-error', 'Some Fleet reports were quarantined'],
    ] as const)('keeps valid evidence and recovery actions visible in %s state',
        async (status, title) => {
            const refresh = vi.fn();
            await render(createElement(FleetOperationalState, {
                acceptedCount: 1,
                isRefreshing: false,
                legacyHref: '/?workspace=black-box-runner&tab=fleet',
                onRefresh: refresh,
                sourceCount: 2,
                status,
            }, createElement('p', { 'data-valid-evidence': true }, 'Retained evidence')));

            expect(container.textContent).toContain(title);
            expect(container.textContent).toContain('1 of 2 reports accepted');
            expect(container.querySelector('[data-valid-evidence]')).not.toBeNull();
            const refreshButton = [...container.querySelectorAll('button')]
                .find(button => button.textContent === 'Refresh');
            await act(async () => refreshButton?.click());
            expect(refresh).toHaveBeenCalledTimes(1);
            expect(container.querySelector<HTMLAnchorElement>(
                'a[href="/?workspace=black-box-runner&tab=fleet"]',
            )?.textContent).toContain('Legacy Fleet');
        });

    it('renders exact summary and live-board truth with bidi-safe agent selection', async () => {
        const selectAgent = vi.fn();
        await render(createElement('div', {},
            createElement(FleetSummary, {
                analysis: ANALYSIS,
                live: { total: 2, connected: 1, targetable: 1, active: 0 },
            }),
            createElement(FleetLiveBoard, {
                onSelectAgent: selectAgent,
                rows: [liveRow(BIDI_AGENT, false), liveRow('agent-pass', true)],
                selectedAgentId: BIDI_AGENT,
            }),
        ));

        expect(container.querySelector('h2')?.textContent).toBe('Fleet status');
        expect(container.textContent).toContain('2 runs');
        expect(container.textContent).toContain('50% pass rate');
        expect(container.textContent).toContain('1 of 2 live agents connected');
        const exact = container.querySelector<HTMLElement>('[data-exact-identifier]');
        expect(exact?.getAttribute('dir')).toBe('ltr');
        const selected = container.querySelector<HTMLButtonElement>(
            `button[data-agent-id="${CSS.escape(BIDI_AGENT)}"]`,
        );
        expect(selected?.getAttribute('aria-pressed')).toBe('true');
        await act(async () => selected?.click());
        expect(selectAgent).toHaveBeenCalledWith(BIDI_AGENT, selected);
    });

    it('renders semantic historical evidence and exact keyboard-equivalent actions', async () => {
        const selectAgent = vi.fn();
        const selectReport = vi.fn();
        const selectRegion = vi.fn();
        const openHistory = vi.fn();
        const openRun = vi.fn();
        await render(createElement('div', {},
            createElement(FleetHeatmap, {
                heatmap: HEATMAP,
                onSelectAgent: selectAgent,
                onSelectReport: selectReport,
            }),
            createElement(FleetRegions, {
                onSelectRegion: selectRegion,
                regions: ANALYSIS.regions,
                selectedRegion: 'eu-north',
            }),
            createElement(FleetFailures, {
                failures: ANALYSIS.failures,
                onOpenHistory: openHistory,
                onOpenRun: openRun,
                onSelectAgent: selectAgent,
            }),
            createElement(FleetTiming, {
                recipeTiming: ANALYSIS.recipeTiming,
                regionTiming: ANALYSIS.regionTiming,
            }),
        ));

        expect(container.querySelector('table[aria-label="Fleet agent by run heatmap"]'))
            .not.toBeNull();
        expect(container.textContent).toContain('No outcome');
        expect(container.textContent).toContain('Repeated failures');
        expect(container.textContent).toContain('Region and recipe timing');

        const reportButton = container.querySelector<HTMLButtonElement>(
            `button[data-report-id="${CSS.escape(RUN_FAILED.distributedRunId)}"]`,
        );
        await act(async () => reportButton?.click());
        expect(selectReport).toHaveBeenCalledWith(RUN_FAILED, reportButton);

        const regionButton = container.querySelector<HTMLButtonElement>(
            'button[data-fleet-region="eu-north"]',
        );
        expect(regionButton?.getAttribute('aria-pressed')).toBe('true');
        await act(async () => regionButton?.click());
        expect(selectRegion).toHaveBeenCalledWith(undefined, regionButton);

        const affectedAgent = [...container.querySelectorAll<HTMLButtonElement>('button')]
            .find(button => button.textContent?.includes(BIDI_AGENT) &&
                button.closest('[data-fleet-failure]'));
        await act(async () => affectedAgent?.click());
        expect(selectAgent).toHaveBeenCalledWith(BIDI_AGENT, affectedAgent);

        const run = [...container.querySelectorAll<HTMLButtonElement>('button')]
            .find(button => button.textContent === 'Open proving run');
        await act(async () => run?.click());
        expect(openRun).toHaveBeenCalledWith(FAILURE, RUN_FAILED.distributedRunId, run);
        const history = [...container.querySelectorAll<HTMLButtonElement>('button')]
            .find(button => button.textContent === 'Filter History');
        await act(async () => history?.click());
        expect(openHistory).toHaveBeenCalledWith(FAILURE, history);
    });

    it('keeps delimiter-bearing region/provider React identities collision-safe', async () => {
        const regions = [
            { ...REGION, region: 'a\u0000b', provider: 'c' },
            { ...REGION, region: 'a', provider: 'b\u0000c' },
        ];
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await render(createElement('div', {},
            createElement(FleetRegions, {
                onSelectRegion: vi.fn(),
                regions: { items: regions, total: 2, omitted: 0 },
            }),
            createElement(FleetEvidenceDetail, {
                onOpenAnalyze: vi.fn(),
                onOpenMonitor: vi.fn(),
                selectedRegionRows: regions,
                selectionIssues: [],
            }),
        ));
        await act(async () => root?.render(createElement('div', {},
            createElement(FleetRegions, {
                onSelectRegion: vi.fn(),
                regions: { items: [...regions].reverse(), total: 2, omitted: 0 },
            }),
            createElement(FleetEvidenceDetail, {
                onOpenAnalyze: vi.fn(),
                onOpenMonitor: vi.fn(),
                selectedRegionRows: [...regions].reverse(),
                selectionIssues: [],
            }),
        )));

        expect(error.mock.calls.some(call => String(call[0]).includes(
            'same key',
        ))).toBe(false);
        error.mockRestore();
    });

    it('uses a complete searchable report picker and exposes bounded quality truth', async () => {
        const selectReport = vi.fn();
        await render(createElement('div', {},
            createElement(FleetSourceBar, {
                contextKey: 'fleet-reports',
                onSelectReport: selectReport,
                reports: [RUN_FAILED, RUN_PASSED],
                revision: ANALYSIS,
                selectedReportId: RUN_FAILED.distributedRunId,
                snapshotReceivedAtEpochMs: 2_500,
            }),
            createElement(FleetEvidenceQuality, {
                acceptedCount: 1,
                issues: [{
                    source: 'report',
                    code: 'unsupported-schema-version',
                    path: '$[1].fleetReportSchemaVersion',
                    message: 'Unsupported Fleet report schema version.',
                    distributedRunId: 'run-invalid',
                }],
                missingLabelAgentIds: {
                    items: [BIDI_AGENT],
                    total: 3,
                    omitted: 2,
                },
                omittedIssueCount: 4,
                quarantinedCount: 1,
                sourceCount: 2,
            }),
        ));

        expect(container.textContent).toContain('Historical report');
        expect(container.textContent).toContain('Snapshot received');
        const trigger = container.querySelector<HTMLButtonElement>(
            '[data-searchable-listbox-trigger]',
        );
        await act(async () => trigger?.click());
        expect(container.querySelectorAll('[role="option"]')).toHaveLength(2);
        expect(container.querySelector('[role="option"]')?.textContent)
            .toContain('report generated');
        const passOption = [...container.querySelectorAll<HTMLButtonElement>(
            '[role="option"]',
        )].find(option => option.textContent?.includes(RUN_PASSED.distributedRunId));
        await act(async () => passOption?.click());
        expect(selectReport).toHaveBeenCalledWith(RUN_PASSED);

        expect(container.textContent).toContain('1 of 2 reports accepted');
        expect(container.textContent).toContain('1 quarantined');
        expect(container.textContent).toContain('4 additional validation issues omitted');
        expect(container.textContent).toContain('2 additional unlabeled agents omitted');
        expect(container.querySelector('[data-exact-identifier]')?.getAttribute('dir'))
            .toBe('ltr');
    });

    it('does not reproject every report recipe on an unrelated source-bar render', async () => {
        let recipeProjectionReads = 0;
        const recipeIds = new Proxy(['recipe-a', 'recipe-b'], {
            get(target, property, receiver) {
                if (property === Symbol.iterator || property === 'length') {
                    recipeProjectionReads += 1;
                }
                return Reflect.get(target, property, receiver);
            },
        });
        const reports = [{ ...RUN_FAILED, recipeIds }];
        await render(createElement(FleetSourceBar, {
            contextKey: 'stable-source-options',
            onSelectReport: vi.fn(),
            reports,
            snapshotReceivedAtEpochMs: 1_000,
        }));
        const readsAfterProjection = recipeProjectionReads;

        await act(async () => root?.render(createElement(FleetSourceBar, {
            contextKey: 'stable-source-options',
            onSelectReport: vi.fn(),
            reports,
            snapshotReceivedAtEpochMs: 2_000,
        })));

        expect(readsAfterProjection).toBeGreaterThan(0);
        expect(recipeProjectionReads).toBe(readsAfterProjection);
    });

    it('labels report-generation time and tolerates epochs outside the Date range', async () => {
        const farFuture = {
            ...RUN_FAILED,
            distributedRunId: 'run-max-safe-time',
            generatedAtEpochMs: Number.MAX_SAFE_INTEGER,
        };
        await render(createElement('div', {},
            createElement(FleetSourceBar, {
                contextKey: 'max-safe-fleet-time',
                onSelectReport: vi.fn(),
                reports: [farFuture],
                selectedReportId: farFuture.distributedRunId,
            }),
            createElement(FleetEvidenceDetail, {
                onOpenAnalyze: vi.fn(),
                onOpenMonitor: vi.fn(),
                selectedRegionRows: [],
                selectedReport: farFuture,
                selectionIssues: [],
            }),
        ));

        const trigger = container.querySelector<HTMLButtonElement>(
            '[data-searchable-listbox-trigger]',
        );
        await act(async () => trigger?.click());
        expect(container.querySelector('[role="option"]')?.textContent)
            .toContain('report generated unavailable');
        expect(container.textContent).toContain('Report generated');
        expect(container.textContent).toContain('unavailable');
    });

    it('does not collapse an absent optional report collection into green zero truth', async () => {
        await render(createElement('div', {},
            createElement(FleetSourceBar, {
                collection: 'absent',
                contextKey: 'absent-fleet-reports',
                onSelectReport: vi.fn(),
                reports: [],
            }),
            createElement(FleetOperationalState, {
                acceptedCount: 0,
                collection: 'absent',
                isRefreshing: false,
                legacyHref: '/?workspace=black-box-runner&tab=fleet',
                onRefresh: vi.fn(),
                sourceCount: 0,
                status: 'partial',
            }, createElement('span', {}, 'Retained live evidence')),
            createElement(FleetSummary, {
                analysis: undefined,
                collection: 'absent',
                live: { total: 0, connected: 0, targetable: 0, active: 0 },
            }),
            createElement(FleetEvidenceQuality, {
                acceptedCount: 0,
                collection: 'absent',
                issues: [],
                missingLabelAgentIds: { items: [], total: 0, omitted: 0 },
                omittedIssueCount: 0,
                quarantinedCount: 0,
                sourceCount: 0,
            }),
        ));

        expect(container.textContent).toContain('Report evidence unavailable');
        expect(container.textContent).toContain('Fleet report collection unavailable');
        expect(container.textContent).not.toContain('0 runs');
        expect(container.textContent).not.toContain('0 accepted reports');
        expect(container.textContent).not.toContain('0 of 0 reports accepted');
        expect(container.textContent).not.toContain('All source reports passed');
    });

    it('keeps a present but empty report collection neutral', async () => {
        const emptyAnalysis = {
            ...ANALYSIS,
            summary: {
                runs: 0,
                agents: 0,
                regions: 0,
                passRate: 0,
                failureGroups: 0,
                stale: 0,
            },
        } as FleetReportAnalysis;
        await render(createElement('div', {},
            createElement(FleetSummary, {
                analysis: emptyAnalysis,
                live: { total: 0, connected: 0, targetable: 0, active: 0 },
            }),
            createElement(FleetEvidenceQuality, {
                acceptedCount: 0,
                issues: [],
                missingLabelAgentIds: { items: [], total: 0, omitted: 0 },
                omittedIssueCount: 0,
                quarantinedCount: 0,
                sourceCount: 0,
            }),
        ));

        expect(container.textContent).toContain('No source reports were available');
        expect(container.textContent).not.toContain('All source reports passed');
        for (const label of ['Pass rate', 'Repeated failures']) {
            expect([...container.querySelectorAll('dt')]
                .find(term => term.textContent === label)?.parentElement
                ?.hasAttribute('data-tone')).toBe(false);
        }
    });

    it('keeps independent live geographic evidence when reports are absent', async () => {
        const connection = {
            query: {
                status: 'partial',
                reachability: 'reachable',
                authorization: 'ready',
                completeness: 'partial',
                receivedAtEpochMs: 2_500,
                isRefreshing: false,
                snapshot: { runs: [], distributedRuns: [] },
            },
            refresh: vi.fn(async () => undefined),
        } as unknown as RecipeConsoleControlConnection;
        const selection = {
            boardRows: [liveRow('live-only-agent', true)],
            boardSummary: {
                total: 1, connected: 1, targetable: 1, active: 0,
                selected: 0, stale: 0, offline: 0, wrongGroup: 0,
                missingIdentity: 0, missingCapability: 0, synthetic: 0,
            },
        } as unknown as RecipeConsoleControlSelection;

        await render(createElement(FleetWorkspace, {
            connection,
            navigate: vi.fn(),
            onInspect: vi.fn(),
            onInspectorChange: vi.fn(),
            onSelectionLabelChange: vi.fn(),
            replace: vi.fn(),
            selection,
            urlState: { v: 1, experience: 'recipe-console', view: 'fleet' },
        }));

        expect(container.textContent).toContain('Fleet report collection unavailable');
        expect(container.querySelector('[aria-labelledby="fleet-map-heading"]'))
            .not.toBeNull();
        expect(container.querySelector('#fleet-geography-ledger')).not.toBeNull();
        expect(container.querySelector('[data-map-agent-id="live-only-agent"]'))
            .not.toBeNull();
        expect(container.textContent).not.toContain('Agent × run');
    });

    it('presents an incompatible report/control deep link as invalid, not selected', async () => {
        const issueValue = 'control-\u202e]wrong';
        await render(createElement(FleetSourceBar, {
            contextKey: 'incompatible-fleet-report',
            onSelectReport: vi.fn(),
            reports: [RUN_FAILED],
            requestedReportId: RUN_FAILED.distributedRunId,
            selectionIssue: 'The requested report belongs to another control run.',
            selectionIssueValue: issueValue,
            snapshotReceivedAtEpochMs: 2_500,
        }));

        const trigger = container.querySelector<HTMLButtonElement>(
            '[data-searchable-listbox-trigger]',
        );
        expect(trigger?.textContent).toContain('Newest accepted report');
        expect(trigger?.textContent).not.toContain(RUN_FAILED.distributedRunId);
        const issue = container.querySelector('[data-fleet-report-selection-issue]');
        expect(issue?.textContent).toContain('belongs to another control run');
        expect(issue?.querySelector('[data-exact-identifier]')?.getAttribute('dir'))
            .toBe('ltr');
        expect([...issue?.querySelectorAll('[data-exact-identifier]') ?? []]
            .map(node => node.textContent)).toEqual([
                RUN_FAILED.distributedRunId,
                issueValue,
            ]);
        for (const value of [RUN_FAILED.distributedRunId, issueValue]) {
            const unsafe = [...issue?.childNodes ?? []].some(node =>
                node.nodeType === Node.TEXT_NODE && node.textContent?.includes(value));
            expect(unsafe).toBe(false);
        }
    });

    it('bidi-isolates exact group and recipe identifiers in source and detail views', async () => {
        const bidiReport = {
            ...RUN_FAILED,
            group: { ...RUN_FAILED.group, groupId: BIDI_GROUP },
            recipeIds: [BIDI_RECIPE],
        };
        await render(createElement('div', {},
            createElement(FleetSourceBar, {
                contextKey: 'bidi-fleet-source',
                onSelectReport: vi.fn(),
                reports: [bidiReport],
                selectedReportId: bidiReport.distributedRunId,
            }),
            createElement(FleetEvidenceDetail, {
                onOpenAnalyze: vi.fn(),
                onOpenMonitor: vi.fn(),
                selectedRegionRows: [],
                selectedReport: bidiReport,
                selectionIssues: [],
            }),
        ));

        const exact = [...container.querySelectorAll<HTMLElement>(
            '[data-exact-identifier]',
        )];
        expect(exact.filter(node => node.textContent === BIDI_GROUP)).toHaveLength(2);
        expect(exact.filter(node => node.textContent === BIDI_RECIPE)).toHaveLength(2);
        expect(exact.every(node => node.getAttribute('dir') === 'ltr')).toBe(true);
        const trigger = container.querySelector<HTMLButtonElement>(
            '[data-searchable-listbox-trigger]',
        );
        await act(async () => trigger?.click());
        const optionDetail = container.querySelector('[role="option"] small');
        expect(optionDetail?.textContent).not.toContain(BIDI_GROUP);
        expect(optionDetail?.textContent).not.toContain(BIDI_RECIPE);
    });

    it('does not duplicate a recipe timing identity as unisolated display text', async () => {
        await render(createElement(FleetTiming, {
            recipeTiming: {
                items: [{
                    id: BIDI_RECIPE,
                    label: BIDI_RECIPE,
                    timing: { count: 1, p50Ms: 10, p95Ms: 20, maxMs: 20 },
                }],
                total: 1,
                omitted: 0,
            },
            regionTiming: { items: [], total: 0, omitted: 0 },
        }));

        const occurrences = [...container.querySelectorAll('[data-exact-identifier]')]
            .filter(node => node.textContent === BIDI_RECIPE);
        expect(occurrences).toHaveLength(1);
        const unsafe = [...container.querySelectorAll('span')]
            .some(node => node.textContent === BIDI_RECIPE);
        expect(unsafe).toBe(false);
    });

    it('composes the lazy workspace from root query truth without actions during render', async () => {
        const navigate = vi.fn();
        const replace = vi.fn();
        const inspect = vi.fn();
        const inspectorChange = vi.fn();
        const selectionLabelChange = vi.fn();
        const refresh = vi.fn(async () => undefined);
        const rows = [liveRow(BIDI_AGENT, false), liveRow('agent-pass', true)];
        const connection = {
            query: {
                status: 'live',
                reachability: 'reachable',
                authorization: 'ready',
                completeness: 'complete',
                receivedAtEpochMs: 2_500,
                isRefreshing: false,
                snapshot: {
                    runs: [],
                    distributedRuns: [],
                    fleetReports: [RUN_FAILED, RUN_PASSED],
                },
            },
            refresh,
        } as unknown as RecipeConsoleControlConnection;
        const selection = {
            boardRows: rows,
            boardSummary: {
                total: 2,
                connected: 1,
                targetable: 1,
                active: 0,
                selected: 0,
                stale: 0,
                offline: 1,
                wrongGroup: 0,
                missingIdentity: 0,
                missingCapability: 0,
                synthetic: 0,
            },
        } as unknown as RecipeConsoleControlSelection;

        await render(createElement(FleetWorkspace, {
            connection,
            navigate,
            onInspect: inspect,
            onInspectorChange: inspectorChange,
            onSelectionLabelChange: selectionLabelChange,
            replace,
            selection,
            urlState: {
                v: 1,
                experience: 'recipe-console',
                view: 'fleet',
            },
        }));

        expect(container.querySelector('[data-fleet-workspace][data-preview-view="fleet"]'))
            .not.toBeNull();
        expect([...container.querySelectorAll('h2')].map(heading => heading.textContent))
            .toEqual(expect.arrayContaining([
                'Fleet status',
                'Live agent board',
                'Agent × run',
                'Regions',
                'Repeated failures',
                'Fleet evidence map',
                'Region and recipe timing',
                'Selected report artifact',
                'Evidence quality',
            ]));
        expect(navigate).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
        expect(inspect).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(container.textContent).toContain('2 of 2 reports accepted');
        const liveLayer = container.querySelector<HTMLButtonElement>(
            '[data-fleet-map-layer="live-agents"]',
        );
        await act(async () => liveLayer?.click());
        expect(navigate).toHaveBeenCalledWith({
            fleetMapLayers: [
                'historical-regions',
                'failures',
                'observed-routes',
            ],
        });
    });

    it('restores the evidence inspector for a unique control-run-only deep link', async () => {
        const inspectorChange = vi.fn();
        const selectionLabelChange = vi.fn();
        const connection = {
            query: {
                status: 'live',
                reachability: 'reachable',
                authorization: 'ready',
                completeness: 'complete',
                receivedAtEpochMs: 2_500,
                isRefreshing: false,
                snapshot: {
                    runs: [],
                    distributedRuns: [],
                    fleetReports: [RUN_FAILED, RUN_PASSED],
                },
            },
            refresh: vi.fn(async () => undefined),
        } as unknown as RecipeConsoleControlConnection;
        const selection = {
            boardRows: [],
            boardSummary: {
                total: 0, connected: 0, targetable: 0, active: 0,
                selected: 0, stale: 0, offline: 0, wrongGroup: 0,
                missingIdentity: 0, missingCapability: 0, synthetic: 0,
            },
        } as unknown as RecipeConsoleControlSelection;

        await render(createElement(FleetWorkspace, {
            connection,
            navigate: vi.fn(),
            onInspect: vi.fn(),
            onInspectorChange: inspectorChange,
            onSelectionLabelChange: selectionLabelChange,
            replace: vi.fn(),
            selection,
            urlState: {
                v: 1,
                experience: 'recipe-console',
                view: 'fleet',
                controlRunId: RUN_FAILED.controlRunId,
            },
        }));

        const detail = inspectorChange.mock.calls.at(-1)?.[0] as
            ReturnType<typeof createElement> | undefined;
        expect(detail?.type).toBe(FleetEvidenceDetail);
        expect((detail?.props as { selectedReport?: ControlFleetRunReport })
            .selectedReport).toMatchObject({
                controlRunId: RUN_FAILED.controlRunId,
                distributedRunId: RUN_FAILED.distributedRunId,
            });
        expect(selectionLabelChange).toHaveBeenLastCalledWith(
            'Fleet run selected',
        );
        expect(selectionLabelChange.mock.calls.at(-1)?.[0]).not.toMatch(
            /[\u202a-\u202e\u2066-\u2069]/u,
        );
    });

    it('shows exact selected evidence and explicit Monitor and Analyze handoffs', async () => {
        const monitor = vi.fn();
        const analyze = vi.fn();
        const writeText = vi.spyOn(navigator.clipboard, 'writeText')
            .mockResolvedValue(undefined);
        const agentDetail = {
            agent: FAILED,
            runs: [{ run: RUN_FAILED, outcome: FAILED }],
            totalRuns: 3,
            omittedRuns: 2,
            passed: 0,
            failed: 3,
            missing: 0,
            reconnectCount: 1,
            diagnosticCount: 6,
        } as FleetReportAgentDetail;
        await render(createElement(FleetEvidenceDetail, {
            onOpenAnalyze: analyze,
            onOpenMonitor: monitor,
            selectedAgent: agentDetail,
            selectedLiveAgent: liveRow(BIDI_AGENT, false),
            selectedRegionRows: [REGION],
            selectedReport: RUN_FAILED,
            selectionIssues: [{
                field: 'fleetRegion',
                code: 'unavailable',
                message: 'Selected region is unavailable.',
                value: 'missing-region',
            }],
        }));

        expect(container.querySelector('h2')?.textContent).toBe('Fleet evidence detail');
        expect(container.textContent).toContain('Selected region is unavailable.');
        expect(container.textContent).toContain('Showing 1 of 3 historical runs');
        expect(container.querySelectorAll('[data-exact-identifier]')).not.toHaveLength(0);
        for (const reference of Object.values(RUN_FAILED.artifactRefs)) {
            expect([...container.querySelectorAll('[data-exact-identifier]')]
                .some(node => node.textContent === reference)).toBe(true);
            expect(container.querySelector(`a[href="${CSS.escape(reference)}"]`))
                .toBeNull();
        }
        const copyFleetReference = [...container.querySelectorAll<HTMLButtonElement>(
            'button',
        )].find(button => button.textContent === 'Copy Fleet report reference');
        await act(async () => copyFleetReference?.click());
        expect(writeText).toHaveBeenCalledWith(RUN_FAILED.artifactRefs.fleetReport);
        expect(container.querySelector('[data-fleet-reference-copy-status]')?.textContent)
            .toContain('Fleet report reference copied');
        const monitorButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
            .find(button => button.textContent === 'Open Monitor');
        await act(async () => monitorButton?.click());
        expect(monitor).toHaveBeenCalledWith(RUN_FAILED, BIDI_AGENT);
        const analyzeButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
            .find(button => button.textContent === 'Open Analyze');
        await act(async () => analyzeButton?.click());
        expect(analyze).toHaveBeenCalledWith(RUN_FAILED, BIDI_AGENT);
    });

    it('renders and traverses every selected-agent historical run', async () => {
        const runs = Array.from({ length: 25 }, (_, index) => ({
            run: report(`agent-run-${String(index).padStart(2, '0')}`, index, FAILED),
            outcome: FAILED,
        }));

        function Harness() {
            const window = useFleetWindow({
                contextKey: 'selected-agent-runs',
                section: 'agentRuns',
                total: runs.length,
            });
            const detail = {
                agent: FAILED,
                runs: runs.slice(
                    window.model.startIndex,
                    window.model.endIndexExclusive,
                ),
                totalRuns: runs.length,
                omittedRuns: runs.length - (
                    window.model.endIndexExclusive - window.model.startIndex
                ),
                passed: 0,
                failed: runs.length,
                missing: 0,
                reconnectCount: 1,
                diagnosticCount: runs.length,
            } as FleetReportAgentDetail;
            return createElement(FleetEvidenceDetail, {
                agentRunWindow: window,
                onOpenAnalyze: vi.fn(),
                onOpenMonitor: vi.fn(),
                selectedAgent: detail,
                selectedRegionRows: [],
                selectionIssues: [],
            });
        }

        await render(createElement(Harness));
        expect(container.textContent).toContain('No current live agent evidence');
        expect(container.textContent).not.toContain('Not connected live');
        const visited: string[] = [];
        while (true) {
            visited.push(...[...container.querySelectorAll<HTMLElement>(
                '[data-fleet-agent-run]',
            )].map(row => row.dataset.fleetAgentRun ?? ''));
            const next = [...container.querySelectorAll<HTMLButtonElement>('button')]
                .find(button => button.textContent === 'Next');
            if (!next || next.disabled) break;
            await act(async () => next.click());
        }
        expect(visited).toEqual(runs.map(entry => entry.run.distributedRunId));
        expect(new Set(visited).size).toBe(25);
    });

    it('renders and traverses every selected-region provider row', async () => {
        const rows = Array.from({ length: 55 }, (_, index) => ({
            ...REGION,
            provider: `provider-${String(index).padStart(2, '0')}`,
        }));

        function Harness() {
            const window = useFleetWindow({
                contextKey: 'selected-region-providers',
                section: 'regionProviders',
                total: rows.length,
            });
            return createElement(FleetEvidenceDetail, {
                onOpenAnalyze: vi.fn(),
                onOpenMonitor: vi.fn(),
                regionProviderWindow: window,
                selectedRegionRows: rows,
                selectionIssues: [],
            });
        }

        await render(createElement(Harness));
        const visited: string[] = [];
        while (true) {
            visited.push(...[...container.querySelectorAll<HTMLElement>(
                '[data-fleet-region-provider]',
            )].map(row => row.dataset.fleetRegionProvider ?? ''));
            const next = [...container.querySelectorAll<HTMLButtonElement>('button')]
                .find(button => button.textContent === 'Next');
            if (!next || next.disabled) break;
            await act(async () => next.click());
        }
        expect(visited).toEqual(rows.map(row => row.provider ?? ''));
        expect(new Set(visited).size).toBe(55);
    });

    it('bounds and traverses every selected-report recipe identity', async () => {
        const recipeIds = Array.from(
            { length: 55 },
            (_, index) => `recipe-${String(index).padStart(2, '0')}`,
        );
        const selectedReport = { ...RUN_FAILED, recipeIds };

        function Harness() {
            const window = useFleetWindow({
                contextKey: 'selected-report-recipes',
                section: 'reportRecipes',
                total: recipeIds.length,
            });
            return createElement(FleetSourceBar, {
                contextKey: 'selected-report-source',
                onSelectReport: vi.fn(),
                recipeWindow: window,
                reports: [selectedReport],
                selectedReportId: selectedReport.distributedRunId,
            });
        }

        await render(createElement(Harness));
        const visited: string[] = [];
        while (true) {
            const mounted = [...container.querySelectorAll<HTMLElement>(
                '[data-fleet-source-recipe]',
            )];
            expect(mounted.length).toBeLessThanOrEqual(24);
            visited.push(...mounted.map(row => row.dataset.fleetSourceRecipe ?? ''));
            const group = container.querySelector<HTMLElement>(
                '[aria-label="Selected Fleet report recipes window"]',
            );
            const next = group?.querySelector<HTMLButtonElement>(
                '[data-explicit-window-direction="next"]',
            );
            if (!next || next.disabled) break;
            await act(async () => next.click());
        }
        expect(visited).toEqual(recipeIds);
        expect(new Set(visited).size).toBe(55);
    });

    it('preserves evidence work and traversal across clone-equivalent control polls', async () => {
        const agents = Array.from({ length: 30 }, (_, index) => outcome(
            `agent-${String(index).padStart(2, '0')}`,
            'passed',
            `region-${String(index).padStart(2, '0')}`,
        ));
        const pressureReport = {
            ...RUN_PASSED,
            agents,
            summary: {
                ...RUN_PASSED.summary,
                agents: agents.length,
                regions: agents.length,
                passed: agents.length,
            },
        } as ControlFleetRunReport;
        const firstSnapshot = {
            runs: [],
            distributedRuns: [],
            fleetReports: [pressureReport],
        };
        const sameSnapshot = structuredClone(firstSnapshot);
        Object.assign(sameSnapshot, { unrelatedLiveRevision: 1 });
        let nestedExtensionVisits = 0;
        for (const snapshot of [firstSnapshot, sameSnapshot]) {
            Object.defineProperty(snapshot.fleetReports[0]!.agents[0]!.label, 'extension', {
                configurable: true,
                enumerable: true,
                get: () => {
                    nestedExtensionVisits += 1;
                    return { ignored: true };
                },
            });
        }
        const connection = {
            query: {
                status: 'live',
                reachability: 'reachable',
                authorization: 'ready',
                completeness: 'complete',
                receivedAtEpochMs: 2_500,
                isRefreshing: false,
                snapshot: firstSnapshot,
            },
            refresh: vi.fn(async () => undefined),
        } as unknown as RecipeConsoleControlConnection;
        const liveRows = Array.from(
            { length: 55 },
            (_, index) => liveRow(`live-agent-${String(index).padStart(2, '0')}`, true),
        );
        const selection = {
            controlRunId: 'stable-live-control',
            boardRows: liveRows,
            boardSummary: {
                total: 55, connected: 55, targetable: 55, active: 0,
                selected: 0, stale: 0, offline: 0, wrongGroup: 0,
                missingIdentity: 0, missingCapability: 0, synthetic: 0,
            },
        } as unknown as RecipeConsoleControlSelection;
        const props = {
            connection,
            selection,
            urlState: { v: 1, experience: 'recipe-console', view: 'fleet' },
            navigate: vi.fn(),
            replace: vi.fn(),
            onInspect: vi.fn(),
            onInspectorChange: vi.fn(),
            onSelectionLabelChange: vi.fn(),
        } as FleetWorkspaceProps;
        let latest: FleetWorkspaceController | undefined;

        function Harness({
            fleetMapLayers,
            snapshot = firstSnapshot,
        }: Readonly<{
            fleetMapLayers?: readonly ['failures'];
            snapshot?: typeof firstSnapshot;
        }>) {
            latest = useFleetWorkspace({
                ...props,
                connection: {
                    ...connection,
                    query: {
                        ...connection.query,
                        receivedAtEpochMs: snapshot === firstSnapshot
                            ? 2_500
                            : 7_500,
                        snapshot,
                    },
                } as RecipeConsoleControlConnection,
                urlState: { ...props.urlState, fleetMapLayers },
            });
            return null;
        }
        await render(createElement(Harness, {}));
        const collection = latest?.model.analysisCollection;
        const geographyHistory = latest?.geographyHistory;
        const extensionVisitsAfterInitialIndex = nestedExtensionVisits;
        expect(latest?.model.analysisCollection?.work.cellLookups).toBe(30);
        await act(async () => latest?.windows.regions.next());
        await act(async () => latest?.windows.liveAgents.next());
        expect(latest?.windows.regions.model.startIndex).toBe(24);
        expect(latest?.windows.liveAgents.model.startIndex).toBe(40);
        expect(latest?.model.analysisCollection?.work.cellLookups).toBe(30);
        expect(nestedExtensionVisits).toBe(extensionVisitsAfterInitialIndex);
        await act(async () => root?.render(createElement(Harness, {
            fleetMapLayers: ['failures'],
            snapshot: sameSnapshot,
        })));
        expect(latest?.model.analysisCollection).toBe(collection);
        expect(latest?.geographyHistory).toBe(geographyHistory);
        expect(latest?.geographyHistory.work).toEqual({
            reportVisits: 1,
            outcomeVisits: 30,
        });
        expect(latest?.model.analysisCollection?.work.cellLookups).toBe(30);
        expect(latest?.windows.regions.model.startIndex).toBe(24);
        expect(latest?.windows.liveAgents.model.startIndex).toBe(40);
        expect(nestedExtensionVisits).toBe(extensionVisitsAfterInitialIndex);
    });

    it('refreshes live projections without resetting historical evidence for the same raw revision',
        async () => {
            const selectedAgentId = 'agent-00';
            const agents = Array.from({ length: 30 }, (_, index) => outcome(
                `agent-${String(index).padStart(2, '0')}`,
                'passed',
                `region-${String(index).padStart(2, '0')}`,
            ));
            const pressureReport = {
                ...RUN_PASSED,
                agents,
                summary: {
                    ...RUN_PASSED.summary,
                    agents: agents.length,
                    regions: agents.length,
                    passed: agents.length,
                },
            } as ControlFleetRunReport;
            const firstSnapshot = {
                runs: [],
                distributedRuns: [],
                fleetReports: [pressureReport],
            };
            const sameSnapshot = structuredClone(firstSnapshot);
            const rawDocument = JSON.stringify(firstSnapshot);
            const revisions = createControlSnapshotRevisionSession();
            for (const snapshot of [firstSnapshot, sameSnapshot]) {
                rememberControlResponseDocument(snapshot, rawDocument);
                revisions.associate(snapshot, {
                    source: 'root-snapshot',
                    rootDocument: snapshot,
                });
            }
            expect(controlSnapshotRevisionOf(sameSnapshot)).toBe(
                controlSnapshotRevisionOf(firstSnapshot),
            );

            const liveRowAt = (connected: boolean): ControlAgentBoardRow => ({
                ...liveRow(selectedAgentId, connected),
                identity: {
                    region: 'eu-north',
                    provider: 'provider-a',
                    location: {
                        latitude: 59.9139,
                        longitude: 10.7522,
                        label: 'Explicit live location',
                        precision: 'exact',
                    },
                },
            });
            const connection = {
                query: {
                    status: 'live',
                    reachability: 'reachable',
                    authorization: 'ready',
                    completeness: 'complete',
                    receivedAtEpochMs: 2_500,
                    isRefreshing: false,
                    snapshot: firstSnapshot,
                },
                refresh: vi.fn(async () => undefined),
            } as unknown as RecipeConsoleControlConnection;
            let latest: FleetWorkspaceController | undefined;

            function Harness({
                boardRows,
                receivedAtEpochMs,
                snapshot,
            }: Readonly<{
                boardRows: readonly ControlAgentBoardRow[];
                receivedAtEpochMs: number;
                snapshot: typeof firstSnapshot;
            }>) {
                latest = useFleetWorkspace({
                    connection: {
                        ...connection,
                        query: {
                            ...connection.query,
                            receivedAtEpochMs,
                            snapshot,
                        },
                    } as RecipeConsoleControlConnection,
                    selection: {
                        agentId: selectedAgentId,
                        boardRows,
                        boardSummary: {
                            total: 1,
                            connected: boardRows[0]?.connected ? 1 : 0,
                            targetable: boardRows[0]?.targetable ? 1 : 0,
                            active: 0,
                            selected: 0,
                            stale: 0,
                            offline: boardRows[0]?.connected ? 0 : 1,
                            wrongGroup: 0,
                            missingIdentity: 0,
                            missingCapability: 0,
                            synthetic: 0,
                        },
                    } as RecipeConsoleControlSelection,
                    urlState: {
                        v: 1,
                        experience: 'recipe-console',
                        view: 'fleet',
                        agentId: selectedAgentId,
                    },
                    navigate: vi.fn(),
                    replace: vi.fn(),
                    onInspect: vi.fn(),
                    onInspectorChange: vi.fn(),
                    onSelectionLabelChange: vi.fn(),
                });
                return createElement(FleetEvidenceDetail, {
                    onOpenAnalyze: vi.fn(),
                    onOpenMonitor: vi.fn(),
                    selectedAgent: latest.evidence?.selectedAgent,
                    selectedLiveAgent: latest.model.selectedLiveAgent,
                    selectedRegionRows: latest.model.selectedRegionRows,
                    selectedReport: latest.model.selectedReport,
                    selectionIssues: latest.model.selectionIssues,
                });
            }

            const connectedRows = [liveRowAt(true)];
            const offlineRows = [liveRowAt(false)];
            await render(createElement(Harness, {
                boardRows: connectedRows,
                receivedAtEpochMs: 2_500,
                snapshot: firstSnapshot,
            }));
            const historicalCollection = latest?.model.analysisCollection;
            const geographyHistory = latest?.geographyHistory;
            await act(async () => latest?.windows.regions.next());
            expect(latest?.windows.regions.model.startIndex).toBe(24);
            expect(latest?.model.selectedLiveAgent?.connected).toBe(true);
            expect(latest?.map.resolvedEvidence.agentMarkers.find(marker =>
                marker.agent.agentId === selectedAgentId
            )).toMatchObject({
                severity: 'neutral',
                agent: { live: { state: 'connected' } },
            });
            expect(container.textContent).toContain('Connected live');

            await act(async () => root?.render(createElement(Harness, {
                boardRows: offlineRows,
                receivedAtEpochMs: 7_500,
                snapshot: sameSnapshot,
            })));

            expect(latest?.model.analysisCollection).toBe(historicalCollection);
            expect(latest?.geographyHistory).toBe(geographyHistory);
            expect(latest?.windows.regions.model.startIndex).toBe(24);
            expect(latest?.model.selectedLiveAgent?.connected).toBe(false);
            expect(latest?.map.resolvedEvidence.agentMarkers.find(marker =>
                marker.agent.agentId === selectedAgentId
            )).toMatchObject({
                severity: 'critical',
                agent: { live: { state: 'offline' } },
            });
            expect(container.textContent).toContain('Not connected live');

            await act(async () => root?.render(createElement(Harness, {
                boardRows: offlineRows,
                receivedAtEpochMs: 9_000,
                snapshot: sameSnapshot,
            })));

            expect(latest?.model.analysisCollection).toBe(historicalCollection);
            expect(latest?.geographyHistory).toBe(geographyHistory);
            expect(latest?.windows.regions.model.startIndex).toBe(24);
            expect(latest?.map.resolvedEvidence.agentMarkers.find(marker =>
                marker.agent.agentId === selectedAgentId
            )?.agent.live?.observedAtEpochMs).toBe(9_000);
        });

    it('bounds and traverses affected agents inside each failure group', async () => {
        const affectedAgents = Array.from(
            { length: 85 },
            (_, index) => `failure-agent-${String(index).padStart(2, '0')}`,
        );
        await render(createElement(FleetFailures, {
            failures: {
                items: [{ ...FAILURE, affectedAgents }],
                total: 1,
                omitted: 0,
            },
            onOpenHistory: vi.fn(),
            onOpenRun: vi.fn(),
            onSelectAgent: vi.fn(),
        }));
        const visited: string[] = [];
        while (true) {
            const mounted = [...container.querySelectorAll<HTMLElement>(
                '[data-failure-agent-id]',
            )];
            expect(mounted.length).toBeLessThanOrEqual(40);
            visited.push(...mounted.map(row => row.dataset.failureAgentId ?? ''));
            const next = [...container.querySelectorAll<HTMLButtonElement>('button')]
                .find(button => button.textContent === 'Next');
            if (!next || next.disabled) break;
            await act(async () => next.click());
        }
        expect(visited).toEqual(affectedAgents);
        expect(new Set(visited).size).toBe(85);
    });

    it('keeps boundary focus with the owning nested failure-agent window',
        async () => {
            const affectedAgents = Array.from(
                { length: 45 },
                (_, index) => `failure-agent-${String(index).padStart(2, '0')}`,
            );

            function NestedFailureWindows() {
                const outer = useFleetWindow({
                    contextKey: 'fleet-failure-groups-test',
                    section: 'failures',
                    total: 30,
                });
                return createElement(Fragment, null,
                    createElement(FleetWindowControls, {
                        contentId: 'fleet-failure-groups-test',
                        itemLabel: 'failure groups',
                        label: 'Fleet failure groups',
                        window: outer,
                    }),
                    createElement('div', {
                        id: 'fleet-failure-groups-test',
                        ...outer.contentFocusProps,
                    }, createElement(FleetFailures, {
                        failures: {
                            items: [{ ...FAILURE, affectedAgents }],
                            total: 30,
                            omitted: 29,
                        },
                        onOpenHistory: vi.fn(),
                        onOpenRun: vi.fn(),
                        onSelectAgent: vi.fn(),
                    })),
                );
            }

            await render(createElement(NestedFailureWindows));
            const next = [...container.querySelectorAll<HTMLButtonElement>(
                'button[data-explicit-window-direction="next"]',
            )].at(-1)!;
            next.focus();
            await act(async () => next.click());

            expect(document.activeElement?.getAttribute(
                'data-fleet-window-focus-anchor',
            )).toBe(`${FAILURE.title} affected agents`);
        });
});
