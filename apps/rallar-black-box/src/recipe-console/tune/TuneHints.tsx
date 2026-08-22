import type { DistributedRunTuningHintKind } from '@shared-test/rallar-bb-test/distributed-run-tuning-decisions.ts';
import type { TuneInspection } from './tune-inspection.ts';
import type { TuneSourceModel } from './tune-source-model.ts';
import styles from './TuneEvidence.module.css';

export function TuneHints({
    source,
    onInspect
}: Readonly<{
    source: TuneSourceModel;
    onInspect(selection: TuneInspection, trigger: HTMLButtonElement): void;
}>) {
    const decisions = source.decisions;
    return (
        <section className={styles.decisions} data-tune-hints>
            <header className={styles.sectionHeader}>
                <div>
                    <p className={styles.eyebrow}>Decision first</p>
                    <h2>Tuning decisions</h2>
                </div>
                <span>{decisions?.state ?? 'unavailable'}</span>
            </header>
            {decisions && decisions.hints.length > 0
                ? (
                    <div className={styles.hintLedger}>
                        {decisions.hints.map((hint) => (
                            <article key={hint.id}>
                                <div>
                                    <strong>{hintKindLabel(hint.kind)}</strong>
                                    <h3>{hint.title}</h3>
                                    <p>{hint.rationale}</p>
                                    <p>{hint.nextAction}</p>
                                    <ul>
                                        {hint.evidence.map((value) => <li key={value}>{value}</li>)}
                                    </ul>
                                    {hint.knob
                                        ? <code>{hint.knob.pointer} · Current {hint.knob.currentValue ?? 'unset'}</code>
                                        : null}
                                </div>
                                <button
                                    onClick={(event) =>
                                        onInspect(
                                            { kind: 'hint', hintId: hint.id },
                                            event.currentTarget
                                        )}
                                    type="button"
                                >
                                    Inspect decision
                                </button>
                            </article>
                        ))}
                    </div>
                )
                : (
                    <p className={styles.empty}>
                        {decisions?.state === 'clean'
                            ? 'No tuning action is supported by the current evidence.'
                            : 'No evidence-backed tuning decision is available.'}
                    </p>
                )}
            {decisions && decisions.issues.length > 0
                ? (
                    <ul className={styles.issues}>
                        {decisions.issues.map((issue) => <li key={`${issue.code}:${issue.message}`}>{issue.message}
                        </li>)}
                    </ul>
                )
                : null}
        </section>
    );
}

function hintKindLabel(kind: DistributedRunTuningHintKind): string {
    const labels: Record<DistributedRunTuningHintKind, string> = {
        'fix-target-readiness': 'Fix target readiness',
        'raise-ack-timeout': 'Review ACK timeout',
        'raise-barrier-timeout': 'Review barrier timeout',
        'lower-cadence': 'Lower cadence',
        'adjust-stream-threshold': 'Review stream threshold',
        'investigate-agent': 'Investigate agent',
        'insufficient-evidence': 'Insufficient evidence'
    };
    return labels[kind];
}
