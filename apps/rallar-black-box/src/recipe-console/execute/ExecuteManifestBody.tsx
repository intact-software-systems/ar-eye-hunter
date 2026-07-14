import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import type { ExecuteManifestDraft } from './execute-manifest.ts';
import { ExecuteWindowedList } from './ExecuteWindowedList.tsx';
import { createExecuteWindowRevision } from './execute-window-revision.ts';
import styles from './ExecuteManifestDisclosure.module.css';

export function ExecuteManifestBody({ draft }: Readonly<{
    draft: ExecuteManifestDraft;
}>) {
    return <div className={styles.body} data-execute-manifest-body>
        <dl className={styles.facts}>
            <Fact label="Distributed run" value={draft.manifest.distributedRunId} />
            <Fact label="Control run" value={draft.manifest.controlRunId ?? 'Unavailable'} />
            <Fact label="Group" value={[draft.manifest.group.applicationId, draft.manifest.group.workspaceId, draft.manifest.group.groupId].join(' / ')} />
            <Fact label="Targets" value={`${draft.manifest.targetPolicy.agentIds?.length ?? 0} selected · exact count ${draft.manifest.targetPolicy.expectedParticipantCount ?? 'unset'}`} />
            <Fact label="Start" value={`${draft.manifest.startMode ?? 'manual'} · ACK ${draft.manifest.ackTimeoutMs ?? 'unset'} ms`} />
        </dl>
        {draft.validation.errors.length > 0 ? (
            <div className={styles.errors}>
                <h3>Manifest validation errors</h3>
                <p data-execute-manifest-live-summary role="alert">
                    {draft.validation.errors.length.toLocaleString('en-US')}{' '}
                    manifest validation errors.
                </p>
                <ExecuteWindowedList
                    contentId="execute-manifest-errors-window"
                    contextKey="execute-manifest-errors-v1"
                    itemKey={(_error, index) => String(index)}
                    itemLabel="errors"
                    items={draft.validation.errors}
                    label="Manifest validation errors"
                    renderItem={error => <li data-execute-manifest-error>
                        <ExactIdentifier value={error.path} /> · {error.message} ({error.source})
                    </li>}
                    revisionKey={createExecuteWindowRevision(
                        draft.validation.errors,
                        error => [error.source, error.path, error.message],
                    )}
                    section="manifestErrors"
                />
            </div>
        ) : null}
        <pre aria-label="Generated distributed run manifest" tabIndex={0}>
            <code>{draft.rawJson}</code>
        </pre>
    </div>;
}

function Fact({ label, value }: Readonly<{ label: string; value: string }>) {
    return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
