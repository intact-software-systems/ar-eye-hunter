import type { ControlFleetRunReport } from '@shared-test/rallar-bb-test/fleet-report.ts';
import { useMemo } from 'react';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import type { SearchableListboxOption } from '../ui/searchable-listbox-model.ts';
import { SearchableWindowedListbox } from '../ui/SearchableWindowedListbox.tsx';
import { fleetUtcTime } from './fleet-time-presentation.ts';
import styles from './FleetSourceBar.module.css';
import { FleetWindowControls } from './FleetWindowControls.tsx';
import type { FleetWindowController } from './use-fleet-window.ts';

export function FleetSourceBar({
    collection = 'present',
    contextKey,
    onSelectReport,
    reports,
    recipeWindow,
    requestedReportId,
    revision,
    selectionIssue,
    selectionIssueValue,
    selectedReportId,
    snapshotReceivedAtEpochMs
}: Readonly<{
    collection?: 'absent' | 'present';
    contextKey: string;
    onSelectReport(report: ControlFleetRunReport): void;
    reports: readonly ControlFleetRunReport[];
    recipeWindow?: FleetWindowController;
    requestedReportId?: string;
    revision?: object;
    selectionIssue?: string;
    selectionIssueValue?: string;
    selectedReportId?: string;
    snapshotReceivedAtEpochMs?: number;
}>) {
    const { options, reportsById } = useMemo(() => ({
        options: reports.map(reportOption),
        reportsById: new Map(reports.map((report) => [
            report.distributedRunId,
            report
        ]))
    }), [reports]);
    const selectedReport = selectedReportId
        ? reportsById.get(selectedReportId)
        : undefined;
    const issueId = selectionIssue ? 'fleet-report-selection-issue' : undefined;
    const visibleRecipes = selectedReport?.recipeIds.slice(
        recipeWindow?.model.startIndex ?? 0,
        recipeWindow?.model.endIndexExclusive ?? 24
    ) ?? [];
    return (
        <section aria-label="Fleet evidence source" className={styles.root}>
            <div className={styles.truth}>
                <span>Root control snapshot</span>
                <strong>
                    {collection === 'absent'
                        ? 'Report collection unavailable'
                        : `${reports.length.toLocaleString('en-US')} accepted reports`}
                </strong>
                <small>Snapshot received {fleetUtcTime(snapshotReceivedAtEpochMs)}</small>
            </div>
            <SearchableWindowedListbox
                contextKey={contextKey}
                id="fleet-report-picker"
                label="Historical report"
                layout="inline"
                onSelect={(option) => {
                    const report = reportsById.get(option.key);
                    if (report) {
                        onSelectReport(report);
                    }
                }}
                options={options}
                placeholder="Newest accepted report"
                revision={revision}
                selectedKey={selectedReportId}
                describedBy={issueId}
                invalid={selectionIssue !== undefined}
            />
            {selectionIssue
                ? (
                    <p
                        className={styles.selectionIssue}
                        data-fleet-report-selection-issue
                        id={issueId}
                        role="alert"
                    >
                        {selectionIssue}
                        {requestedReportId
                            ? (
                                <>
                                    Requested report <ExactIdentifier value={requestedReportId} />.
                                </>
                            )
                            : null}
                        {selectionIssueValue &&
                                selectionIssueValue !== requestedReportId
                            ? (
                                <>
                                    {' '}Conflicting selection <ExactIdentifier value={selectionIssueValue} />.
                                </>
                            )
                            : null}
                    </p>
                )
                : null}
            {selectedReport
                ? (
                    <div className={styles.selectedContext}>
                        <span>Selected group</span>
                        <ExactIdentifier value={selectedReport.group.groupId} />
                        <div className={styles.recipeWindow}>
                            <span>
                                {selectedReport.recipeIds.length === 1
                                    ? 'Recipe'
                                    : 'Recipes'}
                            </span>
                            {recipeWindow
                                ? (
                                    <FleetWindowControls
                                        contentId="fleet-source-report-recipes"
                                        itemLabel="recipes"
                                        label="Selected Fleet report recipes"
                                        window={recipeWindow}
                                    />
                                )
                                : null}
                            {selectedReport.recipeIds.length > 0
                                ? (
                                    <div
                                        className={styles.recipes}
                                        id="fleet-source-report-recipes"
                                        {...recipeWindow?.contentFocusProps}
                                    >
                                        {visibleRecipes.map((recipeId) => (
                                            <span data-fleet-source-recipe={recipeId} key={recipeId}>
                                                <ExactIdentifier value={recipeId} />
                                            </span>
                                        ))}
                                    </div>
                                )
                                : <strong>No recipes</strong>}
                            {!recipeWindow &&
                                    selectedReport.recipeIds.length > visibleRecipes.length
                                ? (
                                    <small>
                                        {selectedReport.recipeIds.length - visibleRecipes.length}{' '}
                                        additional recipes omitted from this bounded detail.
                                    </small>
                                )
                                : null}
                        </div>
                    </div>
                )
                : null}
        </section>
    );
}

function reportOption(report: ControlFleetRunReport): SearchableListboxOption {
    return {
        key: report.distributedRunId,
        value: report.distributedRunId,
        label: `${report.state} · report generated ${fleetUtcTime(report.generatedAtEpochMs)}`,
        exactIdentifier: report.distributedRunId,
        detail: `${report.recipeIds.length.toLocaleString('en-US')} recipes · ${
            report.summary.agents.toLocaleString('en-US')
        } agents`,
        searchText: [
            report.distributedRunId,
            report.controlRunId,
            report.state,
            report.group.groupId,
            ...report.recipeIds
        ].join('\u0000')
    };
}
