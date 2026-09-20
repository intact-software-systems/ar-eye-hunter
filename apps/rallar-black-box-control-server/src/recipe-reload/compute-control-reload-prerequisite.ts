import {
    resolveAlmReloadRole,
    toAlmReloadPair,
    validateAlmReloadRoot,
    type AlmReloadPair
} from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import type { ControlCommandEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';

import {
    isControlRecipeReloadRoot,
    toControlRecipeReloadCommands,
    type ControlRecipeReloadRoot
} from './control-recipe-reload-commands.ts';
import {
    isControlRecipeReloadResult,
    toReloadCompletion,
    type ControlRecipeReloadRead,
    type ControlRecipeReloadStep
} from './control-recipe-reload-evidence.ts';

/** Fixed ALM role checkpoints; no caller-defined dependency graph or independent progress state. */
export function computeControlReloadPrerequisite(
    read: ControlRecipeReloadRead,
    child: ControlCommandEnvelope | undefined
): ControlRecipeReloadStep | undefined {
    const pair = toAlmReloadPair(read.root.envelope.command);
    if (!pair) {
        return undefined;
    }
    const sender = read.run.commands.get(pair.sender.commandId);
    const receiver = read.run.commands.get(pair.receiver.commandId);
    if (!sender || !receiver) {
        return { kind: 'wait' };
    }
    const roots = [sender, receiver];
    if (
        roots.some((root) =>
            validateAlmReloadRoot(root.envelope).length > 0 ||
            JSON.stringify(toAlmReloadPair(root.envelope.command)) !== JSON.stringify(pair)
        )
    ) {
        return toReloadCompletion(read, 'failed', 'RALLAR_BLACK_BOX_RELOAD_EVIDENCE_CONFLICT');
    }
    for (const root of roots) {
        const result = read.run.results.get(root.envelope.commandId);
        if (result && !result.ok) {
            return toReloadCompletion(
                read,
                result.result?.status === 'cancelled' ? 'cancelled' : 'failed',
                'RALLAR_BLACK_BOX_RECIPE_FAILED'
            );
        }
    }
    if (!isControlRecipeReloadRoot(receiver.envelope) || !isControlRecipeReloadRoot(sender.envelope)) {
        return toReloadCompletion(read, 'failed', 'RALLAR_BLACK_BOX_RELOAD_EVIDENCE_CONFLICT');
    }
    const receiverFence = computeReceiverGenerationFence(read, receiver.envelope, pair);
    if (receiverFence) {
        return receiverFence;
    }
    const receiverChildren = toControlRecipeReloadCommands(receiver.envelope);
    if (!child) {
        return undefined;
    }
    const role = resolveAlmReloadRole(pair, read.root.envelope)!;
    const own = role === 'sender' ? sender : receiver;
    if (!isControlRecipeReloadRoot(own.envelope)) {
        return toReloadCompletion(read, 'failed', 'RALLAR_BLACK_BOX_RELOAD_EVIDENCE_CONFLICT');
    }
    const index = toControlRecipeReloadCommands(own.envelope).findIndex((candidate) =>
        candidate.commandId === child.commandId
    );
    const peerChildren = role === 'sender' ? receiverChildren : toControlRecipeReloadCommands(sender.envelope);
    const prerequisiteIndex = resolvePrerequisiteIndex(index, role, pair.checkpoints.length);
    return prerequisiteIndex === undefined
        ? undefined
        : computePrerequisiteResult(read, peerChildren[prerequisiteIndex]);
}

/** Receiver-ready proof stays on one generation until the authored final recovery evidence is complete. */
function computeReceiverGenerationFence(
    read: ControlRecipeReloadRead,
    receiver: ControlRecipeReloadRoot,
    pair: AlmReloadPair
): ControlRecipeReloadStep | undefined {
    const receiverChildren = toControlRecipeReloadCommands(receiver);
    const ready = read.run.commands.get(receiverChildren[0].commandId);
    const agent = read.run.agents.get(pair.receiver.agentId);
    const recovered = receiverChildren[pair.checkpoints.length * 3 - 1];
    const recovery = read.run.commands.get(recovered.commandId);
    const recoveryResult = read.run.results.get(recovered.commandId);
    const recoveryCompleted = recovery !== undefined && recoveryResult?.ok === true &&
        isControlRecipeReloadResult(recovery, recoveryResult);
    if (
        !recoveryCompleted && ready && ready.dispatchCount > 0 &&
        (!agent?.connected || ready.lastDispatchedConnectionSequence !== agent.connectionSequence)
    ) {
        return toReloadCompletion(read, 'failed', 'RALLAR_BLACK_BOX_RELOAD_RECEIVER_CHANGED');
    }
    return undefined;
}

function resolvePrerequisiteIndex(
    index: number,
    role: 'sender' | 'receiver',
    checkpointCount: number
): number | undefined {
    if (index === checkpointCount * 3) {
        return index - 1;
    }
    const phase = index % 3;
    if (phase === 0) {
        return index === 0 ? undefined : index - 1;
    }
    if (phase === 1) {
        return role === 'sender' ? index : index - 1;
    }
    return undefined;
}

function computePrerequisiteResult(
    read: ControlRecipeReloadRead,
    expected: ControlCommandEnvelope
): ControlRecipeReloadStep | undefined {
    const command = read.run.commands.get(expected.commandId);
    const result = read.run.results.get(expected.commandId);
    if (!command || !result) {
        return { kind: 'wait' };
    }
    if (
        JSON.stringify(command.envelope) !== JSON.stringify(expected) || !isControlRecipeReloadResult(command, result)
    ) {
        return toReloadCompletion(read, 'failed', 'RALLAR_BLACK_BOX_RELOAD_EVIDENCE_CONFLICT');
    }
    return result.ok
        ? undefined
        : toReloadCompletion(
            read,
            result.result?.status === 'cancelled' ? 'cancelled' : 'failed',
            'RALLAR_BLACK_BOX_RECIPE_FAILED'
        );
}
