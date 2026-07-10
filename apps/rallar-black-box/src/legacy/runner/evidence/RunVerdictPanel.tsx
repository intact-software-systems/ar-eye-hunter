import type { RunVerdictView } from '../../../distributed-recipes.ts';
import { formatDuration, formatTime } from '../../shared/time-format.ts';

export function RunVerdictPanel({
    view,
}: {
    view: RunVerdictView;
}) {
    return (
        <section className={`run-verdict-band runner-evidence-first ${view.tone}`}>
            <div className="run-verdict-main">
                <div>
                    <span className="eyebrow">Run Verdict</span>
                    <h3>{view.title}</h3>
                    <p>{view.summary}</p>
                </div>
                <dl>
                    <div>
                        <dt>Run</dt>
                        <dd>{view.runId ?? '-'}</dd>
                    </div>
                    <div>
                        <dt>Recipe</dt>
                        <dd>{view.recipeLabel ?? '-'}</dd>
                    </div>
                    <div>
                        <dt>Targets</dt>
                        <dd>{view.targetCount ?? '-'}</dd>
                    </div>
                    <div>
                        <dt>Duration</dt>
                        <dd>{formatDuration(view.durationMs)}</dd>
                    </div>
                    <div>
                        <dt>Fresh</dt>
                        <dd>{formatTime(view.refreshedAtEpochMs)}</dd>
                    </div>
                </dl>
            </div>
            <div className="run-verdict-metrics">
                {view.primaryEvidence.map((entry) => (
                    <article
                        className={`run-verdict-metric ${entry.tone}`}
                        key={entry.label}
                    >
                        <span>{entry.label}</span>
                        <strong>{entry.value}</strong>
                        {entry.detail && <small>{entry.detail}</small>}
                    </article>
                ))}
            </div>
            {(view.successSignals.length > 0 ||
                view.warningSignals.length > 0 ||
                view.likelyCause ||
                view.nextAction) && (
                <div className="run-verdict-evidence">
                    {view.successSignals.length > 0 && (
                        <div>
                            <strong>Why this passed</strong>
                            <ul>
                                {view.successSignals.slice(0, 4).map((signal) => (
                                    <li key={signal}>{signal}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {(view.likelyCause || view.nextAction) && (
                        <div>
                            <strong>What to do next</strong>
                            {view.likelyCause && <p>{view.likelyCause}</p>}
                            {view.nextAction && <small>{view.nextAction}</small>}
                        </div>
                    )}
                    {view.warningSignals.length > 0 && (
                        <div>
                            <strong>Evidence warnings</strong>
                            <ul>
                                {view.warningSignals.slice(0, 4).map((warning) => (
                                    <li key={warning}>{warning}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}
        </section>
    );
}
