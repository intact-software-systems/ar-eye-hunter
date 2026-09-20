import { Either } from '@shared/resilience/Either.ts';

import type { ControlCommandEnvelope } from '../../control-protocol.ts';
import type { RallarBlackBoxTestCommand, RallarBlackBoxTestRecipe } from '../../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../../schema/json-schema-validation.ts';

export interface AlmReloadCheckpoint {
    readonly key: string;
    readonly senderPrefixEnd: string;
    readonly senderReload: string;
    readonly senderSuffixEnd: string;
    readonly receiverReadyEnd: string;
    readonly receiverAbsenceEnd: string;
    readonly receiverRecoveryEnd: string;
}

export interface AlmReloadRootAddress {
    readonly agentId: string;
    readonly commandId: string;
}

export interface AlmReloadPair {
    readonly runId: string;
    readonly sender: AlmReloadRootAddress;
    readonly receiver: AlmReloadRootAddress;
    readonly checkpoints: readonly AlmReloadCheckpoint[];
}

export interface AlmReloadPairCommands {
    readonly sender: ControlCommandEnvelope;
    readonly receiver: ControlCommandEnvelope;
}

export type AlmReloadRole = 'sender' | 'receiver';

export function hasAuthoredAlmReloadCheckpoints(command: RallarBlackBoxTestCommand): boolean {
    return command.kind === 'recipe.run' && command.recipe?.metadata !== undefined &&
        Object.hasOwn(command.recipe.metadata, 'almReloadCheckpoints');
}

export function hasAlmReloadPair(command: RallarBlackBoxTestCommand): boolean {
    return command.metadata !== undefined && Object.hasOwn(command.metadata, 'almReloadPair');
}

/** Raw command metadata is decoded once before the fixed checkpoint policy reads it. */
export function toAlmReloadPair(command: RallarBlackBoxTestCommand): AlmReloadPair | undefined {
    const value = command.metadata?.almReloadPair;
    if (
        !isJsonRecordValue(value) || !isNonemptyString(value.runId) ||
        !isAlmReloadRootAddress(value.sender) || !isAlmReloadRootAddress(value.receiver)
    ) {
        return undefined;
    }
    const checkpoints = toAlmReloadCheckpoints(value.checkpoints);
    return checkpoints
        ? { runId: value.runId, sender: value.sender, receiver: value.receiver, checkpoints }
        : undefined;
}

export function toAlmReloadCheckpoints(value: unknown): readonly AlmReloadCheckpoint[] | undefined {
    return Array.isArray(value) && value.length > 0 && value.every(isAlmReloadCheckpoint)
        ? value
        : undefined;
}

/** Both dispatch callers bind the same authored pair using the actual control addresses. */
export function bindAlmReloadPair(commands: AlmReloadPairCommands): Either<readonly string[], AlmReloadPairCommands> {
    const sender = commands.sender;
    const receiver = commands.receiver;
    const checkpoints = sender.command.kind === 'recipe.run'
        ? toAlmReloadCheckpoints(sender.command.recipe?.metadata?.almReloadCheckpoints)
        : undefined;
    const receiverCheckpoints = receiver.command.kind === 'recipe.run'
        ? toAlmReloadCheckpoints(receiver.command.recipe?.metadata?.almReloadCheckpoints)
        : undefined;
    if (
        !checkpoints || JSON.stringify(checkpoints) !== JSON.stringify(receiverCheckpoints) ||
        !sender.agentId || !receiver.agentId || sender.runId !== receiver.runId
    ) {
        return Either.ofLeft([
            'ALM reload pair requires matching authored checkpoints and actual run/agent addresses.'
        ]);
    }
    const pair: AlmReloadPair = {
        runId: sender.runId,
        sender: { agentId: sender.agentId, commandId: sender.commandId },
        receiver: { agentId: receiver.agentId, commandId: receiver.commandId },
        checkpoints
    };
    const bound = {
        sender: {
            ...sender,
            command: { ...sender.command, metadata: { ...sender.command.metadata, almReloadPair: pair } }
        },
        receiver: {
            ...receiver,
            command: { ...receiver.command, metadata: { ...receiver.command.metadata, almReloadPair: pair } }
        }
    };
    const issues = [...validateAlmReloadRoot(bound.sender), ...validateAlmReloadRoot(bound.receiver)];
    return issues.length > 0 ? Either.ofLeft(issues) : Either.ofRight(bound);
}

export function validateAlmReloadRoot(root: ControlCommandEnvelope): readonly string[] {
    const pair = toAlmReloadPair(root.command);
    if (!pair) {
        return ['Malformed ALM reload pair metadata.'];
    }
    const role = resolveAlmReloadRole(pair, root);
    if (!role || pair.sender.agentId === pair.receiver.agentId || pair.sender.commandId === pair.receiver.commandId) {
        return ['ALM reload roots require distinct agents/root IDs and exact same-run ownership.'];
    }
    const recipe = root.command.kind === 'recipe.run' ? root.command.recipe : undefined;
    if (!recipe || recipe.metadata?.profile !== 'alm-conformance' || recipe.continueOnFailure !== false) {
        return ['ALM reload pair requires an inline fail-fast conformance recipe.'];
    }
    const issues = validateAlmReloadBoundaries(recipe, pair, role);
    if (
        ![root.deadlineEpochMs, root.command.deadlineEpochMs, root.command.timeoutMs].some((value) =>
            typeof value === 'number' && Number.isFinite(value) && value > 0
        )
    ) {
        issues.push('ALM paired roots require an existing finite command deadline or timeout.');
    }
    if (
        JSON.stringify(toAlmReloadCheckpoints(recipe.metadata?.almReloadCheckpoints)) !==
            JSON.stringify(pair.checkpoints)
    ) {
        issues.push('Bound ALM reload checkpoints differ from their authored recipe.');
    }
    return issues;
}

export function resolveAlmReloadRole(pair: AlmReloadPair, root: ControlCommandEnvelope): AlmReloadRole | undefined {
    if (root.runId !== pair.runId) {
        return undefined;
    }
    return (['sender', 'receiver'] as const).find((role) =>
        pair[role].agentId === root.agentId && pair[role].commandId === root.commandId
    );
}

function validateAlmReloadBoundaries(
    recipe: RallarBlackBoxTestRecipe,
    pair: AlmReloadPair,
    role: AlmReloadRole
): string[] {
    const issues: string[] = [];
    const ids = recipe.commands.map((command) => command.commandId);
    if (
        ids.some((id) => !id) || new Set(ids).size !== ids.length ||
        new Set(pair.checkpoints.map((item) => item.key)).size !== pair.checkpoints.length
    ) {
        issues.push('ALM reload commands and checkpoint keys must be explicit and unique.');
    }
    let previous = -1;
    for (const checkpoint of pair.checkpoints) {
        const boundaries = role === 'sender'
            ? [checkpoint.senderPrefixEnd, checkpoint.senderReload, checkpoint.senderSuffixEnd]
            : [checkpoint.receiverReadyEnd, checkpoint.receiverAbsenceEnd, checkpoint.receiverRecoveryEnd];
        for (const id of boundaries) {
            const index = ids.indexOf(id);
            if (index <= previous) {
                issues.push('ALM reload phase boundaries must exist in strictly increasing order.');
            }
            previous = index;
        }
        if (role === 'sender' && recipe.commands[ids.indexOf(checkpoint.senderReload)]?.kind !== 'agent.reload') {
            issues.push('ALM reload sender boundary must name a direct agent.reload.');
        }
        if (role === 'sender' && ids.indexOf(checkpoint.senderReload) !== ids.indexOf(checkpoint.senderPrefixEnd) + 1) {
            issues.push('ALM reload must immediately follow the sender prefix.');
        }
    }
    if (
        recipe.commands.some((command) =>
            command.kind === 'agent.reload' &&
            (role !== 'sender' || !pair.checkpoints.some((checkpoint) => checkpoint.senderReload === command.commandId))
        )
    ) {
        issues.push('Every paired reload must belong to an authored sender checkpoint.');
    }
    return issues;
}

function isAlmReloadRootAddress(value: unknown): value is AlmReloadRootAddress {
    return isJsonRecordValue(value) && isNonemptyString(value.agentId) && isNonemptyString(value.commandId);
}

function isAlmReloadCheckpoint(value: unknown): value is AlmReloadCheckpoint {
    return isJsonRecordValue(value) &&
        [
            'key',
            'senderPrefixEnd',
            'senderReload',
            'senderSuffixEnd',
            'receiverReadyEnd',
            'receiverAbsenceEnd',
            'receiverRecoveryEnd'
        ]
            .every((field) => isNonemptyString(value[field]));
}

function isNonemptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}
