import type { RecipeConsoleControlFleetCapability } from '../control/control-api.ts';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import styles from './FleetArtifactEvidence.module.css';
import { useFleetArtifact } from './use-fleet-artifact.ts';

export function FleetArtifactEvidence({
    capability,
    selectedReportId
}: Readonly<{
    capability?: RecipeConsoleControlFleetCapability;
    selectedReportId?: string;
}>) {
    const artifact = useFleetArtifact({ capability, selectedReportId });
    return (
        <section aria-labelledby="fleet-artifact-heading" className={styles.root}>
            <header>
                <div>
                    <span>Explicit bounded retrieval</span>
                    <h2 id="fleet-artifact-heading">Selected report artifact</h2>
                </div>
                <button
                    aria-busy={artifact.status === 'loading'}
                    disabled={!capability || !selectedReportId || artifact.status === 'loading'}
                    onClick={() => void artifact.load()}
                    type="button"
                >
                    {artifact.status === 'loading' ? 'Loading…' : 'Load artifact bundle'}
                </button>
            </header>
            {selectedReportId
                ? (
                    <p className={styles.selection}>
                        Exact report <ExactIdentifier value={selectedReportId} />
                    </p>
                )
                : <p className={styles.empty}>Select an accepted report to load its bundle.</p>}
            {artifact.message ? <p className={styles.error} role="alert">{artifact.message}</p> : null}
            {artifact.model
                ? (
                    <div className={styles.ready}>
                        <ul>
                            {artifact.model.files.map((file) => (
                                <li key={file.name}>
                                    <code>{file.name}</code>
                                    <span>{file.utf8Bytes.toLocaleString('en-US')} UTF-8 bytes</span>
                                </li>
                            ))}
                        </ul>
                        <div>
                            <strong>{artifact.model.totalUtf8Bytes.toLocaleString('en-US')} total UTF-8 bytes</strong>
                            <button onClick={artifact.exportEnvelope} type="button">
                                Export validated envelope
                            </button>
                        </div>
                    </div>
                )
                : null}
        </section>
    );
}
