import type {
    ControlDistributedRunCommandLink,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from '../control-snapshots.ts';
import { distributedRecipeStateTone } from './distributed-recipe-state-tone.ts';
import type {
    DistributedRunEventRow,
    DistributedRunFailureRow,
    DistributedRunRuntimeDiagnosticRow,
    DistributedRunTimelineItem
} from './distributed-run-row-contracts.ts';
import { toDiagnosticSeverityTone } from './distributed-run-runtime-diagnostic-rows.ts';

export interface ToDistributedRunTimelineInput {
    readonly distributedRun: ControlDistributedRunSnapshot;
    readonly commandLinks: readonly ControlDistributedRunCommandLink[];
    readonly commands: ReadonlyMap<string, ControlCommandSnapshot>;
    readonly results: readonly ControlResultSnapshot[];
    readonly events: readonly DistributedRunEventRow[];
    readonly runtimeDiagnostics: readonly DistributedRunRuntimeDiagnosticRow[];
    readonly failures: readonly DistributedRunFailureRow[];
}

type ControlCommandSnapshot = ControlRunSnapshot['commands'][number];
type ControlResultSnapshot = ControlRunSnapshot['results'][number];

/** A timeline item that may not have a time yet; the projection drops those. */
type TimedTimelineItem = Omit<DistributedRunTimelineItem, 'atEpochMs'> & { atEpochMs?: number; };

export function toDistributedRunTimeline(input: ToDistributedRunTimelineInput): readonly DistributedRunTimelineItem[] {
    const candidates: readonly TimedTimelineItem[] = [
        ...toLifecycleItems(input.distributedRun),
        ...input.commandLinks.flatMap((link) => toCommandLinkItems(link, input.commands.get(link.commandId))),
        ...input.results.map(toResultItem),
        ...input.failures.map(toFailureItem),
        ...input.events.map(toEventItem),
        ...input.runtimeDiagnostics.map(toDiagnosticItem)
    ];

    return candidates
        .filter(isTimedTimelineItem)
        .sort((left, right) => left.atEpochMs - right.atEpochMs || left.id.localeCompare(right.id));
}

function isTimedTimelineItem(candidate: TimedTimelineItem): candidate is DistributedRunTimelineItem {
    return candidate.atEpochMs !== undefined;
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
    link: ControlDistributedRunCommandLink,
    command: ControlCommandSnapshot | undefined
): readonly TimedTimelineItem[] {
    return [
        toCommandLinkItem({ link, command, stage: 'queued', atEpochMs: link.queuedAtEpochMs, tone: 'muted' }),
        toCommandLinkItem({
            link,
            command,
            stage: 'dispatched',
            atEpochMs: command?.dispatchedAtEpochMs,
            tone: 'active'
        }),
        toCommandLinkItem({ link, command, stage: 'completed', atEpochMs: command?.completedAtEpochMs, tone: 'good' })
    ];
}

interface CommandLinkItemInput {
    readonly link: ControlDistributedRunCommandLink;
    readonly command: ControlCommandSnapshot | undefined;
    readonly stage: 'queued' | 'dispatched' | 'completed';
    readonly atEpochMs: number | undefined;
    readonly tone: string;
}

function toCommandLinkItem(input: CommandLinkItemInput): TimedTimelineItem {
    const { link } = input;
    return {
        id: `${input.stage}-${link.commandId}`,
        atEpochMs: input.atEpochMs,
        kind: 'command',
        label: `${link.phase} ${input.stage}`,
        detail: input.command?.envelope.command.kind,
        tone: input.tone,
        agentId: link.agentId,
        recipeId: link.recipeId,
        commandId: link.commandId,
        phase: link.phase
    };
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
