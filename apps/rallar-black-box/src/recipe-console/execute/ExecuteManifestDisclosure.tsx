import { useState } from 'react';
import { StatusMark } from '../ui/StatusMark.tsx';
import type { ExecuteManifestDraft } from './execute-manifest.ts';
import { ExecuteManifestBody } from './ExecuteManifestBody.tsx';
import styles from './ExecuteManifestDisclosure.module.css';

export type ExecuteManifestDisclosureProps = Readonly<{
    draft?: ExecuteManifestDraft;
}>;

export function ExecuteManifestDisclosure({ draft }: ExecuteManifestDisclosureProps) {
    const [open, setOpen] = useState(false);
    return (
        <details className={styles.disclosure} data-execute-manifest open={open}>
            <summary onClick={event => {
                event.preventDefault();
                setOpen(current => !current);
            }}>
                <span>
                    <strong>Generated manifest</strong>
                    <small>Read-only control contract</small>
                </span>
                <StatusMark
                    label={draft ? draft.validation.ok ? 'Valid' : 'Blocked' : 'Unavailable'}
                    status={draft ? draft.validation.ok ? 'passed' : 'failed' : 'disabled'}
                />
            </summary>
            {open && draft ? <ExecuteManifestBody draft={draft} /> : null}
            {open && !draft ? (
                <p className={styles.empty}>A manifest becomes available after a recipe, control run, and safe target set are selected.</p>
            ) : null}
        </details>
    );
}
