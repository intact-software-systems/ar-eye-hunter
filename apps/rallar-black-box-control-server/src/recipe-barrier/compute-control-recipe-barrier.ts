import {
    decodeBarrierArrival,
    type ControlBarrierEnvelope,
    type ControlBarrierFailureReason,
    type ControlBarrierResolution,
    type RallarBlackBoxBarrierArrival
} from '@shared-test/rallar-bb-test/barrier/control-barrier-protocol.ts';
import {
    RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
    type ControlEventEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import { Either } from '@shared/resilience/Either.ts';

import type {
    ControlAgentState,
    ControlDistributedRunState,
    ControlRecipeBarrierParticipant,
    ControlRecipeBarrierState,
    ControlRunState
} from '../control-service-state.ts';

export interface ControlRecipeBarrierArrivalRead {
    readonly run: ControlRunState;
    readonly envelope: ControlEventEnvelope;
    readonly distributedRuns: Iterable<ControlDistributedRunState>;
    readonly nowEpochMs: number;
}

export interface ControlRecipeBarrierDeliveryRead {
    readonly run: ControlRunState;
    readonly agent: ControlAgentState;
    readonly nowEpochMs: number;
}

export interface ControlRecipeBarrierDelivery {
    readonly barriers: readonly ControlRecipeBarrierState[];
    readonly envelopes: readonly ControlBarrierEnvelope[];
}

interface DeliveredBarrier {
    readonly barrier: ControlRecipeBarrierState;
    /** Undefined when this agent has nothing new to hear on its current connection. */
    readonly envelope: ControlBarrierEnvelope | undefined;
}

const EVERY_STARTED_AGENT = 'every-started-agent';

/** The barrier one forwarded event opens or joins; undefined when the event is no barrier arrival. */
export function computeControlRecipeBarrierArrival(
    read: ControlRecipeBarrierArrivalRead
): ControlRecipeBarrierState | undefined {
    const arrival = read.envelope.kind === 'event' ? decodeBarrierArrival(read.envelope.payload).right : undefined;
    if (arrival === undefined) {
        return undefined;
    }
    const barrier = read.run.barriers.get(arrival.barrierId) ?? toOpenedBarrier(arrival, read);
    const agentId = read.envelope.agentId;
    if (barrier.arrivedAgentIds.includes(agentId)) {
        return barrier;
    }
    const issue = resolveArrivalIssue(barrier, arrival, agentId);
    const arrivedAgentIds = [...barrier.arrivedAgentIds, agentId];
    if (barrier.resolution === undefined || issue === undefined) {
        return { ...barrier, arrivedAgentIds, issue: barrier.issue ?? issue };
    }
    return { ...barrier, arrivedAgentIds, lateArrivalIssues: { ...barrier.lateArrivalIssues, [agentId]: issue } };
}

/** Every barrier with the resolution now due, and the envelopes this agent has not heard on its current connection. */
export function computeControlRecipeBarrierDelivery(
    read: ControlRecipeBarrierDeliveryRead
): ControlRecipeBarrierDelivery {
    const delivered = [...read.run.barriers.values()].map((barrier) =>
        toDeliveredBarrier({ ...barrier, resolution: computeControlRecipeBarrierResolution(barrier, read) }, read.agent)
    );
    return {
        barriers: delivered.map((entry) => entry.barrier),
        envelopes: delivered.flatMap((entry) => entry.envelope === undefined ? [] : [entry.envelope])
    };
}

function computeControlRecipeBarrierResolution(
    barrier: ControlRecipeBarrierState,
    read: Pick<ControlRecipeBarrierDeliveryRead, 'run' | 'nowEpochMs'>
): ControlBarrierResolution | undefined {
    if (barrier.resolution !== undefined) {
        return barrier.resolution;
    }
    const missing = barrier.participants.filter((participant) =>
        !barrier.arrivedAgentIds.includes(participant.agentId)
    );
    if (barrier.issue === undefined && missing.length === 0) {
        return { outcome: 'released', arrivedAgentIds: barrier.arrivedAgentIds };
    }
    const reason = barrier.issue ??
        (missing.some((participant) => read.run.results.get(participant.startCommandId)?.ok === false)
            ? 'participant-failed'
            : undefined) ??
        (read.nowEpochMs >= barrier.openedAtEpochMs + barrier.timeoutMs ? 'timed-out' : undefined);
    return reason === undefined ? undefined : {
        outcome: 'failed',
        reason,
        arrivedAgentIds: barrier.arrivedAgentIds,
        missingAgentIds: missing.map((participant) => participant.agentId)
    };
}

function toOpenedBarrier(
    arrival: RallarBlackBoxBarrierArrival,
    read: ControlRecipeBarrierArrivalRead
): ControlRecipeBarrierState {
    const participants = resolveBarrierParticipants(
        resolveStartedDistributedRun(read.distributedRuns, read.run.runId),
        arrival.participants
    );
    return {
        barrierId: arrival.barrierId,
        timeoutMs: arrival.timeoutMs,
        authoredParticipants: toAuthoredParticipants(arrival.participants),
        participants: participants.right ?? [],
        openedAtEpochMs: read.nowEpochMs,
        arrivedAgentIds: [],
        issue: participants.left,
        resolution: undefined,
        lateArrivalIssues: {},
        deliveredConnectionSequences: {}
    };
}

function resolveArrivalIssue(
    barrier: ControlRecipeBarrierState,
    arrival: RallarBlackBoxBarrierArrival,
    agentId: string
): ControlBarrierFailureReason | undefined {
    if (
        barrier.timeoutMs !== arrival.timeoutMs ||
        barrier.authoredParticipants !== toAuthoredParticipants(arrival.participants)
    ) {
        return 'conflicting-arrival';
    }
    return barrier.participants.some((participant) => participant.agentId === agentId)
        ? undefined
        : 'not-a-participant';
}

/** The latest started distributed run of the control run owns the participant set. */
function resolveStartedDistributedRun(
    distributedRuns: Iterable<ControlDistributedRunState>,
    controlRunId: string
): ControlDistributedRunState | undefined {
    return [...distributedRuns]
        .filter((distributedRun) =>
            distributedRun.controlRunId === controlRunId && distributedRun.startedAtEpochMs !== undefined
        )
        .sort((left, right) => (right.startedAtEpochMs ?? 0) - (left.startedAtEpochMs ?? 0))[0];
}

function resolveBarrierParticipants(
    distributedRun: ControlDistributedRunState | undefined,
    roles: readonly string[] | undefined
): Either<ControlBarrierFailureReason, readonly ControlRecipeBarrierParticipant[]> {
    if (distributedRun === undefined) {
        return Either.ofLeft('no-distributed-run');
    }
    const starts = distributedRun.commandLinks.filter((link) =>
        link.phase === 'start' && (roles === undefined || (link.role !== undefined && roles.includes(link.role)))
    );
    if (roles !== undefined && roles.some((role) => !starts.some((link) => link.role === role))) {
        return Either.ofLeft('unknown-participant-role');
    }
    return Either.ofRight(
        starts
            .filter((link, index) => starts.findIndex((other) => other.agentId === link.agentId) === index)
            .map((link) => ({ agentId: link.agentId, startCommandId: link.commandId }))
    );
}

function toAuthoredParticipants(roles: readonly string[] | undefined): string {
    return roles === undefined ? EVERY_STARTED_AGENT : JSON.stringify([...roles].sort());
}

function toDeliveredBarrier(barrier: ControlRecipeBarrierState, agent: ControlAgentState): DeliveredBarrier {
    const resolution = toAgentResolution(barrier, agent.agentId);
    if (
        resolution === undefined || !barrier.arrivedAgentIds.includes(agent.agentId) ||
        barrier.deliveredConnectionSequences[agent.agentId] === agent.connectionSequence
    ) {
        return { barrier, envelope: undefined };
    }
    return {
        barrier: {
            ...barrier,
            deliveredConnectionSequences: {
                ...barrier.deliveredConnectionSequences,
                [agent.agentId]: agent.connectionSequence
            }
        },
        envelope: {
            kind: 'barrier',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: agent.runId,
            agentId: agent.agentId,
            barrierId: barrier.barrierId,
            resolution
        }
    };
}

function toAgentResolution(barrier: ControlRecipeBarrierState, agentId: string): ControlBarrierResolution | undefined {
    const lateIssue = barrier.lateArrivalIssues[agentId];
    if (barrier.resolution === undefined || lateIssue === undefined) {
        return barrier.resolution;
    }
    return { outcome: 'failed', reason: lateIssue, arrivedAgentIds: barrier.arrivedAgentIds, missingAgentIds: [] };
}
