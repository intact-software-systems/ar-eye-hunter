import type { DistributedArtifactEvidenceEntry } from '@shared-test/rallar-bb-test/mod.ts';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import type { AnalyzeArtifactProjection } from './analyze-worker-contract.ts';
import { AnalyzeFailureDetails } from './AnalyzeFailureDetails.tsx';
import styles from './AnalyzeInspector.module.css';

export function AnalyzeInspector({
    entry,
    model,
}: Readonly<{
    entry: DistributedArtifactEvidenceEntry;
    model: AnalyzeArtifactProjection;
}>) {
    const exactSelectors: readonly (readonly [string, readonly string[]])[] = [
        ['Agent', entry.agentIds?.length
            ? entry.agentIds
            : entry.agentId ? [entry.agentId] : []],
        ['Recipe', entry.recipeId ? [entry.recipeId] : []],
        ['Command', entry.commandId ? [entry.commandId] : []],
    ];
    const selectors: readonly (readonly [string, string | undefined])[] = [
        ['Source file', entry.sourceFile],
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
                <ExactIdentifier value={entry.id} />
            </header>
            {entry.kind === 'result' && entry.failureDetails ? (
                <AnalyzeFailureDetails
                    density="inspector"
                    details={entry.failureDetails}
                />
            ) : null}
            <dl>
                {exactSelectors.filter(([, values]) => values.length > 0)
                    .map(([label, values]) => (
                        <div key={label}>
                            <dt>{label}</dt>
                            <dd className={styles.exactIdentifiers}>
                                {values.map(value => (
                                    <ExactIdentifier key={value} value={value} />
                                ))}
                            </dd>
                        </div>
                    ))}
                {selectors.filter((row): row is readonly [string, string] =>
                    row[1] !== undefined && row[1].length > 0
                ).map(([label, value]) => (
                    <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                    </div>
                ))}
            </dl>
            {entry.payloadSummary && entry.kind === 'result' && entry.failureDetails ? (
                <details className={styles.rawPayload}>
                    <summary>Raw payload JSON</summary>
                    <pre>{entry.payloadSummary}</pre>
                </details>
            ) : entry.payloadSummary ? (
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
