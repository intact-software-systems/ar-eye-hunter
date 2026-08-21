import type { ControlFleetRunReport } from '@shared-test/rallar-bb-test/fleet-report.ts';
import { useState } from 'react';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import styles from './FleetArtifactReferences.module.css';

type ArtifactReference = Readonly<{
    key: keyof ControlFleetRunReport['artifactRefs'];
    label: string;
    value: string;
}>;

export function FleetArtifactReferences({
    references
}: Readonly<{ references: ControlFleetRunReport['artifactRefs']; }>) {
    const [status, setStatus] = useState(
        'Opaque references are displayed as identifiers and are never opened as URLs.'
    );
    const items: readonly ArtifactReference[] = [
        {
            key: 'distributedRun',
            label: 'Distributed run reference',
            value: references.distributedRun
        },
        {
            key: 'controlRun',
            label: 'Control run reference',
            value: references.controlRun
        },
        {
            key: 'fleetReport',
            label: 'Fleet report reference',
            value: references.fleetReport
        }
    ];

    async function copy(reference: ArtifactReference): Promise<void> {
        if (!navigator.clipboard?.writeText) {
            setStatus('Clipboard access is unavailable.');
            return;
        }
        try {
            await navigator.clipboard.writeText(reference.value);
            setStatus(`${reference.label} copied.`);
        }
        catch {
            setStatus(`${reference.label} was not copied.`);
        }
    }

    return (
        <section aria-labelledby="fleet-artifact-references" className={styles.root}>
            <h4 id="fleet-artifact-references">Opaque artifact references</h4>
            <ul>
                {items.map((reference) => (
                    <li data-fleet-artifact-reference={reference.key} key={reference.key}>
                        <span>{reference.label}</span>
                        <ExactIdentifier value={reference.value} />
                        <button
                            onClick={() => void copy(reference)}
                            type="button"
                        >
                            Copy {reference.label}
                        </button>
                    </li>
                ))}
            </ul>
            <p
                aria-live="polite"
                data-fleet-reference-copy-status
                role="status"
            >
                {status}
            </p>
        </section>
    );
}
