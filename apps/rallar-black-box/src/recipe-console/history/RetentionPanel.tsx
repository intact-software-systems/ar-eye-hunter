import { useRef } from 'react';
import type {
    RetentionCleanupController,
    RetentionCleanupPreview,
} from './use-retention-cleanup.ts';
import { ExactIdentifier } from './ExactIdentifier.tsx';
import { historyUtcDisplay, historyUtcIso } from './history-utc.ts';
import styles from './RetentionPanel.module.css';

export type RetentionPanelProps = Readonly<{
    controller: RetentionCleanupController;
    onRequestConfirm(returnFocus: HTMLButtonElement): void;
}>;

export function RetentionPanel({
    controller,
    onRequestConfirm,
}: RetentionPanelProps) {
    const previewButtonRef = useRef<HTMLButtonElement>(null);
    const preview = controller.state.preview;
    const reviewable = preview?.current === true &&
        preview.maxRuns > 0 &&
        preview.candidates.length > 0 &&
        controller.canConfirm;

    return (
        <section
            aria-labelledby="retention-panel-heading"
            className={styles.panel}
            data-retention-panel
        >
            <header className={styles.heading}>
                <div>
                    <p className={styles.eyebrow}>Signal ledger</p>
                    <h3 id="retention-panel-heading">Local history retention</h3>
                </div>
                <div className={styles.actions}>
                    <button
                        aria-busy={controller.busy}
                        disabled={!controller.canPreview || controller.busy}
                        onClick={() => void controller.preview()}
                        ref={previewButtonRef}
                        type="button"
                    >
                        Preview cleanup
                    </button>
                    {reviewable ? (
                        <button
                            className={styles.review}
                            onClick={() => onRequestConfirm(
                                previewButtonRef.current!,
                            )}
                            type="button"
                        >
                            Review cleanup
                        </button>
                    ) : null}
                </div>
            </header>

            <p
                aria-atomic="true"
                aria-live="polite"
                className={styles.status}
                role="status"
            >
                {controller.state.message ?? statusMessage(
                    controller.state.status,
                )}
            </p>

            {preview ? <PreviewEvidence preview={preview} /> : null}
            {controller.state.confirmation ? (
                <CleanupResult confirmation={controller.state.confirmation} />
            ) : null}
        </section>
    );
}

function PreviewEvidence({
    preview,
}: Readonly<{ preview: RetentionCleanupPreview }>) {
    const disabled = preview.maxRuns === 0;
    const empty = preview.candidates.length === 0;
    return (
        <div className={styles.evidence} data-current={preview.current}>
            <div className={styles.previewHeading}>
                <h4>Cleanup preview</h4>
                <strong className={preview.current ? styles.current : styles.stale}>
                    {preview.current
                        ? 'Current preview'
                        : 'Stale preview · not current'}
                </strong>
            </div>

            <ul aria-label="Retention preview counts" className={styles.counts}>
                <li><strong>{preview.retainedRuns}</strong> current</li>
                <li><strong>{preview.projectedRetainedRuns}</strong> projected</li>
                <li><strong>Cap {preview.maxRuns}</strong></li>
                <li>{plural(preview.wouldDeleteRunIds.length, 'control run')}</li>
                <li>{plural(
                    preview.wouldDeleteDistributedRunIds.length,
                    'distributed run',
                )}</li>
                <li>{plural(
                    preview.wouldDeleteFleetReportIds.length,
                    'fleet report',
                )}</li>
            </ul>

            {disabled ? (
                <p className={styles.empty}>Retention cap is disabled (0).</p>
            ) : empty ? (
                <p className={styles.empty}>
                    No in-memory history would be deleted by this cleanup.
                </p>
            ) : (
                <ol className={styles.candidates}>
                    {preview.candidates.map(candidate => (
                        <li className={styles.candidate} key={candidate.key}>
                            <div className={styles.candidateHeading}>
                                <span>Control run</span>
                                <ExactIdentifier value={candidate.runId} />
                            </div>
                            <div className={styles.candidateFacts}>
                                <span>{plural(
                                    candidate.connectedAgentCount,
                                    'connected agent',
                                )}</span>
                                <span>{plural(
                                    candidate.issuedRunTokenCount,
                                    'issued run token',
                                )}</span>
                                <span>
                                    Created <time dateTime={historyUtcIso(
                                        candidate.createdAtEpochMs,
                                    )}>{historyUtcDisplay(
                                        candidate.createdAtEpochMs,
                                    )}</time>
                                </span>
                                <span>
                                    Updated <time dateTime={historyUtcIso(
                                        candidate.updatedAtEpochMs,
                                    )}>{historyUtcDisplay(
                                        candidate.updatedAtEpochMs,
                                    )}</time>
                                </span>
                            </div>
                            <DistributedDisclosure candidate={candidate} />
                            <FleetDisclosure candidate={candidate} />
                        </li>
                    ))}
                </ol>
            )}

            <TotalIdDisclosure
                ids={preview.wouldDeleteRunIds}
                label="Control run IDs"
            />
            <TotalIdDisclosure
                ids={preview.wouldDeleteDistributedRunIds}
                label="Distributed run IDs"
            />
            <TotalIdDisclosure
                ids={preview.wouldDeleteFleetReportIds}
                label="Fleet report IDs"
            />
            {!empty && !disabled ? (
                <p className={styles.warning}>
                    <strong>
                        In-memory control, distributed, and fleet state is deleted.
                    </strong>{' '}
                    Existing connected sockets and stored artifact files remain.
                </p>
            ) : null}
        </div>
    );
}

type Candidate = RetentionCleanupPreview['candidates'][number];

function DistributedDisclosure({ candidate }: Readonly<{ candidate: Candidate }>) {
    return (
        <details className={styles.disclosure}>
            <summary>
                Linked distributed runs ({candidate.distributedRuns.length})
            </summary>
            {candidate.distributedRuns.length > 0 ? (
                <ul>
                    {candidate.distributedRuns.map((run, index) => (
                        <li key={index}>
                            <ExactIdentifier value={run.distributedRunId} />
                            <span>State: {run.state}</span>
                        </li>
                    ))}
                </ul>
            ) : <p>None linked.</p>}
        </details>
    );
}

function FleetDisclosure({ candidate }: Readonly<{ candidate: Candidate }>) {
    return (
        <details className={styles.disclosure}>
            <summary>Linked fleet reports ({candidate.fleetReportIds.length})</summary>
            {candidate.fleetReportIds.length > 0 ? (
                <ul>
                    {candidate.fleetReportIds.map((id, index) => (
                        <li key={index}><ExactIdentifier value={id} /></li>
                    ))}
                </ul>
            ) : <p>None linked.</p>}
        </details>
    );
}

function TotalIdDisclosure({
    ids,
    label,
}: Readonly<{ ids: readonly string[]; label: string }>) {
    return (
        <details className={styles.totalDisclosure}>
            <summary>{label} ({ids.length})</summary>
            {ids.length > 0 ? (
                <ul>
                    {ids.map((id, index) => (
                        <li key={index}><ExactIdentifier value={id} /></li>
                    ))}
                </ul>
            ) : <p>None.</p>}
        </details>
    );
}

type Confirmation = NonNullable<
    RetentionCleanupController['state']['confirmation']
>;

function CleanupResult({ confirmation }: Readonly<{ confirmation: Confirmation }>) {
    return (
        <div className={styles.result}>
            <h4>Cleanup completed</h4>
            <p>
                {plural(confirmation.deletedRunIds.length, 'control run')} deleted
                {' · '}{confirmation.retainedRuns} retained
                {' · '}Cap {confirmation.maxRuns}
            </p>
            <TotalIdDisclosure
                ids={confirmation.deletedRunIds}
                label="Deleted control run IDs"
            />
        </div>
    );
}

function plural(count: number, singular: string): string {
    return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function statusMessage(
    status: RetentionCleanupController['state']['status'],
): string {
    switch (status) {
        case 'idle':
            return 'Preview retention consequences before cleanup.';
        case 'previewing':
            return 'Building retention preview…';
        case 'preview-ready':
            return 'Retention preview is current.';
        case 'confirming':
            return 'Deleting previewed in-memory history…';
        case 'succeeded':
            return 'Retention cleanup succeeded.';
        case 'drift':
            return 'Retention preview is stale; preview cleanup again.';
        case 'error':
            return 'Retention cleanup failed.';
        case 'unavailable':
            return 'Retention cleanup is unavailable.';
    }
}
