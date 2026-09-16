import type { ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    ControlDistributedRunCommandLink,
    ControlDistributedRunCommandPhase
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    rollupDistributedRunResult,
    type RallarBlackBoxDistributedParticipantResult,
    type RallarBlackBoxDistributedRunRollup
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import { computeDistributedGroupAssertionResults } from '@shared-test/rallar-bb-test/distributed/group-assertions-evaluation.ts';
import {
    toDistributedGroupAssertionParticipants,
    toDistributedGroupAssertionRecipeEvidence
} from '@shared-test/rallar-bb-test/distributed/group-assertions-evidence.ts';
import type { RallarBlackBoxTestRedactionOptions } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import type { ControlDistributedRunState, ControlRunState } from '../control-service-state.ts';
import {
    resolveFirstStartedAtEpochMs,
    resolveLastEndedAtEpochMs,
    toDistributedRecipeResult,
    toDistributedRunResultError
} from './distributed-recipe-results.ts';
import { toDistributedBarrierTimeoutMs } from './distributed-run-commands.ts';
import { toRolesForAgent } from './distributed-run-targeting.ts';

export interface DistributedRunEvaluationInput {
    readonly distributedRun: ControlDistributedRunState;
    readonly run: ControlRunState | undefined;
    readonly redaction: RallarBlackBoxTestRedactionOptions | undefined;
    readonly nowEpochMs: number;
}

interface ParticipantEvaluationInput {
    readonly distributedRun: ControlDistributedRunState;
    readonly run: ControlRunState | undefined;
    readonly agentId: string;
    readonly nowEpochMs: number;
}

interface PhaseEvidence {
    readonly links: readonly ControlDistributedRunCommandLink[];
    readonly results: readonly ControlResultEnvelope[];
}

type ParticipantIdentity = Pick<
    RallarBlackBoxDistributedParticipantResult,
    'agentId' | 'clientId' | 'sessionId' | 'roles'
>;

interface ParticipantEvidence {
    readonly input: ParticipantEvaluationInput;
    readonly identity: ParticipantIdentity;
    readonly connected: boolean | undefined;
    readonly stage: PhaseEvidence;
    readonly barrier: PhaseEvidence;
    readonly start: PhaseEvidence;
}

export function toDistributedRunRollup(
    { distributedRun, run, redaction, nowEpochMs }: DistributedRunEvaluationInput
): RallarBlackBoxDistributedRunRollup {
    const participants = distributedRun.targetAgentIds.map((agentId) =>
        toDistributedParticipantResult({ distributedRun, run, agentId, nowEpochMs })
    );
    const recipes = distributedRun.commandLinks
        .filter((link) => link.phase === 'start')
        .map((link) =>
            toDistributedRecipeResult({
                link,
                dispatched: run?.commands.get(link.commandId)?.dispatchedAtEpochMs !== undefined,
                result: run?.results.get(link.commandId)
            })
        );
    const groupAssertions = computeDistributedGroupAssertionResults({
        manifest: distributedRun.manifest,
        participants: toDistributedGroupAssertionParticipants(distributedRun.targetResolution),
        recipeResults: recipes,
        recipeEvidence: toDistributedGroupAssertionRecipeEvidence({
            commandLinks: distributedRun.commandLinks,
            resultByCommandId: run?.results ?? new Map()
        }),
        redaction
    });

    return rollupDistributedRunResult({
        stateHint: distributedRun.state,
        participants,
        recipes,
        groupAssertions
    });
}

export function isDistributedAckTimedOut(distributedRun: ControlDistributedRunState, nowEpochMs: number): boolean {
    return (distributedRun.state === 'waiting-for-ack' || distributedRun.state === 'timed-out') &&
        distributedRun.stagedAtEpochMs !== undefined &&
        nowEpochMs > distributedRun.stagedAtEpochMs + distributedRun.manifest.ackTimeoutMs;
}

export function isDistributedBarrierTimedOut(distributedRun: ControlDistributedRunState, nowEpochMs: number): boolean {
    const barrierTimeoutMs = toDistributedBarrierTimeoutMs(distributedRun);
    return (distributedRun.state === 'waiting-for-barrier' || distributedRun.state === 'timed-out') &&
        distributedRun.barrierStartedAtEpochMs !== undefined &&
        barrierTimeoutMs !== undefined &&
        nowEpochMs > distributedRun.barrierStartedAtEpochMs + barrierTimeoutMs;
}

function toDistributedParticipantResult(input: ParticipantEvaluationInput): RallarBlackBoxDistributedParticipantResult {
    const evidence = toParticipantEvidence(input);
    const failed = [...evidence.stage.results, ...evidence.barrier.results, ...evidence.start.results]
        .find((result) => !result.ok);
    if (failed) {
        return { ...evidence.identity, state: 'failed', ok: false, error: toDistributedRunResultError(failed) };
    }
    const timeout = toParticipantTimeout(evidence);
    if (timeout) {
        return timeout;
    }
    if (evidence.start.links.length > 0) {
        return toStartedParticipant(evidence);
    }
    if (evidence.barrier.links.length > 0) {
        return toBarrierParticipant(evidence);
    }
    return toStagedParticipant(evidence);
}

function toParticipantEvidence(input: ParticipantEvaluationInput): ParticipantEvidence {
    const { distributedRun, run, agentId } = input;
    const agent = run?.agents.get(agentId);
    return {
        input,
        identity: {
            agentId,
            clientId: agent?.identity?.clientId,
            sessionId: agent?.identity?.sessionId,
            roles: Array.from(toRolesForAgent(distributedRun, agentId))
        },
        connected: agent?.connected,
        stage: toPhaseEvidence(input, 'stage'),
        barrier: toPhaseEvidence(input, 'barrier'),
        start: toPhaseEvidence(input, 'start')
    };
}

function toPhaseEvidence(
    { distributedRun, run, agentId }: ParticipantEvaluationInput,
    phase: ControlDistributedRunCommandPhase
): PhaseEvidence {
    const links = distributedRun.commandLinks.filter((link) => link.phase === phase && link.agentId === agentId);
    return {
        links,
        results: links
            .map((link) => run?.results.get(link.commandId))
            .filter((result): result is ControlResultEnvelope => Boolean(result))
    };
}

function toParticipantTimeout(evidence: ParticipantEvidence): RallarBlackBoxDistributedParticipantResult | undefined {
    const { input, stage, barrier, start } = evidence;
    if (start.links.length > 0) {
        return undefined;
    }
    if (
        isDistributedAckTimedOut(input.distributedRun, input.nowEpochMs) &&
        (stage.links.length === 0 || stage.results.length < stage.links.length)
    ) {
        return toAckTimeoutParticipant(evidence);
    }
    if (
        isDistributedBarrierTimedOut(input.distributedRun, input.nowEpochMs) &&
        barrier.links.length > 0 &&
        barrier.results.length < barrier.links.length
    ) {
        return toBarrierTimeoutParticipant(evidence);
    }
    return undefined;
}

function toAckTimeoutParticipant({ input, identity }: ParticipantEvidence): RallarBlackBoxDistributedParticipantResult {
    return {
        ...identity,
        state: 'timed-out',
        ok: false,
        error: {
            code: 'RALLAR_BB_DISTRIBUTED_ACK_TIMEOUT',
            message: `Agent ${identity.agentId} did not ACK distributed-run staging before ackTimeoutMs.`,
            details: {
                ackTimeoutMs: input.distributedRun.manifest.ackTimeoutMs,
                stagedAtEpochMs: input.distributedRun.stagedAtEpochMs
            }
        }
    };
}

function toBarrierTimeoutParticipant(
    { input, identity }: ParticipantEvidence
): RallarBlackBoxDistributedParticipantResult {
    return {
        ...identity,
        state: 'timed-out',
        ok: false,
        error: {
            code: 'RALLAR_BB_DISTRIBUTED_BARRIER_TIMEOUT',
            message: `Agent ${identity.agentId} did not report barrier.ready before barrier timeout.`,
            details: {
                barrierTimeoutMs: toDistributedBarrierTimeoutMs(input.distributedRun),
                barrierStartedAtEpochMs: input.distributedRun.barrierStartedAtEpochMs
            }
        }
    };
}

function toStartedParticipant({ identity, start }: ParticipantEvidence): RallarBlackBoxDistributedParticipantResult {
    return start.results.length === start.links.length
        ? {
            ...identity,
            state: 'passed',
            ok: true,
            startedAtEpochMs: resolveFirstStartedAtEpochMs(start.results),
            endedAtEpochMs: resolveLastEndedAtEpochMs(start.results)
        }
        : { ...identity, state: 'running' };
}

function toBarrierParticipant(
    { identity, stage, barrier, connected }: ParticipantEvidence
): RallarBlackBoxDistributedParticipantResult {
    if (barrier.results.length === barrier.links.length) {
        return {
            ...identity,
            state: 'ready',
            ok: true,
            acknowledgedAtEpochMs: resolveLastEndedAtEpochMs([...stage.results, ...barrier.results])
        };
    }
    if (connected === false) {
        return {
            ...identity,
            state: 'disconnected',
            ok: false,
            error: {
                code: 'RALLAR_BB_DISTRIBUTED_BARRIER_DISCONNECTED',
                message: `Agent ${identity.agentId} disconnected while waiting at the distributed barrier.`
            }
        };
    }
    return { ...identity, state: 'acknowledged', acknowledgedAtEpochMs: resolveLastEndedAtEpochMs(stage.results) };
}

function toStagedParticipant(
    { identity, stage, connected }: ParticipantEvidence
): RallarBlackBoxDistributedParticipantResult {
    if (stage.links.length > 0 && stage.results.length === stage.links.length) {
        return {
            ...identity,
            state: 'ready',
            ok: true,
            acknowledgedAtEpochMs: resolveLastEndedAtEpochMs(stage.results)
        };
    }
    return {
        ...identity,
        state: stage.results.length > 0 ? 'acknowledged' : connected === false ? 'disconnected' : 'targeted'
    };
}
