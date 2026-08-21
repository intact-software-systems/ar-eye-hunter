import type { RallarBlackBoxDistributedRunState } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { ExecuteNextStep } from './execute-next-action.ts';
import styles from './ExecuteLifecycleStrip.module.css';

const PHASES = [
    ['agents', 'Agents'],
    ['targets', 'Targets'],
    ['draft', 'Draft'],
    ['staged', 'Staged'],
    ['running', 'Running'],
    ['monitor', 'Monitor']
] as const;

export function ExecuteLifecycleStrip({
    nextStep,
    runState
}: Readonly<{
    nextStep: ExecuteNextStep;
    runState?: RallarBlackBoxDistributedRunState;
}>) {
    const current = currentPhase(nextStep);
    const completeThrough = completedPhaseIndex(nextStep, runState);
    return (
        <ol aria-label="Distributed run lifecycle" className={styles.strip}>
            {PHASES.map(([phase, label], index) => {
                const status = phase === current
                    ? 'current'
                    : index <= completeThrough
                    ? 'complete'
                    : 'future';
                return (
                    <li
                        aria-current={status === 'current' ? 'step' : undefined}
                        data-status={status}
                        key={phase}
                    >
                        <span aria-hidden="true" className={styles.mark} />
                        <span>{label}</span>
                    </li>
                );
            })}
        </ol>
    );
}

function currentPhase(step: ExecuteNextStep): typeof PHASES[number][0] {
    switch (step) {
        case 'refresh-control':
        case 'connect-agents':
        case 'registering':
            return 'agents';
        case 'resolve':
            return 'targets';
        case 'create':
            return 'draft';
        case 'stage':
        case 'waiting-for-ack':
            return 'staged';
        case 'review-start':
            return 'running';
        case 'monitor':
            return 'monitor';
    }
}

function completedPhaseIndex(
    step: ExecuteNextStep,
    runState: RallarBlackBoxDistributedRunState | undefined
): number {
    if (step === 'monitor') {
        return runState ? 4 : 3;
    }
    switch (step) {
        case 'refresh-control':
        case 'connect-agents':
        case 'registering':
            return -1;
        case 'resolve':
            return 0;
        case 'create':
            return 1;
        case 'stage':
            return 2;
        case 'waiting-for-ack':
            return 2;
        case 'review-start':
            return 3;
    }
}
