import { deriveDistributedRunFailureEvidenceDestinations } from
    '../../distributed-recipes.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { MonitorDiagnosticHandoffs } from './MonitorDiagnosticHandoffs.tsx';
import { MonitorFailureDestinationsWindow } from './MonitorInspectorWindow.tsx';
import type { MonitorEvidenceSelection } from './monitor-selection.ts';
import type { MonitorWorkspaceModel } from './monitor-workspace-model.ts';
import styles from './MonitorInspector.module.css';

export type MonitorFailureEvidenceProps = Readonly<{
    failureKey: string;
    model: MonitorWorkspaceModel;
    onSelectEvidence(
        selection: MonitorEvidenceSelection,
        patch?: Partial<RecipeConsoleUrlState>,
    ): void;
    sourceSearch: string;
    urlState: RecipeConsoleUrlState;
}>;

export function MonitorFailureEvidence({
    failureKey,
    model,
    onSelectEvidence,
    sourceSearch,
    urlState,
}: MonitorFailureEvidenceProps) {
    const failure = model.monitor.failures.find(row => row.key === failureKey);
    if (!failure) {
        return (
            <p className={styles.empty}>
                The selected failure <code>{failureKey}</code> is not in this snapshot.
            </p>
        );
    }
    const explanation = model.report.nextActions.find(action =>
        action.evidence.includes(failure.key)
    );
    const destinations = deriveDistributedRunFailureEvidenceDestinations({
        failure,
        monitor: model.monitor,
    });

    return (
        <>
            <section className={styles.callout} data-minimal-fix>
                <h3>{explanation?.title ?? 'Selected distributed failure'}</h3>
                <p>{failure.message}</p>
                <dl className={styles.facts}>
                    {[
                        ['Agent', failure.agentId ?? 'Run scope'],
                        ['Recipe', failure.recipeId ?? 'Run rollup'],
                        ['Command', failure.commandId ?? 'No command link'],
                        ['Code', failure.code ?? 'No error code'],
                        ['Observed', formatEpoch(failure.atEpochMs)],
                    ].map(([label, value]) => (
                        <div key={label}>
                            <dt>{label}</dt>
                            <dd>{value}</dd>
                        </div>
                    ))}
                </dl>
            </section>
            <section className={styles.section}>
                <h3>Likely cause</h3>
                <p>{explanation?.likelyCause ?? failure.message}</p>
            </section>
            <section className={styles.section}>
                <h3>Next action</h3>
                <p>{explanation?.nextAction ?? fallbackFailureAction(failure)}</p>
            </section>
            <MonitorDiagnosticHandoffs
                controlRunId={model.source.controlRun.runId}
                diagnostics={model.monitor.runtimeDiagnostics}
                distributedRunId={model.source.distributedRun.distributedRunId}
                failure={failure}
                group={model.source.distributedRun.manifest.group}
                sourceSearch={sourceSearch}
                state={urlState}
            />
            <section className={styles.section}>
                <h3>Correlated destinations <span>{destinations.length}</span></h3>
                {destinations.length > 0 ? (
                    <MonitorFailureDestinationsWindow
                        contentClassName={styles.destinations}
                        contextKey={model.source.contextKey}
                        destinations={destinations}
                        onSelect={onSelectEvidence}
                        scopeId={failureKey}
                    />
                ) : (
                    <p className={styles.empty}>
                        No directly correlated destination is available.
                    </p>
                )}
            </section>
        </>
    );
}

function fallbackFailureAction(
    failure: MonitorWorkspaceModel['monitor']['failures'][number],
): string {
    const scope = failure.commandId ?? failure.recipeId ??
        failure.agentId ?? failure.key;
    return `Inspect the correlated destinations for ${scope}, then compare the failing evidence with sibling agents.`;
}

function formatEpoch(epochMs?: number): string {
    return epochMs === undefined
        ? 'Not recorded'
        : new Date(epochMs).toLocaleString();
}
