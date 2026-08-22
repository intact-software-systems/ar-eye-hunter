import { RetentionCandidateRow } from './RetentionCandidateRow.tsx';
import { RetentionTotalIdDisclosure, type RetentionDisclosureController } from './RetentionDisclosure.tsx';
import styles from './RetentionPanel.module.css';
import { RetentionWindowedList } from './RetentionWindowedList.tsx';
import type { RetentionCleanupPreview } from './use-retention-cleanup.ts';

export function RetentionPreviewEvidence({
    controller,
    preview,
    suppressPressure = false
}: Readonly<{
    controller: RetentionDisclosureController;
    preview: RetentionCleanupPreview;
    suppressPressure?: boolean;
}>) {
    const disabled = preview.maxRuns === 0;
    const empty = preview.candidates.length === 0;
    return (
        <div className={styles.evidence} data-current={preview.current}>
            <div className={styles.previewHeading}>
                <h4>Cleanup preview</h4>
                <strong className={preview.current ? styles.current : styles.stale}>
                    {preview.current ? 'Current preview' : 'Stale preview · not current'}
                </strong>
            </div>
            <ul aria-label="Retention preview counts" className={styles.counts}>
                <li>
                    <strong>{preview.retainedRuns}</strong> current
                </li>
                <li>
                    <strong>{preview.projectedRetainedRuns}</strong> projected
                </li>
                <li>
                    <strong>Cap {preview.maxRuns}</strong>
                </li>
                <li>{plural(preview.wouldDeleteRunIds.length, 'control run')}</li>
                <li>{plural(preview.wouldDeleteDistributedRunIds.length, 'distributed run')}</li>
                <li>{plural(preview.wouldDeleteFleetReportIds.length, 'fleet report')}</li>
            </ul>
            {disabled ? <p className={styles.empty}>Retention cap is disabled (0).</p> : empty
                ? (
                    <p className={styles.empty}>
                        No in-memory history would be deleted by this cleanup.
                    </p>
                )
                : suppressPressure
                ? (
                    <p className={styles.empty}>
                        Detailed preview evidence is paused while confirmation is open. Cancel to inspect linked
                        consequences.
                    </p>
                )
                : (
                    <RetentionWindowedList
                        className={styles.candidates}
                        contextKey="retention-preview-candidates"
                        itemKey={(candidate) => candidate.key}
                        itemLabel="candidates"
                        items={preview.candidates}
                        label="Retention candidates"
                        ordered
                        renderItem={(candidate) => (
                            <RetentionCandidateRow
                                candidate={candidate}
                                controller={controller}
                            />
                        )}
                        revision={preview}
                    />
                )}
            {!suppressPressure
                ? (
                    <>
                        <RetentionTotalIdDisclosure
                            controller={controller}
                            ids={preview.wouldDeleteRunIds}
                            label="Control run IDs"
                            revision={preview}
                        />
                        <RetentionTotalIdDisclosure
                            controller={controller}
                            ids={preview.wouldDeleteDistributedRunIds}
                            label="Distributed run IDs"
                            revision={preview}
                        />
                        <RetentionTotalIdDisclosure
                            controller={controller}
                            ids={preview.wouldDeleteFleetReportIds}
                            label="Fleet report IDs"
                            revision={preview}
                        />
                    </>
                )
                : null}
            {!empty && !disabled
                ? (
                    <p className={styles.warning}>
                        <strong>In-memory control, distributed, and fleet state is deleted.</strong>{' '}
                        Existing connected sockets and stored artifact files remain.
                    </p>
                )
                : null}
        </div>
    );
}

export function RetentionCleanupResult({ confirmation, controller }: Readonly<{
    confirmation: Readonly<{
        deletedRunIds: readonly string[];
        retainedRuns: number;
        maxRuns: number;
    }>;
    controller: RetentionDisclosureController;
}>) {
    return (
        <div className={styles.result}>
            <h4>Cleanup completed</h4>
            <p>
                {plural(confirmation.deletedRunIds.length, 'control run')} deleted
                {' · '}
                {confirmation.retainedRuns} retained
                {' · '}Cap {confirmation.maxRuns}
            </p>
            <RetentionTotalIdDisclosure
                controller={controller}
                ids={confirmation.deletedRunIds}
                label="Deleted control run IDs"
                revision={confirmation}
            />
        </div>
    );
}

function plural(count: number, singular: string): string {
    return `${count} ${singular}${count === 1 ? '' : 's'}`;
}
