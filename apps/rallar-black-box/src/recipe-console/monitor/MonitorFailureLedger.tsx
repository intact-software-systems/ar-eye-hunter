import type { DistributedRunFailureRow } from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import type { MonitorEvidenceSelection } from './monitor-selection.ts';
import styles from './MonitorLedger.module.css';

const FAILURE_LIMIT = 60;

export function MonitorFailureLedger({
    failures,
    selected,
    onInspect,
}: Readonly<{
    failures: readonly DistributedRunFailureRow[];
    selected?: MonitorEvidenceSelection;
    onInspect(
        selection: MonitorEvidenceSelection,
        patch: Partial<RecipeConsoleUrlState>,
        trigger: HTMLButtonElement,
    ): void;
}>) {
    const visible = failures.slice(0, FAILURE_LIMIT);
    return (
        <section className={styles.section} data-monitor-section="failures">
            <header>
                <div>
                    <p className={styles.eyebrow}>Failure-first evidence</p>
                    <h2>Failures ({failures.length})</h2>
                </div>
                {failures.length > FAILURE_LIMIT ? (
                    <span>{failures.length - FAILURE_LIMIT} omitted by view bound</span>
                ) : null}
            </header>
            {visible.length === 0 ? (
                <p className={styles.empty}>No failures are reported for this run.</p>
            ) : (
                <ul aria-label="Failure ledger" className={styles.ledger}>
                    {visible.map(failure => {
                        const active = selected?.kind === 'failure' && selected.id === failure.key;
                        return (
                            <li key={failure.key}>
                                <button
                                aria-pressed={active}
                                className={styles.row}
                                data-failure-key={failure.key}
                                data-selected={active}
                                onClick={event => onInspect(
                                    { kind: 'failure', id: failure.key },
                                    evidencePatch(failure),
                                    event.currentTarget,
                                )}
                                type="button"
                            >
                                <span className={styles.code}>{failure.code ?? failure.kind}</span>
                                <strong>{failure.message}</strong>
                                <code>{failure.agentId ?? failure.recipeId ?? failure.commandId ?? failure.key}</code>
                                <span className={styles.inspect}>Inspect</span>
                            </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}

function evidencePatch(failure: DistributedRunFailureRow): Partial<RecipeConsoleUrlState> {
    return {
        agentId: failure.agentId,
        recipeId: failure.recipeId,
        commandId: failure.commandId,
    };
}
