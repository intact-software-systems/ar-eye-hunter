import type { MonitorPreviewModel } from '../data/recipe-console-models.ts';
import styles from './MonitorPreview.module.css';

export type FailureInspectorProps = Readonly<{
    model: MonitorPreviewModel;
    failureKey: string;
}>;

export function FailureInspector({ model, failureKey }: FailureInspectorProps) {
    const failure = model.failureLedger.find(row => row.key === failureKey) ??
        model.selectedCommandFailure;
    const identity = failure.agentId ?? failure.recipeId ?? failure.key;
    return (
        <article className={styles.inspector}>
            <p className={styles.eyebrow}>Selected failure</p>
            <h2>Failure · {identity}</h2>
            <section>
                <h3>Likely cause</h3>
                <p>{model.verdict.likelyCause ?? failure.message}</p>
            </section>
            <section>
                <h3>Next action</h3>
                <p>{model.verdict.nextAction}</p>
            </section>
            <section>
                <h3>Minimal fix area</h3>
                <dl className={styles.fixArea} data-minimal-fix>
                    <dt>Agent</dt><dd>{failure.agentId ?? 'Run scope'}</dd>
                    <dt>Command</dt><dd>{failure.commandId ?? 'Recipe rollup'}</dd>
                    <dt>Recipe</dt><dd>{failure.recipeId ?? model.seed.distributedRun.manifest.recipes[0]?.recipeId}</dd>
                </dl>
            </section>
            <section>
                <h3>Correlated evidence</h3>
                <ol className={styles.evidenceList}>
                    {model.verdict.causalTrail.map(item => (
                        <li
                            data-causal-kind={item.kind}
                            key={`${item.kind}:${item.targetId ?? item.label}`}
                        >
                            <strong>{item.label}</strong>
                            <span>Evidence · {item.detail}</span>
                            <code>{item.evidence.join(' · ')}</code>
                        </li>
                    ))}
                </ol>
            </section>
            <a href="/?provider=simulated&experience=legacy&tab=rtc-diagnostics">
                Open legacy RTC diagnostic
            </a>
        </article>
    );
}
