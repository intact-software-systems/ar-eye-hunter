import { StatusMark } from '../ui/StatusMark.tsx';
import type { ExecuteManifestDraft } from './execute-manifest.ts';
import styles from './ExecuteManifestDisclosure.module.css';

export type ExecuteManifestDisclosureProps = Readonly<{
    draft?: ExecuteManifestDraft;
}>;

export function ExecuteManifestDisclosure({ draft }: ExecuteManifestDisclosureProps) {
    return (
        <details className={styles.disclosure} data-execute-manifest>
            <summary>
                <span>
                    <strong>Generated manifest</strong>
                    <small>Read-only control contract</small>
                </span>
                <StatusMark
                    label={draft ? draft.validation.ok ? 'Valid' : 'Blocked' : 'Unavailable'}
                    status={draft ? draft.validation.ok ? 'passed' : 'failed' : 'disabled'}
                />
            </summary>
            {draft ? (
                <div className={styles.body}>
                    <dl className={styles.facts}>
                        <Fact label="Distributed run" value={draft.manifest.distributedRunId} />
                        <Fact label="Control run" value={draft.manifest.controlRunId ?? 'Unavailable'} />
                        <Fact
                            label="Group"
                            value={[draft.manifest.group.applicationId, draft.manifest.group.workspaceId, draft.manifest.group.groupId].join(' / ')}
                        />
                        <Fact
                            label="Targets"
                            value={`${draft.manifest.targetPolicy.agentIds?.length ?? 0} selected · exact count ${draft.manifest.targetPolicy.expectedParticipantCount ?? 'unset'}`}
                        />
                        <Fact label="Start" value={`${draft.manifest.startMode ?? 'manual'} · ACK ${draft.manifest.ackTimeoutMs ?? 'unset'} ms`} />
                    </dl>
                    {draft.validation.errors.length > 0 ? (
                        <div className={styles.errors} role="alert">
                            <h3>Manifest validation errors</h3>
                            <ul>
                                {draft.validation.errors.map((error, index) => (
                                    <li key={`${error.source}-${error.path}-${index}`}>
                                        <code>{error.path}</code> · {error.message} ({error.source})
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ) : null}
                    <pre aria-label="Generated distributed run manifest" tabIndex={0}>
                        <code>{draft.rawJson}</code>
                    </pre>
                </div>
            ) : (
                <p className={styles.empty}>A manifest becomes available after a recipe, control run, and safe target set are selected.</p>
            )}
        </details>
    );
}

function Fact({ label, value }: Readonly<{ label: string; value: string }>) {
    return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
