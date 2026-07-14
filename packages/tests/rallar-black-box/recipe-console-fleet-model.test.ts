import { describe, expect, it } from 'vitest';
import type { ControlServerSnapshot } from
    '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    ControlFleetAgentRunOutcome,
    ControlFleetRunReport,
} from '../../../packages/shared-test/rallar-bb-test/fleet-report.ts';
import type { ControlAgentBoardRow } from
    '../../../apps/rallar-black-box/src/control-agent-board.ts';
import type { ControlQuerySnapshot } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-query.ts';
import { deriveFleetWorkspaceModel } from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/fleet-workspace-model.ts';
import { fleetLiveGeographyEvidenceFromBoardRows } from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/fleet-live-adapter.ts';
import type { RecipeConsoleUrlState } from
    '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';

const URL_STATE: RecipeConsoleUrlState = {
    v: 1,
    experience: 'recipe-console',
    view: 'fleet',
};

function outcome(
    agentId: string,
    region: string,
    state: ControlFleetAgentRunOutcome['state'] = 'passed',
): ControlFleetAgentRunOutcome {
    return {
        agentId,
        label: { agentId, region, provider: 'provider-a' },
        state,
        ok: state === 'passed',
        missing: state === 'missing',
        flaky: false,
        stale: false,
        commandCount: 1,
        failedCommandCount: state === 'failed' ? 1 : 0,
        resultCount: 1,
        eventCount: 1,
        diagnosticCount: state === 'failed' ? 1 : 0,
        reconnectCount: 0,
        durationMs: 100,
        failureSignatureIds: state === 'failed' ? ['sig-runtime'] : [],
    };
}

function report(
    distributedRunId: string,
    generatedAtEpochMs: number,
    region = 'eu-north',
    agentId = 'agent-a',
): ControlFleetRunReport {
    const agent = outcome(agentId, region);
    return {
        fleetReportSchemaVersion: 1,
        distributedRunId,
        controlRunId: `control-${distributedRunId}`,
        generatedAtEpochMs,
        state: 'passed',
        ok: true,
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: `group-${region}`,
        },
        recipeIds: ['rtc-smoke'],
        runDurationMs: 500,
        summary: {
            agents: 1,
            regions: 1,
            passed: 1,
            failed: 0,
            missing: 0,
            flaky: 0,
            stale: 0,
            passRate: 1,
            failureGroups: 0,
        },
        timing: {
            run: { count: 1, p95Ms: 500 },
            commands: { count: 1, p95Ms: 100 },
        },
        agents: [agent],
        regions: [{
            region,
            provider: 'provider-a',
            agentCount: 1,
            passed: 1,
            failed: 0,
            missing: 0,
            flaky: 0,
            stale: 0,
            passRate: 1,
            timing: { count: 1, p95Ms: 100 },
        }],
        failureSignatures: [],
        artifactRefs: {
            distributedRun: `opaque-distributed:${distributedRunId}`,
            controlRun: `opaque-control:control-${distributedRunId}`,
            fleetReport: `opaque-fleet:${distributedRunId}`,
        },
    };
}

function query(
    status: ControlQuerySnapshot<ControlServerSnapshot>['status'],
    fleetReports: 'absent' | readonly unknown[] = 'absent',
): ControlQuerySnapshot<ControlServerSnapshot> {
    const snapshot = status === 'connecting' ||
            (status === 'offline' && fleetReports === 'absent')
        ? undefined
        : {
            runs: [],
            distributedRuns: [],
            ...(fleetReports === 'absent' ? {} : {
                fleetReports: fleetReports as readonly ControlFleetRunReport[],
            }),
        };
    return {
        status,
        reachability: status === 'offline' ? 'unreachable' : 'reachable',
        authorization: 'ready',
        snapshot,
        completeness: status === 'partial' ? 'partial' : 'complete',
        receivedAtEpochMs: snapshot ? 5_000 : undefined,
        isRefreshing: false,
    };
}

function liveAgent(agentId: string, region: string): ControlAgentBoardRow {
    return {
        agentId,
        region,
        provider: 'provider-a',
        connected: true,
        synthetic: false,
        activeRuns: [],
    } as unknown as ControlAgentBoardRow;
}

describe('Recipe Console Fleet workspace model', () => {
    it('adapts only root-selected live board truth into shared geography evidence', () => {
        const connected = {
            ...liveAgent('agent-b', 'us-east'),
            identity: {
                region: 'identity-region',
                provider: 'identity-provider',
                location: { latitude: 40, longitude: -70, label: 'live rack' },
            },
            activeRuns: [
                { distributedRunId: 'run-z' },
                { distributedRunId: 'run-a' },
            ],
            lastSeenAtEpochMs: 4_900,
        } as unknown as ControlAgentBoardRow;
        const stale = {
            ...liveAgent('agent-a', 'eu-north'),
            connected: false,
            targetStatus: 'stale',
        } as ControlAgentBoardRow;

        expect(fleetLiveGeographyEvidenceFromBoardRows(
            [connected, stale],
            5_000,
        )).toEqual([
            expect.objectContaining({
                agentId: 'agent-a',
                state: 'stale',
                observedAtEpochMs: 5_000,
            }),
            expect.objectContaining({
                agentId: 'agent-b',
                state: 'connected',
                region: 'us-east',
                provider: 'provider-a',
                location: { latitude: 40, longitude: -70, label: 'live rack' },
                activeRunIds: ['run-a', 'run-z'],
            }),
        ]);
    });

    it.each([
        ['connecting', query('connecting'), 'connecting', 'absent', 0],
        ['offline', query('offline'), 'offline', 'absent', 0],
        ['absent optional collection', query('live'), 'partial', 'absent', 0],
        ['empty collection', query('live', []), 'empty', 'present', 0],
        ['partial evidence', query('partial', [report('run-a', 1)]), 'partial', 'present', 1],
        ['last-known evidence', query('stale', [report('run-a', 1)]), 'stale', 'present', 1],
        ['live evidence', query('live', [report('run-a', 1)]), 'live', 'present', 1],
    ] as const)(
        'projects %s without conflating absence and emptiness',
        (_label, controlQuery, status, collection, reportCount) => {
            const model = deriveFleetWorkspaceModel({
                query: controlQuery,
                selection: { boardRows: [] },
                urlState: URL_STATE,
            });

            expect(model).toMatchObject({
                status,
                collection,
                reports: { sourceCount: reportCount, acceptedCount: reportCount },
            });
            expect(model.reports.items).toHaveLength(reportCount);
        },
    );

    it('retains valid evidence while exposing mixed schema errors and exact counts', () => {
        const valid = report('run-valid', 2_000);
        const invalid = {
            ...report('run-invalid', 1_000),
            fleetReportSchemaVersion: 9,
        };

        const model = deriveFleetWorkspaceModel({
            query: query('live', [invalid, valid]),
            selection: { boardRows: [] },
            urlState: URL_STATE,
        });

        expect(model).toMatchObject({
            status: 'schema-error',
            reports: {
                sourceCount: 2,
                acceptedCount: 1,
                quarantinedCount: 1,
            },
        });
        expect(model.reports.items.map(item => item.distributedRunId))
            .toEqual(['run-valid']);
        expect(model.validationIssues).toEqual([
            expect.objectContaining({
                code: 'unsupported-schema-version',
                distributedRunId: 'run-invalid',
            }),
        ]);
        expect(model.analysis?.summary.runs).toBe(1);
    });

    it('resolves exact report, region, and root-selected agent evidence', () => {
        const newest = report('run-new', 3_000, 'eu-north', 'agent-a');
        const selected = report('run-selected', 2_000, 'us-east', 'agent-b');

        const model = deriveFleetWorkspaceModel({
            query: query('live', [selected, newest]),
            selection: {
                agentId: 'agent-b',
                boardRows: [
                    liveAgent('agent-a', 'eu-north'),
                    liveAgent('agent-b', 'us-east'),
                ],
            },
            urlState: {
                ...URL_STATE,
                distributedRunId: 'run-selected',
                controlRunId: 'control-run-selected',
                agentId: 'agent-b',
                fleetRegion: 'us-east',
            },
        });

        expect(model.selectedReport).toMatchObject({
            distributedRunId: 'run-selected',
            controlRunId: 'control-run-selected',
        });
        expect(model.selectedRegionRows.map(row => row.region))
            .toEqual(['us-east']);
        expect(model.selectedLiveAgent).toMatchObject({ agentId: 'agent-b' });
        expect(model.analysis?.selectedAgent).toMatchObject({
            agent: { agentId: 'agent-b' },
        });
        expect(model.selectionIssues).toEqual([]);
    });

    it('never substitutes another report when an exact URL identity is unavailable or incompatible', () => {
        const available = report('run-available', 3_000);
        const unavailable = deriveFleetWorkspaceModel({
            query: query('live', [available]),
            selection: { boardRows: [] },
            urlState: { ...URL_STATE, distributedRunId: 'run-missing' },
        });
        const incompatible = deriveFleetWorkspaceModel({
            query: query('live', [available]),
            selection: { boardRows: [] },
            urlState: {
                ...URL_STATE,
                distributedRunId: 'run-available',
                controlRunId: 'control-other',
            },
        });

        expect(unavailable.selectedReport).toBeUndefined();
        expect(unavailable.selectionIssues).toEqual([
            expect.objectContaining({ field: 'distributedRunId', code: 'unavailable' }),
        ]);
        expect(incompatible.selectedReport).toBeUndefined();
        expect(incompatible.selectionIssues).toEqual([
            expect.objectContaining({ field: 'controlRunId', code: 'incompatible' }),
        ]);
    });

    it('resolves a control-run-only URL exactly and rejects missing or ambiguous evidence', () => {
        const unrelated = report('run-unrelated', 4_000);
        const exact = {
            ...report('run-exact', 3_000),
            controlRunId: 'control-exact',
        };
        const unique = deriveFleetWorkspaceModel({
            query: query('live', [exact, unrelated]),
            selection: { boardRows: [] },
            urlState: { ...URL_STATE, controlRunId: 'control-exact' },
        });
        const missing = deriveFleetWorkspaceModel({
            query: query('live', [exact, unrelated]),
            selection: { boardRows: [] },
            urlState: { ...URL_STATE, controlRunId: 'control-missing' },
        });
        const ambiguous = deriveFleetWorkspaceModel({
            query: query('live', [
                exact,
                { ...report('run-also-exact', 2_000), controlRunId: 'control-exact' },
            ]),
            selection: { boardRows: [] },
            urlState: { ...URL_STATE, controlRunId: 'control-exact' },
        });

        expect(unique.selectedReport?.distributedRunId).toBe('run-exact');
        expect(unique.selectionIssues).toEqual([]);
        expect(missing.selectedReport).toBeUndefined();
        expect(missing.selectionIssues).toEqual([
            expect.objectContaining({ field: 'controlRunId', code: 'unavailable' }),
        ]);
        expect(ambiguous.selectedReport).toBeUndefined();
        expect(ambiguous.selectionIssues).toEqual([
            expect.objectContaining({ field: 'controlRunId', code: 'ambiguous' }),
        ]);
    });

    it.each([
        ['connecting', query('connecting')],
        ['offline last-known', query('offline', [report('run-known', 1_000)])],
        ['partial evidence', query('partial', [report('run-known', 1_000)])],
    ] as const)(
        'keeps exact deep-link selections pending during %s evidence',
        (_label, controlQuery) => {
            const model = deriveFleetWorkspaceModel({
                query: controlQuery,
                selection: { agentId: 'agent-missing', boardRows: [] },
                urlState: {
                    ...URL_STATE,
                    distributedRunId: 'run-missing',
                    controlRunId: 'control-missing',
                    agentId: 'agent-missing',
                    fleetRegion: 'region-missing',
                },
            });

            expect(model.selectedReport).toBeUndefined();
            expect(model.selectedRegionRows).toEqual([]);
            expect(model.selectedLiveAgent).toBeUndefined();
            expect(model.selectionIssues).toEqual([]);
        },
    );

    it('does not invalidate report deep links when the optional collection is absent', () => {
        const model = deriveFleetWorkspaceModel({
            query: query('live'),
            selection: { agentId: 'agent-pending', boardRows: [] },
            urlState: {
                ...URL_STATE,
                distributedRunId: 'run-pending',
                controlRunId: 'control-pending',
                agentId: 'agent-pending',
                fleetRegion: 'region-pending',
            },
        });

        expect(model.collection).toBe('absent');
        expect(model.selectionIssues).toEqual([]);
    });
});
