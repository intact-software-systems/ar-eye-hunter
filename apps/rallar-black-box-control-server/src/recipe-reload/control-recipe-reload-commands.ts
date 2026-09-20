import {
    hasAlmReloadPair,
    hasAuthoredAlmReloadCheckpoints,
    resolveAlmReloadRole,
    toAlmReloadPair,
    validateAlmReloadRoot
} from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import type { ControlCommandEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipeRunCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import type { ControlCommandState, ControlRunState } from '../control-service-state.ts';

export interface ControlRecipeReloadRoot extends ControlCommandEnvelope {
    readonly command: RallarBlackBoxTestRecipeRunCommand & {
        readonly recipe: NonNullable<RallarBlackBoxTestRecipeRunCommand['recipe']>;
    };
}

export function isControlRecipeReloadRoot(envelope: ControlCommandEnvelope): envelope is ControlRecipeReloadRoot {
    return envelope.command.kind === 'recipe.run' && envelope.command.recipe !== undefined &&
        (hasAlmReloadPair(envelope.command) || hasAuthoredAlmReloadCheckpoints(envelope.command) ||
            (envelope.command.recipe.metadata?.profile === 'alm-conformance' &&
                envelope.command.recipe.commands.some(containsReload)));
}

export function validateControlRecipeReloadRoot(envelope: ControlRecipeReloadRoot): readonly string[] {
    const recipe = envelope.command.recipe;
    const issues: string[] = [];
    if (recipe.continueOnFailure !== false) {
        issues.push('ALM reload recipes require continueOnFailure=false.');
    }
    if (recipe.commands.some((command) => command.kind !== 'agent.reload' && containsReload(command))) {
        issues.push('ALM reload recipes require direct linear reload commands.');
    }
    if (recipe.commands.some((command) => !command.commandId)) {
        issues.push('ALM reload recipe children require explicit command IDs.');
    }
    if (new Set(recipe.commands.map((command) => command.commandId)).size !== recipe.commands.length) {
        issues.push('ALM reload recipe child IDs must be unique.');
    }
    return issues;
}

export function toControlRecipeReloadCommands(root: ControlRecipeReloadRoot): readonly ControlCommandEnvelope[] {
    if (hasAlmReloadPair(root.command) || hasAuthoredAlmReloadCheckpoints(root.command)) {
        return toPairedReloadCommands(root);
    }
    const commands: ControlCommandEnvelope[] = [];
    let segment: RallarBlackBoxTestCommand[] = [];
    for (const command of root.command.recipe.commands) {
        if (command.kind !== 'agent.reload') {
            segment.push(command);
            continue;
        }
        if (segment.length > 0) {
            commands.push(toReloadSegment(root, segment, commands.length));
            segment = [];
        }
        commands.push(toReloadChild(root, command, commands.length));
    }
    if (segment.length > 0) {
        commands.push(toReloadSegment(root, segment, commands.length));
    }
    return commands;
}

export function resolveControlRecipeReloadOwner(
    run: ControlRunState,
    commandId: string
): ControlCommandState | undefined {
    for (const root of run.commands.values()) {
        if (
            isControlRecipeReloadRoot(root.envelope) && (root.envelope.commandId === commandId ||
                toControlRecipeReloadCommands(root.envelope).some((child) => child.commandId === commandId))
        ) {
            return root;
        }
    }
    return undefined;
}

export function isReloadChildEnvelope(expected: ControlCommandEnvelope, actual: ControlCommandEnvelope): boolean {
    return JSON.stringify(expected) === JSON.stringify(actual);
}

function containsReload(command: RallarBlackBoxTestCommand): boolean {
    switch (command.kind) {
        case 'agent.reload':
            return true;
        case 'recipe.run':
        case 'recipe.load':
            return command.recipe?.commands.some(containsReload) ?? false;
        case 'loop':
            return command.commands.some(containsReload);
        case 'parallel':
            return command.groups.some((group) => group.commands.some(containsReload));
        default:
            return false;
    }
}

function toReloadChild(
    root: ControlRecipeReloadRoot,
    command: RallarBlackBoxTestCommand,
    index: number
): ControlCommandEnvelope {
    const commandId = `alm-reload:${JSON.stringify(root.commandId)}:${index}`;
    return {
        ...root,
        commandId,
        command: { ...command, commandId },
        deadlineEpochMs: root.deadlineEpochMs ?? root.command.deadlineEpochMs
    };
}

function toReloadSegment(
    root: ControlRecipeReloadRoot,
    commands: readonly RallarBlackBoxTestCommand[],
    index: number
): ControlCommandEnvelope {
    return toReloadChild(root, {
        kind: 'recipe.run',
        recipe: {
            schemaVersion: 1,
            recipeId: `${root.command.recipe.recipeId}:segment:${index}`,
            continueOnFailure: false,
            commands
        }
    }, index);
}

export function validateControlRecipeReloadEnqueue(
    run: ControlRunState,
    envelope: ControlCommandEnvelope
): readonly string[] {
    if (hasAuthoredAlmReloadCheckpoints(envelope.command) && !hasAlmReloadPair(envelope.command)) {
        return ['Authored ALM reload checkpoints require exact paired control binding.'];
    }
    if (hasAlmReloadPair(envelope.command)) {
        const pairIssues = validateAlmReloadRoot(envelope);
        if (pairIssues.length > 0) {
            return pairIssues;
        }
        const pair = toAlmReloadPair(envelope.command)!;
        const peerAddress = pair.sender.commandId === envelope.commandId ? pair.receiver : pair.sender;
        const peer = run.commands.get(peerAddress.commandId);
        if (peer && JSON.stringify(toAlmReloadPair(peer.envelope.command)) !== JSON.stringify(pair)) {
            return ['ALM reload pair roots must contain reciprocal exact addresses and checkpoints.'];
        }
    }
    const owner = resolveControlRecipeReloadOwner(run, envelope.commandId);
    if (owner && owner.envelope.commandId !== envelope.commandId) {
        return ['Command ID belongs to an ALM reload recipe.'];
    }
    if (!isControlRecipeReloadRoot(envelope)) {
        return [];
    }
    const issues = [...validateControlRecipeReloadRoot(envelope)];
    if (!run.commands.has(envelope.commandId)) {
        if (run.results.has(envelope.commandId)) {
            issues.push('ALM reload root already has external result evidence.');
        }
        for (const child of toControlRecipeReloadCommands(envelope)) {
            if (run.commands.has(child.commandId) || run.results.has(child.commandId)) {
                issues.push('ALM reload child ID already has external evidence.');
            }
        }
    }
    return issues;
}

function toPairedReloadCommands(root: ControlRecipeReloadRoot): readonly ControlCommandEnvelope[] {
    const pair = toAlmReloadPair(root.command);
    const role = pair ? resolveAlmReloadRole(pair, root) : undefined;
    if (!pair || !role || validateAlmReloadRoot(root).length > 0) {
        return [];
    }
    const recipe = root.command.recipe;
    const boundaries = pair.checkpoints.flatMap((checkpoint) =>
        role === 'sender'
            ? [checkpoint.senderPrefixEnd, checkpoint.senderReload, checkpoint.senderSuffixEnd]
            : [checkpoint.receiverReadyEnd, checkpoint.receiverAbsenceEnd, checkpoint.receiverRecoveryEnd]
    );
    const commands: ControlCommandEnvelope[] = [];
    let start = 0;
    for (const boundary of boundaries) {
        const end = recipe.commands.findIndex((command) => command.commandId === boundary);
        const segment = recipe.commands.slice(start, end + 1);
        commands.push(
            segment.length === 1 && segment[0].kind === 'agent.reload'
                ? toReloadChild(root, segment[0], commands.length)
                : toReloadSegment(root, segment, commands.length)
        );
        start = end + 1;
    }
    if (start < recipe.commands.length) {
        commands.push(toReloadSegment(root, recipe.commands.slice(start), commands.length));
    }
    return commands;
}

export interface ControlRecipeReloadState extends ControlCommandState {
    readonly envelope: ControlRecipeReloadRoot;
}

export function toPendingControlRecipeReloadRoots(
    commands: Iterable<ControlCommandState>
): readonly ControlRecipeReloadState[] {
    return Array.from(commands).filter((root): root is ControlRecipeReloadState =>
        root.completedAtEpochMs === undefined && isControlRecipeReloadRoot(root.envelope)
    );
}

export function hasQueuedReloadSuccessor(
    children: readonly ControlCommandEnvelope[],
    child: ControlCommandEnvelope,
    run: ControlRunState
): boolean {
    const successor = children[children.indexOf(child) + 1];
    const queued = successor ? run.commands.get(successor.commandId) : undefined;
    return successor !== undefined && queued !== undefined && isReloadChildEnvelope(successor, queued.envelope);
}
