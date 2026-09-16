import type { ControlDistributedRunSnapshot, ControlRunSnapshot } from '../control-snapshots.ts';
import type { DistributedRunMonitorIndex } from '../distributed-run-monitor-index.ts';
import { distributedRecipeStateTone } from './distributed-recipe-state-tone.ts';
import type {
    DistributedRunArtifactValidation,
    DistributedRunEventRow,
    DistributedRunFailureRow,
    DistributedRunRuntimeDiagnosticRow,
    DistributedRunTimelineItem
} from './distributed-run-row-contracts.ts';
import { toDiagnosticSeverityTone } from './distributed-run-runtime-diagnostic-rows.ts';

type ControlCommandSnapshot = ControlRunSnapshot['commands'][number];
type ControlResultSnapshot = ControlRunSnapshot['results'][number];

/** A timeline item whose time is still unknown; the projection drops those. */
type TimedTimelineItem = Omit<DistributedRunTimelineItem, 'atEpochMs'> & { atEpochMs?: number; };

export function distributedRunTimeline(
    input: Readonly<{
        distributedRun: ControlDistributedRunSnapshot;
        index: DistributedRunMonitorIndex;
        commands: ReadonlyMap<string, ControlCommandSnapshot>;
        results: readonly ControlResultSnapshot[];
        events: readonly DistributedRunEventRow[];
        runtimeDiagnostics: readonly DistributedRunRuntimeDiagnosticRow[];
        failures: readonly DistributedRunFailureRow[];
        artifact: DistributedRunArtifactValidation;
    }>
): readonly DistributedRunTimelineItem[] {
    const items: DistributedRunTimelineItem[] = [];
    addTimedItems(items, toLifecycleItems(input.distributedRun));
    input.index.commandLinks.forEach((link) => {
        input.index.work.timelineCommandLinkProjectionVisitCount += 1;
        addTimedItems(items, toCommandLinkItems(link, input.commands.get(link.commandId)));
    });
    addTimedItems(items, input.results.map(toResultItem));
    addTimedItems(items, input.failures.map(toFailureItem));
    addTimedItems(items, input.events.map(toEventItem));
    addTimedItems(items, input.runtimeDiagnostics.map(toDiagnosticItem));

    return items.sort((left, right) => left.atEpochMs - right.atEpochMs || left.id.localeCompare(right.id));
}

function addTimedItems(
    items: DistributedRunTimelineItem[],
    candidates: readonly TimedTimelineItem[]
): void {
    for (const candidate of candidates) {
        if (candidate.atEpochMs !== undefined) {
            items.push(candidate as DistributedRunTimelineItem);
        }
    }
}

function toLifecycleItems(
    distributedRun: ControlDistributedRunSnapshot
): readonly TimedTimelineItem[] {
    return [
        {
            id: 'created',
            atEpochMs: distributedRun.createdAtEpochMs,
            kind: 'lifecycle',
            label: 'created',
            tone: 'muted'
        },
        {
            id: 'staged',
            atEpochMs: distributedRun.stagedAtEpochMs,
            kind: 'lifecycle',
            label: 'staged',
            tone: 'active'
        },
        {
            id: 'barrier-started',
            atEpochMs: distributedRun.barrierStartedAtEpochMs,
            kind: 'lifecycle',
            label: 'barrier started',
            tone: 'active'
        },
        {
            id: 'barrier-completed',
            atEpochMs: distributedRun.barrierCompletedAtEpochMs,
            kind: 'lifecycle',
            label: 'barrier ready',
            tone: 'good'
        },
        {
            id: 'started',
            atEpochMs: distributedRun.startedAtEpochMs,
            kind: 'lifecycle',
            label: 'started',
            tone: 'active'
        },
        {
            id: 'cancelled',
            atEpochMs: distributedRun.cancelledAtEpochMs,
            kind: 'lifecycle',
            label: 'cancelled',
            tone: 'warn'
        },
        {
            id: 'completed',
            atEpochMs: distributedRun.completedAtEpochMs,
            kind: 'lifecycle',
            label: 'completed',
            tone: distributedRecipeStateTone(distributedRun.state)
        }
    ];
}

function toCommandLinkItems(
    link: DistributedRunMonitorIndex['commandLinks'][number],
    command: ControlCommandSnapshot | undefined
): readonly TimedTimelineItem[] {
    const toItem = (
        id: string,
        atEpochMs: number | undefined,
        label: string,
        tone: string
    ): TimedTimelineItem => ({
        id,
        atEpochMs,
        kind: 'command',
        label,
        detail: command?.envelope.command.kind,
        tone,
        agentId: link.agentId,
        recipeId: link.recipeId,
        commandId: link.commandId,
        phase: link.phase
    });
    return [
        toItem(`queued-${link.commandId}`, link.queuedAtEpochMs, `${link.phase} queued`, 'muted'),
        toItem(
            `dispatched-${link.commandId}`,
            command?.dispatchedAtEpochMs,
            `${link.phase} dispatched`,
            'active'
        ),
        toItem(`completed-${link.commandId}`, command?.completedAtEpochMs, `${link.phase} completed`, 'good')
    ];
}

function toResultItem(result: ControlResultSnapshot): TimedTimelineItem {
    return {
        id: `result-${result.commandId}`,
        atEpochMs: result.result?.endedAtEpochMs,
        kind: 'result',
        label: result.ok ? 'result ok' : 'result failed',
        detail: result.result?.kind,
        tone: result.ok ? 'good' : 'bad',
        agentId: result.agentId,
        commandId: result.commandId
    };
}

function toFailureItem(failure: DistributedRunFailureRow, index: number): TimedTimelineItem {
    return {
        id: `failure-${failure.key}-${index}`,
        atEpochMs: failure.atEpochMs,
        kind: 'failure',
        label: failure.code ?? failure.kind,
        detail: failure.message,
        tone: 'bad',
        agentId: failure.agentId,
        recipeId: failure.recipeId,
        commandId: failure.commandId
    };
}

function toEventItem(event: DistributedRunEventRow): TimedTimelineItem {
    return {
        id: `event-${event.eventId}`,
        atEpochMs: event.atEpochMs,
        kind: 'event',
        label: event.kind,
        detail: event.summary,
        tone: 'muted',
        agentId: event.agentId,
        commandId: event.commandId
    };
}

function toDiagnosticItem(diagnostic: DistributedRunRuntimeDiagnosticRow): TimedTimelineItem {
    return {
        id: `diagnostic-${diagnostic.eventId}`,
        atEpochMs: diagnostic.atEpochMs,
        kind: 'diagnostic',
        label: `${diagnostic.transport ?? 'runtime'} ${diagnostic.severity}`,
        detail: diagnostic.message,
        tone: toDiagnosticSeverityTone(diagnostic.severity),
        agentId: diagnostic.agentId,
        commandId: diagnostic.commandId
    };
}
