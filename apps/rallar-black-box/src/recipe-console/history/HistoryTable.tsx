import React from 'react';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { ExplicitWindowControls } from '../ui/ExplicitWindowControls.tsx';
import { ExactIdentifier } from './ExactIdentifier.tsx';
import type {
    RecipeConsoleHistoryCollection,
    RecipeConsoleHistoryModel,
    RecipeConsoleHistoryRow
} from './history-model.ts';
import { historyUtcDisplay, historyUtcIso } from './history-utc.ts';
import styles from './HistoryTable.module.css';
import { HistoryWindowTruth } from './HistoryWindowTruth.tsx';
import type { HistoryWindowController } from './use-history-window.ts';

export type HistoryTableProps = Readonly<{
    collectionWork?: RecipeConsoleHistoryCollection['work'];
    model: RecipeConsoleHistoryModel;
    onBaseline(patch: Partial<RecipeConsoleUrlState>): void;
    onCandidate(patch: Partial<RecipeConsoleUrlState>): void;
    window?: HistoryWindowController;
}>;

export function HistoryTable({
    collectionWork,
    model,
    onBaseline,
    onCandidate,
    window
}: HistoryTableProps) {
    return (
        <section
            aria-labelledby="history-ledger-title"
            className={styles.ledger}
            data-history-action-projections={model.work?.actionProjections ?? 0}
            data-history-catalog-run-projections={model.work?.catalogRunProjections ?? 0}
            data-history-control-agent-visits={model.work?.controlAgentVisits ?? 0}
            data-history-control-run-visits={collectionWork?.controlRunVisits ?? 0}
            data-history-distributed-run-visits={collectionWork?.distributedRunVisits ?? 0}
            data-history-label-projections={model.work?.labelProjections ?? 0}
            data-history-projected-rows={model.work?.projectedRows ?? 0}
        >
            <header className={styles.heading}>
                <div>
                    <p className={styles.eyebrow}>Signal ledger</p>
                    <h3 id="history-ledger-title">Run history</h3>
                </div>
                <p aria-atomic="true" aria-live="polite" className={styles.counts}>
                    {model.counts.total} filtered · {model.counts.rendered} rendered · {model.counts.omitted} omitted
                </p>
            </header>

            {window && window.model.total > window.model.windowSize
                ? (
                    <div
                        className={styles.windowControls}
                        data-history-window-controls
                        {...window.controlsFocusProps}
                    >
                        <ExplicitWindowControls
                            contentId="history-ledger-table"
                            itemLabel="runs"
                            label="History runs"
                            model={window.model}
                            onNext={window.next}
                            onPrevious={window.previous}
                        />
                    </div>
                )
                : null}
            {window ? <HistoryWindowTruth window={window} /> : null}

            <div
                aria-label="Recipe run history"
                className={styles.scrollRegion}
                role="region"
                tabIndex={0}
                {...window?.contentFocusProps}
            >
                <table className={styles.table} id="history-ledger-table">
                    <caption className={styles.visuallyHidden}>
                        Recipe run history evidence and comparison actions
                    </caption>
                    <thead>
                        <tr>
                            <th scope="col">Run identities</th>
                            <th scope="col">State</th>
                            <th scope="col">UTC timeline</th>
                            <th scope="col">Group</th>
                            <th scope="col">Recipe / profile</th>
                            <th scope="col">Failures</th>
                            <th scope="col">Control evidence</th>
                            <th scope="col">Compare</th>
                        </tr>
                    </thead>
                    <tbody>
                        {model.rows.map((row) => (
                            <HistoryTableRow
                                key={row.key}
                                row={row}
                                onBaseline={onBaseline}
                                onCandidate={onCandidate}
                            />
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

function HistoryTableRow({
    row,
    onBaseline,
    onCandidate
}: Readonly<{
    row: RecipeConsoleHistoryRow;
    onBaseline(patch: Partial<RecipeConsoleUrlState>): void;
    onCandidate(patch: Partial<RecipeConsoleUrlState>): void;
}>) {
    return (
        <tr data-history-row-key={row.key} data-quarantined={row.quarantined}>
            <td className={styles.identities}>
                {row.labels.displayName ? <strong>{row.labels.displayName}</strong> : null}
                <span>
                    <small>Distributed</small>
                    <ExactIdentifier value={row.distributedRunId} />
                </span>
                <span>
                    <small>Control</small>
                    <ExactIdentifier value={row.controlRunId} />
                </span>
            </td>
            <td>
                <span className={styles.state} data-state={row.state}>{row.state}</span>
            </td>
            <td className={styles.timeline}>
                <span>
                    <small>Created</small>
                    <time dateTime={historyUtcIso(row.createdAtEpochMs)}>
                        {historyUtcDisplay(row.createdAtEpochMs)}
                    </time>
                </span>
                <span>
                    <small>Updated</small>
                    <time dateTime={historyUtcIso(row.updatedAtEpochMs)}>
                        {historyUtcDisplay(row.updatedAtEpochMs)}
                    </time>
                </span>
            </td>
            <td className={styles.wrappable}>{row.labels.group.label}</td>
            <td className={styles.itemList}>
                {row.labels.recipes.length === 0
                    ? <span className={styles.muted}>No recipe label</span>
                    : row.labels.recipes.map((recipe, index) => <span key={index}>{recipe.label}</span>)}
            </td>
            <td className={styles.itemList}>
                {row.labels.failures.length === 0
                    ? <span className={styles.muted}>No recorded failures</span>
                    : row.labels.failures.map((failure, index) => (
                        <span className={styles.failure} key={index}>{failure.label}</span>
                    ))}
            </td>
            <td className={styles.controlEvidence}>
                <ControlEvidence row={row} />
                {row.quarantineCodes.map((code, index) => (
                    <code className={styles.quarantineCode} key={index}>{code}</code>
                ))}
                {row.issues.map((issue, index) => <span className={styles.issue} key={index}>{issue}</span>)}
            </td>
            <td>
                {row.actions.eligible
                    ? (
                        <div className={styles.actions}>
                            <button
                                aria-label={`Set ${row.distributedRunId} as comparison baseline`}
                                onClick={() => onBaseline(row.actions.baselinePatch)}
                                type="button"
                            >
                                Baseline
                            </button>
                            <button
                                aria-label={`Set ${row.distributedRunId} as comparison candidate`}
                                onClick={() => onCandidate(row.actions.candidatePatch)}
                                type="button"
                            >
                                Candidate
                            </button>
                        </div>
                    )
                    : <span className={styles.blocked}>{actionBlockedReason(row)}</span>}
            </td>
        </tr>
    );
}

function ControlEvidence({ row }: Readonly<{ row: RecipeConsoleHistoryRow; }>) {
    if (row.controlStatus === 'missing') {
        return (
            <>
                <strong>Missing control pair</strong>
                <span>{row.connectedAgentCount} of {row.agentCount} agents connected</span>
            </>
        );
    }
    if (row.controlStatus === 'ambiguous') {
        return (
            <>
                <strong>Ambiguous control pair</strong>
                <span>{row.connectedAgentCount} of {row.agentCount} agents connected</span>
            </>
        );
    }
    return (
        <>
            <strong>Paired control</strong>
            <span>{row.connectedAgentCount} of {row.agentCount} agents connected</span>
        </>
    );
}

function actionBlockedReason(row: RecipeConsoleHistoryRow): string {
    if (row.actions.reason === 'missing-control') {
        return 'Navigation unavailable: missing control pair.';
    }
    if (row.actions.reason === 'ambiguous-control') {
        return 'Navigation unavailable: ambiguous control pair.';
    }
    return 'Navigation unavailable: quarantined evidence.';
}
