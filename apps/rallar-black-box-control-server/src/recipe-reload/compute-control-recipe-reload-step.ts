import type { ControlCommandEnvelope, ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { computeCommandDeadlineEpochMs } from '@shared-test/rallar-bb-test/runtime/to-runtime-command-values.ts';

import type { ControlAgentState, ControlCommandState } from '../control-service-state.ts';
import {
    hasQueuedReloadSuccessor,
    isControlRecipeReloadRoot,
    isReloadChildEnvelope,
    toControlRecipeReloadCommands
} from './control-recipe-reload-commands.ts';
import {
    isControlRecipeReloadResult,
    toReloadCompletion,
    type ControlRecipeReloadRead,
    type ControlRecipeReloadStep
} from './control-recipe-reload-evidence.ts';

const WAIT: ControlRecipeReloadStep = { kind: 'wait' };

export function computeControlRecipeReloadStep(read: ControlRecipeReloadRead): ControlRecipeReloadStep {
    const { root, run, nowEpochMs } = read;
    if (root.completedAtEpochMs !== undefined || !isControlRecipeReloadRoot(root.envelope)) {
        return WAIT;
    }
    const deadline = computeReloadRootDeadline(root);
    if (deadline !== undefined && nowEpochMs >= deadline) {
        return toReloadCompletion(read, 'failed', 'RALLAR_BLACK_BOX_RECIPE_TIMEOUT');
    }
    const children = toControlRecipeReloadCommands(root.envelope);
    for (const child of children) {
        const command = run.commands.get(child.commandId);
        const result = run.results.get(child.commandId);
        if (command === undefined) {
            return hasMissingReloadEvidence(read, children, child)
                ? toReloadCompletion(read, 'failed', 'RALLAR_BLACK_BOX_RELOAD_EVIDENCE_CONFLICT')
                : { kind: 'queue', envelope: child };
        }
        if (!isReloadChildEnvelope(child, command.envelope)) {
            return toReloadCompletion(read, 'failed', 'RALLAR_BLACK_BOX_RELOAD_EVIDENCE_CONFLICT');
        }
        if (result === undefined) {
            return computeReloadPendingStep(read, command);
        }
        if (!isControlRecipeReloadResult(command, result)) {
            return toReloadCompletion(read, 'failed', 'RALLAR_BLACK_BOX_RELOAD_EVIDENCE_CONFLICT');
        }
        if (!result.ok) {
            return toReloadCompletion(
                read,
                result.result?.status === 'cancelled' ? 'cancelled' : 'failed',
                'RALLAR_BLACK_BOX_RECIPE_FAILED'
            );
        }
        if (child.command.kind === 'agent.reload' && !hasQueuedReloadSuccessor(children, child, run)) {
            const readiness = computeReloadReadiness(read, command);
            if (readiness !== undefined) {
                return readiness;
            }
        }
    }
    return toReloadCompletion(read, 'ok', undefined);
}

export function toCancelledControlRecipeReload(read: ControlRecipeReloadRead): ControlResultEnvelope {
    return toReloadCompletion(read, 'cancelled', 'RALLAR_BLACK_BOX_RECIPE_CANCELLED').envelope;
}

export function computeReloadRootDeadline(root: ControlCommandState): number | undefined {
    const command = {
        ...root.envelope.command,
        deadlineEpochMs: root.envelope.deadlineEpochMs ?? root.envelope.command.deadlineEpochMs
    };
    return root.dispatchedAtEpochMs === undefined
        ? command.deadlineEpochMs
        : computeCommandDeadlineEpochMs(command, root.dispatchedAtEpochMs);
}

function computeReloadPendingStep(
    read: ControlRecipeReloadRead,
    command: ControlCommandState
): ControlRecipeReloadStep {
    if (command.dispatchCount === 0) {
        return { kind: 'dispatch', envelope: command.envelope };
    }
    const agent = read.run.agents.get(command.envelope.agentId ?? '');
    if (
        agent?.connected &&
        command.lastDispatchedConnectionSequence !== agent.connectionSequence
    ) {
        return toReloadCompletion(read, 'failed', 'RALLAR_BLACK_BOX_RELOAD_RESULT_UNOBSERVABLE');
    }
    return command.envelope.command.kind === 'agent.reload' ? computeReloadReadiness(read, command) ?? WAIT : WAIT;
}

function computeReloadReadiness(
    read: ControlRecipeReloadRead,
    command: ControlCommandState
): ControlRecipeReloadStep | undefined {
    if (command.envelope.command.kind !== 'agent.reload' || command.dispatchedAtEpochMs === undefined) {
        return WAIT;
    }
    const deadlineEpochMs = Math.min(
        command.dispatchedAtEpochMs + command.envelope.command.readyTimeoutMs,
        command.envelope.command.deadlineEpochMs ?? Infinity
    );
    if (read.nowEpochMs >= deadlineEpochMs) {
        return toReloadCompletion(read, 'failed', 'RALLAR_BLACK_BOX_RELOAD_READY_TIMEOUT');
    }
    const agent = read.run.agents.get(command.envelope.agentId ?? '');
    return isReloadResumed(agent, command) ? undefined : WAIT;
}

function isReloadResumed(agent: ControlAgentState | undefined, command: ControlCommandState): boolean {
    return agent?.connected === true && command.lastDispatchedConnectionSequence !== undefined &&
        agent.connectionSequence > command.lastDispatchedConnectionSequence &&
        agent.resumeCompletedCommandIds.has(command.envelope.commandId);
}

export function toControlRecipeReloadDispatch(
    root: ControlCommandState | undefined,
    child: ControlCommandEnvelope
): ControlCommandEnvelope {
    if (!root) {
        return child;
    }
    const deadlineEpochMs = Math.min(
        computeReloadRootDeadline(root) ?? Infinity,
        child.command.deadlineEpochMs ?? Infinity
    );
    return deadlineEpochMs === Infinity ? child : { ...child, deadlineEpochMs };
}

function hasMissingReloadEvidence(
    read: ControlRecipeReloadRead,
    children: readonly ControlCommandEnvelope[],
    child: ControlCommandEnvelope
): boolean {
    return read.run.results.has(child.commandId) ||
        (children[0] === child && read.root.dispatchedAtEpochMs !== undefined) ||
        children.slice(children.indexOf(child) + 1).some((later) =>
            read.run.commands.has(later.commandId) || read.run.results.has(later.commandId)
        );
}
