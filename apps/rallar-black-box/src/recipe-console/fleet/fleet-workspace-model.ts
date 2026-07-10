import {
    createFleetReportAnalysisCollection,
    deriveFleetReportAnalysisFromCollection,
    type FleetReportAnalysis,
    type FleetReportAnalysisCollection,
} from '@shared-test/rallar-bb-test/fleet-report-analysis.ts';
import type {
    ControlFleetRegionSummary,
    ControlFleetRunReport,
} from '@shared-test/rallar-bb-test/fleet-report.ts';
import {
    validateControlFleetRunReportCollection,
    type ControlFleetReportValidationIssue,
} from '@shared-test/rallar-bb-test/fleet-report-validation.ts';
import type { ControlServerSnapshot } from
    '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { ControlAgentBoardRow } from '../../control-agent-board.ts';
import type { ControlQuerySnapshot } from '../control/control-query.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';

export type FleetWorkspaceStatus =
    | 'connecting'
    | 'live'
    | 'partial'
    | 'stale'
    | 'offline'
    | 'empty'
    | 'schema-error';

export type FleetWorkspaceSelectionIssue = Readonly<{
    field: 'distributedRunId' | 'controlRunId' | 'fleetRegion' | 'agentId';
    code: 'unavailable' | 'incompatible' | 'ambiguous';
    message: string;
    value: string;
}>;

export type FleetWorkspaceModel = Readonly<{
    status: FleetWorkspaceStatus;
    collection: 'absent' | 'present';
    reports: Readonly<{
        items: readonly ControlFleetRunReport[];
        sourceCount: number;
        acceptedCount: number;
        quarantinedCount: number;
    }>;
    validationIssues: readonly ControlFleetReportValidationIssue[];
    omittedValidationIssueCount: number;
    analysisCollection?: FleetReportAnalysisCollection;
    analysis?: FleetReportAnalysis;
    selectedReport?: ControlFleetRunReport;
    selectedRegionRows: readonly ControlFleetRegionSummary[];
    selectedLiveAgent?: ControlAgentBoardRow;
    selectionIssues: readonly FleetWorkspaceSelectionIssue[];
}>;

export type FleetWorkspaceModelInput = Readonly<{
    query: ControlQuerySnapshot<ControlServerSnapshot>;
    selection: Readonly<{
        agentId?: string;
        boardRows: readonly ControlAgentBoardRow[];
    }>;
    urlState: RecipeConsoleUrlState;
}>;

export type FleetWorkspaceReportEvidence = Readonly<{
    collection: 'absent' | 'present';
    validation?: ReturnType<typeof validateControlFleetRunReportCollection>;
    reports: readonly ControlFleetRunReport[];
    analysisCollection?: FleetReportAnalysisCollection;
}>;

export function createFleetWorkspaceReportEvidence(
    rawReports: unknown,
): FleetWorkspaceReportEvidence {
    const collection = rawReports === undefined ? 'absent' : 'present';
    const validation = rawReports === undefined
        ? undefined
        : validateControlFleetRunReportCollection(rawReports);
    const reports = validation?.reports ?? [];
    const analysisCollection = rawReports === undefined
        ? undefined
        : createFleetReportAnalysisCollection({ reports });
    return {
        collection,
        ...(validation ? { validation } : {}),
        reports,
        ...(analysisCollection ? { analysisCollection } : {}),
    };
}

export function deriveFleetWorkspaceModel(
    input: FleetWorkspaceModelInput,
): FleetWorkspaceModel {
    const evidence = createFleetWorkspaceReportEvidence(
        input.query.snapshot?.fleetReports,
    );
    const analysis = evidence.analysisCollection === undefined
        ? undefined
        : deriveFleetReportAnalysisFromCollection(evidence.analysisCollection, {
            selectedAgentId: input.selection.agentId,
        });
    return deriveFleetWorkspaceModelFromEvidence(input, evidence, analysis);
}

export function deriveFleetWorkspaceModelFromEvidence(
    input: FleetWorkspaceModelInput,
    evidence: FleetWorkspaceReportEvidence,
    analysis: FleetReportAnalysis | undefined,
): FleetWorkspaceModel {
    const {
        analysisCollection,
        collection,
        reports,
        validation,
    } = evidence;
    const selectionIssues: FleetWorkspaceSelectionIssue[] = [];
    const currentCompleteEvidence = input.query.status === 'live' &&
        input.query.completeness === 'complete';
    const reportSelectionAuthoritative = currentCompleteEvidence &&
        collection === 'present' && validation?.ok === true;
    const reportsById = new Map(
        reports.map(report => [report.distributedRunId, report]),
    );
    const selectedReport = selectReport(
        input.urlState,
        reports,
        reportsById,
        selectionIssues,
        reportSelectionAuthoritative,
    );
    const regionRows = analysisCollection?.regions ?? [];
    const selectedRegionRows = input.urlState.fleetRegion
        ? regionRows.filter(row => row.region === input.urlState.fleetRegion)
        : [];
    if (
        reportSelectionAuthoritative &&
        input.urlState.fleetRegion && selectedRegionRows.length === 0
    ) {
        selectionIssues.push({
            field: 'fleetRegion',
            code: 'unavailable',
            value: input.urlState.fleetRegion,
            message:
                'The requested Fleet region is not present in the accepted reports.',
        });
    }
    const liveAgentsById = new Map(
        input.selection.boardRows.map(row => [row.agentId, row]),
    );
    const selectedLiveAgent = input.selection.agentId
        ? liveAgentsById.get(input.selection.agentId)
        : undefined;
    if (
        input.selection.agentId &&
        !selectedLiveAgent &&
        !analysis?.selectedAgent &&
        reportSelectionAuthoritative
    ) {
        selectionIssues.push({
            field: 'agentId',
            code: 'unavailable',
            value: input.selection.agentId,
            message:
                'The requested Fleet agent is not present in live or accepted historical evidence.',
        });
    }

    return {
        status: workspaceStatus(input.query, collection, validation),
        collection,
        reports: {
            items: reports,
            sourceCount: validation?.sourceCount ?? 0,
            acceptedCount: validation?.acceptedCount ?? 0,
            quarantinedCount: validation?.quarantinedCount ?? 0,
        },
        validationIssues: validation?.issues ?? [],
        omittedValidationIssueCount: validation?.omittedIssueCount ?? 0,
        analysisCollection,
        analysis,
        selectedReport,
        selectedRegionRows,
        selectedLiveAgent,
        selectionIssues,
    };
}

function workspaceStatus(
    query: ControlQuerySnapshot<ControlServerSnapshot>,
    collection: FleetWorkspaceModel['collection'],
    validation: ReturnType<typeof validateControlFleetRunReportCollection>
        | undefined,
): FleetWorkspaceStatus {
    if (query.status === 'connecting') {
        return 'connecting';
    }
    if (query.status === 'offline') {
        return 'offline';
    }
    if (query.status === 'stale') {
        return 'stale';
    }
    if (collection === 'absent') {
        return 'partial';
    }
    if (validation && !validation.ok) {
        return 'schema-error';
    }
    if (query.status === 'partial') {
        return 'partial';
    }
    if (validation?.sourceCount === 0) {
        return 'empty';
    }
    return 'live';
}

function selectReport(
    state: RecipeConsoleUrlState,
    reports: readonly ControlFleetRunReport[],
    reportsById: ReadonlyMap<string, ControlFleetRunReport>,
    issues: FleetWorkspaceSelectionIssue[],
    authoritative: boolean,
): ControlFleetRunReport | undefined {
    if (!state.distributedRunId) {
        if (state.controlRunId) {
            const matches = reports.filter(
                report => report.controlRunId === state.controlRunId,
            );
            if (matches.length === 1) return matches[0];
            if (authoritative) {
                issues.push({
                    field: 'controlRunId',
                    code: matches.length === 0 ? 'unavailable' : 'ambiguous',
                    value: state.controlRunId,
                    message: matches.length === 0
                        ? 'The requested control run is not present in the accepted Fleet reports.'
                        : `The requested control run matches ${matches.length} accepted Fleet reports; select an exact distributed run.`,
                });
            }
            return undefined;
        }
        return reports[0];
    }
    const report = reportsById.get(state.distributedRunId);
    if (!report) {
        if (authoritative) {
            issues.push({
                field: 'distributedRunId',
                code: 'unavailable',
                value: state.distributedRunId,
                message:
                    'The requested Fleet report is not present in the accepted reports.',
            });
        }
        return undefined;
    }
    if (state.controlRunId && report.controlRunId !== state.controlRunId) {
        if (authoritative) {
            issues.push({
                field: 'controlRunId',
                code: 'incompatible',
                value: state.controlRunId,
                message:
                    'The requested Fleet report belongs to another control run.',
            });
        }
        return undefined;
    }
    return report;
}
