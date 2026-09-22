import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    ControlFleetAgentLabel,
    ControlFleetFailureSignature,
    ControlFleetRunReport
} from '@shared-test/rallar-bb-test/fleet-report.ts';

import { decodeFleetDiagnostic, decodeText, isFleetLinkedEvent } from './control-fleet-evidence.ts';
import {
    toFleetFailureCategory,
    toFleetFailureLikelyCause,
    toFleetFailureNextAction
} from './control-fleet-failure-guidance.ts';
import { UNLABELED_REGION } from './control-fleet-statistics.ts';

export interface FleetRunFailureInput {
    readonly distributedRun: ControlDistributedRunSnapshot;
    readonly controlRun: ControlRunSnapshot | undefined;
    readonly labels: ReadonlyMap<string, ControlFleetAgentLabel>;
}

export interface FleetRunFailureSignatures {
    readonly signatures: readonly ControlFleetFailureSignature[];
    readonly signatureIdsByAgent: ReadonlyMap<string, ReadonlySet<string>>;
}

interface FleetFailureObservation {
    readonly agentId: string;
    readonly category: ControlFleetFailureSignature['category'];
    readonly title: string;
    readonly message: string;
    readonly code?: string;
    readonly recipeId?: string;
    readonly commandKind?: string;
    readonly diagnosticTypeId?: string;
    readonly transport?: string;
    readonly atEpochMs: number | undefined;
}

interface FleetFailureSignatureTally {
    signatureId: string;
    category: ControlFleetFailureSignature['category'];
    title: string;
    normalizedMessage: string;
    code?: string;
    recipeId?: string;
    commandKind?: string;
    diagnosticTypeId?: string;
    transport?: string;
    count: number;
    firstSeenAtEpochMs?: number;
    lastSeenAtEpochMs?: number;
    affectedAgents: Set<string>;
    affectedRegions: Set<string>;
    affectedRuns: Set<string>;
    likelyCause: string;
    nextAction: string;
}

interface FleetRunFailureTally {
    readonly runId: string;
    readonly labels: ReadonlyMap<string, ControlFleetAgentLabel>;
    readonly signatures: Map<string, FleetFailureSignatureTally>;
    readonly signatureIdsByAgent: Map<string, Set<string>>;
}

const SIGNATURE_MESSAGE_LENGTH = 180;
const SIGNATURE_ID_LENGTH = 96;

export function computeFleetRunFailureSignatures(input: FleetRunFailureInput): FleetRunFailureSignatures {
    const tally: FleetRunFailureTally = {
        runId: input.distributedRun.distributedRunId,
        labels: input.labels,
        signatures: new Map(),
        signatureIdsByAgent: new Map()
    };
    const observations = [
        ...toCommandFailureObservations(input),
        ...toRollupFailureObservations(input.distributedRun),
        ...toDiagnosticFailureObservations(input)
    ];
    observations.forEach((observation) => addFailureObservation(tally, observation));
    return {
        signatures: toSortedFailureSignatures(tally.signatures.values()),
        signatureIdsByAgent: tally.signatureIdsByAgent
    };
}

export function computeAggregateFleetFailureSignatures(
    reports: readonly ControlFleetRunReport[]
): readonly ControlFleetFailureSignature[] {
    const signatures = new Map<string, FleetFailureSignatureTally>();
    for (const signature of reports.flatMap((report) => report.failureSignatures)) {
        const existing = signatures.get(signature.signatureId) ?? {
            ...signature,
            count: 0,
            affectedAgents: new Set<string>(),
            affectedRegions: new Set<string>(),
            affectedRuns: new Set<string>()
        };
        existing.count += signature.count;
        existing.firstSeenAtEpochMs = toEarliestEpochMs(existing.firstSeenAtEpochMs, signature.firstSeenAtEpochMs);
        existing.lastSeenAtEpochMs = toLatestEpochMs(existing.lastSeenAtEpochMs, signature.lastSeenAtEpochMs);
        signature.affectedAgents.forEach((agentId) => existing.affectedAgents.add(agentId));
        signature.affectedRegions.forEach((region) => existing.affectedRegions.add(region));
        signature.affectedRuns.forEach((runId) => existing.affectedRuns.add(runId));
        signatures.set(signature.signatureId, existing);
    }
    return toSortedFailureSignatures(signatures.values());
}

function toCommandFailureObservations({ distributedRun, controlRun }: FleetRunFailureInput): FleetFailureObservation[] {
    const commandById = new Map((controlRun?.commands ?? []).map((command) => [command.envelope.commandId, command]));
    return (controlRun?.results ?? []).flatMap((result) => {
        const link = distributedRun.commandLinks.find((candidate) => candidate.commandId === result.commandId);
        if (!link || result.ok) {
            return [];
        }
        const commandError = result.error ?? result.result?.error;
        return [{
            agentId: result.agentId,
            category: 'command',
            title: 'Command failure',
            code: decodeText(commandError?.code),
            message: decodeText(commandError?.message) ?? 'Distributed command failed.',
            recipeId: link.recipeId,
            commandKind: commandById.get(result.commandId)?.envelope.command.kind,
            atEpochMs: result.result?.endedAtEpochMs ?? result.result?.startedAtEpochMs
        }];
    });
}

function toRollupFailureObservations(distributedRun: ControlDistributedRunSnapshot): FleetFailureObservation[] {
    return distributedRun.rollup.failures.flatMap((failure) => {
        const affectedAgentIds = distributedRun.targetAgentIds.filter((agentId) => failure.key.includes(agentId));
        const agentIds = affectedAgentIds.length > 0 ? affectedAgentIds : distributedRun.targetAgentIds;
        return agentIds.map((agentId) => ({
            agentId,
            category: toFleetFailureCategory(failure.error?.code, failure.error?.message),
            title: failure.kind === 'recipe' ? 'Recipe failure' : 'Participant failure',
            code: failure.error?.code,
            message: failure.error?.message ?? `${failure.kind} ${failure.state}`,
            recipeId: failure.kind === 'recipe' ? failure.key : undefined,
            atEpochMs: distributedRun.completedAtEpochMs ?? distributedRun.updatedAtEpochMs
        }));
    });
}

function toDiagnosticFailureObservations(
    { distributedRun, controlRun }: FleetRunFailureInput
): FleetFailureObservation[] {
    return (controlRun?.events ?? []).flatMap((event) => {
        const diagnostic = isFleetLinkedEvent(distributedRun, event) ? decodeFleetDiagnostic(event.payload) : undefined;
        if (!diagnostic || (diagnostic.severity !== 'error' && diagnostic.severity !== 'warning')) {
            return [];
        }
        return [{
            agentId: event.agentId,
            category: 'diagnostic',
            title: 'Runtime diagnostic',
            code: diagnostic.severity,
            message: diagnostic.message,
            diagnosticTypeId: diagnostic.diagnosticTypeId,
            transport: diagnostic.transport,
            atEpochMs: event.atEpochMs
        }];
    });
}

function addFailureObservation(tally: FleetRunFailureTally, observation: FleetFailureObservation): void {
    const normalizedMessage = toNormalizedFailureMessage(observation.message);
    const signatureId = toFailureSignatureId([
        observation.category,
        observation.code,
        observation.recipeId,
        observation.commandKind,
        observation.diagnosticTypeId,
        observation.transport,
        normalizedMessage
    ]);
    const signature = tally.signatures.get(signatureId) ?? toFailureSignatureTally(observation, signatureId);
    signature.count += 1;
    signature.firstSeenAtEpochMs = toEarliestEpochMs(signature.firstSeenAtEpochMs, observation.atEpochMs);
    signature.lastSeenAtEpochMs = toLatestEpochMs(signature.lastSeenAtEpochMs, observation.atEpochMs);
    signature.affectedAgents.add(observation.agentId);
    signature.affectedRegions.add(tally.labels.get(observation.agentId)?.region ?? UNLABELED_REGION);
    signature.affectedRuns.add(tally.runId);
    tally.signatures.set(signatureId, signature);

    const agentSignatureIds = tally.signatureIdsByAgent.get(observation.agentId) ?? new Set<string>();
    agentSignatureIds.add(signatureId);
    tally.signatureIdsByAgent.set(observation.agentId, agentSignatureIds);
}

function toFailureSignatureTally(
    observation: FleetFailureObservation,
    signatureId: string
): FleetFailureSignatureTally {
    return {
        signatureId,
        category: observation.category,
        title: observation.title,
        normalizedMessage: toNormalizedFailureMessage(observation.message),
        code: observation.code,
        recipeId: observation.recipeId,
        commandKind: observation.commandKind,
        diagnosticTypeId: observation.diagnosticTypeId,
        transport: observation.transport,
        count: 0,
        affectedAgents: new Set<string>(),
        affectedRegions: new Set<string>(),
        affectedRuns: new Set<string>(),
        likelyCause: toFleetFailureLikelyCause(observation.category, observation.code, observation.message),
        nextAction: toFleetFailureNextAction(observation.category, observation.code, observation.transport)
    };
}

function toSortedFailureSignatures(
    signatures: Iterable<FleetFailureSignatureTally>
): readonly ControlFleetFailureSignature[] {
    return Array.from(signatures, (signature) => ({
        ...signature,
        affectedAgents: [...signature.affectedAgents].sort(),
        affectedRegions: [...signature.affectedRegions].sort(),
        affectedRuns: [...signature.affectedRuns].sort()
    })).sort((left, right) => right.count - left.count || left.signatureId.localeCompare(right.signatureId));
}

function toNormalizedFailureMessage(message: string): string {
    return message.toLowerCase()
        .replaceAll(/[0-9a-f]{8,}/g, '<id>')
        .replaceAll(/\d+/g, '<n>')
        .replaceAll(/\s+/g, ' ')
        .trim()
        .slice(0, SIGNATURE_MESSAGE_LENGTH);
}

function toFailureSignatureId(parts: readonly (string | undefined)[]): string {
    const joined = parts.filter(Boolean).join('|') || 'unknown';
    const safe = joined.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '');
    return safe.slice(0, SIGNATURE_ID_LENGTH) || 'unknown';
}

function toEarliestEpochMs(left: number | undefined, right: number | undefined): number | undefined {
    return left === undefined ? right : right === undefined ? left : Math.min(left, right);
}

function toLatestEpochMs(left: number | undefined, right: number | undefined): number | undefined {
    return left === undefined ? right : right === undefined ? left : Math.max(left, right);
}
