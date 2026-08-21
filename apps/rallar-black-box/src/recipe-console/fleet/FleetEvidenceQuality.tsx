import type { FleetReportWindow } from '@shared-test/rallar-bb-test/fleet-report-analysis.ts';
import type { ControlFleetReportValidationIssue } from '@shared-test/rallar-bb-test/fleet-report-validation.ts';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import styles from './FleetEvidenceQuality.module.css';

export function FleetEvidenceQuality({
    acceptedCount,
    collection = 'present',
    issues,
    missingLabelAgentIds,
    omittedIssueCount,
    quarantinedCount,
    sourceCount
}: Readonly<{
    acceptedCount: number;
    collection?: 'absent' | 'present';
    issues: readonly ControlFleetReportValidationIssue[];
    missingLabelAgentIds: FleetReportWindow<string>;
    omittedIssueCount: number;
    quarantinedCount: number;
    sourceCount: number;
}>) {
    return (
        <section aria-labelledby="fleet-quality-heading" className={styles.root}>
            <header>
                <div>
                    <span>Boundary validation</span>
                    <h2 id="fleet-quality-heading">Evidence quality</h2>
                </div>
                <p>
                    {collection === 'absent'
                        ? 'Fleet report collection unavailable'
                        : <>{acceptedCount} of {sourceCount} reports accepted · {quarantinedCount} quarantined</>}
                </p>
            </header>
            {collection === 'absent'
                ? <p className={styles.unavailable}>Fleet report collection unavailable.</p>
                : sourceCount === 0 && issues.length === 0
                ? (
                    <p className={styles.unavailable}>
                        No source reports were available to validate.
                    </p>
                )
                : issues.length === 0
                ? <p className={styles.ok}>All source reports passed the supported schema boundary.</p>
                : (
                    <ol className={styles.issues}>
                        {issues.map((issue, index) => (
                            <li key={`${issue.path}\u0000${issue.code}\u0000${index}`}>
                                <strong>{issue.code}</strong>
                                <bdi dir="ltr">
                                    <code>{issue.path}</code>
                                </bdi>
                                <span>{issue.message}</span>
                                {issue.distributedRunId
                                    ? <ExactIdentifier value={issue.distributedRunId} />
                                    : null}
                            </li>
                        ))}
                    </ol>
                )}
            {omittedIssueCount > 0
                ? <p>{omittedIssueCount} additional validation issues omitted by the bounded boundary.</p>
                : null}
            {missingLabelAgentIds.total > 0
                ? (
                    <div className={styles.labels}>
                        <h3>Agents missing region or provider labels</h3>
                        <div>
                            {missingLabelAgentIds.items.map((agentId) => (
                                <ExactIdentifier key={agentId} value={agentId} />
                            ))}
                        </div>
                        {missingLabelAgentIds.omitted > 0
                            ? <p>{missingLabelAgentIds.omitted} additional unlabeled agents omitted.</p>
                            : null}
                    </div>
                )
                : null}
        </section>
    );
}
