import type { FleetReportWindow } from '@shared-test/rallar-bb-test/fleet-report-analysis.ts';
import type { ControlFleetFailureSignature } from '@shared-test/rallar-bb-test/fleet-report.ts';
import styles from './FleetEvidence.module.css';
import { FleetFailureRow } from './FleetFailureRow.tsx';

export function FleetFailures({
    failures,
    onOpenHistory,
    onOpenRun,
    onSelectAgent
}: Readonly<{
    failures: FleetReportWindow<ControlFleetFailureSignature>;
    onOpenHistory(failure: ControlFleetFailureSignature, trigger: HTMLButtonElement): void;
    onOpenRun(failure: ControlFleetFailureSignature, runId: string, trigger: HTMLButtonElement): void;
    onSelectAgent(agentId: string, trigger: HTMLButtonElement): void;
}>) {
    return (
        <section aria-labelledby="fleet-failures-heading" className={styles.panel}>
            <header className={styles.heading}>
                <div>
                    <span className={styles.eyebrow}>Failure-first evidence</span>
                    <h2 id="fleet-failures-heading">Repeated failures</h2>
                </div>
                <p>{failures.items.length} of {failures.total} groups</p>
            </header>
            {failures.items.length === 0
                ? <p className={styles.empty}>No repeated failures.</p>
                : (
                    <ol className={styles.failureList}>
                        {failures.items.map(
                            (failure, index) => (
                                <FleetFailureRow
                                    failure={failure}
                                    index={index}
                                    key={failure.signatureId}
                                    onOpenHistory={onOpenHistory}
                                    onOpenRun={onOpenRun}
                                    onSelectAgent={onSelectAgent}
                                />
                            )
                        )}
                    </ol>
                )}
        </section>
    );
}
