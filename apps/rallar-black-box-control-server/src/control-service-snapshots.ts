import type { ControlRetentionRunSafety } from '@shared-test/rallar-bb-test/control-retention.ts';
import type {
    ControlAgentSnapshot,
    ControlDistributedRunSnapshot,
    ControlQueuedCommandSnapshot,
    ControlRunSnapshot,
    ControlRunSnapshotBounds,
    ControlServerSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { rollupDistributedRunResult } from '@shared-test/rallar-bb-test/distributed/distributed-run-rollup.ts';
import type { RallarBlackBoxTestRedactionOptions } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { toControlCommandFingerprint } from './control-command-queue-policy.ts';
import {
    toCompactedControlReport,
    toCompactedResultEnvelope,
    toControlReportDedupeKey,
    toGroupAssertionEvidenceCommandIds
} from './control-evidence-compaction.ts';
import { toBoundedTail } from './control-runtime-retention.ts';
import type {
    ControlAgentState,
    ControlCommandState,
    ControlDistributedRunState,
    ControlRunState
} from './control-service-state.ts';

export interface RestoredControlSnapshot {
    readonly runs: Map<string, ControlRunState>;
    readonly distributedRuns: Map<string, ControlDistributedRunState>;
}

interface RestoredControlRunInput {
    readonly runSnapshot: ControlRunSnapshot;
    readonly evidenceCommandKeys: ReadonlySet<string>;
    readonly redaction: RallarBlackBoxTestRedactionOptions | undefined;
}

export function toControlCommandSnapshot(command: ControlCommandState): ControlQueuedCommandSnapshot {
    return {
        envelope: command.envelope,
        queuedAtEpochMs: command.queuedAtEpochMs,
        dispatchedAtEpochMs: command.dispatchedAtEpochMs,
        completedAtEpochMs: command.completedAtEpochMs,
        dispatchCount: command.dispatchCount
    };
}

export function toControlRunSnapshot(
    run: ControlRunState,
    bounds: ControlRunSnapshotBounds
): ControlRunSnapshot {
    const commands = Array.from(
        run.commands.values(),
        (command) => toControlCommandSnapshot(command)
    );
    const results = Array.from(run.results.values());
    return {
        runId: run.runId,
        createdAtEpochMs: run.createdAtEpochMs,
        updatedAtEpochMs: run.updatedAtEpochMs,
        agents: Array.from(run.agents.values(), (agent) => ({
            runId: agent.runId,
            agentId: agent.agentId,
            connected: agent.connected,
            registeredAtEpochMs: agent.registeredAtEpochMs,
            disconnectedAtEpochMs: agent.disconnectedAtEpochMs,
            lastSeenAtEpochMs: agent.lastSeenAtEpochMs,
            lastHeartbeatAtEpochMs: agent.lastHeartbeatAtEpochMs,
            status: agent.status,
            identity: agent.identity,
            connectionSequence: agent.connectionSequence,
            reconnectCount: agent.reconnectCount,
            receivedResultCount: agent.receivedResultCount,
            receivedEventCount: agent.receivedEventCount,
            completedCommandIds: Array.from(agent.completedCommandIds),
            resumeCompletedCommandIds: Array.from(agent.resumeCompletedCommandIds)
        })),
        commands: toBoundedTail(commands, bounds.commands),
        results: toBoundedTail(results, bounds.results),
        events: toBoundedTail(run.events, bounds.events),
        stats: toBoundedTail(run.stats, bounds.stats),
        reports: toBoundedTail(run.reports, bounds.reports),
        heartbeats: toBoundedTail(run.heartbeats, bounds.heartbeats)
    };
}

export function toDistributedRunSnapshot(
    distributedRun: ControlDistributedRunState,
    rollup: ControlDistributedRunSnapshot['rollup']
): ControlDistributedRunSnapshot {
    return {
        distributedRunId: distributedRun.distributedRunId,
        controlRunId: distributedRun.controlRunId,
        manifest: distributedRun.manifest,
        state: distributedRun.state,
        createdAtEpochMs: distributedRun.createdAtEpochMs,
        updatedAtEpochMs: distributedRun.updatedAtEpochMs,
        stagedAtEpochMs: distributedRun.stagedAtEpochMs,
        barrierStartedAtEpochMs: distributedRun.barrierStartedAtEpochMs,
        barrierCompletedAtEpochMs: distributedRun.barrierCompletedAtEpochMs,
        startedAtEpochMs: distributedRun.startedAtEpochMs,
        cancelledAtEpochMs: distributedRun.cancelledAtEpochMs,
        completedAtEpochMs: distributedRun.completedAtEpochMs,
        targetAgentIds: [...distributedRun.targetAgentIds],
        targetResolution: distributedRun.targetResolution,
        commandLinks: [...distributedRun.commandLinks],
        rollup,
        error: distributedRun.error
    };
}
export function toPassiveDistributedRunSnapshot(
    distributedRun: ControlDistributedRunState
): ControlDistributedRunSnapshot {
    return toDistributedRunSnapshot(
        distributedRun,
        distributedRun.rollup ?? rollupDistributedRunResult({ stateHint: distributedRun.state })
    );
}

export function toControlRetentionRunSafety(run: ControlRunState): ControlRetentionRunSafety {
    return {
        runId: run.runId,
        connectedAgentIds: Array.from(run.agents.values())
            .filter((agent) => agent.connected)
            .map((agent) => agent.agentId),
        issuedRunTokens: Array.from(run.tokens.values(), (token) => ({
            agentId: token.agentId,
            issuedAtEpochMs: token.issuedAtEpochMs,
            expiresAtEpochMs: token.expiresAtEpochMs
        })),
        runStateFingerprint: `revision:${run.retentionRevision}`,
        issuedRunTokenStateFingerprint: `revision:${run.issuedRunTokenStateRevision}`
    };
}

export function toRestoredControlSnapshot(
    snapshot: ControlServerSnapshot,
    redaction: RallarBlackBoxTestRedactionOptions | undefined
): RestoredControlSnapshot {
    const evidenceCommandKeys = toGroupAssertionEvidenceKeys(snapshot);
    return {
        runs: new Map(
            snapshot.runs.map(
                (run) => [run.runId, toRestoredControlRun({ runSnapshot: run, evidenceCommandKeys, redaction })]
            )
        ),
        distributedRuns: new Map(
            (snapshot.distributedRuns ?? []).map((run) => [run.distributedRunId, toRestoredDistributedRun(run)])
        )
    };
}

function toGroupAssertionEvidenceKeys(snapshot: ControlServerSnapshot): ReadonlySet<string> {
    const evidenceCommandKeys = new Set<string>();
    for (const distributedRun of snapshot.distributedRuns ?? []) {
        for (const commandId of toGroupAssertionEvidenceCommandIds(distributedRun)) {
            evidenceCommandKeys.add(toResultCommandKey(distributedRun.controlRunId, commandId));
        }
    }
    return evidenceCommandKeys;
}

function toRestoredControlRun(
    { runSnapshot, evidenceCommandKeys, redaction }: RestoredControlRunInput
): ControlRunState {
    const run: ControlRunState = {
        runId: runSnapshot.runId,
        createdAtEpochMs: runSnapshot.createdAtEpochMs,
        updatedAtEpochMs: runSnapshot.updatedAtEpochMs,
        agents: new Map(),
        commands: new Map(),
        results: new Map(),
        events: runSnapshot.events.map((event) =>
            event.kind === 'report' ? toCompactedControlReport(event, redaction) : event
        ),
        stats: [...runSnapshot.stats],
        reports: runSnapshot.reports.map((event) => toCompactedControlReport(event, redaction)),
        reportKeys: new Set(
            runSnapshot.reports.map((report) => toControlReportDedupeKey(report))
        ),
        heartbeats: [...runSnapshot.heartbeats],
        tokens: new Map(),
        retentionRevision: 0,
        issuedRunTokenStateRevision: 0
    };
    for (const agent of runSnapshot.agents) {
        run.agents.set(agent.agentId, toRestoredControlAgent(agent));
    }
    for (const command of runSnapshot.commands) {
        run.commands.set(command.envelope.commandId, toRestoredControlCommand(command));
    }
    for (const result of runSnapshot.results) {
        run.results.set(
            result.commandId,
            evidenceCommandKeys.has(toResultCommandKey(run.runId, result.commandId))
                ? result
                : toCompactedResultEnvelope(result)
        );
    }
    return run;
}

function toRestoredControlAgent(agentSnapshot: ControlAgentSnapshot): ControlAgentState {
    return {
        runId: agentSnapshot.runId,
        agentId: agentSnapshot.agentId,
        connected: false,
        registeredAtEpochMs: agentSnapshot.registeredAtEpochMs,
        disconnectedAtEpochMs: agentSnapshot.disconnectedAtEpochMs,
        lastSeenAtEpochMs: agentSnapshot.lastSeenAtEpochMs,
        lastHeartbeatAtEpochMs: agentSnapshot.lastHeartbeatAtEpochMs,
        status: agentSnapshot.status,
        identity: agentSnapshot.identity,
        connectionSequence: agentSnapshot.connectionSequence,
        reconnectCount: agentSnapshot.reconnectCount,
        receivedResultCount: agentSnapshot.receivedResultCount,
        receivedEventCount: agentSnapshot.receivedEventCount,
        completedCommandIds: new Set(agentSnapshot.completedCommandIds),
        resumeCompletedCommandIds: new Set(agentSnapshot.resumeCompletedCommandIds),
        commandEnqueueTimestamps: []
    };
}

function toRestoredControlCommand(commandSnapshot: ControlQueuedCommandSnapshot): ControlCommandState {
    return {
        envelope: commandSnapshot.envelope,
        fingerprint: toControlCommandFingerprint(commandSnapshot.envelope),
        queuedAtEpochMs: commandSnapshot.queuedAtEpochMs,
        dispatchedAtEpochMs: commandSnapshot.dispatchedAtEpochMs,
        completedAtEpochMs: commandSnapshot.completedAtEpochMs,
        dispatchCount: commandSnapshot.dispatchCount
    };
}

function toRestoredDistributedRun(distributedRunSnapshot: ControlDistributedRunSnapshot): ControlDistributedRunState {
    return {
        distributedRunId: distributedRunSnapshot.distributedRunId,
        controlRunId: distributedRunSnapshot.controlRunId,
        manifest: distributedRunSnapshot.manifest,
        state: distributedRunSnapshot.state,
        createdAtEpochMs: distributedRunSnapshot.createdAtEpochMs,
        updatedAtEpochMs: distributedRunSnapshot.updatedAtEpochMs,
        stagedAtEpochMs: distributedRunSnapshot.stagedAtEpochMs,
        barrierStartedAtEpochMs: distributedRunSnapshot.barrierStartedAtEpochMs,
        barrierCompletedAtEpochMs: distributedRunSnapshot.barrierCompletedAtEpochMs,
        startedAtEpochMs: distributedRunSnapshot.startedAtEpochMs,
        cancelledAtEpochMs: distributedRunSnapshot.cancelledAtEpochMs,
        completedAtEpochMs: distributedRunSnapshot.completedAtEpochMs,
        targetAgentIds: [...distributedRunSnapshot.targetAgentIds],
        targetResolution: distributedRunSnapshot.targetResolution,
        commandLinks: [...distributedRunSnapshot.commandLinks],
        rollup: distributedRunSnapshot.rollup,
        error: distributedRunSnapshot.error
    };
}

function toResultCommandKey(runId: string, commandId: string): string {
    return `${runId}\u0000${commandId}`;
}
