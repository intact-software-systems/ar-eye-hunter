import type { AnalyzeArtifactProjection } from './analyze-worker-contract.ts';
import { AnalyzeFailureDetails } from './AnalyzeFailureDetails.tsx';
import styles from './AnalyzeVerdict.module.css';

export function AnalyzeVerdict({
    model,
    onInspect,
    onInspectResult,
}: Readonly<{
    model: AnalyzeArtifactProjection;
    onInspect?(trigger: HTMLButtonElement): void;
    onInspectResult?(trigger: HTMLButtonElement): void;
}>) {
    const { analysis } = model;
    const failure = analysis.failure;
    return (
        <section
            className={styles.verdict}
            data-analyze-section="verdict"
            data-artifact-support={model.workspace.support}
            data-run-state={analysis.status}
        >
            <header className={styles.heading}>
                <div>
                    <p className={styles.eyebrow}>
                        {failure ? 'First actionable failure' : 'Artifact verdict'}
                    </p>
                    <h2>{failure?.title ?? (analysis.ok ? 'Run passed' : 'Outcome needs attention')}</h2>
                    <p>{failure?.likelyCause ?? analysis.spa?.verdict.summary ??
                        `Run ${analysis.distributedRunId} is ${analysis.status}.`}</p>
                </div>
                <span data-tone={analysis.ok ? 'good' : failure ? 'bad' : 'warn'}>
                    {analysis.ok ? 'Passed' : analysis.status}
                </span>
            </header>

            {model.primaryResultFailure ? (
                <AnalyzeFailureDetails
                    density="verdict"
                    details={model.primaryResultFailure.failureDetails}
                    onInspect={onInspectResult}
                />
            ) : null}
            {failure ? (
                <>
                    <div className={styles.nextAction} data-first-actionable-failure>
                        <div>
                            <strong>Next action</strong>
                            <p>{failure.nextAction}</p>
                        </div>
                        {model.firstActionableEvidenceId && onInspect ? (
                            <button type="button" onClick={event => onInspect(event.currentTarget)}>
                                Inspect evidence
                            </button>
                        ) : null}
                    </div>
                    <dl className={styles.answers}>
                        <Answer label="Fix area" value={failure.minimalFixArea} />
                        <Answer label="Evidence" value={failure.evidenceFile} />
                        <Answer
                            label="Affected"
                            value={[
                                ...failure.affectedAgents,
                                ...failure.affectedRegions,
                            ].join(', ') || 'Run-wide'}
                        />
                        <Answer label="Command" value={failure.commandId ?? 'Not linked'} />
                        <Answer
                            label="Verify"
                            value={failure.verificationCommand.replaceAll('`', '')}
                            code
                        />
                    </dl>
                </>
            ) : (
                <dl className={styles.answers}>
                    <Answer label="Run" value={analysis.distributedRunId} />
                    <Answer label="Agents" value={String(analysis.summary.agents)} />
                    <Answer label="Pass rate" value={`${Math.round(analysis.summary.passRate * 100)}%`} />
                    <Answer label="Warnings" value={String(model.workspace.issues.length)} />
                </dl>
            )}
        </section>
    );
}

function Answer({
    label,
    value,
    code = false,
}: Readonly<{ label: string; value: string; code?: boolean }>) {
    return (
        <div>
            <dt>{label}</dt>
            <dd>{code ? <code>{value}</code> : value}</dd>
        </div>
    );
}
