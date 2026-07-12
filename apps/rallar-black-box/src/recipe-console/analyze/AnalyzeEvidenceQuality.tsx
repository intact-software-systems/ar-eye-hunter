import type { AnalyzeArtifactModel } from './analyze-artifact-model.ts';
import { analyzeArtifactIdentityIssues } from './analyze-identity-policy.ts';
import styles from './AnalyzeEvidence.module.css';

export function AnalyzeEvidenceQuality({
    model,
}: Readonly<{ model: AnalyzeArtifactModel }>) {
    const trail = model.analysis.spa?.verdict.causalTrail.slice(0, 6) ?? [];
    const identityIssues = analyzeArtifactIdentityIssues(model.identity);
    const issueCount = model.workspace.issues.length +
        model.provenance.ignoredFiles.length + identityIssues.length;
    return (
        <section className={styles.panel} data-analyze-section="quality">
            <header className={styles.heading}>
                <div>
                    <p className={styles.eyebrow}>Evidence quality</p>
                    <h2>Likely causal trail &amp; file inventory</h2>
                </div>
                <span>{issueCount} issue{issueCount === 1 ? '' : 's'}</span>
            </header>

            {trail.length > 0 ? (
                <ol className={styles.trail} aria-label="Likely causal trail">
                    {trail.map((item, index) => (
                        <li key={`${item.kind}-${item.targetId ?? 'none'}-${index}`} data-tone={item.tone}>
                            <span>{index + 1}</span>
                            <div>
                                <strong>{item.label}</strong>
                                <p>{item.detail}</p>
                                {item.evidence.length > 0 ? (
                                    <small>Evidence: {item.evidence.join(', ')}</small>
                                ) : null}
                            </div>
                        </li>
                    ))}
                </ol>
            ) : (
                <p className={styles.empty}>No causal links were derivable from the loaded evidence.</p>
            )}

            <div className={styles.inventory} aria-label="Artifact file inventory">
                {model.workspace.inventory.map(item => (
                    <div key={`${item.fileName}-${item.requirement}`} data-file-status={item.status}>
                        <strong>{item.fileName}</strong>
                        <span>{fileStatusLabel(item.status)}</span>
                        {item.message ? <small>{item.message}</small> : null}
                    </div>
                ))}
                {model.provenance.ignoredFiles.map(file => (
                    <div key={file.sourcePath} data-file-status="ignored">
                        <strong>{file.basename}</strong>
                        <span>Ignored</span>
                        <small>{file.reason}</small>
                    </div>
                ))}
            </div>
            {model.workspace.issues.some(issue => issue.code === 'identity-conflict') ? (
                <p className={styles.identityWarning} role="alert">
                    Conflicting run identities were detected. Evidence remains inspectable, but must not be treated as one coherent run.
                </p>
            ) : null}
            {identityIssues.map(issue => (
                <p className={styles.identityWarning} key={issue} role="alert">
                    {issue}
                </p>
            ))}
        </section>
    );
}

function fileStatusLabel(status: string): string {
    return status.split('-').map(word =>
        `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`
    ).join(' ');
}
