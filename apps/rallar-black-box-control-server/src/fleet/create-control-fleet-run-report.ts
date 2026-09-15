import type { ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { isDistributedRunTerminalState } from '@shared-test/rallar-bb-test/distributed-run.ts';
import {
    RALLAR_BLACK_BOX_FLEET_REPORT_SCHEMA_VERSION,
    type ControlFleetAgentLabel,
    type ControlFleetAgentRunOutcome,
    type ControlFleetAgentState,
    type ControlFleetRunReport
} from '@shared-test/rallar-bb-test/fleet-report.ts';
import type { RallarBlackBoxTestRedactionOptions } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';

import { decodeFleetDiagnostic, toResultDurationMs } from './control-fleet-evidence.ts';
import {
    computeFleetRunFailureSignatures,
    type FleetRunFailureSignatures
} from './control-fleet-failure-signatures.ts';
import {
    toFleetRegionSummaries,
    toFleetTimingDistribution,
    toRatio,
    toSortedUniqueValues,
    UNLABELED_REGION
} from './control-fleet-statistics.ts';

export interface CreateControlFleetRunReportInput {
    readonly distributedRun: ControlDistributedRunSnapshot;
    readonly controlRun: ControlRunSnapshot | undefined;
    readonly generatedAtEpochMs: number;
    readonly redaction: RallarBlackBoxTestRedactionOptions | undefined;
}

interface FleetAgentOutcomeInput {
    readonly report: CreateControlFleetRunReportInput;
    readonly agentId: string;
    readonly labels: ReadonlyMap<string, ControlFleetAgentLabel>;
    readonly failures: FleetRunFailureSignatures;
    readonly resultsByCommandId: ReadonlyMap<string, ControlResultEnvelope>;
}

interface FleetAgentStateInput {
    readonly runState: ControlDistributedRunSnapshot['state'];
    readonly failedResultCount: number;
    readonly missing: boolean;
    readonly failureSignatureCount: number;
    readonly terminal: boolean;
}

const STALE_HEARTBEAT_MS = 30_000;

export function createControlFleetRunReport(input: CreateControlFleetRunReportInput): ControlFleetRunReport {
    const { distributedRun, controlRun, generatedAtEpochMs } = input;
    const labels = toAgentLabels(distributedRun, controlRun);
    const failures = computeFleetRunFailureSignatures({ distributedRun, controlRun, labels });
    const resultsByCommandId = new Map((controlRun?.results ?? []).map((result) => [result.commandId, result]));
    const outcomes = distributedRun.targetAgentIds.map((agentId) =>
        computeFleetAgentOutcome({ report: input, agentId, labels, failures, resultsByCommandId })
    );
    const runDurationMs = toDistributedRunDurationMs(distributedRun);
    const report = {
        fleetReportSchemaVersion: RALLAR_BLACK_BOX_FLEET_REPORT_SCHEMA_VERSION,
        distributedRunId: distributedRun.distributedRunId,
        controlRunId: distributedRun.controlRunId,
        generatedAtEpochMs,
        state: distributedRun.state,
        ok: distributedRun.rollup.ok,
        group: distributedRun.manifest.group,
        recipeIds: toFleetRecipeIds(distributedRun),
        runDurationMs,
        summary: toFleetRunSummary(outcomes, failures.signatures.length),
        timing: {
            run: toFleetTimingDistribution(runDurationMs === undefined ? [] : [runDurationMs]),
            commands: toFleetTimingDistribution(toLinkedCommandDurations(distributedRun, controlRun))
        },
        agents: outcomes,
        regions: toFleetRegionSummaries(outcomes),
        failureSignatures: failures.signatures,
        artifactRefs: {
            distributedRun: `distributed-run:${distributedRun.distributedRunId}`,
            controlRun: `control-run:${distributedRun.controlRunId}`,
            fleetReport: `fleet-report:${distributedRun.distributedRunId}`
        }
    } satisfies ControlFleetRunReport;
    return redactRallarBlackBoxValue(report, input.redaction);
}

function computeFleetAgentOutcome(input: FleetAgentOutcomeInput): ControlFleetAgentRunOutcome {
    const { distributedRun, controlRun, generatedAtEpochMs } = input.report;
    const links = distributedRun.commandLinks.filter((link) => link.agentId === input.agentId);
    const results = links
        .map((link) => input.resultsByCommandId.get(link.commandId))
        .filter((result): result is ControlResultEnvelope => Boolean(result));
    const failedResultCount = results.filter((result) => !result.ok).length;
    const failureSignatureIds = [...(input.failures.signatureIdsByAgent.get(input.agentId) ?? [])].sort();
    const agent = controlRun?.agents.find((candidate) => candidate.agentId === input.agentId);
    const agentEvents = controlRun?.events.filter((event) => event.agentId === input.agentId);
    const durations = results.map(toResultDurationMs).filter((duration): duration is number => duration !== undefined);
    const terminal = isDistributedRunTerminalState(distributedRun.state);
    const missing = terminal && links.length > 0 && results.length < links.length;
    const state = toFleetAgentState({
        runState: distributedRun.state,
        failedResultCount,
        missing,
        failureSignatureCount: failureSignatureIds.length,
        terminal
    });
    return {
        agentId: input.agentId,
        label: input.labels.get(input.agentId) ?? { agentId: input.agentId },
        state,
        ok: state === 'passed',
        missing,
        flaky: false,
        stale: agent?.lastHeartbeatAtEpochMs === undefined ||
            generatedAtEpochMs - agent.lastHeartbeatAtEpochMs > STALE_HEARTBEAT_MS,
        commandCount: links.length,
        failedCommandCount: failedResultCount,
        resultCount: results.length,
        eventCount: agentEvents?.length ?? 0,
        diagnosticCount: agentEvents?.filter((event) => decodeFleetDiagnostic(event.payload)).length ?? 0,
        reconnectCount: agent?.reconnectCount ?? 0,
        durationMs: durations.length > 0 ? Math.max(...durations) : undefined,
        lastHeartbeatAtEpochMs: agent?.lastHeartbeatAtEpochMs,
        failureSignatureIds
    };
}

function toFleetRecipeIds(distributedRun: ControlDistributedRunSnapshot): readonly string[] {
    return distributedRun.manifest.recipes
        .map((selection) => selection.recipeId ?? selection.recipe?.recipeId ?? selection.role)
        .filter((value): value is string => Boolean(value));
}

function toFleetAgentState(input: FleetAgentStateInput): ControlFleetAgentState {
    if (input.runState === 'cancelled') {
        return 'cancelled';
    }
    if (input.runState === 'timed-out' && (input.missing || input.failureSignatureCount > 0)) {
        return 'timed-out';
    }
    if (input.failedResultCount > 0 || input.failureSignatureCount > 0) {
        return 'failed';
    }
    if (input.missing) {
        return 'missing';
    }
    if (!input.terminal) {
        return 'running';
    }
    return input.runState === 'passed' || input.runState === 'failed' || input.runState === 'timed-out'
        ? 'passed'
        : 'unknown';
}

function toAgentLabels(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot | undefined
): ReadonlyMap<string, ControlFleetAgentLabel> {
    const agentsById = new Map((controlRun?.agents ?? []).map((agent) => [agent.agentId, agent]));
    return new Map(distributedRun.targetAgentIds.map((agentId) => {
        const identity = agentsById.get(agentId)?.identity;
        const label: ControlFleetAgentLabel = {
            agentId,
            region: identity?.region,
            provider: identity?.provider,
            datacenter: identity?.datacenter,
            hostId: identity?.hostId,
            agentPoolId: identity?.agentPoolId,
            deploymentId: identity?.deploymentId,
            browserName: identity?.browserName,
            browserVersion: identity?.browserVersion,
            os: identity?.os,
            tags: identity?.tags,
            location: identity?.location
        };
        return [agentId, label];
    }));
}

function toFleetRunSummary(
    outcomes: readonly ControlFleetAgentRunOutcome[],
    failureGroups: number
): ControlFleetRunReport['summary'] {
    const passed = outcomes.filter((outcome) => outcome.state === 'passed').length;
    return {
        agents: outcomes.length,
        regions: toSortedUniqueValues(outcomes.map((outcome) => outcome.label.region ?? UNLABELED_REGION)).length,
        passed,
        failed: outcomes.filter((outcome) => outcome.state === 'failed' || outcome.state === 'timed-out').length,
        missing: outcomes.filter((outcome) => outcome.missing).length,
        flaky: outcomes.filter((outcome) => outcome.flaky).length,
        stale: outcomes.filter((outcome) => outcome.stale).length,
        passRate: toRatio(passed, outcomes.length),
        failureGroups
    };
}

function toLinkedCommandDurations(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot | undefined
): readonly number[] {
    const linkedCommandIds = new Set(distributedRun.commandLinks.map((link) => link.commandId));
    return (controlRun?.results ?? [])
        .filter((result) => linkedCommandIds.has(result.commandId))
        .map(toResultDurationMs)
        .filter((duration): duration is number => duration !== undefined);
}

function toDistributedRunDurationMs(distributedRun: ControlDistributedRunSnapshot): number | undefined {
    const start = distributedRun.startedAtEpochMs ?? distributedRun.stagedAtEpochMs ?? distributedRun.createdAtEpochMs;
    const end = distributedRun.completedAtEpochMs ?? distributedRun.updatedAtEpochMs;
    return end !== undefined && start !== undefined ? Math.max(0, end - start) : undefined;
}
