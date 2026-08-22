import { ExactIdentifier } from './ExactIdentifier.tsx';
import { historyUtcDisplay, historyUtcIso } from './history-utc.ts';
import { RetentionDisclosure, type RetentionDisclosureController } from './RetentionDisclosure.tsx';
import styles from './RetentionPanel.module.css';
import type { RetentionCleanupPreview } from './use-retention-cleanup.ts';

type Candidate = RetentionCleanupPreview['candidates'][number];

export function RetentionCandidateRow({
    candidate,
    controller
}: Readonly<{
    candidate: Candidate;
    controller: RetentionDisclosureController;
}>) {
    return (
        <li className={styles.candidate} data-retention-candidate-row>
            <div className={styles.candidateHeading}>
                <span>Control run</span>
                <ExactIdentifier value={candidate.runId} />
            </div>
            <div className={styles.candidateFacts}>
                <span>{plural(candidate.connectedAgentCount, 'connected agent')}</span>
                <span>{plural(candidate.issuedRunTokenCount, 'issued run token')}</span>
                <span>
                    Created{' '}
                    <time dateTime={historyUtcIso(candidate.createdAtEpochMs)}>
                        {historyUtcDisplay(candidate.createdAtEpochMs)}
                    </time>
                </span>
                <span>
                    Updated{' '}
                    <time dateTime={historyUtcIso(candidate.updatedAtEpochMs)}>
                        {historyUtcDisplay(candidate.updatedAtEpochMs)}
                    </time>
                </span>
            </div>
            <RetentionDisclosure
                className={styles.disclosure}
                contextKey={`${candidate.key}:distributed`}
                controller={controller}
                disclosureKey={`${candidate.key}:distributed`}
                emptyLabel="None linked."
                itemKey={(run, index) =>
                    JSON.stringify([
                        run.distributedRunId,
                        index
                    ])}
                itemLabel="linked runs"
                items={candidate.distributedRuns}
                label="Linked distributed runs"
                renderItem={(run) => (
                    <li data-retention-linked-run-row>
                        <ExactIdentifier value={run.distributedRunId} />
                        <span>State: {run.state}</span>
                    </li>
                )}
                revision={candidate}
            />
            <RetentionDisclosure
                className={styles.disclosure}
                contextKey={`${candidate.key}:fleet`}
                controller={controller}
                disclosureKey={`${candidate.key}:fleet`}
                emptyLabel="None linked."
                itemKey={(id, index) => JSON.stringify([id, index])}
                itemLabel="linked reports"
                items={candidate.fleetReportIds}
                label="Linked fleet reports"
                renderItem={(id) => (
                    <li data-retention-linked-fleet-row>
                        <ExactIdentifier value={id} />
                    </li>
                )}
                revision={candidate}
            />
        </li>
    );
}

function plural(count: number, singular: string): string {
    return `${count} ${singular}${count === 1 ? '' : 's'}`;
}
