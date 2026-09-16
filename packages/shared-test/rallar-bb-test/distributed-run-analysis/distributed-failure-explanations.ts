import type { ControlDistributedRunSnapshot } from '../control-snapshots.ts';
import type { DistributedRunMonitor } from '../distributed-run-monitor.ts';
import type { DistributedRunFailureRow } from '../distributed-run-observation/distributed-run-row-contracts.ts';
import type {
    DistributedFailureExplanation,
    FirstDistributedRunPhaseForCommand
} from './distributed-failure-explanation-contracts.ts';
import { toCompactStrings } from './to-compact-strings.ts';
import { toDistributedFailureExplanation } from './to-distributed-failure-explanation.ts';

export interface ToDistributedFailureExplanationsInput {
    readonly distributedRun: ControlDistributedRunSnapshot;
    readonly monitor: DistributedRunMonitor;
    readonly firstFailure: DistributedRunFailureRow | undefined;
    readonly firstPhaseForCommand: FirstDistributedRunPhaseForCommand;
}

export function toDistributedFailureExplanations(
    input: ToDistributedFailureExplanationsInput
): readonly DistributedFailureExplanation[] {
    const { distributedRun, monitor, firstFailure, firstPhaseForCommand } = input;
    const explanations: DistributedFailureExplanation[] = [];
    const orderedFailures = firstFailure
        ? [
            firstFailure,
            ...monitor.failures.filter((failure) => failure.key !== firstFailure.key)
        ]
        : monitor.failures;

    orderedFailures.slice(0, 6).forEach((failure) => {
        explanations.push(toDistributedFailureExplanation(
            failure,
            firstPhaseForCommand
        ));
    });

    explanations.push(...toDiagnosticExplanations(monitor));

    if (explanations.length === 0 && !distributedRun.rollup.ok) {
        explanations.push({
            category: 'unknown',
            title: 'Run ended without linked failure evidence',
            likelyCause:
                'The distributed rollup is not OK, but no command result or diagnostic was available in the loaded snapshot.',
            nextAction:
                'Load the distributed artifact, refresh the control run with larger bounds, or inspect the raw control-run snapshot.',
            evidence: [distributedRun.distributedRunId]
        });
    }

    if (explanations.length === 0 && !isDistributedAnalysisTerminal(distributedRun.state)) {
        explanations.push({
            category: 'readiness',
            title: 'Run is still collecting evidence',
            likelyCause: 'At least one distributed command is still queued, running, or waiting for agent results.',
            nextAction: 'Keep the agents connected and wait for the live monitor to reach a terminal state.',
            evidence: [distributedRun.distributedRunId]
        });
    }

    return toUniqueDistributedFailureExplanations(explanations);
}

/** The three highest-signal diagnostics become their own next actions. */
function toDiagnosticExplanations(
    monitor: DistributedRunMonitor
): readonly DistributedFailureExplanation[] {
    const highSignalDiagnostics = monitor.runtimeDiagnostics
        .filter((row) =>
            row.severity === 'error' ||
            row.severity === 'warning' ||
            row.correlatedFailureKeys.length > 0
        )
        .slice(0, 3);
    return highSignalDiagnostics.map((diagnostic) => {
        return {
            category: 'diagnostic',
            title: `${diagnostic.transport ?? 'Runtime'} diagnostic`,
            likelyCause: diagnostic.summary || diagnostic.message,
            nextAction: diagnostic.transport === 'ws' || diagnostic.transport === 'messages.ws'
                ? 'Inspect the WebSocket topic/payload and confirm every agent is subscribed before the recipe sends.'
                : diagnostic.transport === 'realtime' || diagnostic.transport === 'messages.rtc'
                ? 'Inspect RTC peer, lane, group, and topic evidence; mismatched lane or peer metadata usually means agents joined different realtime contexts.'
                : 'Inspect the correlated diagnostic payload and the command result that emitted it.',
            evidence: toCompactStrings([
                diagnostic.eventId,
                diagnostic.commandId,
                diagnostic.agentId,
                ...diagnostic.correlatedFailureKeys
            ])
        };
    });
}

function toUniqueDistributedFailureExplanations(
    explanations: readonly DistributedFailureExplanation[]
): readonly DistributedFailureExplanation[] {
    const seen = new Set<string>();
    return explanations.filter((explanation) => {
        const key = `${explanation.category}:${explanation.title}:${explanation.evidence.join(',')}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

function isDistributedAnalysisTerminal(state: string): boolean {
    return state === 'passed' || state === 'failed' || state === 'timed-out' || state === 'cancelled';
}
