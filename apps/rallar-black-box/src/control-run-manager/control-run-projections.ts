import type { ControlRunSnapshot, ControlServerSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { RallarBlackBoxControlAgentIdentity } from '@shared-test/rallar-bb-test/distributed-run.ts';
import { toControlAgentIdentitySummary } from './to-control-agent-identity-summary.ts';

export type ControlRunManagerStats = Readonly<{
    runCount: number;
    agentCount: number;
    connectedAgentCount: number;
    queuedCommandCount: number;
    completedCommandCount: number;
    resultCount: number;
    eventCount: number;
    reportCount: number;
    heartbeatCount: number;
}>;

/**
 * Every optional row fact below is absent because the agent's own registration and heartbeats do
 * not report it: an agent the control server has never heard from carries no timestamps, and one
 * that registered without an identity block carries neither identity nor its summary.
 */
export type ControlRunAgentRow = Readonly<{
    agentId: string;
    connected: boolean;
    status: string;
    lastSeenAtEpochMs?: number;
    lastHeartbeatAtEpochMs?: number;
    identity?: RallarBlackBoxControlAgentIdentity;
    identitySummary?: string;
    queuedCommandCount: number;
    completedCommandCount: number;
    receivedResultCount: number;
    receivedEventCount: number;
    reconnectCount: number;
}>;

export type ControlRunCommandRow = Readonly<{
    commandId: string;
    agentId: string;
    kind: string;
    status: 'queued' | 'dispatched' | 'completed';
    dispatchCount: number;
    queuedAtEpochMs: number;
    /** Absent while the command is still queued or dispatched, so it has not completed yet. */
    completedAtEpochMs?: number;
}>;

export function computeControlRunManagerStats(
    snapshot: ControlServerSnapshot | undefined
): ControlRunManagerStats {
    const runs = snapshot?.runs ?? [];
    return runs.reduce<ControlRunManagerStats>((stats, run) => ({
        runCount: stats.runCount + 1,
        agentCount: stats.agentCount + run.agents.length,
        connectedAgentCount: stats.connectedAgentCount +
            run.agents.filter((agent) => agent.connected).length,
        queuedCommandCount: stats.queuedCommandCount +
            run.commands.filter((command) => command.completedAtEpochMs === undefined).length,
        completedCommandCount: stats.completedCommandCount +
            run.commands.filter((command) => command.completedAtEpochMs !== undefined).length,
        resultCount: stats.resultCount + run.results.length,
        eventCount: stats.eventCount + run.events.length,
        reportCount: stats.reportCount + run.reports.length,
        heartbeatCount: stats.heartbeatCount + run.heartbeats.length
    }), {
        runCount: 0,
        agentCount: 0,
        connectedAgentCount: 0,
        queuedCommandCount: 0,
        completedCommandCount: 0,
        resultCount: 0,
        eventCount: 0,
        reportCount: 0,
        heartbeatCount: 0
    });
}

export function toControlRunAgentRows(run: ControlRunSnapshot | undefined): readonly ControlRunAgentRow[] {
    if (!run) {
        return [];
    }

    return [...run.agents]
        .sort((left, right) => left.agentId.localeCompare(right.agentId))
        .map((agent) => ({
            agentId: agent.agentId,
            connected: agent.connected,
            status: agent.status ?? (agent.connected ? 'connected' : 'offline'),
            lastSeenAtEpochMs: agent.lastSeenAtEpochMs,
            lastHeartbeatAtEpochMs: agent.lastHeartbeatAtEpochMs,
            identity: agent.identity,
            identitySummary: toControlAgentIdentitySummary(agent.identity),
            queuedCommandCount: run.commands.filter((command) =>
                command.envelope.agentId === agent.agentId &&
                command.completedAtEpochMs === undefined
            ).length,
            completedCommandCount: agent.completedCommandIds.length,
            receivedResultCount: agent.receivedResultCount,
            receivedEventCount: agent.receivedEventCount,
            reconnectCount: agent.reconnectCount
        }));
}

export function toControlRunCommandRows(
    run: ControlRunSnapshot | undefined
): readonly ControlRunCommandRow[] {
    if (!run) {
        return [];
    }

    return [...run.commands]
        .sort((left, right) => right.queuedAtEpochMs - left.queuedAtEpochMs)
        .map((command) => ({
            commandId: command.envelope.commandId,
            agentId: command.envelope.agentId ?? '-',
            kind: command.envelope.command.kind,
            status: command.completedAtEpochMs !== undefined
                ? 'completed'
                : command.dispatchedAtEpochMs !== undefined
                ? 'dispatched'
                : 'queued',
            dispatchCount: command.dispatchCount,
            queuedAtEpochMs: command.queuedAtEpochMs,
            completedAtEpochMs: command.completedAtEpochMs
        }));
}
