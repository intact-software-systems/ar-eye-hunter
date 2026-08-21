import type { ControlFleetFailureSignature } from '@shared-test/rallar-bb-test/fleet-report.ts';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import styles from './FleetEvidence.module.css';
import { FleetWindowControls } from './FleetWindowControls.tsx';
import { useFleetWindow } from './use-fleet-window.ts';

export function FleetFailureRow({
    failure,
    index,
    onOpenHistory,
    onOpenRun,
    onSelectAgent
}: Readonly<{
    failure: ControlFleetFailureSignature;
    index: number;
    onOpenHistory(failure: ControlFleetFailureSignature, trigger: HTMLButtonElement): void;
    onOpenRun(failure: ControlFleetFailureSignature, runId: string, trigger: HTMLButtonElement): void;
    onSelectAgent(agentId: string, trigger: HTMLButtonElement): void;
}>) {
    const window = useFleetWindow({
        contextKey: JSON.stringify(['fleet-failure-agents-v1', failure.signatureId]),
        section: 'failureAgents',
        total: failure.affectedAgents.length
    });
    const contentId = `fleet-failure-agents-${index}`;
    const agents = failure.affectedAgents.slice(
        window.model.startIndex,
        window.model.endIndexExclusive
    );
    return (
        <li data-fleet-failure={failure.signatureId}>
            <div className={styles.failureTitle}>
                <div>
                    <span className={styles.status} data-tone="failed">{failure.category}</span>
                    <h3>{failure.title}</h3>
                </div>
                <strong>{failure.count.toLocaleString('en-US')} observations</strong>
            </div>
            <p>{failure.likelyCause}</p>
            <p>
                <strong>Next:</strong> {failure.nextAction}
            </p>
            <FleetWindowControls
                contentId={contentId}
                itemLabel="affected agents"
                label={`${failure.title} affected agents`}
                window={window}
            />
            <div
                aria-label="Affected agents"
                className={styles.chips}
                id={contentId}
                {...window.contentFocusProps}
            >
                {agents.map((agentId) => (
                    <button
                        data-failure-agent-id={agentId}
                        key={agentId}
                        onClick={(event) =>
                            onSelectAgent(
                                agentId,
                                event.currentTarget
                            )}
                        type="button"
                    >
                        <ExactIdentifier value={agentId} />
                    </button>
                ))}
            </div>
            <div className={styles.actions}>
                {failure.affectedRuns[0]
                    ? (
                        <button
                            onClick={(event) =>
                                onOpenRun(
                                    failure,
                                    failure.affectedRuns[0]!,
                                    event.currentTarget
                                )}
                            type="button"
                        >
                            Open proving run
                        </button>
                    )
                    : null}
                <button
                    onClick={(event) => onOpenHistory(failure, event.currentTarget)}
                    type="button"
                >
                    Filter History
                </button>
            </div>
        </li>
    );
}
