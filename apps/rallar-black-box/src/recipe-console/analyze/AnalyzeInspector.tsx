import type { DistributedArtifactEvidenceEntry } from '@shared-test/rallar-bb-test/mod.ts';
import type { AnalyzeArtifactModel } from './analyze-artifact-model.ts';
import styles from './AnalyzeInspector.module.css';

export function AnalyzeInspector({
    entry,
    model,
}: Readonly<{
    entry: DistributedArtifactEvidenceEntry;
    model: AnalyzeArtifactModel;
}>) {
    const selectors: readonly (readonly [string, string | undefined])[] = [
        ['Source file', entry.sourceFile],
        ['Agent', entry.agentIds?.join(', ') ?? entry.agentId],
        ['Recipe', entry.recipeId],
        ['Command', entry.commandId],
        ['Topic', entry.topic],
        ['Diagnostic type', entry.diagnosticType],
        ['Severity', entry.severity],
        ['Transport', entry.transport],
        ['Status', entry.status],
        ['Category', entry.category],
        ['Time', entry.atEpochMs === undefined
            ? undefined
            : new Date(entry.atEpochMs).toISOString()],
    ];
    return (
        <section
            className={styles.inspector}
            data-analyze-inspector
            data-selection-kind={entry.kind}
        >
            <header>
                <p>{entry.kind} evidence</p>
                <h2>{entry.summary}</h2>
                <code>{entry.id}</code>
            </header>
            <dl>
                {selectors.filter((row): row is readonly [string, string] =>
                    row[1] !== undefined && row[1].length > 0
                ).map(([label, value]) => (
                    <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                    </div>
                ))}
            </dl>
            {entry.payloadSummary ? (
                <div className={styles.payload}>
                    <h3>Payload summary</h3>
                    <pre>{entry.payloadSummary}</pre>
                </div>
            ) : null}
            <footer>
                <span>{model.workspace.source === 'bundle-envelope' ? 'Imported envelope' : 'Artifact files'}</span>
                <span>{model.workspace.support}</span>
            </footer>
        </section>
    );
}
