import type { DistributedRunFailureRow } from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import { ExplicitWindowControls } from '../ui/ExplicitWindowControls.tsx';
import type { MonitorEvidenceSelection } from './monitor-selection.ts';
import styles from './MonitorLedger.module.css';
import { MonitorWindowTruth } from './MonitorWindowTruth.tsx';
import { useMonitorWindow } from './use-monitor-window.ts';

const CONTENT_ID = 'monitor-failure-ledger-window';

export function MonitorFailureLedger({
    contextKey,
    failures,
    selected,
    onInspect
}: Readonly<{
    contextKey: string;
    failures: readonly DistributedRunFailureRow[];
    selected?: MonitorEvidenceSelection;
    onInspect(
        selection: MonitorEvidenceSelection,
        patch: Partial<RecipeConsoleUrlState>,
        trigger: HTMLButtonElement
    ): void;
}>) {
    const window = useMonitorWindow({
        contextKey,
        section: 'failures',
        total: failures.length
    });
    const visible = failures.slice(
        window.model.startIndex,
        window.model.endIndexExclusive
    );
    return (
        <section className={styles.section} data-monitor-section="failures">
            <header>
                <div>
                    <p className={styles.eyebrow}>Failure-first evidence</p>
                    <h2>Failures ({failures.length})</h2>
                </div>
            </header>
            {window.model.total > window.model.windowSize
                ? (
                    <div data-monitor-window-controls {...window.controlsFocusProps}>
                        <ExplicitWindowControls
                            contentId={CONTENT_ID}
                            itemLabel="failures"
                            label="Failures"
                            model={window.model}
                            onNext={window.next}
                            onPrevious={window.previous}
                        />
                    </div>
                )
                : null}
            <MonitorWindowTruth
                itemLabel="failures"
                label="Failures"
                window={window}
            />
            {visible.length === 0 ? <p className={styles.empty}>No failures are reported for this run.</p> : (
                <ul
                    aria-label="Failure ledger"
                    className={styles.ledger}
                    id={CONTENT_ID}
                    {...window.contentFocusProps}
                >
                    {visible.map((failure, offset) => {
                        const active = selected?.kind === 'failure' && selected.id === failure.key;
                        const sourceOrdinal = window.model.startIndex + offset;
                        return (
                            <li data-monitor-source-ordinal={sourceOrdinal} key={sourceOrdinal}>
                                <button
                                    aria-pressed={active}
                                    className={styles.row}
                                    data-failure-key={failure.key}
                                    data-selected={active}
                                    onClick={(event) =>
                                        onInspect(
                                            { kind: 'failure', id: failure.key },
                                            evidencePatch(failure),
                                            event.currentTarget
                                        )}
                                    type="button"
                                >
                                    <span className={styles.code}>{failure.code ?? failure.kind}</span>
                                    <strong>{failure.message}</strong>
                                    <span className={styles.scope}>
                                        <ExactIdentifier
                                            value={failure.agentId ?? failure.recipeId ??
                                                failure.commandId ?? failure.key}
                                        />
                                    </span>
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
        commandId: failure.commandId
    };
}
