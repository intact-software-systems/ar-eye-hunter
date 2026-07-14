import type { FleetReportAgentDetail } from
    '@shared-test/rallar-bb-test/fleet-report-analysis.ts';
import type {
    ControlFleetRegionSummary,
    ControlFleetRunReport,
} from '@shared-test/rallar-bb-test/fleet-report.ts';
import type { ControlAgentBoardRow } from '../../control-agent-board.ts';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import { FleetArtifactReferences } from './FleetArtifactReferences.tsx';
import { FleetWindowControls } from './FleetWindowControls.tsx';
import { fleetRegionProviderKey } from './fleet-region-key.ts';
import { fleetUtcTime } from './fleet-time-presentation.ts';
import type { FleetWorkspaceSelectionIssue } from './fleet-workspace-model.ts';
import type { FleetWindowController } from './use-fleet-window.ts';
import styles from './FleetEvidenceDetail.module.css';

export function FleetEvidenceDetail({
    agentRunWindow,
    onOpenAnalyze,
    onOpenMonitor,
    regionProviderWindow,
    selectedAgent,
    selectedLiveAgent,
    selectedRegionRows,
    selectedReport,
    selectionIssues,
}: Readonly<{
    agentRunWindow?: FleetWindowController;
    onOpenAnalyze(report: ControlFleetRunReport, agentId?: string): void;
    onOpenMonitor(report: ControlFleetRunReport, agentId?: string): void;
    regionProviderWindow?: FleetWindowController;
    selectedAgent?: FleetReportAgentDetail;
    selectedLiveAgent?: ControlAgentBoardRow;
    selectedRegionRows: readonly ControlFleetRegionSummary[];
    selectedReport?: ControlFleetRunReport;
    selectionIssues: readonly FleetWorkspaceSelectionIssue[];
}>) {
    const agentId = selectedAgent?.agent.agentId ?? selectedLiveAgent?.agentId;
    const reportAgentId = selectedReport && agentId &&
            selectedReport.agents.some(agent => agent.agentId === agentId)
        ? agentId
        : undefined;
    const visibleRegionRows = selectedRegionRows.slice(
        regionProviderWindow?.model.startIndex ?? 0,
        regionProviderWindow?.model.endIndexExclusive ?? 24,
    );
    const visibleRecipes = selectedReport?.recipeIds.slice(0, 24) ?? [];
    return (
        <section aria-labelledby="fleet-detail-heading" className={styles.root}>
            <header>
                <span>Exact selected evidence</span>
                <h2 id="fleet-detail-heading">Fleet evidence detail</h2>
            </header>
            {selectionIssues.map(issue => (
                <p className={styles.issue} key={`${issue.field}\u0000${issue.value}`} role="alert">
                    {issue.message} Exact selection <ExactIdentifier value={issue.value} />.
                </p>
            ))}
            {selectedReport ? (
                <div className={styles.section}>
                    <h3>Report</h3>
                    <dl>
                        <Detail label="Distributed run" value={selectedReport.distributedRunId} />
                        <Detail label="Control run" value={selectedReport.controlRunId} />
                        <TextDetail label="State" value={selectedReport.state} />
                        <TextDetail
                            label="Report generated"
                            value={fleetUtcTime(selectedReport.generatedAtEpochMs)}
                        />
                        <Detail label="Group" value={selectedReport.group.groupId} />
                    </dl>
                    <div className={styles.recipeDetail}>
                        <h4>Recipes</h4>
                        <div
                            className={styles.identifiers}
                            id="fleet-detail-report-recipes"
                        >{visibleRecipes.length > 0
                                ? visibleRecipes.map(recipeId => (
                                    <span data-fleet-detail-recipe={recipeId} key={recipeId}>
                                        <ExactIdentifier value={recipeId} />
                                    </span>
                                ))
                                : 'None'}</div>
                        {selectedReport.recipeIds.length > visibleRecipes.length ? (
                            <p>{selectedReport.recipeIds.length - visibleRecipes.length}{' '}
                                additional recipes omitted from this bounded detail.</p>
                        ) : null}
                    </div>
                    <FleetArtifactReferences
                        key={selectedReport.distributedRunId}
                        references={selectedReport.artifactRefs}
                    />
                    <div className={styles.actions}>
                        <button
                            onClick={() => onOpenMonitor(selectedReport, reportAgentId)}
                            type="button"
                        >Open Monitor</button>
                        <button
                            onClick={() => onOpenAnalyze(selectedReport, reportAgentId)}
                            type="button"
                        >Open Analyze</button>
                    </div>
                </div>
            ) : <p className={styles.empty}>No exact report is selected.</p>}
            {agentId ? (
                <div className={styles.section}>
                    <h3>Agent</h3>
                    <ExactIdentifier value={agentId} />
                    <p>{selectedLiveAgent === undefined
                        ? 'No current live agent evidence'
                        : selectedLiveAgent.connected
                        ? 'Connected live'
                        : 'Not connected live'} ·{' '}
                        {selectedAgent
                            ? `Showing ${selectedAgent.runs.length} of ${selectedAgent.totalRuns} historical runs`
                            : 'No accepted historical outcomes'}</p>
                    {selectedAgent ? (
                        <>
                            {agentRunWindow ? (
                                <FleetWindowControls
                                    contentId="fleet-selected-agent-runs"
                                    itemLabel="historical runs"
                                    label="Selected Fleet agent runs"
                                    window={agentRunWindow}
                                />
                            ) : null}
                            <ol
                                className={styles.runs}
                                id="fleet-selected-agent-runs"
                                {...agentRunWindow?.contentFocusProps}
                            >{selectedAgent.runs.map(entry => (
                                <li
                                    data-fleet-agent-run={entry.run.distributedRunId}
                                    key={entry.run.distributedRunId}
                                >
                                    <ExactIdentifier value={entry.run.distributedRunId} />
                                    <span>{entry.outcome.state} ·{' '}
                                        {entry.outcome.durationMs === undefined
                                            ? 'duration unavailable'
                                            : `${entry.outcome.durationMs.toLocaleString('en-US')} ms`}</span>
                                </li>
                            ))}</ol>
                        </>
                    ) : null}
                    {selectedAgent ? (
                        <dl className={styles.metrics}>
                            <TextDetail label="Passed" value={String(selectedAgent.passed)} />
                            <TextDetail label="Failed" value={String(selectedAgent.failed)} />
                            <TextDetail label="Missing" value={String(selectedAgent.missing)} />
                            <TextDetail label="Diagnostics" value={String(selectedAgent.diagnosticCount)} />
                        </dl>
                    ) : null}
                </div>
            ) : null}
            {selectedRegionRows.length > 0 ? (
                <div className={styles.section}>
                    <h3>Selected region</h3>
                    {regionProviderWindow ? (
                        <FleetWindowControls
                            contentId="fleet-selected-region-providers"
                            itemLabel="provider rows"
                            label="Selected Fleet region providers"
                            window={regionProviderWindow}
                        />
                    ) : null}
                    <div
                        id="fleet-selected-region-providers"
                        {...regionProviderWindow?.contentFocusProps}
                    >
                    {visibleRegionRows.map(region => (
                        <p
                            data-fleet-region-provider={region.provider ?? ''}
                            key={fleetRegionProviderKey(
                                region.region,
                                region.provider,
                            )}
                        >
                            <ExactIdentifier value={region.region} /> /{' '}
                            {region.provider
                                ? <ExactIdentifier value={region.provider} />
                                : 'Unknown'} ·{' '}
                            {(region.passRate * 100).toLocaleString('en-US', {
                                maximumFractionDigits: 1,
                            })}% pass
                        </p>
                    ))}
                    </div>
                    {!regionProviderWindow &&
                            selectedRegionRows.length > visibleRegionRows.length ? (
                        <p>{selectedRegionRows.length - visibleRegionRows.length}{' '}
                            additional provider rows omitted from this bounded detail.</p>
                    ) : null}
                </div>
            ) : null}
        </section>
    );
}

function Detail({ label, value }: Readonly<{ label: string; value: string }>) {
    return <div><dt>{label}</dt><dd><ExactIdentifier value={value} /></dd></div>;
}

function TextDetail({ label, value }: Readonly<{ label: string; value: string }>) {
    return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
